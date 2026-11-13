import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { and, eq, sql } from "drizzle-orm";
import { createDb, withContext, schema, type Db, type Tx } from "../src/index.ts";

const ADMIN = process.env.DATABASE_URL_ADMIN ?? "postgres://postgres:postgres@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm");
const APP = process.env.DATABASE_URL_APP ?? "postgres://crm_app:app_dev@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm");
const run = Date.now().toString(36);
const U = { owner: `n-owner-${run}`, admin: `n-admin-${run}`, agent: `n-agent-${run}`, gone: `n-gone-${run}`, other: `n-other-${run}` };
let db: Db;
let admin: pg.Client;
let ws: string;
let otherWs: string;

const asSystem = <T>(workspaceId: string, fn: (tx: Tx) => Promise<T>) =>
  withContext(db, { workspaceId }, async (tx) => {
    await tx.execute(sql`SELECT set_config('app.system', 'dispatcher', true)`);
    return fn(tx);
  });
/** Drizzle wraps driver errors; the Postgres message is on `cause`. */
async function rejectsWith(p: Promise<unknown>, re: RegExp) {
  const e = await p.then(() => null, (x: { cause?: { message?: string }; message?: string }) => x);
  expect(e, "expected the statement to be rejected").not.toBeNull();
  expect(String(e!.cause?.message ?? e!.message)).toMatch(re);
}
const note = (userId: string, workspaceId = ws, dedupeKey = `k-${Math.random()}`) => ({ workspaceId, userId, kind: "task.assigned", title: `for ${userId}`, dedupeKey });

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  for (const [k, id] of Object.entries(U)) await admin.query(`INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,$1,$2,true) ON CONFLICT (id) DO NOTHING`, [id, `notif-${k}-${run}@t.example`]);
  db = createDb(APP);
  const mk = (owner: string, slug: string) =>
    withContext(db, { userId: owner }, async (tx) => {
      const [w] = await tx.insert(schema.workspaces).values({ name: slug, slug: `${slug}-${run}`, ownerUserId: owner }).returning();
      await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId: owner, role: "owner" });
      return w!.id;
    });
  ws = await mk(U.owner, "notif");
  otherWs = await mk(U.other, "notif-other");
  await withContext(db, { userId: U.owner, workspaceId: ws }, (tx) =>
    tx.insert(schema.memberships).values([
      { workspaceId: ws, userId: U.admin, role: "admin" },
      { workspaceId: ws, userId: U.agent, role: "agent" },
      { workspaceId: ws, userId: U.gone, role: "agent", status: "deactivated" },
    ]),
  );
});
afterAll(async () => {
  await db.$client.end();
  await admin.end();
});

describe("notifications RLS", () => {
  it("a user reads only their own notifications, even admins and owners cannot read another member's", async () => {
    await asSystem(ws, (tx) => tx.insert(schema.notifications).values([note(U.agent), note(U.admin)]));
    const read = (userId: string, workspaceId = ws) => withContext(db, { userId, workspaceId }, (tx) => tx.select().from(schema.notifications));
    expect((await read(U.agent)).map((n) => n.userId)).toEqual([U.agent]);
    expect((await read(U.admin)).map((n) => n.userId)).toEqual([U.admin]);
    expect(await read(U.owner)).toEqual([]);
    expect(await read(U.other, otherWs)).toEqual([]);
    expect(await read(U.agent, otherWs)).toEqual([]); // wrong workspace context
    expect(await withContext(db, { workspaceId: ws }, (tx) => tx.select().from(schema.notifications))).toEqual([]); // no user
  });

  it("inserts only through the system path and only for active members of that workspace", async () => {
    await expect(withContext(db, { userId: U.owner, workspaceId: ws }, (tx) => tx.insert(schema.notifications).values(note(U.agent)))).rejects.toThrow();
    await expect(withContext(db, { userId: U.agent, workspaceId: ws }, (tx) => tx.insert(schema.notifications).values(note(U.agent)))).rejects.toThrow();
    await expect(asSystem(ws, (tx) => tx.insert(schema.notifications).values(note(U.gone)))).rejects.toThrow(); // deactivated
    await expect(asSystem(ws, (tx) => tx.insert(schema.notifications).values(note(U.other)))).rejects.toThrow(); // not a member
    await expect(asSystem(ws, (tx) => tx.insert(schema.notifications).values(note(U.agent, otherWs)))).rejects.toThrow(); // other workspace
  });

  it("dedupe_key is unique per (workspace, user)", async () => {
    await asSystem(ws, (tx) => tx.insert(schema.notifications).values(note(U.agent, ws, "dup")));
    await expect(asSystem(ws, (tx) => tx.insert(schema.notifications).values(note(U.agent, ws, "dup")))).rejects.toThrow();
    await asSystem(ws, (tx) => tx.insert(schema.notifications).values(note(U.admin, ws, "dup"))); // different user is fine
  });

  it("users can only change read_at on their own rows; no deletes", async () => {
    const [mine] = await withContext(db, { userId: U.agent, workspaceId: ws }, (tx) => tx.select().from(schema.notifications).limit(1));
    const upd = (userId: string, set: Partial<typeof schema.notifications.$inferInsert>) => withContext(db, { userId, workspaceId: ws }, (tx) => tx.update(schema.notifications).set(set).where(eq(schema.notifications.id, mine!.id)).returning());
    expect(await upd(U.agent, { readAt: new Date() })).toHaveLength(1);
    expect(await upd(U.admin, { readAt: new Date() })).toHaveLength(0); // someone else's row is invisible
    await rejectsWith(upd(U.agent, { title: "tampered" }), /permission denied/);
    await rejectsWith(withContext(db, { userId: U.agent, workspaceId: ws }, (tx) => tx.delete(schema.notifications)), /permission denied/);
  });
});

