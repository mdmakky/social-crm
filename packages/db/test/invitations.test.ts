import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDb, withContext, schema, type Db } from "../src/index.ts";

const ADMIN = process.env.DATABASE_URL_ADMIN ?? "postgres://postgres:postgres@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm");
const APP = process.env.DATABASE_URL_APP ?? "postgres://crm_app:app_dev@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm");
const run = Date.now().toString(36);
const U = { owner: `i-owner-${run}`, admin: `i-admin-${run}`, agent: `i-agent-${run}`, other: `i-other-${run}`, joiner: `i-joiner-${run}` };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const I = schema.workspaceInvitations;
let db: Db;
let admin: pg.Client;
let ws: string;
let otherWs: string;
let n = 0;
const as = (who: keyof typeof U, workspaceId = ws) => ({ userId: U[who], workspaceId });
const mk = (over: Partial<typeof I.$inferInsert> = {}) => ({ workspaceId: ws, email: `p${n++}-${run}@t.example`, role: "agent" as const, tokenHash: sha(`tok-${run}-${n}`), invitedBy: U.owner, ...over });

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  for (const [k, id] of Object.entries(U)) await admin.query(`INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,$1,$2,true) ON CONFLICT (id) DO NOTHING`, [id, `inv-${k}-${run}@t.example`]);
  db = createDb(APP);
  ws = await withContext(db, { userId: U.owner }, async (tx) => {
    const [w] = await tx.insert(schema.workspaces).values({ name: "Acme", slug: `inv-acme-${run}`, ownerUserId: U.owner }).returning();
    await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId: U.owner, role: "owner" });
    return w!.id;
  });
  otherWs = await withContext(db, { userId: U.other }, async (tx) => {
    const [w] = await tx.insert(schema.workspaces).values({ name: "Other", slug: `inv-other-${run}`, ownerUserId: U.other }).returning();
    await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId: U.other, role: "owner" });
    return w!.id;
  });
  await withContext(db, as("owner"), (tx) => tx.insert(schema.memberships).values([{ workspaceId: ws, userId: U.admin, role: "admin" }, { workspaceId: ws, userId: U.agent, role: "agent" }]));
});
afterAll(async () => {
  await db.$client.end();
  await admin.end();
});

const rls = { cause: { message: expect.stringMatching(/row-level security/) } };

describe("workspace_invitations RLS", () => {
  it("owner/admin create and read; agent cannot read or insert; another workspace sees nothing", async () => {
    const [row] = await withContext(db, as("owner"), (tx) => tx.insert(I).values(mk()).returning());
    expect(row!.status).toBe("pending");
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6.9 * 86_400_000);
    await withContext(db, as("admin"), (tx) => tx.insert(I).values(mk({ invitedBy: U.admin })));
    expect((await withContext(db, as("admin"), (tx) => tx.select().from(I))).length).toBeGreaterThanOrEqual(2);
    expect(await withContext(db, as("agent"), (tx) => tx.select().from(I))).toEqual([]);
    await expect(withContext(db, as("agent"), (tx) => tx.insert(I).values(mk({ invitedBy: U.agent })))).rejects.toMatchObject(rls);
    expect(await withContext(db, as("other", otherWs), (tx) => tx.select().from(I))).toEqual([]);
    expect(await withContext(db, as("other", otherWs), (tx) => tx.select().from(I).where(eq(I.workspaceId, ws)))).toEqual([]);
    expect(await db.select().from(I)).toEqual([]);
    await expect(withContext(db, as("other", otherWs), (tx) => tx.insert(I).values(mk()))).rejects.toMatchObject(rls);
  });
  it("only an owner can create or change an admin invitation; owner role is rejected", async () => {
    await expect(withContext(db, as("admin"), (tx) => tx.insert(I).values(mk({ role: "admin", invitedBy: U.admin })))).rejects.toMatchObject(rls);
    const [a] = await withContext(db, as("owner"), (tx) => tx.insert(I).values(mk({ role: "admin" })).returning());
    expect(await withContext(db, as("admin"), (tx) => tx.update(I).set({ status: "revoked" }).where(eq(I.id, a!.id)).returning())).toEqual([]);
    expect(await withContext(db, as("owner"), (tx) => tx.update(I).set({ status: "revoked" }).where(eq(I.id, a!.id)).returning())).toHaveLength(1);
    await expect(admin.query(`INSERT INTO workspace_invitations(workspace_id,email,role,token_hash,invited_by) VALUES ($1,'o@t.example','owner',$2,$3)`, [ws, sha("o"), U.owner])).rejects.toThrow(/workspace_invitations_role/);
  });
  it("every token_hash must be a SHA-256 hex digest (a raw token is rejected)", async () => {
    await expect(admin.query(`INSERT INTO workspace_invitations(workspace_id,email,role,token_hash,invited_by) VALUES ($1,'raw@t.example','agent','a-raw-token-value',$2)`, [ws, U.owner])).rejects.toThrow(/workspace_invitations_hash/);
    await expect(admin.query(`INSERT INTO workspace_invitations(workspace_id,email,role,token_hash,invited_by) VALUES ($1,'Upper@t.example','agent',$2,$3)`, [ws, sha("u"), U.owner])).rejects.toThrow(/workspace_invitations_email/);
  });
});

