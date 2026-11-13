import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, schema, withContext, type Db } from "../src/index.ts";

const DB = process.env.CRM_DB_NAME ?? "crm";
const ADMIN = process.env.DATABASE_URL_ADMIN ?? `postgres://postgres:postgres@127.0.0.1:5436/${DB}`;
const APP = process.env.DATABASE_URL_APP ?? `postgres://crm_app:app_dev@127.0.0.1:5436/${DB}`;
const OWNER = process.env.DATABASE_URL_MIGRATOR ?? `postgres://crm_migrator:migrator_dev@127.0.0.1:5436/${DB}`;
const run = Date.now().toString(36);
const U = { ownerA: `tk-owner-${run}`, adminA: `tk-admin-${run}`, agentA: `tk-agent-${run}`, agent2A: `tk-agent2-${run}`, viewerA: `tk-viewer-${run}`, ownerB: `tk-ownerb-${run}` };

let db: Db;
let admin: pg.Client;
let A: string;
let B: string;
let contactA: string;
let contactB: string;
let taskOfAgent: string; // created by agentA, unassigned
let taskOfAgent2: string; // created by agent2A, unassigned
let taskB: string;

const ctx = (userId: string, workspaceId: string) => ({ userId, workspaceId });
const denied = /row-level security|permission denied|violates foreign key|append-only|does not exist in this workspace|violates check constraint/;
const rejects = async (p: Promise<unknown>) => {
  await expect(p).rejects.toMatchObject({ cause: { message: expect.stringMatching(denied) } });
};
const newTask = (ws: string, by: string, extra: Partial<typeof schema.tasks.$inferInsert> = {}) => ({ workspaceId: ws, title: "t", createdBy: by, ...extra });
const mkTask = async (u: string, ws: string, extra: Partial<typeof schema.tasks.$inferInsert> = {}) => (await withContext(db, ctx(u, ws), (tx) => tx.insert(schema.tasks).values(newTask(ws, u, extra)).returning()))[0]!.id;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  for (const [k, id] of Object.entries(U)) await admin.query(`INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,$1,$2,true) ON CONFLICT (id) DO NOTHING`, [id, `${k}-${run}@t.example`]);
  db = createDb(APP);
  const mk = (owner: string, slug: string) =>
    withContext(db, { userId: owner }, async (tx) => {
      const [w] = await tx.insert(schema.workspaces).values({ name: slug, slug, ownerUserId: owner }).returning();
      await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId: owner, role: "owner" });
      return w!.id;
    });
  A = await mk(U.ownerA, `tk-a-${run}`);
  B = await mk(U.ownerB, `tk-b-${run}`);
  await withContext(db, ctx(U.ownerA, A), (tx) =>
    tx.insert(schema.memberships).values([
      { workspaceId: A, userId: U.adminA, role: "admin" },
      { workspaceId: A, userId: U.agentA, role: "agent" },
      { workspaceId: A, userId: U.agent2A, role: "agent" },
      { workspaceId: A, userId: U.viewerA, role: "viewer" },
    ]),
  );
  const stageA = (await withContext(db, ctx(U.ownerA, A), (tx) => tx.insert(schema.lifecycleStages).values({ workspaceId: A, name: "New", position: 0 }).returning()))[0]!.id;
  const stageB = (await withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.lifecycleStages).values({ workspaceId: B, name: "New", position: 0 }).returning()))[0]!.id;
  contactA = (await withContext(db, ctx(U.agentA, A), (tx) => tx.insert(schema.contacts).values({ workspaceId: A, name: "Alice A", lifecycleStageId: stageA }).returning()))[0]!.id;
  contactB = (await withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.contacts).values({ workspaceId: B, name: "Bob B", lifecycleStageId: stageB }).returning()))[0]!.id;
  taskOfAgent = await mkTask(U.agentA, A, { title: "agent task", contactId: contactA });
  taskOfAgent2 = await mkTask(U.agent2A, A, { title: "agent2 task" });
  taskB = await mkTask(U.ownerB, B, { title: "B secret" });
});
afterAll(async () => {
  await db.$client.end();
  await admin.end();
});

const seen = async (u: string, ws: string, table: "tasks" | "task_events" | "task_links") => (await withContext(db, ctx(u, ws), (tx) => tx.execute(sql.raw(`SELECT * FROM ${table}`)))).rows;