describe("notification_preferences RLS", () => {
  it("own rows only; the system path can read them; nobody writes for someone else", async () => {
    await withContext(db, { userId: U.agent, workspaceId: ws }, (tx) => tx.insert(schema.notificationPreferences).values({ workspaceId: ws, userId: U.agent, kind: "task.assigned", inApp: false }));
    expect(await withContext(db, { userId: U.admin, workspaceId: ws }, (tx) => tx.select().from(schema.notificationPreferences))).toEqual([]);
    expect(await withContext(db, { userId: U.agent, workspaceId: otherWs }, (tx) => tx.select().from(schema.notificationPreferences))).toEqual([]);
    expect(await asSystem(ws, (tx) => tx.select().from(schema.notificationPreferences))).toHaveLength(1);
    await expect(withContext(db, { userId: U.admin, workspaceId: ws }, (tx) => tx.insert(schema.notificationPreferences).values({ workspaceId: ws, userId: U.agent, kind: "x", inApp: false }))).rejects.toThrow();
    expect(await withContext(db, { userId: U.admin, workspaceId: ws }, (tx) => tx.update(schema.notificationPreferences).set({ inApp: true }).returning())).toHaveLength(0);
  });
});

describe("domain_events, counters and consumers RLS", () => {
  const ev = (workspaceId: string, seq: number) => ({ workspaceId, seq, type: "t", entityType: "e", entityId: "1" });

  it("members append in their own workspace only; only the system path reads", async () => {
    await withContext(db, { userId: U.agent, workspaceId: ws }, (tx) => tx.insert(schema.domainEvents).values(ev(ws, 1)));
    await expect(withContext(db, { userId: U.agent, workspaceId: ws }, (tx) => tx.insert(schema.domainEvents).values(ev(otherWs, 1)))).rejects.toThrow();
    await expect(withContext(db, { userId: U.other, workspaceId: ws }, (tx) => tx.insert(schema.domainEvents).values(ev(ws, 2)))).rejects.toThrow(); // not a member
    expect(await withContext(db, { userId: U.owner, workspaceId: ws }, (tx) => tx.select().from(schema.domainEvents))).toEqual([]);
    expect(await asSystem(otherWs, (tx) => tx.select().from(schema.domainEvents))).toEqual([]);
    expect(await asSystem(ws, (tx) => tx.select().from(schema.domainEvents))).toHaveLength(1);
  });

  it("is append-only: no UPDATE; DELETE only at or below every consumer offset", async () => {
    await rejectsWith(asSystem(ws, (tx) => tx.update(schema.domainEvents).set({ type: "x" })), /permission denied/);
    expect(await asSystem(ws, (tx) => tx.delete(schema.domainEvents).returning())).toHaveLength(0); // no consumers: nothing deletable
    await asSystem(ws, (tx) => tx.insert(schema.eventConsumers).values({ consumer: "c1", workspaceId: ws, lastSeq: 0 }));
    expect(await asSystem(ws, (tx) => tx.delete(schema.domainEvents).returning())).toHaveLength(0); // consumer still at 0
    await asSystem(ws, (tx) => tx.update(schema.eventConsumers).set({ lastSeq: 1 }).where(and(eq(schema.eventConsumers.consumer, "c1"), eq(schema.eventConsumers.workspaceId, ws))));
    expect(await withContext(db, { userId: U.owner, workspaceId: ws }, (tx) => tx.delete(schema.domainEvents).returning())).toHaveLength(0); // not the system path
    expect(await asSystem(ws, (tx) => tx.delete(schema.domainEvents).returning())).toHaveLength(1);
  });

  it("counter moves up by exactly one, is workspace scoped and not deletable", async () => {
    await withContext(db, { userId: U.agent, workspaceId: ws }, (tx) => tx.insert(schema.workspaceEventCounters).values({ workspaceId: ws, lastSeq: 0 }));
    await withContext(db, { userId: U.agent, workspaceId: ws }, (tx) => tx.update(schema.workspaceEventCounters).set({ lastSeq: 1 }));
    await rejectsWith(withContext(db, { userId: U.agent, workspaceId: ws }, (tx) => tx.update(schema.workspaceEventCounters).set({ lastSeq: 7 })), /exactly 1/);
    await rejectsWith(withContext(db, { userId: U.agent, workspaceId: ws }, (tx) => tx.update(schema.workspaceEventCounters).set({ lastSeq: 0 })), /exactly 1/);
    await rejectsWith(withContext(db, { userId: U.agent, workspaceId: ws }, (tx) => tx.delete(schema.workspaceEventCounters)), /permission denied/);
    expect(await withContext(db, { userId: U.agent, workspaceId: otherWs }, (tx) => tx.select().from(schema.workspaceEventCounters))).toEqual([]);
    expect((await asSystem(ws, (tx) => tx.select().from(schema.workspaceEventCounters))).length).toBeGreaterThanOrEqual(1);
  });

  it("event_consumers are dispatcher-only", async () => {
    expect(await withContext(db, { userId: U.owner, workspaceId: ws }, (tx) => tx.select().from(schema.eventConsumers))).toEqual([]);
    await expect(withContext(db, { userId: U.owner, workspaceId: ws }, (tx) => tx.insert(schema.eventConsumers).values({ consumer: "evil", workspaceId: ws }))).rejects.toThrow();
    await expect(asSystem(ws, (tx) => tx.insert(schema.eventConsumers).values({ consumer: "x", workspaceId: otherWs }))).rejects.toThrow(); // system context is still workspace-bound
  });
});
