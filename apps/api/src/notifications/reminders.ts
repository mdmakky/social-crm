import { and, asc, inArray, isNotNull, isNull, lte, eq } from "drizzle-orm";
import { schema, type Db } from "@crm/db";
import { withSystem } from "../events.ts";
import { deliver } from "./consumer.ts";

/**
 * Time based notifications: for every open task whose remind_at has passed, the assignee gets one "task.reminder" notification and the task is
 * marked reminded_at. Rows are locked with SKIP LOCKED so two API instances never both send; the dedupe key (task id + remind time) makes a
 * crash-and-retry a no-op. Runs inside the dispatcher loop (afterDispatch), so it ticks as often as events do and, like them, slows down when nobody uses the API.
 */
export async function sweepTaskReminders(db: Db, now = new Date()): Promise<number> {
  const workspaces = await withSystem(db, undefined, (tx) => tx.select({ id: schema.workspaceEventCounters.workspaceId }).from(schema.workspaceEventCounters));
  let sent = 0;
  for (const ws of workspaces) {
    sent += await withSystem(db, ws.id, async (tx) => {
      const due = await tx
        .select()
        .from(schema.tasks)
        .where(and(eq(schema.tasks.workspaceId, ws.id), isNull(schema.tasks.deletedAt), isNull(schema.tasks.remindedAt), isNotNull(schema.tasks.remindAt), lte(schema.tasks.remindAt, now), isNotNull(schema.tasks.assigneeUserId), inArray(schema.tasks.status, ["open", "in_progress"])))
        .orderBy(asc(schema.tasks.remindAt))
        .limit(200)
        .for("update", { skipLocked: true });
      if (!due.length) return 0;
      await deliver(tx, ws.id, due.map((t) => ({
        userId: t.assigneeUserId!, kind: "task.reminder" as const, title: `Reminder: ${t.title}`, entityType: "task", entityId: t.id,
        data: { title: t.title, dueAt: t.dueAt?.toISOString() ?? null, remindAt: t.remindAt!.toISOString(), contactId: t.contactId },
        dedupeKey: `reminder:${t.id}:${t.remindAt!.getTime()}`,
      })));
      for (const t of due) await tx.update(schema.tasks).set({ remindedAt: now }).where(and(eq(schema.tasks.workspaceId, ws.id), eq(schema.tasks.id, t.id)));
      return due.length;
    });
  }
  return sent;
}
