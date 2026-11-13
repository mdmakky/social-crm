import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, schema, withContext, type Db } from "../src/index.ts";

// leads.next_activity_at trigger: earliest due_at of open/in_progress, non-deleted linked tasks.
const NAME = process.env.CRM_DB_NAME ?? "crm";
const ADMIN = process.env.DATABASE_URL_ADMIN ?? `postgres://postgres:postgres@127.0.0.1:5436/${NAME}`;
const APP = process.env.DATABASE_URL_APP ?? `postgres://crm_app:app_dev@127.0.0.1:5436/${NAME}`;
const run = Date.now().toString(36);
const U = { owner: `na-owner-${run}`, agent: `na-agent-${run}`, ownerB: `na-ownerb-${run}` };
let db: Db, admin: pg.Client;
let A: string, B: string, lead: string, lead2: string, leadB: string;
const ctx = (userId: string, workspaceId: string) => ({ userId, workspaceId });
const D = (d: number) => new Date(Date.UTC(2031, 0, d));
const nextOf = async (id: string, ws = A, u = U.owner) =>
  ((await withContext(db, ctx(u, ws), (tx) => tx.select({ n: schema.leads.nextActivityAt }).from(schema.leads).where(sql`${schema.leads.id} = ${id}`)))[0]!.n)?.toISOString() ?? null;
const iso = (d: number) => D(d).toISOString();
const mkTask = async (due: Date | null, extra: Record<string, unknown> = {}, ws = A, u = U.owner) =>
  (await withContext(db, ctx(u, ws), (tx) => tx.insert(schema.tasks).values({ workspaceId: ws, title: "t", createdBy: u, dueAt: due, ...extra } as never).returning()))[0]!.id;
const link = (t: string, l: string, ws = A, u = U.owner) => withContext(db, ctx(u, ws), (tx) => tx.execute(sql`INSERT INTO task_links (workspace_id, task_id, entity_type, entity_id) VALUES (${ws}, ${t}, 'lead', ${l})`));
const unlink = (t: string, l: string, ws = A) => withContext(db, ctx(U.owner, ws), (tx) => tx.execute(sql`DELETE FROM task_links WHERE workspace_id = ${ws} AND task_id = ${t} AND entity_type = 'lead' AND entity_id = ${l}`));
const setTask = (t: string, v: Record<string, unknown>, ws = A, u = U.owner) => withContext(db, ctx(u, ws), (tx) => tx.update(schema.tasks).set(v as never).where(sql`${schema.tasks.id} = ${t}`));

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  for (const id of Object.values(U)) await admin.query(`INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,$1,$2,true) ON CONFLICT (id) DO NOTHING`, [id, `${id}@t.test`]);
  db = createDb(APP);
  const seed = async (owner: string, slug: string) => {
    const ws = await withContext(db, { userId: owner }, async (tx) => {
      const [w] = await tx.insert(schema.workspaces).values({ name: slug, slug, ownerUserId: owner }).returning();
      await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId: owner, role: "owner" });
      return w!.id;
    });
    return withContext(db, ctx(owner, ws), async (tx) => {
      const [ls] = await tx.insert(schema.lifecycleStages).values({ workspaceId: ws, name: "New", position: 0 }).returning();
      const [c] = await tx.insert(schema.contacts).values({ workspaceId: ws, name: "C", lifecycleStageId: ls!.id }).returning();
      const [p] = await tx.insert(schema.pipelines).values({ workspaceId: ws, name: "Sales", kind: "sales", isDefault: true, position: 0 }).returning();
      const [s] = await tx.insert(schema.pipelineStages).values({ workspaceId: ws, pipelineId: p!.id, name: "New", kind: "open", defaultProbability: 10, position: 0 }).returning();
      const mk = async (rank: string) => (await tx.insert(schema.leads).values({ workspaceId: ws, title: "L", primaryContactId: c!.id, pipelineId: p!.id, stageId: s!.id, outcome: "open", rank, probability: 10 } as never).returning())[0]!.id;
      return { ws, l1: await mk("a0"), l2: await mk("a1") };
    });
  };
  const a = await seed(U.owner, `na-a-${run}`);
  A = a.ws; lead = a.l1; lead2 = a.l2;
  await withContext(db, ctx(U.owner, A), (tx) => tx.insert(schema.memberships).values({ workspaceId: A, userId: U.agent, role: "agent" }));
  const b = await seed(U.ownerB, `na-b-${run}`);
  B = b.ws; leadB = b.l1;
});
afterAll(async () => { await db.$client.end(); await admin.end(); });

describe("leads.next_activity_at", () => {
  it("is null with no tasks, then tracks the earliest open due date through link, update and unlink", async () => {
    expect(await nextOf(lead)).toBeNull();
    const t1 = await mkTask(D(10)), t2 = await mkTask(D(5)), t3 = await mkTask(null);
    await link(t1, lead);
    expect(await nextOf(lead)).toBe(iso(10));
    await link(t2, lead);
    expect(await nextOf(lead)).toBe(iso(5));
    await link(t3, lead); // no due date never counts
    expect(await nextOf(lead)).toBe(iso(5));
    await setTask(t2, { dueAt: D(20) });
    expect(await nextOf(lead)).toBe(iso(10));
    await setTask(t1, { status: "in_progress" }); // still open
    expect(await nextOf(lead)).toBe(iso(10));
    await setTask(t1, { status: "done" });
    expect(await nextOf(lead)).toBe(iso(20));
    await setTask(t1, { status: "open" }); // reopen
    expect(await nextOf(lead)).toBe(iso(10));
    await setTask(t1, { status: "cancelled" });
    expect(await nextOf(lead)).toBe(iso(20));
    await setTask(t2, { deletedAt: new Date() }); // soft delete
    expect(await nextOf(lead)).toBeNull();
    await setTask(t2, { deletedAt: null });
    expect(await nextOf(lead)).toBe(iso(20));
    await unlink(t2, lead);
    expect(await nextOf(lead)).toBeNull();
  });

  it("relinking a task moves it between leads", async () => {
    const t = await mkTask(D(7));
    await link(t, lead);
    expect(await nextOf(lead)).toBe(iso(7));
    await unlink(t, lead);
    await link(t, lead2);
    expect(await nextOf(lead)).toBeNull();
    expect(await nextOf(lead2)).toBe(iso(7));
    await link(t, lead); // linked to both
    expect(await nextOf(lead)).toBe(iso(7));
    await setTask(t, { status: "done" });
    expect(await nextOf(lead)).toBeNull();
    expect(await nextOf(lead2)).toBeNull();
  });

  it("works for an agent writing a task they own", async () => {
    const t = await mkTask(D(3), { assigneeUserId: U.agent }, A, U.agent);
    await link(t, lead, A, U.agent);
    expect(await nextOf(lead2, A, U.agent)).toBeNull();
    expect(await nextOf(lead, A, U.agent)).toBe(iso(3));
    await setTask(t, { status: "done" }, A, U.agent);
    expect(await nextOf(lead)).toBeNull();
  });

  it("never crosses workspaces", async () => {
    const tb = await mkTask(D(2), {}, B, U.ownerB);
    await expect(link(tb, lead, A)).rejects.toThrow(); // task of B, lead of A, ctx A: task not visible / FK fails
    await link(tb, leadB, B, U.ownerB);
    expect(await nextOf(leadB, B, U.ownerB)).toBe(iso(2));
    expect(await nextOf(lead)).toBeNull();
  });
});
