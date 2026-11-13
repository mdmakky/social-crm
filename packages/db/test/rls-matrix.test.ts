import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { and, eq, sql } from "drizzle-orm";
import { createDb, schema, withContext, type Db } from "../src/index.ts";

// Migration 0008 (security review M4, m1): the database backs the permission matrix, not only the API.
const ADMIN = process.env.DATABASE_URL_ADMIN ?? "postgres://postgres:postgres@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm");
const APP = process.env.DATABASE_URL_APP ?? "postgres://crm_app:app_dev@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm");
const run = Date.now().toString(36);
const U = { owner: `rm-owner-${run}`, admin: `rm-admin-${run}`, agent: `rm-agent-${run}`, agent2: `rm-agent2-${run}`, viewer: `rm-viewer-${run}`, ownerB: `rm-ownerb-${run}`, stranger: `rm-stranger-${run}` };
let db: Db, admin: pg.Client;
let A: string, B: string, stageA: string, contactA: string, taskByAgent: string, taskByAdmin: string;
const ctx = (userId: string, workspaceId?: string) => ({ userId, workspaceId });
const denied = /row-level security|permission denied/;
const rejects = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ cause: { message: expect.stringMatching(denied) } });

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  for (const [k, id] of Object.entries(U)) await admin.query(`INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,$1,$2,true) ON CONFLICT (id) DO NOTHING`, [id, `${k}-${run}@t.example`]);
  db = createDb(APP);
  const mk = (owner: string, slug: string) => withContext(db, { userId: owner }, async (tx) => {
    const [w] = await tx.insert(schema.workspaces).values({ name: slug, slug, ownerUserId: owner }).returning();
    await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId: owner, role: "owner" });
    return w!.id;
  });
  A = await mk(U.owner, `rm-a-${run}`);
  B = await mk(U.ownerB, `rm-b-${run}`);
  await withContext(db, ctx(U.owner, A), (tx) => tx.insert(schema.memberships).values([
    { workspaceId: A, userId: U.admin, role: "admin" }, { workspaceId: A, userId: U.agent, role: "agent" }, { workspaceId: A, userId: U.agent2, role: "agent" }, { workspaceId: A, userId: U.viewer, role: "viewer" },
  ]));
  stageA = (await withContext(db, ctx(U.owner, A), (tx) => tx.insert(schema.lifecycleStages).values({ workspaceId: A, name: "New", position: 0 }).returning()))[0]!.id;
  contactA = (await withContext(db, ctx(U.agent, A), (tx) => tx.insert(schema.contacts).values({ workspaceId: A, name: "Alice", lifecycleStageId: stageA }).returning()))[0]!.id;
  taskByAgent = (await withContext(db, ctx(U.agent, A), (tx) => tx.insert(schema.tasks).values({ workspaceId: A, contactId: contactA, title: "agent task", createdBy: U.agent, assigneeUserId: U.agent }).returning()))[0]!.id;
  taskByAdmin = (await withContext(db, ctx(U.admin, A), (tx) => tx.insert(schema.tasks).values({ workspaceId: A, contactId: contactA, title: "admin task", createdBy: U.admin, assigneeUserId: U.admin }).returning()))[0]!.id;
  await withContext(db, ctx(U.owner, A), (tx) => tx.insert(schema.auditLog).values({ workspaceId: A, action: "test.seed" }));
});
afterAll(async () => { await db.$client.end(); await admin.end(); });

describe("audit_log", () => {
  it("is readable by owners and admins only", async () => {
    const n = async (u: string) => (await withContext(db, ctx(u, A), (tx) => tx.select().from(schema.auditLog).where(eq(schema.auditLog.workspaceId, A)))).length;
    expect(await n(U.owner)).toBeGreaterThan(0);
    expect(await n(U.admin)).toBeGreaterThan(0);
    expect(await n(U.agent)).toBe(0);
    expect(await n(U.viewer)).toBe(0);
  });
  it("accepts entries from members of that workspace only: no forging for another tenant, none from a non-member", async () => {
    await withContext(db, ctx(U.viewer, A), (tx) => tx.insert(schema.auditLog).values({ workspaceId: A, action: "test.member_entry" }));
    await rejects(withContext(db, ctx(U.stranger, A), (tx) => tx.insert(schema.auditLog).values({ workspaceId: A, action: "test.forged" })));
    await rejects(withContext(db, ctx(U.owner, A), (tx) => tx.insert(schema.auditLog).values({ workspaceId: B, action: "test.cross_tenant" })));
  });
});

describe("a caller who is not a member cannot reach a tenant by naming it in the context", () => {
  it("sees no workspace row, contacts, tasks or audit entries", async () => {
    await withContext(db, ctx(U.stranger, A), async (tx) => {
      expect(await tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, A))).toHaveLength(0);
      expect(await tx.select().from(schema.contacts)).toHaveLength(0);
      expect(await tx.select().from(schema.tasks)).toHaveLength(0);
      expect(await tx.select().from(schema.auditLog)).toHaveLength(0);
    });
  });
  it("cannot update, delete or insert in that tenant", async () => {
    await withContext(db, ctx(U.stranger, A), async (tx) => {
      expect(await tx.update(schema.workspaces).set({ name: "pwned" }).where(eq(schema.workspaces.id, A)).returning()).toHaveLength(0);
      expect(await tx.update(schema.contacts).set({ name: "pwned" }).where(eq(schema.contacts.id, contactA)).returning()).toHaveLength(0);
      expect(await tx.update(schema.tasks).set({ deletedAt: new Date() }).where(eq(schema.tasks.id, taskByAgent)).returning()).toHaveLength(0); // tasks are soft-deleted (DELETE is revoked)
    });
    await rejects(withContext(db, ctx(U.stranger, A), (tx) => tx.insert(schema.contacts).values({ workspaceId: A, name: "x", lifecycleStageId: stageA })));
  });
  it("a member of tenant A cannot touch tenant B even with A's context", async () => {
    await withContext(db, ctx(U.owner, A), async (tx) => {
      expect(await tx.update(schema.workspaces).set({ name: "pwned" }).where(eq(schema.workspaces.id, B)).returning()).toHaveLength(0);
      expect(await tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, B))).toHaveLength(0);
    });
  });
});

