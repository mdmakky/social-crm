import { sql, type SQL } from "drizzle-orm";
import { escapeLike } from "@crm/core";
import { isUuid } from "./routes/scope.ts";

// Shared contact query building (list, export, global search). Extracted from routes/contacts.ts unchanged.
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/;

export type Q = Record<string, string | number | undefined>;
export type Parsed = { where: SQL[]; error?: string };

export function filters(workspaceId: string, userId: string, q: Q): Parsed {
  const where: SQL[] = [sql`c.workspace_id = ${workspaceId}`, sql`c.deleted_at IS NULL`];
  const search = typeof q.search === "string" ? q.search.trim().toLowerCase() : "";
  if (search) {
    const like = `%${escapeLike(search)}%`;
    // Digits only count as a phone search when the whole query looks like a phone number ("100%" must not).
    const digits = /^[+\d\s().-]+$/.test(search) ? search.replace(/\D/g, "") : "";
    where.push(sql`(lower(c.name) LIKE ${like} ESCAPE '\\' OR c.email_normalized LIKE ${like} ESCAPE '\\' OR lower(coalesce(c.company, '')) LIKE ${like} ESCAPE '\\' OR ${digits.length >= 3 ? sql`c.phone_normalized LIKE ${`%${digits}%`}` : sql`false`})`);
  }
  if (q.lifecycleStageId) where.push(sql`c.lifecycle_stage_id = ${String(q.lifecycleStageId)}::uuid`);
  if (q.ownerId === "me") where.push(sql`c.owner_user_id = ${userId}`);
  else if (q.ownerId === "unassigned") where.push(sql`c.owner_user_id IS NULL`);
  else if (q.ownerId) where.push(sql`c.owner_user_id = ${String(q.ownerId)}`);
  if (q.source) where.push(sql`c.source = ${String(q.source)}`);
  if (q.tagIds) {
    const ids = String(q.tagIds).split(",").filter(Boolean);
    if (ids.length === 0 || ids.length > 10 || ids.some((i) => !isUuid(i))) return { where, error: "tagIds must be up to 10 comma-separated ids" };
    where.push(sql`EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.workspace_id = c.workspace_id AND ct.contact_id = c.id AND ct.tag_id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}))`);
  }
  for (const [key, op] of [["createdFrom", ">="], ["createdTo", "<"]] as const) {
    const raw = q[key];
    if (raw === undefined) continue;
    const v = String(raw);
    // Strict ISO 8601: a date (whole UTC day) or a date-time WITH an offset. Zone-less values would be read in the server's zone, and Date.parse accepts junk like "1".
    if (!DATE_RE.test(v)) return { where, error: `${key} must be a date (YYYY-MM-DD) or a date-time with a time zone offset` };
    const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
    if (Number.isNaN(t) || new Date(t).getUTCFullYear() < 1900 || new Date(t).getUTCFullYear() > 2100) return { where, error: `${key} is not a valid date` };
    // Date-times go to Postgres as written so microseconds survive; a plain createdTo date includes that whole day.
    const bound = v.length === 10 ? (key === "createdTo" ? new Date(t + 86_400_000).toISOString() : `${v}T00:00:00Z`) : v;
    where.push(op === ">=" ? sql`c.created_at >= ${bound}::timestamptz` : sql`c.created_at < ${bound}::timestamptz`);
  }
  return { where };
}
