import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ContactDetail, ContactSummary, DuplicateCandidate } from "@crm/contracts";
import { normalizeEmail, normalizePhone, type CustomFieldDef } from "@crm/core";
import { schema, user, type Tx } from "@crm/db";

export const DEFAULT_STAGES = ["New", "Engaged", "Qualified", "Customer", "Inactive"];

/** Seeds the five default lifecycle stages when a workspace has none. Returns true when it seeded. */
export async function ensureDefaultStages(tx: Tx, workspaceId: string): Promise<boolean> {
  const existing = await tx.select({ id: schema.lifecycleStages.id }).from(schema.lifecycleStages).where(eq(schema.lifecycleStages.workspaceId, workspaceId)).limit(1);
  if (existing.length) return false;
  await tx.insert(schema.lifecycleStages).values(DEFAULT_STAGES.map((name, position) => ({ workspaceId, name, position })));
  return true;
}

export async function activeStages(tx: Tx, workspaceId: string) {
  return tx.select().from(schema.lifecycleStages).where(and(eq(schema.lifecycleStages.workspaceId, workspaceId), isNull(schema.lifecycleStages.archivedAt))).orderBy(asc(schema.lifecycleStages.position));
}

export async function customDefs(tx: Tx, workspaceId: string, opts: { includeArchived?: boolean } = {}) {
  const rows = await tx.select().from(schema.customFieldDefinitions).where(eq(schema.customFieldDefinitions.workspaceId, workspaceId)).orderBy(asc(schema.customFieldDefinitions.position), asc(schema.customFieldDefinitions.createdAt));
  return rows.filter((r) => opts.includeArchived || !r.archivedAt);
}
export const toFieldDef = (r: { key: string; label: string; type: CustomFieldDef["type"]; options: unknown; required: number }): CustomFieldDef => ({ key: r.key, label: r.label, type: r.type, options: (r.options as string[]) ?? [], required: r.required === 1 });

export async function activeMember(tx: Tx, workspaceId: string, userId: string): Promise<boolean> {
  const [m] = await tx.select({ u: schema.memberships.userId }).from(schema.memberships).where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, userId), eq(schema.memberships.status, "active")));
  return !!m;
}

export async function recordActivity(tx: Tx, a: { workspaceId: string; contactId: string; kind: string; actorUserId: string | null; data?: Record<string, unknown> }) {
  await tx.insert(schema.activities).values({ workspaceId: a.workspaceId, contactId: a.contactId, kind: a.kind, actorUserId: a.actorUserId, actorType: a.actorUserId ? "user" : "system", data: a.data ?? {} });
  await tx.update(schema.contacts).set({ lastActivityAt: new Date() }).where(and(eq(schema.contacts.workspaceId, a.workspaceId), eq(schema.contacts.id, a.contactId)));
}

/** Existing, non-deleted contacts that share a normalized email or phone with the given values. */
export async function findDuplicates(tx: Tx, workspaceId: string, v: { email?: string | null; phone?: string | null }, excludeId?: string): Promise<DuplicateCandidate[]> {
  const email = normalizeEmail(v.email);
  const phone = normalizePhone(v.phone);
  if (!email && !phone) return [];
  const rows = await tx
    .select({ id: schema.contacts.id, name: schema.contacts.name, email: schema.contacts.email, phone: schema.contacts.phone, en: schema.contacts.emailNormalized, pn: schema.contacts.phoneNormalized })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.workspaceId, workspaceId), isNull(schema.contacts.deletedAt), sql`(${email ? sql`${schema.contacts.emailNormalized} = ${email}` : sql`false`} OR ${phone ? sql`${schema.contacts.phoneNormalized} = ${phone}` : sql`false`})`, excludeId ? sql`${schema.contacts.id} <> ${excludeId}` : sql`true`))
    .limit(5);
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone, matchedOn: [...(email && r.en === email ? ["email" as const] : []), ...(phone && r.pn === phone ? ["phone" as const] : [])] }));
}

type Row = typeof schema.contacts.$inferSelect;

/** Loads stage, owner and tags for contacts and shapes them for the API. */
export async function toSummaries(tx: Tx, workspaceId: string, rows: Row[]): Promise<ContactSummary[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const stageIds = Array.from(new Set(rows.map((r) => r.lifecycleStageId)));
  const ownerIds = Array.from(new Set(rows.map((r) => r.ownerUserId).filter((x): x is string => !!x)));
  const [stages, owners, tagRows] = await Promise.all([
    tx.select({ id: schema.lifecycleStages.id, name: schema.lifecycleStages.name }).from(schema.lifecycleStages).where(and(eq(schema.lifecycleStages.workspaceId, workspaceId), inArray(schema.lifecycleStages.id, stageIds))),
    ownerIds.length ? tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ownerIds)) : Promise.resolve([] as { id: string; name: string }[]),
    tx
      .select({ contactId: schema.contactTags.contactId, id: schema.tags.id, name: schema.tags.name, color: schema.tags.color })
      .from(schema.contactTags)
      .innerJoin(schema.tags, and(eq(schema.tags.workspaceId, schema.contactTags.workspaceId), eq(schema.tags.id, schema.contactTags.tagId)))
      .where(and(eq(schema.contactTags.workspaceId, workspaceId), inArray(schema.contactTags.contactId, ids)))
      .orderBy(asc(schema.tags.name)),
  ]);
  const stageBy = new Map(stages.map((s) => [s.id, s]));
  const ownerBy = new Map(owners.map((o) => [o.id, o]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    company: r.company,
    lifecycleStage: { id: r.lifecycleStageId, name: stageBy.get(r.lifecycleStageId)?.name ?? "Unknown" },
    owner: r.ownerUserId ? { id: r.ownerUserId, name: ownerBy.get(r.ownerUserId)?.name ?? "Former member" } : null,
    tags: tagRows.filter((t) => t.contactId === r.id).map((t) => ({ id: t.id, name: t.name, color: t.color as ContactSummary["tags"][number]["color"] })),
    source: r.source,
    lastActivityAt: (r.lastActivityAt ?? r.createdAt).toISOString(),
    createdAt: r.createdAt.toISOString(),
    version: r.version,
  }));
}

export async function toDetail(tx: Tx, workspaceId: string, row: Row): Promise<ContactDetail> {
  const [s] = await toSummaries(tx, workspaceId, [row]);
  const [open] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.tasks).where(and(eq(schema.tasks.workspaceId, workspaceId), eq(schema.tasks.contactId, row.id), inArray(schema.tasks.status, ["open", "in_progress"]), isNull(schema.tasks.deletedAt)));
  return { ...s!, custom: (row.custom as Record<string, unknown>) ?? {}, updatedAt: row.updatedAt.toISOString(), openTaskCount: open?.n ?? 0 };
}

export async function loadContact(tx: Tx, workspaceId: string, id: string): Promise<Row | null> {
  const [r] = await tx.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), eq(schema.contacts.id, id), isNull(schema.contacts.deletedAt)));
  return r ?? null;
}
