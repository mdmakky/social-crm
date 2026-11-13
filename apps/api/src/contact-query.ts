import { sql, type SQL } from "drizzle-orm";
import { escapeLike } from "@crm/core";
import { isUuid } from "./routes/scope.ts";

// Shared contact query building (list, export, global search). Extracted from routes/contacts.ts unchanged.
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
    let t = Date.parse(String(raw));
    if (Number.isNaN(t)) return { where, error: `${key} is not a valid date` };
    if (key === "createdTo" && /^\d{4}-\d{2}-\d{2}$/.test(String(raw))) t += 86_400_000; // a plain date includes that whole day
    where.push(op === ">=" ? sql`c.created_at >= ${new Date(t).toISOString()}::timestamptz` : sql`c.created_at < ${new Date(t).toISOString()}::timestamptz`);
  }
  return { where };
}