describe("tenant isolation (tasks, task_events, task_links)", () => {
  it("each workspace sees only its own rows; no context sees nothing", async () => {
    for (const t of ["tasks", "task_events", "task_links"] as const) {
      expect((await seen(U.ownerB, B, t)).every((r) => r.workspace_id === B), t).toBe(true);
      expect((await seen(U.ownerA, A, t)).every((r) => r.workspace_id === A), t).toBe(true);
    }
    expect((await seen(U.ownerA, A, "tasks")).map((r) => r.id)).not.toContain(taskB);
    expect(await withContext(db, { userId: U.ownerA }, (tx) => tx.select().from(schema.tasks))).toHaveLength(0);
  });
  it("another workspace's owner cannot read, update or insert into A's tasks and history", async () => {
    expect((await withContext(db, ctx(U.ownerB, B), (tx) => tx.update(schema.tasks).set({ title: "x" }).where(sql`id = ${taskOfAgent}`).returning())).length).toBe(0);
    await rejects(withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.tasks).values(newTask(A, U.ownerB))));
    await rejects(withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.taskEvents).values({ workspaceId: A, taskId: taskOfAgent, kind: "created", actorUserId: U.ownerB })));
    await rejects(withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.taskLinks).values({ workspaceId: A, taskId: taskOfAgent, entityType: "contact", entityId: contactA })));
  });
  it("composite foreign keys stop a task linking to, or history attaching to, another workspace", async () => {
    await rejects(withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.tasks).values(newTask(B, U.ownerB, { contactId: contactA }))));
    await rejects(withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.taskEvents).values({ workspaceId: B, taskId: taskOfAgent, kind: "created", actorUserId: U.ownerB })));
    await rejects(withContext(db, ctx(U.ownerB, B), (tx) => tx.update(schema.tasks).set({ contactId: contactA }).where(sql`id = ${taskB}`)));
    await rejects(withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.taskLinks).values({ workspaceId: B, taskId: taskB, entityType: "contact", entityId: contactA })));
  });
});

describe("tasks: role boundaries (matrix task.edit)", () => {
  it("every role can read tasks and history; viewers cannot write", async () => {
    for (const u of [U.ownerA, U.adminA, U.agentA, U.viewerA]) expect((await seen(u, A, "tasks")).length).toBeGreaterThanOrEqual(2);
    await rejects(withContext(db, ctx(U.viewerA, A), (tx) => tx.insert(schema.tasks).values(newTask(A, U.viewerA))));
    expect((await withContext(db, ctx(U.viewerA, A), (tx) => tx.update(schema.tasks).set({ title: "x" }).where(sql`id = ${taskOfAgent}`).returning())).length).toBe(0);
    await rejects(withContext(db, ctx(U.viewerA, A), (tx) => tx.insert(schema.taskEvents).values({ workspaceId: A, taskId: taskOfAgent, kind: "updated", actorUserId: U.viewerA })));
    await rejects(withContext(db, ctx(U.viewerA, A), (tx) => tx.insert(schema.taskLinks).values({ workspaceId: A, taskId: taskOfAgent, entityType: "contact", entityId: contactA })));
  });
  it("owner and admin update any task", async () => {
    for (const u of [U.ownerA, U.adminA]) expect((await withContext(db, ctx(u, A), (tx) => tx.update(schema.tasks).set({ priority: "high" }).where(sql`id = ${taskOfAgent2}`).returning())).length).toBe(1);
  });
  it("an agent updates only tasks they created or are assigned to", async () => {
    const upd = (u: string, id: string) => withContext(db, ctx(u, A), (tx) => tx.update(schema.tasks).set({ title: "edited" }).where(sql`id = ${id}`).returning());
    expect((await upd(U.agentA, taskOfAgent)).length).toBe(1);
    expect((await upd(U.agentA, taskOfAgent2)).length).toBe(0);
    await withContext(db, ctx(U.adminA, A), (tx) => tx.update(schema.tasks).set({ assigneeUserId: U.agentA }).where(sql`id = ${taskOfAgent2}`));
    expect((await upd(U.agentA, taskOfAgent2)).length).toBe(1);
    await withContext(db, ctx(U.adminA, A), (tx) => tx.update(schema.tasks).set({ assigneeUserId: null }).where(sql`id = ${taskOfAgent2}`));
    expect((await upd(U.agentA, taskOfAgent2)).length).toBe(0);
  });
  it("an agent can hand a task they own to someone else (new row only needs a writer role)", async () => {
    const r = await withContext(db, ctx(U.agentA, A), (tx) => tx.update(schema.tasks).set({ assigneeUserId: U.agent2A }).where(sql`id = ${taskOfAgent}`).returning());
    expect(r.length).toBe(1);
  });
  it("an agent cannot create a task in someone else's name", async () => {
    await rejects(withContext(db, ctx(U.agentA, A), (tx) => tx.insert(schema.tasks).values(newTask(A, U.agent2A))));
  });
  it("tasks are never hard-deleted by the app role (soft delete only)", async () => {
    await rejects(withContext(db, ctx(U.ownerA, A), (tx) => tx.execute(sql`DELETE FROM tasks`)));
  });
});