describe("workspaces", () => {
  it("only owners and admins can change a workspace", async () => {
    const rename = (u: string) => withContext(db, ctx(u, A), (tx) => tx.update(schema.workspaces).set({ name: `renamed-by-${u}` }).where(eq(schema.workspaces.id, A)).returning());
    expect(await rename(U.viewer)).toHaveLength(0);
    expect(await rename(U.agent)).toHaveLength(0);
    expect(await rename(U.admin)).toHaveLength(1);
    expect(await rename(U.owner)).toHaveLength(1);
  });
  it("members still list their own workspaces without a workspace in context", async () => {
    const rows = await withContext(db, { userId: U.viewer }, (tx) => tx.select().from(schema.workspaces));
    expect(rows.map((w) => w.id)).toEqual([A]);
  });
});

describe("contacts: soft delete is admin-only", () => {
  const softDelete = (u: string) => withContext(db, ctx(u, A), (tx) => tx.update(schema.contacts).set({ deletedAt: new Date() }).where(eq(schema.contacts.id, contactA)).returning());
  it("an agent can edit but not delete; a viewer can do neither", async () => {
    expect(await withContext(db, ctx(U.agent, A), (tx) => tx.update(schema.contacts).set({ company: "Edited" }).where(eq(schema.contacts.id, contactA)).returning())).toHaveLength(1);
    await rejects(softDelete(U.agent));
    expect(await withContext(db, ctx(U.viewer, A), (tx) => tx.update(schema.contacts).set({ company: "x" }).where(eq(schema.contacts.id, contactA)).returning())).toHaveLength(0);
  });
  it("an admin can delete; afterwards an agent can no longer modify the deleted row", async () => {
    expect(await softDelete(U.admin)).toHaveLength(1);
    expect(await withContext(db, ctx(U.agent, A), (tx) => tx.update(schema.contacts).set({ company: "zombie" }).where(eq(schema.contacts.id, contactA)).returning())).toHaveLength(0);
    // restore so later tests keep a live contact
    expect(await withContext(db, ctx(U.admin, A), (tx) => tx.update(schema.contacts).set({ deletedAt: null }).where(eq(schema.contacts.id, contactA)).returning())).toHaveLength(1);
  });
});

describe("tasks: agents change only their own", () => {
  const upd = (u: string, id: string) => withContext(db, ctx(u, A), (tx) => tx.update(schema.tasks).set({ title: `by ${u}` }).where(eq(schema.tasks.id, id)).returning());
  const del = (u: string, id: string) => withContext(db, ctx(u, A), (tx) => tx.update(schema.tasks).set({ deletedAt: new Date() }).where(eq(schema.tasks.id, id)).returning()); // soft delete: DELETE is revoked from the app role
  it("an agent cannot update or delete someone else's task, but can handle their own", async () => {
    expect(await upd(U.agent2, taskByAgent)).toHaveLength(0);
    expect(await del(U.agent2, taskByAgent)).toHaveLength(0);
    expect(await upd(U.agent, taskByAdmin)).toHaveLength(0);
    expect(await upd(U.agent, taskByAgent)).toHaveLength(1);
  });
  it("admins can handle any task; viewers none", async () => {
    expect(await upd(U.viewer, taskByAgent)).toHaveLength(0);
    expect(await upd(U.admin, taskByAgent)).toHaveLength(1);
    expect(await del(U.admin, taskByAdmin)).toHaveLength(1);
  });
});

describe("activities cannot be forged", () => {
  const add = (u: string, actor: string | null) => withContext(db, ctx(u, A), (tx) => tx.insert(schema.activities).values({ workspaceId: A, contactId: contactA, kind: "contact.deleted", actorUserId: actor, actorType: actor ? "user" : "system" }));
  it("an entry is attributed to the caller or to the system, never to another user", async () => {
    await add(U.agent, U.agent);
    await add(U.agent, null);
    await rejects(add(U.agent, U.owner));
    await rejects(add(U.viewer, U.viewer));
  });
});

describe("transactions", () => {
  it("a failure part-way leaves nothing behind", async () => {
    const before = (await admin.query(`SELECT count(*)::int n FROM contacts WHERE workspace_id=$1`, [A])).rows[0].n;
    await expect(withContext(db, ctx(U.owner, A), async (tx) => {
      await tx.insert(schema.contacts).values({ workspaceId: A, name: "ghost", lifecycleStageId: stageA });
      await tx.execute(sql`SELECT 1/0`);
    })).rejects.toBeTruthy();
    expect((await admin.query(`SELECT count(*)::int n FROM contacts WHERE workspace_id=$1`, [A])).rows[0].n).toBe(before);
    void and;
  });
});
