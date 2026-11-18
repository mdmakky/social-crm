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
  if (q.ownerId) {
    // One or several (comma-separated): "me", "unassigned" and user ids; a contact matches when its owner is any of them.
    const toks = [...new Set(String(q.ownerId).split(",").map((t) => t.trim()).filter(Boolean))];
    if (toks.length === 0 || toks.length > 30) return { where, error: "ownerId must be up to 30 comma-separated values" };
    const ids = toks.map((t) => (t === "me" ? userId : t)).filter((t) => t !== "unassigned");
    const parts = [...(ids.length ? [sql`c.owner_user_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`] : []), ...(toks.includes("unassigned") ? [sql`c.owner_user_id IS NULL`] : [])];
    where.push(parts.length === 1 ? parts[0]! : sql`(${sql.join(parts, sql` OR `)})`);
  }
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

/**
 * Lead or enquiry (D310). Computed, never stored. A person is a LEAD when they have a phone number (the contact's own phone, or ANY phone contact method: entered, imported,
 * channel-provided or detected in a conversation) or a live lead row; otherwise an ENQUIRY. Needs the alias `c`; independent of PRIMARY_LEAD_JOIN so every query can use it.
 */
// WhatsApp people created before D311 have no stored phone, but their sender id (wa_id) is one: counted here without touching data.
const HAS_PHONE = sql`(c.phone_normalized IS NOT NULL OR EXISTS (SELECT 1 FROM contact_methods cm WHERE cm.workspace_id = c.workspace_id AND cm.contact_id = c.id AND cm.kind = 'phone')
  OR EXISTS (SELECT 1 FROM platform_identities pi JOIN integration_accounts ia ON ia.workspace_id = pi.workspace_id AND ia.id = pi.integration_account_id WHERE pi.workspace_id = c.workspace_id AND pi.contact_id = c.id AND ia.platform = 'whatsapp' AND pi.external_user_id ~ '^[0-9]{7,15}$'))`;
const HAS_LEAD_ROW = sql`EXISTS (SELECT 1 FROM leads l WHERE l.workspace_id = c.workspace_id AND l.primary_contact_id = c.id AND l.deleted_at IS NULL)`;
export const kindWhere = (kind: "lead" | "enquiry" | "all" | undefined): SQL | null => (kind === "all" ? null : kind === "enquiry" ? sql`NOT (${HAS_PHONE} OR ${HAS_LEAD_ROW})` : sql`(${HAS_PHONE} OR ${HAS_LEAD_ROW})`);