describe("task_events append-only", () => {
  it("writers insert history as themselves; nobody can update, delete or truncate, even the table owner", async () => {
    await withContext(db, ctx(U.agentA, A), (tx) => tx.insert(schema.taskEvents).values({ workspaceId: A, taskId: taskOfAgent, kind: "created", actorUserId: U.agentA, data: { title: "t" } }));
    await rejects(withContext(db, ctx(U.agentA, A), (tx) => tx.insert(schema.taskEvents).values({ workspaceId: A, taskId: taskOfAgent, kind: "created", actorUserId: U.agent2A })));
    await rejects(withContext(db, ctx(U.ownerA, A), (tx) => tx.insert(schema.taskEvents).values({ workspaceId: A, taskId: taskOfAgent, kind: "bogus", actorUserId: U.ownerA })));
    await rejects(withContext(db, ctx(U.ownerA, A), (tx) => tx.execute(sql`UPDATE task_events SET kind = 'updated'`)));
    await rejects(withContext(db, ctx(U.ownerA, A), (tx) => tx.execute(sql`DELETE FROM task_events`)));
    await rejects(withContext(db, ctx(U.ownerA, A), (tx) => tx.execute(sql`TRUNCATE task_events`)));
    const owner = new pg.Client({ connectionString: OWNER });
    await owner.connect();
    await expect(owner.query("UPDATE task_events SET kind = 'updated'")).rejects.toThrow(/append-only/);
    await expect(owner.query("DELETE FROM task_events")).rejects.toThrow(/append-only/);
    await expect(owner.query("TRUNCATE task_events")).rejects.toThrow(/append-only/);
    await owner.end();
    expect((await seen(U.viewerA, A, "task_events")).length).toBeGreaterThanOrEqual(1);
  });
});

describe("task_links (generic entity links)", () => {
  it("the contact link is mirrored from tasks.contact_id on insert, change and clear", async () => {
    const t = await mkTask(U.agentA, A, { contactId: contactA });
    const links = () => withContext(db, ctx(U.agentA, A), (tx) => tx.select().from(schema.taskLinks).where(sql`task_id = ${t}`));
    expect((await links()).map((l) => [l.entityType, l.entityId])).toEqual([["contact", contactA]]);
    await withContext(db, ctx(U.agentA, A), (tx) => tx.update(schema.tasks).set({ contactId: null }).where(sql`id = ${t}`));
    expect(await links()).toHaveLength(0);
    await withContext(db, ctx(U.agentA, A), (tx) => tx.update(schema.tasks).set({ contactId: contactA }).where(sql`id = ${t}`));
    expect(await links()).toHaveLength(1);
  });
  it("only allow-listed entity types are accepted and the target must exist in the workspace", async () => {
    await rejects(withContext(db, ctx(U.agentA, A), (tx) => tx.insert(schema.taskLinks).values({ workspaceId: A, taskId: taskOfAgent, entityType: "opportunity", entityId: contactA })));
    await rejects(withContext(db, ctx(U.agentA, A), (tx) => tx.insert(schema.taskLinks).values({ workspaceId: A, taskId: taskOfAgent, entityType: "contact", entityId: "00000000-0000-7000-8000-000000000000" })));
  });
  it("links cannot be updated in place", async () => {
    await rejects(withContext(db, ctx(U.ownerA, A), (tx) => tx.execute(sql`UPDATE task_links SET entity_type = 'contact'`)));
  });
});
