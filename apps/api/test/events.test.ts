import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema, withContext } from "@crm/db";
import { dispatchPending, emitEvent, pruneEvents, startDispatcher, withSystem, type Consumer } from "../src/events.ts";
import { bootstrap, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner: TestUser;
let agent: TestUser;
let ws: string;
let n = 0;
const uniq = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${n++}`;
const emit = (type = "test.event", extra: Partial<Parameters<typeof emitEvent>[1]> = {}) =>
  withContext(h.db, { userId: owner.id, workspaceId: ws }, (tx) => emitEvent(tx, { workspaceId: ws, type, entityType: "thing", entityId: "1", actorUserId: owner.id, ...extra }));
const seqs = (workspaceId = ws) => withSystem(h.db, workspaceId, (tx) => tx.select({ seq: schema.domainEvents.seq }).from(schema.domainEvents).orderBy(schema.domainEvents.seq)).then((r) => r.map((x) => x.seq));
const offset = async (consumer: string, workspaceId = ws) => (await withSystem(h.db, workspaceId, (tx) => tx.select().from(schema.eventConsumers).where(and(eq(schema.eventConsumers.consumer, consumer), eq(schema.eventConsumers.workspaceId, workspaceId)))))[0]?.lastSeq;
const recorder = (name: string, seen: number[] = [], opts: { failAt?: number; delayMs?: number } = {}): Consumer & { seen: number[] } => ({
  name,
  seen,
  async handle(_tx, ev) {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (ev.seq === opts.failAt) throw new Error("boom");
    seen.push(ev.seq);
  },
});

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("evowner");
  agent = await h.newUser("evagent");
  ws = await h.workspace(owner, "Events", { agent });
});
afterAll(() => h.close());

describe("emitEvent: gapless per-workspace seq (B1)", () => {
  it("assigns 1..N under concurrent transactions that commit in random order, and a reader never sees a gap", async () => {
    const w = await h.workspace(owner, "Concurrent");
    const emitIn = (delay: number) =>
      withContext(h.db, { userId: owner.id, workspaceId: w }, async (tx) => {
        const seq = await emitEvent(tx, { workspaceId: w, type: "c", entityType: "t", entityId: "1" });
        await new Promise((r) => setTimeout(r, delay)); // commit after others have started, in a different order
        return seq;
      });
    let done = false;
    const gaps: number[][] = [];
    const reader = (async () => {
      while (!done) {
        const s = await seqs(w);
        if (s.some((v, i) => v !== i + 1)) gaps.push(s); // every snapshot must be a contiguous prefix 1..k
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    const got = await Promise.all(Array.from({ length: 25 }, (_, i) => emitIn((25 - i) * 4)));
    done = true;
    await reader;
    expect(gaps).toEqual([]);
    expect([...got].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(await seqs(w)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("a rolled-back transaction does not consume a seq", async () => {
    const w = await h.workspace(owner, "Rollback");
    const e = (tx: Parameters<typeof emitEvent>[0]) => emitEvent(tx, { workspaceId: w, type: "r", entityType: "t", entityId: "1" });
    await withContext(h.db, { userId: owner.id, workspaceId: w }, e);
    await expect(withContext(h.db, { userId: owner.id, workspaceId: w }, async (tx) => { await e(tx); throw new Error("abort"); })).rejects.toThrow("abort");
    await withContext(h.db, { userId: owner.id, workspaceId: w }, e);
    expect(await seqs(w)).toEqual([1, 2]);
  });

  it("seq is per workspace", async () => {
    const w = await h.workspace(owner, "Other seq");
    expect(await withContext(h.db, { userId: owner.id, workspaceId: w }, (tx) => emitEvent(tx, { workspaceId: w, type: "x", entityType: "t", entityId: "1" }))).toBe(1);
  });
});

describe("dispatchPending", () => {
  it("delivers in seq order, advances the offset, and a second run does nothing", async () => {
    const c = recorder(uniq());
    for (let i = 0; i < 5; i++) await emit();
    const total = (await seqs()).length;
    const r = await dispatchPending(h.db, { consumers: [c], workspaceIds: [ws], batchSize: 2 }); // several batches
    expect(r.errors).toEqual([]);
    expect(c.seen).toEqual(await seqs());
    expect(c.seen).toHaveLength(total);
    expect(await offset(c.name)).toBe(total);
    expect((await dispatchPending(h.db, { consumers: [c], workspaceIds: [ws] })).processed).toBe(0);
    expect(c.seen).toHaveLength(total);
  });

  it("crash then resume: a failing handler rolls back its batch and offset; the next run redelivers and finishes", async () => {
    const name = uniq();
    const before = (await seqs()).length;
    await emit();
    await emit();
    await emit();
    const failAt = before + 2;
    const flaky = recorder(name, [], { failAt });
    const r1 = await dispatchPending(h.db, { consumers: [flaky], workspaceIds: [ws] });
    expect(r1.errors).toHaveLength(1);
    expect(await offset(name)).toBe(0); // whole batch rolled back, nothing skipped
    const good = recorder(name);
    await dispatchPending(h.db, { consumers: [good], workspaceIds: [ws] });
    expect(good.seen.at(-1)).toBe(before + 3);
    expect(good.seen).toEqual(await seqs());
    expect(await offset(name)).toBe(before + 3);
  });

  it("two dispatchers running at once never process the same event twice", async () => {
    const name = uniq();
    const seen: number[] = [];
    const a = recorder(name, seen, { delayMs: 20 });
    for (let i = 0; i < 6; i++) await emit();
    const results = await Promise.all([1, 2, 3].map(() => dispatchPending(h.db, { consumers: [a], workspaceIds: [ws], batchSize: 100 })));
    expect(results.flatMap((r) => r.errors)).toEqual([]);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect([...seen].sort((x, y) => x - y)).toEqual(await seqs());
    expect(results.filter((r) => r.processed > 0)).toHaveLength(1); // exactly one won the lock
  });

  it("consumers keep independent offsets", async () => {
    const fast = recorder(uniq());
    const slow = recorder(uniq(), [], { failAt: 1 });
    await emit();
    await dispatchPending(h.db, { consumers: [fast, slow], workspaceIds: [ws] });
    expect(await offset(fast.name)).toBe((await seqs()).at(-1));
    expect(await offset(slow.name)).toBe(0);
  });

  it("startDispatcher polls and stops gracefully", async () => {
    const c = recorder(uniq());
    const d = startDispatcher(h.db, { consumers: [c], intervalMs: 20, log: () => undefined });
    await emit();
    await expect.poll(() => c.seen.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await d.stop();
    const after = c.seen.length;
    await emit();
    await new Promise((r) => setTimeout(r, 100));
    expect(c.seen.length).toBe(after); // stopped: nothing further is delivered
  });

  it("while idle the dispatcher polls slowly, wake() delivers at once, and active polling stays fast", async () => {
    const c = recorder(uniq());
    let active = false;
    const d = startDispatcher(h.db, { consumers: [c], intervalMs: 20, idleIntervalMs: 3_600_000, isActive: () => active, log: () => undefined });
    let last = -1;
    await expect.poll(async () => { const now = c.seen.length; const stable = now === last; last = now; await new Promise((r) => setTimeout(r, 250)); return stable; }, { timeout: 20_000 }).toBe(true); // first pass done
    const before = c.seen.length;
    await emit();
    await new Promise((r) => setTimeout(r, 400));
    expect(c.seen.length).toBe(before); // idle: the next poll is an hour away
    active = true; // same order as server.ts: the request marks the system active first, then wakes the dispatcher
    d.wake();
    await expect.poll(() => c.seen.length, { timeout: 10_000 }).toBeGreaterThan(before);
    const mid = c.seen.length;
    await emit();
    await expect.poll(() => c.seen.length, { timeout: 10_000 }).toBeGreaterThan(mid); // active again: fast polling
    await d.stop();
  });
});

describe("pruneEvents", () => {
  it("removes only events that are old AND below every consumer offset", async () => {
    const w = await h.workspace(owner, "Prune");
    const emitW = () => withContext(h.db, { userId: owner.id, workspaceId: w }, (tx) => emitEvent(tx, { workspaceId: w, type: "p", entityType: "t", entityId: "1" }));
    for (let i = 0; i < 4; i++) await emitW();
    await h.admin.query("UPDATE domain_events SET created_at = now() - interval '40 days' WHERE workspace_id = $1 AND seq <= 3", [w]);
    const fast = uniq();
    const slow = uniq();
    await dispatchPending(h.db, { consumers: [recorder(fast), recorder(slow, [], { failAt: 3 })], workspaceIds: [w], batchSize: 2 });
    // fast is at 4; slow committed seq 1-2 and then failed in the batch holding 3
    expect(await offset(slow, w)).toBe(2);
    expect(await pruneEvents(h.db, { consumers: [fast, slow], olderThanDays: 30, workspaceIds: [w] })).toBe(2); // 1,2 old and consumed by both
    expect(await seqs(w)).toEqual([3, 4]);
    expect(await pruneEvents(h.db, { consumers: [fast, slow], olderThanDays: 30, workspaceIds: [w] })).toBe(0); // 3 is old but slow has not consumed it
  });

  it("a consumer with no offset row yet holds events back; recent events are kept", async () => {
    const w = await h.workspace(owner, "Prune2");
    await withContext(h.db, { userId: owner.id, workspaceId: w }, (tx) => emitEvent(tx, { workspaceId: w, type: "p", entityType: "t", entityId: "1" }));
    await h.admin.query("UPDATE domain_events SET created_at = now() - interval '40 days' WHERE workspace_id = $1", [w]);
    const c = recorder(uniq());
    const late = recorder(uniq()); // registered for pruning but never dispatched yet
    await dispatchPending(h.db, { consumers: [c], workspaceIds: [w] });
    expect(await pruneEvents(h.db, { consumers: [c.name, late.name], olderThanDays: 30, workspaceIds: [w] })).toBe(0);
    await dispatchPending(h.db, { consumers: [late], workspaceIds: [w] });
    expect(await pruneEvents(h.db, { consumers: [c.name, late.name], olderThanDays: 60, workspaceIds: [w] })).toBe(0); // not old enough
    expect(await pruneEvents(h.db, { consumers: [c.name, late.name], olderThanDays: 30, workspaceIds: [w] })).toBe(1);
  });
});

describe("notifications consumer", async () => {
  const { notificationsConsumer } = await import("../src/notifications/index.ts");
  const run = () => dispatchPending(h.db, { consumers: [notificationsConsumer], workspaceIds: [ws] });
  const inbox = (u: TestUser) => withContext(h.db, { userId: u.id, workspaceId: ws }, (tx) => tx.select().from(schema.notifications).orderBy(schema.notifications.id));

  it("contact.owner_assigned notifies the new owner, never the actor, and is idempotent when an event is reprocessed", async () => {
    const w = await h.workspace(owner, "Notify1", { agent });
    const go = () => dispatchPending(h.db, { consumers: [notificationsConsumer], workspaceIds: [w] });
    const as = (u: TestUser) => withContext(h.db, { userId: u.id, workspaceId: w }, (tx) => tx.select().from(schema.notifications));
    await withContext(h.db, { userId: owner.id, workspaceId: w }, async (tx) => {
      await emitEvent(tx, { workspaceId: w, type: "contact.owner_assigned", entityType: "contact", entityId: "c-1", actorUserId: owner.id, payload: { ownerUserId: agent.id, contactName: "Ana" } });
      await emitEvent(tx, { workspaceId: w, type: "contact.owner_assigned", entityType: "contact", entityId: "c-2", actorUserId: owner.id, payload: { ownerUserId: owner.id, contactName: "Self" } });
    });
    await go();
    const mine = await as(agent);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "contact.owner_assigned", entityType: "contact", entityId: "c-1", readAt: null });
    expect(mine[0]!.title).toContain("Ana");
    expect(await as(owner)).toEqual([]); // self-assignment: actor is not notified
    await h.admin.query("UPDATE event_consumers SET last_seq = 0 WHERE consumer = 'notifications' AND workspace_id = $1", [w]); // simulate redelivery
    await go();
    expect(await as(agent)).toHaveLength(1);
  });

  it("task.assigned and import.completed (system event with no actor) are delivered to the right person", async () => {
    const w = await h.workspace(owner, "Notify2", { agent });
    await withContext(h.db, { userId: owner.id, workspaceId: w }, async (tx) => {
      await emitEvent(tx, { workspaceId: w, type: "task.assigned", entityType: "task", entityId: "t-1", actorUserId: owner.id, payload: { assigneeUserId: agent.id, title: "Call back", contactId: null } });
      await emitEvent(tx, { workspaceId: w, type: "import.completed", entityType: "import", entityId: "i-1", actorUserId: null, payload: { importedByUserId: owner.id, created: 3, updated: 1, skipped: 0 } });
      await emitEvent(tx, { workspaceId: w, type: "unknown.type", entityType: "x", entityId: "1" });
      await emitEvent(tx, { workspaceId: w, type: "task.assigned", entityType: "task", entityId: "t-2", payload: { nonsense: true } }); // malformed: skipped, does not block
    });
    const r = await dispatchPending(h.db, { consumers: [notificationsConsumer], workspaceIds: [w] });
    expect(r.errors).toEqual([]);
    const as = (u: TestUser) => withContext(h.db, { userId: u.id, workspaceId: w }, (tx) => tx.select().from(schema.notifications));
    expect((await as(agent)).map((x) => x.kind)).toEqual(["task.assigned"]);
    const imp = await as(owner);
    expect(imp.map((x) => x.kind)).toEqual(["import.completed"]);
    expect(imp[0]!.body).toBe("3 created, 1 updated, 0 skipped");
  });

  it("respects preferences, and skips users who are no longer active members", async () => {
    const w = await h.workspace(owner, "Notify3", { agent });
    const go = () => dispatchPending(h.db, { consumers: [notificationsConsumer], workspaceIds: [w] });
    const emitAssign = (entityId: string) => withContext(h.db, { userId: owner.id, workspaceId: w }, (tx) => emitEvent(tx, { workspaceId: w, type: "task.assigned", entityType: "task", entityId, actorUserId: owner.id, payload: { assigneeUserId: agent.id, title: "T" } }));
    await withContext(h.db, { userId: agent.id, workspaceId: w }, (tx) => tx.insert(schema.notificationPreferences).values({ workspaceId: w, userId: agent.id, kind: "task.assigned", inApp: false }));
    await emitAssign("a");
    await go();
    const count = () => withContext(h.db, { userId: agent.id, workspaceId: w }, (tx) => tx.select().from(schema.notifications)).then((r) => r.length);
    expect(await count()).toBe(0);
    await withContext(h.db, { userId: agent.id, workspaceId: w }, (tx) => tx.update(schema.notificationPreferences).set({ inApp: true }));
    await emitAssign("b");
    await go();
    expect(await count()).toBe(1);
    await h.admin.query("UPDATE memberships SET status = 'deactivated' WHERE workspace_id = $1 AND user_id = $2", [w, agent.id]);
    await emitAssign("c");
    expect((await go()).errors).toEqual([]); // skipped quietly, no crash
    await h.admin.query("UPDATE memberships SET status = 'active' WHERE workspace_id = $1 AND user_id = $2", [w, agent.id]);
    expect(await count()).toBe(1);
  });

  it("generic mechanism: registering a generator adds a kind without touching the consumer", async () => {
    const { registerGenerator } = await import("../src/notifications/index.ts");
    registerGenerator("custom.ping", (e) => [{ userId: agent.id, kind: "task.assigned", title: "Ping", entityType: e.entityType, entityId: e.entityId }]);
    await emit("custom.ping");
    await run();
    expect((await inbox(agent)).some((x) => x.title === "Ping")).toBe(true);
  });
});

