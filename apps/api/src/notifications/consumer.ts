import { and, eq, inArray } from "drizzle-orm";
import { EventPayloads, type NotificationKind } from "@crm/contracts";
import { schema, type Tx } from "@crm/db";
import type { Consumer, EventRow } from "../events.ts";

export type NotificationDraft = { userId: string; kind: NotificationKind; title: string; body?: string | null; entityType?: string | null; entityId?: string | null; data?: Record<string, unknown> };
/** Pure mapping from one event to zero or more recipients. Never writes; the consumer applies the common rules. */
export type Generator = (event: EventRow, payload: unknown) => NotificationDraft[];

const generators = new Map<string, Generator>();
/** The extension point: register a generator for an event type to add a notification kind (also add the kind in @crm/contracts). */
export function registerGenerator(type: string, g: Generator) {
  generators.set(type, g);
}

/**
 * Common rules, applied to every generator's drafts: the actor is never notified of their own action, only active members receive
 * notifications, in_app = false suppresses the row, and the dedupe key (default: event id) makes reprocessing a no-op.
 */
export const notificationsConsumer: Consumer = {
  name: "notifications",
  async handle(tx: Tx, event: EventRow) {
    const gen = generators.get(event.type);
    if (!gen) return;
    const schemaFor = (EventPayloads as Record<string, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }>)[event.type];
    const parsed = schemaFor ? schemaFor.safeParse(event.payload) : { success: true, data: event.payload };
    if (!parsed.success) return; // malformed payload: skip rather than block the queue
    const drafts = gen(event, parsed.data).filter((d) => d.userId !== event.actorUserId);
    await deliver(tx, event.workspaceId, drafts.map((d) => ({ ...d, entityType: d.entityType ?? event.entityType, entityId: d.entityId ?? event.entityId, dedupeKey: `${event.id}:${d.kind}` })));
  },
};

/** Writes drafts as notification rows under the common rules: active members only, in_app = false suppresses, the dedupe key makes a repeat a no-op. */
export async function deliver(tx: Tx, workspaceId: string, drafts: (NotificationDraft & { dedupeKey: string })[]) {
  if (!drafts.length) return;
  const users = [...new Set(drafts.map((d) => d.userId))];
  const active = new Set((await tx.select({ u: schema.memberships.userId }).from(schema.memberships).where(and(eq(schema.memberships.workspaceId, workspaceId), inArray(schema.memberships.userId, users), eq(schema.memberships.status, "active")))).map((r) => r.u));
  const off = await tx.select({ u: schema.notificationPreferences.userId, k: schema.notificationPreferences.kind }).from(schema.notificationPreferences).where(and(eq(schema.notificationPreferences.workspaceId, workspaceId), inArray(schema.notificationPreferences.userId, users), eq(schema.notificationPreferences.inApp, false)));
  const muted = new Set(off.map((o) => `${o.u}|${o.k}`));
  const rows = drafts
    .filter((d) => active.has(d.userId) && !muted.has(`${d.userId}|${d.kind}`))
    .map((d) => ({ workspaceId, userId: d.userId, kind: d.kind, title: d.title, body: d.body ?? null, entityType: d.entityType ?? null, entityId: d.entityId ?? null, data: d.data ?? {}, dedupeKey: d.dedupeKey }));
  if (rows.length) await tx.insert(schema.notifications).values(rows).onConflictDoNothing();
}
