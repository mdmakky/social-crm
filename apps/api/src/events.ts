import { and, eq, gt, lt, sql } from "drizzle-orm";
import { schema, withContext, type Db, type Tx } from "@crm/db";

export type EventRow = typeof schema.domainEvents.$inferSelect;
export type EmitEvent = { workspaceId: string; type: string; entityType: string; entityId: string; actorUserId?: string | null; payload?: Record<string, unknown> };

/**
 * Appends a domain event inside the caller's transaction (architecture B1). The counter row is incremented with
 * UPDATE ... RETURNING; its row lock is held until the caller commits, so seq order equals commit order per workspace
 * and a reader that has seen seq = n can never miss an event below n. The caller's tx must carry the workspace context.
 */
export async function emitEvent(tx: Tx, e: EmitEvent): Promise<number> {
  await tx.insert(schema.workspaceEventCounters).values({ workspaceId: e.workspaceId, lastSeq: 0 }).onConflictDoNothing();
  const [c] = await tx
    .update(schema.workspaceEventCounters)
    .set({ lastSeq: sql`${schema.workspaceEventCounters.lastSeq} + 1` })
    .where(eq(schema.workspaceEventCounters.workspaceId, e.workspaceId))
    .returning({ seq: schema.workspaceEventCounters.lastSeq });
  await tx.insert(schema.domainEvents).values({ workspaceId: e.workspaceId, seq: c!.seq, type: e.type, entityType: e.entityType, entityId: e.entityId, actorUserId: e.actorUserId ?? null, payload: e.payload ?? {} });
  return c!.seq;
}

/** Runs fn as the dispatcher: workspace context plus app.system = 'dispatcher' (transaction-local), which the RLS policies key on. */
export function withSystem<T>(db: Db, workspaceId: string | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withContext(db, { workspaceId }, async (tx) => {
    await tx.execute(sql`SELECT set_config('app.system', 'dispatcher', true)`);
    return fn(tx);
  });
}

/** A consumer must be idempotent: after a crash or rollback an event can be handled again. Effects and the offset commit together. */
export type Consumer = { name: string; handle: (tx: Tx, event: EventRow) => Promise<void> };
export type DispatchResult = { processed: number; errors: { consumer: string; workspaceId: string; error: unknown }[] };

/**
 * Processes events after each consumer's offset, in seq order, per workspace. The offset row is locked FOR UPDATE SKIP LOCKED,
 * so a second concurrent dispatcher skips that (consumer, workspace) instead of double-processing it. A handler error rolls back
 * the whole batch (offset included) and is retried on the next run: at-least-once delivery.
 * shortcut: a permanently failing event blocks its workspace for that consumer; add a dead-letter/attempt cap when a second real consumer exists.
 */
export async function dispatchPending(db: Db, opts: { consumers: Consumer[]; batchSize?: number }): Promise<DispatchResult> {
  const batch = opts.batchSize ?? 100;
  const result: DispatchResult = { processed: 0, errors: [] };
  const workspaces = await withSystem(db, undefined, (tx) => tx.select({ id: schema.workspaceEventCounters.workspaceId, last: schema.workspaceEventCounters.lastSeq }).from(schema.workspaceEventCounters));
  for (const consumer of opts.consumers) {
    for (const ws of workspaces) {
      // Offset rows are created in their own short transaction so concurrent first runs never wait on a batch.
      await withSystem(db, ws.id, (tx) => tx.insert(schema.eventConsumers).values({ consumer: consumer.name, workspaceId: ws.id }).onConflictDoNothing());
      for (;;) {
        try {
          const n = await withSystem(db, ws.id, async (tx) => {
            const [off] = await tx
              .select()
              .from(schema.eventConsumers)
              .where(and(eq(schema.eventConsumers.consumer, consumer.name), eq(schema.eventConsumers.workspaceId, ws.id)))
              .for("update", { skipLocked: true });
            if (!off) return 0; // another dispatcher is on it
            const events = await tx.select().from(schema.domainEvents).where(and(eq(schema.domainEvents.workspaceId, ws.id), gt(schema.domainEvents.seq, off.lastSeq))).orderBy(schema.domainEvents.seq).limit(batch);
            if (!events.length) return 0;
            for (const ev of events) await consumer.handle(tx, ev);
            await tx.update(schema.eventConsumers).set({ lastSeq: events[events.length - 1]!.seq, updatedAt: sql`now()` }).where(and(eq(schema.eventConsumers.consumer, consumer.name), eq(schema.eventConsumers.workspaceId, ws.id)));
            return events.length;
          });
          result.processed += n;
          if (n < batch) break;
        } catch (error) {
          result.errors.push({ consumer: consumer.name, workspaceId: ws.id, error });
          break;
        }
      }
    }
  }
  return result;
}

/**
 * Retention: deletes events older than `olderThanDays` AND at or below every named consumer's offset (the DELETE policy enforces
 * the offset rule again in the database). Missing offset rows are created at 0 first, so a newly added consumer holds events back.
 */
export async function pruneEvents(db: Db, opts: { consumers: string[]; olderThanDays: number }): Promise<number> {
  const cutoff = new Date(Date.now() - opts.olderThanDays * 86_400_000);
  const workspaces = await withSystem(db, undefined, (tx) => tx.select({ id: schema.workspaceEventCounters.workspaceId }).from(schema.workspaceEventCounters));
  let deleted = 0;
  for (const ws of workspaces) {
    deleted += await withSystem(db, ws.id, async (tx) => {
      for (const consumer of opts.consumers) await tx.insert(schema.eventConsumers).values({ consumer, workspaceId: ws.id }).onConflictDoNothing();
      const rows = await tx.delete(schema.domainEvents).where(and(eq(schema.domainEvents.workspaceId, ws.id), lt(schema.domainEvents.createdAt, cutoff))).returning({ id: schema.domainEvents.id });
      return rows.length;
    });
  }
  return deleted;
}

/**
 * In-process polling loop (decision D7: moves to a pg-boss worker app later; dispatchPending stays the unit of work).
 * Runs never overlap; stop() resolves after the in-flight run finishes.
 */
export function startDispatcher(db: Db, opts: { consumers: Consumer[]; intervalMs?: number; retentionDays?: number; log?: (m: string, e?: unknown) => void }) {
  const log = opts.log ?? ((m, e) => console.error(m, e));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> = Promise.resolve();
  let lastPrune = 0;
  const tick = () => {
    inflight = (async () => {
      try {
        const r = await dispatchPending(db, { consumers: opts.consumers });
        for (const e of r.errors) log(`dispatcher: ${e.consumer} failed for workspace ${e.workspaceId}`, e.error);
        if (Date.now() - lastPrune > 3_600_000) {
          lastPrune = Date.now();
          await pruneEvents(db, { consumers: opts.consumers.map((c) => c.name), olderThanDays: opts.retentionDays ?? 30 });
        }
      } catch (e) {
        log("dispatcher: run failed", e);
      }
      if (!stopped) timer = setTimeout(tick, opts.intervalMs ?? 1000);
    })();
  };
  tick();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inflight;
    },
  };
}
