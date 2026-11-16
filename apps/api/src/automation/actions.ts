import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AutomationAction } from "@crm/contracts";
import { schema, user, type Tx } from "@crm/db";
import { activeMember, recordActivity } from "../crm-service.ts";
import { emitEvent } from "../events.ts";

/** A failure that retrying cannot fix (missing contact, unknown member): the run fails at once instead of backing off. */
export class PermanentError extends Error {}

export type ActionContext = { tx: Tx; workspaceId: string; actorUserId: string; runId: string; contactId: string | null };
type Handler<T extends AutomationAction["type"]> = (ctx: ActionContext, a: Extract<AutomationAction, { type: T }>) => Promise<Record<string, unknown>>;

/** Events an action emits carry this marker; the automation consumer ignores them, so rules cannot trigger each other in a loop. */
const via = (runId: string) => ({ viaAutomation: true, runId });

async function contactOf(ctx: ActionContext) {
  if (!ctx.contactId) throw new PermanentError("This trigger has no contact to act on.");
  const [c] = await ctx.tx.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ctx.workspaceId), eq(schema.contacts.id, ctx.contactId), isNull(schema.contacts.deletedAt)));
  if (!c) throw new PermanentError("The contact no longer exists.");
  return c;
}

const createTask: Handler<"create_task"> = async (ctx, a) => {
  const { tx, workspaceId, actorUserId } = ctx;
  const contact = await contactOf(ctx);
  const assignee = a.assigneeUserId ?? contact.ownerUserId ?? null;
  if (assignee && !(await activeMember(tx, workspaceId, assignee))) throw new PermanentError("The assignee is no longer a member of this workspace.");
  const dueAt = a.dueInHours ? new Date(Date.now() + a.dueInHours * 3_600_000) : null;
  const [t] = await tx.insert(schema.tasks).values({ workspaceId, contactId: contact.id, title: a.title, description: a.description ?? null, dueAt, assigneeUserId: assignee, priority: a.priority ?? "normal", createdBy: actorUserId }).returning();
  await tx.insert(schema.taskEvents).values({ workspaceId, taskId: t!.id, kind: "created", actorUserId, data: { title: t!.title, via: "automation", runId: ctx.runId } });
  await recordActivity(tx, { workspaceId, contactId: contact.id, kind: "task.created", actorUserId, data: { taskId: t!.id, title: t!.title, runId: ctx.runId } });
  if (assignee) await emitEvent(tx, { workspaceId, type: "task.assigned", entityType: "task", entityId: t!.id, actorUserId, payload: { assigneeUserId: assignee, title: t!.title, contactId: contact.id, ...via(ctx.runId) } });
  return { taskId: t!.id, contactId: contact.id };
};

const addTag: Handler<"add_tag"> = async (ctx, a) => {
  const { tx, workspaceId, actorUserId } = ctx;
  const contact = await contactOf(ctx);
  const name = a.tagName;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tag:${workspaceId}:${name.toLowerCase()}`}, 0))`); // same lock the contact route takes
  let [tag] = await tx.select().from(schema.tags).where(and(eq(schema.tags.workspaceId, workspaceId), sql`lower(${schema.tags.name}) = ${name.toLowerCase()}`));
  tag ??= (await tx.insert(schema.tags).values({ workspaceId, name }).returning())[0];
  const ins = await tx.insert(schema.contactTags).values({ workspaceId, contactId: contact.id, tagId: tag!.id }).onConflictDoNothing().returning();
  if (ins.length) await recordActivity(tx, { workspaceId, contactId: contact.id, kind: "contact.tag_added", actorUserId, data: { tag: tag!.name, runId: ctx.runId } });
  return { contactId: contact.id, tag: tag!.name, alreadyTagged: !ins.length };
};

const assignOwner: Handler<"assign_owner"> = async (ctx, a) => {
  const { tx, workspaceId, actorUserId } = ctx;
  const contact = await contactOf(ctx);
  if (!(await activeMember(tx, workspaceId, a.ownerUserId))) throw new PermanentError("The new owner is not a member of this workspace.");
  if (contact.ownerUserId === a.ownerUserId) return { contactId: contact.id, unchanged: true };
  await tx.update(schema.contacts).set({ ownerUserId: a.ownerUserId, version: sql`${schema.contacts.version} + 1`, updatedAt: new Date() }).where(and(eq(schema.contacts.workspaceId, workspaceId), eq(schema.contacts.id, contact.id)));
  const ids = [contact.ownerUserId, a.ownerUserId].filter((x): x is string => !!x);
  const names = new Map((await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids))).map((x) => [x.id, x.name]));
  await recordActivity(tx, { workspaceId, contactId: contact.id, kind: "contact.owner_changed", actorUserId, data: { from: contact.ownerUserId ? names.get(contact.ownerUserId) ?? null : null, to: names.get(a.ownerUserId) ?? null, runId: ctx.runId } });
  await emitEvent(tx, { workspaceId, type: "contact.owner_assigned", entityType: "contact", entityId: contact.id, actorUserId, payload: { ownerUserId: a.ownerUserId, previousOwnerUserId: contact.ownerUserId, contactName: contact.name, ...via(ctx.runId) } });
  return { contactId: contact.id, ownerUserId: a.ownerUserId };
};

/** The action registry. Adding an action = a zod variant in @crm/contracts plus one handler here; nothing is dispatched by string eval. */
export const ACTION_HANDLERS: { [K in AutomationAction["type"]]: Handler<K> } = { create_task: createTask, add_tag: addTag, assign_owner: assignOwner };

export function runAction(ctx: ActionContext, a: AutomationAction): Promise<Record<string, unknown>> {
  return (ACTION_HANDLERS[a.type] as (c: ActionContext, x: AutomationAction) => Promise<Record<string, unknown>>)(ctx, a);
}
