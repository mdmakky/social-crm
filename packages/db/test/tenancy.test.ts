import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { createDb, withContext, schema, type Db } from "../src/index.ts";

const ADMIN = process.env.DATABASE_URL_ADMIN ?? "postgres://postgres:postgres@127.0.0.1:5436/crm";
const APP = process.env.DATABASE_URL_APP ?? "postgres://crm_app:app_dev@127.0.0.1:5436/crm";
const run = Date.now().toString(36);
const U = { owner: `u-owner-${run}`, admin: `u-admin-${run}`, agent: `u-agent-${run}`, other: `u-other-${run}` };
let db: Db;
let admin: pg.Client;
let wsId: string;
let otherWs: string;

const msg = (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? e);

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  for (const [k, id] of Object.entries(U)) {
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,$1,$2,true) ON CONFLICT (id) DO NOTHING`, [id, `${k}-${run}@t.example`]);
  }
  db = createDb(APP);
  wsId = (await withContext(db, { userId: U.owner }, async (tx) => {
    const [w] = await tx.insert(schema.workspaces).values({ name: "Acme", slug: `acme-${run}`, ownerUserId: U.owner }).returning();
    await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId: U.owner, role: "owner" });
    return w!.id;
  }));
  otherWs = (await withContext(db, { userId: U.other }, async (tx) => {
    const [w] = await tx.insert(schema.workspaces).values({ name: "Other Co", slug: `other-${run}`, ownerUserId: U.other }).returning();
    await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId: U.other, role: "owner" });
    return w!.id;
  }));
  // owner adds an admin and an agent inside their workspace context
  await withContext(db, { userId: U.owner, workspaceId: wsId }, async (tx) => {
    await tx.insert(schema.memberships).values([
      { workspaceId: wsId, userId: U.admin, role: "admin" },
      { workspaceId: wsId, userId: U.agent, role: "agent" },
    ]);
  });
});
afterAll(async () => {
  await db.$client.end();
  await admin.end();
});

describe("workspaces and memberships RLS", () => {
  it("a user lists only workspaces they belong to", async () => {
    const mine = await withContext(db, { userId: U.owner }, (tx) => tx.select().from(schema.workspaces));
    expect(mine.map((w) => w.slug)).toEqual([`acme-${run}`]);
    const none = await withContext(db, { userId: "nobody" }, (tx) => tx.select().from(schema.workspaces));
    expect(none).toEqual([]);
  });
  it("no context sees nothing", async () => {
    expect(await db.select().from(schema.workspaces)).toEqual([]);
    expect(await db.select().from(schema.memberships)).toEqual([]);
  });
  it("members of a workspace see its member list; outsiders do not", async () => {
    const asAgent = await withContext(db, { userId: U.agent, workspaceId: wsId }, (tx) => tx.select().from(schema.memberships));
    expect(asAgent.map((m) => m.userId).sort()).toEqual([U.admin, U.agent, U.owner].sort());
    const spoof = await withContext(db, { userId: U.other, workspaceId: otherWs }, (tx) => tx.select().from(schema.memberships).where(eq(schema.memberships.workspaceId, wsId)));
    expect(spoof).toEqual([]);
  });
  it("cannot create a workspace owned by someone else", async () => {
    await expect(
      withContext(db, { userId: U.other }, (tx) => tx.insert(schema.workspaces).values({ name: "X", slug: `x-steal-${run}`, ownerUserId: U.owner })),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } });
  });
  it("cannot self-grant owner on someone else's workspace", async () => {
    await expect(
      withContext(db, { userId: U.other }, (tx) => tx.insert(schema.memberships).values({ workspaceId: wsId, userId: U.other, role: "owner" })),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } });
  });
  it("an agent cannot add, change or remove memberships (DB-level)", async () => {
    await expect(
      withContext(db, { userId: U.agent, workspaceId: wsId }, (tx) => tx.insert(schema.memberships).values({ workspaceId: wsId, userId: U.other, role: "viewer" })),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } });
    const upd = await withContext(db, { userId: U.agent, workspaceId: wsId }, (tx) => tx.update(schema.memberships).set({ role: "owner" }).where(eq(schema.memberships.userId, U.agent)).returning());
    expect(upd).toEqual([]);
    const del = await withContext(db, { userId: U.agent, workspaceId: wsId }, (tx) => tx.delete(schema.memberships).where(eq(schema.memberships.userId, U.admin)).returning());
    expect(del).toEqual([]);
  });
  it("an admin can change an agent's role in their own workspace only", async () => {
    const ok = await withContext(db, { userId: U.admin, workspaceId: wsId }, (tx) => tx.update(schema.memberships).set({ role: "viewer" }).where(eq(schema.memberships.userId, U.agent)).returning());
    expect(ok).toHaveLength(1);
    await withContext(db, { userId: U.admin, workspaceId: wsId }, (tx) => tx.update(schema.memberships).set({ role: "agent" }).where(eq(schema.memberships.userId, U.agent)));
    const cross = await withContext(db, { userId: U.admin, workspaceId: wsId }, (tx) => tx.update(schema.memberships).set({ role: "viewer" }).where(eq(schema.memberships.workspaceId, otherWs)).returning());
    expect(cross).toEqual([]);
  });
  it("workspaces cannot be hard-deleted by the app role", async () => {
    await expect(
      withContext(db, { userId: U.owner, workspaceId: wsId }, (tx) => tx.delete(schema.workspaces).where(eq(schema.workspaces.id, wsId))),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
  });
});

describe("audit log", () => {
  it("members can append entries for their workspace and read them back", async () => {
    await withContext(db, { userId: U.owner, workspaceId: wsId }, (tx) => tx.insert(schema.auditLog).values({ workspaceId: wsId, actorUserId: U.owner, action: "workspace.created" }));
    const rows = await withContext(db, { userId: U.owner, workspaceId: wsId }, (tx) => tx.select().from(schema.auditLog));
    expect(rows.map((r) => r.action)).toContain("workspace.created");
  });
  it("cannot append entries to another workspace", async () => {
    await expect(
      withContext(db, { userId: U.owner, workspaceId: wsId }, (tx) => tx.insert(schema.auditLog).values({ workspaceId: otherWs, action: "x" })),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } });
  });
  it("is append-only: update and delete are denied for the app role", async () => {
    await expect(withContext(db, { userId: U.owner, workspaceId: wsId }, (tx) => tx.execute(sql`UPDATE audit_log SET action = 'tampered'`))).rejects.toThrow();
    await expect(withContext(db, { userId: U.owner, workspaceId: wsId }, (tx) => tx.execute(sql`DELETE FROM audit_log`))).rejects.toThrow();
  });
  it("is append-only even for the table owner (trigger)", async () => {
    const owner = new pg.Client({ connectionString: process.env.DATABASE_URL_MIGRATOR ?? "postgres://crm_migrator:migrator_dev@127.0.0.1:5436/crm" });
    await owner.connect();
    await expect(owner.query("UPDATE audit_log SET action = 'tampered'")).rejects.toThrow(/append-only/);
    await owner.end();
  });
});

describe("tenant table policy (CI check)", () => {
  // Tables that are intentionally not tenant-scoped: auth tables and Drizzle bookkeeping.
  const NOT_TENANT = new Set(["user", "session", "account", "verification"]);
  it("every other public table has RLS enabled, forced, at least one policy, and a workspace_id (except the workspaces root)", async () => {
    const { rows } = await admin.query(`
      SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies,
             EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema='public' AND k.table_name=c.relname AND k.column_name='workspace_id') AS has_ws
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`);
    const tenant = rows.filter((r) => !NOT_TENANT.has(r.name));
    expect(tenant.length).toBeGreaterThanOrEqual(3);
    const bad = tenant.filter((r) => !r.rls || !r.forced || r.policies < 1 || (r.name !== "workspaces" && !r.has_ws));
    expect(bad).toEqual([]);
  });
});