describe("workspace_invitations constraints and guard", () => {
  it("one pending invitation per workspace and email; a new one is fine after revoke", async () => {
    const v = mk();
    const [first] = await withContext(db, as("owner"), (tx) => tx.insert(I).values(v).returning());
    await expect(withContext(db, as("owner"), (tx) => tx.insert(I).values({ ...v, tokenHash: sha("other-" + run + n) }))).rejects.toMatchObject({ cause: { code: "23505" } });
    await withContext(db, as("owner"), (tx) => tx.update(I).set({ status: "revoked" }).where(eq(I.id, first!.id)));
    await withContext(db, as("owner"), (tx) => tx.insert(I).values({ ...v, tokenHash: sha("again-" + run + n) }));
  });
  it("identity is immutable, final states are final, the app role cannot accept, a lapsed one cannot be accepted", async () => {
    const [r] = await withContext(db, as("owner"), (tx) => tx.insert(I).values(mk()).returning());
    // column grants already forbid these for the app role
    await expect(withContext(db, as("owner"), (tx) => tx.update(I).set({ email: "x@t.example" } as never).where(eq(I.id, r!.id)))).rejects.toThrow();
    await expect(withContext(db, as("owner"), (tx) => tx.update(I).set({ role: "viewer" } as never).where(eq(I.id, r!.id)))).rejects.toThrow();
    await expect(withContext(db, as("owner"), (tx) => tx.update(I).set({ status: "accepted" }).where(eq(I.id, r!.id)))).rejects.toThrow();
    // the table owner is bound by the trigger too
    await expect(admin.query(`UPDATE workspace_invitations SET email='x@t.example' WHERE id=$1`, [r!.id])).rejects.toThrow(/cannot change its identity/);
    await expect(admin.query(`UPDATE workspace_invitations SET role='viewer' WHERE id=$1`, [r!.id])).rejects.toThrow(/cannot change its identity/);
    await expect(withContext(db, as("owner"), (tx) => tx.update(I).set({ status: "revoked", tokenHash: sha("new-" + run) }).where(eq(I.id, r!.id)))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/keeps its token/) } });
    await expect(withContext(db, as("owner"), (tx) => tx.update(I).set({ tokenHash: sha("rot-" + run) }).where(eq(I.id, r!.id)))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/later expiry/) } });
    await withContext(db, as("owner"), (tx) => tx.update(I).set({ tokenHash: sha("rot-" + run), expiresAt: new Date(Date.now() + 8 * 86_400_000) }).where(eq(I.id, r!.id)));
    await expect(withContext(db, as("owner"), (tx) => tx.update(I).set({ status: "expired" }).where(eq(I.id, r!.id)))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/only a lapsed/) } });
    await withContext(db, as("owner"), (tx) => tx.update(I).set({ status: "revoked" }).where(eq(I.id, r!.id)));
    await expect(withContext(db, as("owner"), (tx) => tx.update(I).set({ status: "pending" }).where(eq(I.id, r!.id)))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/is final/) } });
    await expect(admin.query(`UPDATE workspace_invitations SET status='pending' WHERE id=$1`, [r!.id])).rejects.toThrow(/is final/);
  });
  it("invitation_accept creates the membership once and rejects a wrong email; preview returns no raw secret", async () => {
    const raw = `raw-${run}`;
    const email = `joiner-${run}@t.example`;
    const [r] = await withContext(db, as("owner"), (tx) => tx.insert(I).values(mk({ email, tokenHash: sha(raw), role: "viewer" })).returning());
    const accept = (hash: string, user: string, mail: string) => withContext(db, { userId: user }, async (tx) => (await tx.execute(sql`SELECT * FROM invitation_accept(${hash}, ${user}, ${mail})`)).rows[0] as { outcome: string; workspace_id: string | null; role: string | null });
    expect((await accept(sha(raw), U.other, `other-${run}@t.example`))?.outcome).toBe("wrong_email");
    expect(await accept(sha("nope"), U.joiner, email)).toMatchObject({ outcome: "not_found" });
    expect(await accept(sha(raw), U.joiner, email.toUpperCase())).toMatchObject({ outcome: "accepted", workspace_id: ws, role: "viewer" });
    expect(await accept(sha(raw), U.joiner, email)).toMatchObject({ outcome: "already" });
    expect((await accept(sha(raw), U.other, `other-${run}@t.example`))?.outcome).toBe("not_found");
    const { rows } = await admin.query(`SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2`, [ws, U.joiner]);
    expect(rows).toEqual([{ role: "viewer" }]);
    const { rows: inv } = await admin.query(`SELECT status, accepted_by FROM workspace_invitations WHERE id=$1`, [r!.id]);
    expect(inv[0]).toEqual({ status: "accepted", accepted_by: U.joiner });
    const pv = (await withContext(db, {}, (tx) => tx.execute(sql`SELECT * FROM invitation_preview(${sha(raw)})`))).rows[0] as Record<string, unknown>;
    expect(Object.keys(pv).sort()).toEqual(["email", "expires_at", "inviter_name", "role", "status", "workspace_name"]);
    // the definer functions are not a way to read or write tables directly
    await expect(withContext(db, as("agent"), (tx) => tx.execute(sql`INSERT INTO memberships(workspace_id,user_id,role) VALUES (${ws}, ${U.other}, 'viewer')`))).rejects.toThrow();
  });
  it("caps pending invitations at 100 per workspace", async () => {
    const w = await withContext(db, { userId: U.other }, async (tx) => {
      const [x] = await tx.insert(schema.workspaces).values({ name: "Cap", slug: `inv-cap-${run}`, ownerUserId: U.other }).returning();
      await tx.insert(schema.memberships).values({ workspaceId: x!.id, userId: U.other, role: "owner" });
      return x!.id;
    });
    await admin.query(`INSERT INTO workspace_invitations(workspace_id,email,role,token_hash,invited_by) SELECT $1, 'c'||g||'@t.example','agent',encode(sha256(($3||g)::bytea),'hex'),$2 FROM generate_series(1,100) g`, [w, U.other, `cap-${run}-`]);
    await expect(withContext(db, { userId: U.other, workspaceId: w }, (tx) => tx.insert(I).values({ workspaceId: w, email: "c101@t.example", role: "agent", tokenHash: sha("c101"), invitedBy: U.other }))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/too many pending/) } });
  });
});
