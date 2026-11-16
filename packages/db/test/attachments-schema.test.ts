import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, schema, withContext, type Db } from "../src/index.ts";

// Inbox attachments (migration 0033): tenant isolation, roles, column grants, guard (immutable content, delete rights, status graph), knowledge cascade.
const NAME = process.env.CRM_DB_NAME ?? "crm";
const url = (u: string, p: string) => `postgres://${u}:${p}@127.0.0.1:5436/${NAME}`;
const run = Date.now().toString(36);
const U = { owner: `at-owner-${run}`, admin: `at-admin-${run}`, agent: `at-agent-${run}`, agent2: `at-agent2-${run}`, viewer: `at-viewer-${run}`, ownerB: `at-ownerb-${run}` };
let app: Db, worker: Db, root: pg.Client;
let A = "", B = "", convA = "", convB = "", msgA = "", msgA2 = "";
const ctx = (userId?: string, workspaceId?: string) => ({ userId, workspaceId });
const q = <T = Record<string, unknown>>(db: Db, c: ReturnType<typeof ctx>, s: ReturnType<typeof sql>) => withContext(db, c, async (tx) => (await tx.execute(s)).rows as T[]);
const rejects = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toMatchObject({ cause: { message: expect.stringMatching(re) } });
const RLS = /row-level security/;
const one = async (text: string, params: unknown[] = []) => (await root.query(text, params)).rows[0];
const SHA = "a".repeat(64);
let n = 0;
const num = () => `${Date.now()}${String(n++).padStart(4, "0")}`;

/** A ready outbound upload as the API writes it. */
const upload = (c: ReturnType<typeof ctx>, ws: string, conv: string, by = c.userId!) => {
  const id = crypto.randomUUID();
  return q<{ id: string }>(app, c, sql`INSERT INTO attachments (id, workspace_id, conversation_id, direction, source, kind, status, mime, size_bytes, sha256, storage_key, created_by)
    VALUES (${id}::uuid, ${ws}::uuid, ${conv}::uuid, 'outbound', 'user_upload', 'image', 'ready', 'image/png', 10, ${SHA}, ${`workspaces/${ws}/attachments/${id}`}, ${by}) RETURNING id`).then((r) => r[0]!.id);
};
/** An inbound pending row as the webhook worker writes it. */
const inboundRow = (ws: string, conv: string, msg: string, mediaId: string) =>
  q<{ id: string }>(worker, ctx(undefined, ws), sql`INSERT INTO attachments (workspace_id, conversation_id, message_id, direction, source, kind, status, provider_media_id) VALUES (${ws}::uuid, ${conv}::uuid, ${msg}::uuid, 'inbound', 'channel_download', 'image', 'pending', ${mediaId}) RETURNING id`).then((r) => r[0]!.id);

beforeAll(async () => {
  root = new pg.Client({ connectionString: process.env.DATABASE_URL_ADMIN ?? url("postgres", "postgres") });
  await root.connect();
  app = createDb(url("crm_app", "app_dev")); worker = createDb(url("crm_worker", "worker_dev"));
  for (const id of Object.values(U)) await root.query(`INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,$1,$2,true) ON CONFLICT (id) DO NOTHING`, [id, `${id}@t.test`]);
  const mk = (owner: string, slug: string) => withContext(app, { userId: owner }, async (tx) => {
    const [w] = await tx.insert(schema.workspaces).values({ name: slug, slug, ownerUserId: owner }).returning();
    await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId: owner, role: "owner" });
    return w!.id;
  });
  A = await mk(U.owner, `at-a-${run}`); B = await mk(U.ownerB, `at-b-${run}`);
  await withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.memberships).values([{ workspaceId: A, userId: U.admin, role: "admin" }, { workspaceId: A, userId: U.agent, role: "agent" }, { workspaceId: A, userId: U.agent2, role: "agent" }, { workspaceId: A, userId: U.viewer, role: "viewer" }]));
  const seed = async (ws: string, owner: string) => {
    const stage = (await one(`INSERT INTO lifecycle_stages(workspace_id,name,position) VALUES ($1,'New',0) RETURNING id`, [ws])).id;
    const contact = (await one(`INSERT INTO contacts(workspace_id,name,lifecycle_stage_id) VALUES ($1,'C',$2) RETURNING id`, [ws, stage])).id;
    const acct = (await one(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id,connected_by) VALUES ($1,'messenger',$2,$3) RETURNING id`, [ws, num(), owner])).id;
    const ident = (await one(`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES ($1,$2,$3,$4) RETURNING id`, [ws, acct, num(), contact])).id;
    const conv = (await one(`INSERT INTO conversations(workspace_id,integration_account_id,identity_id,contact_id) VALUES ($1,$2,$3,$4) RETURNING id`, [ws, acct, ident, contact])).id;
    const msg = (mid: string) => one(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,external_id,sender_kind,body,delivery_state,occurred_at) VALUES ($1,$2,$3,'in',$4,'contact','hi','received',now()) RETURNING id`, [ws, conv, acct, mid]).then((r) => r.id as string);
    return { conv: conv as string, m1: await msg(`m1-${num()}`), m2: await msg(`m2-${num()}`) };
  };
  const a = await seed(A, U.owner), b = await seed(B, U.ownerB);
  convA = a.conv; msgA = a.m1; msgA2 = a.m2; convB = b.conv;
});
afterAll(async () => { await Promise.all([app.$client.end(), worker.$client.end(), root.end()]); });

describe("tenant isolation and roles", () => {
  it("members read their workspace's attachments (viewers included); outsiders and context-less sessions see nothing", async () => {
    const id = await upload(ctx(U.agent, A), A, convA);
    for (const u of [U.owner, U.admin, U.agent, U.viewer]) expect((await q(app, ctx(u, A), sql`SELECT id FROM attachments WHERE id = ${id}::uuid`)).length).toBe(1);
    expect(await q(app, ctx(U.ownerB, B), sql`SELECT id FROM attachments WHERE id = ${id}::uuid`)).toEqual([]);
    expect(await q(app, ctx(U.ownerB, A), sql`SELECT id FROM attachments`)).toEqual([]);
    expect(await q(app, ctx(U.owner), sql`SELECT id FROM attachments`)).toEqual([]);
  });
  it("viewers cannot upload; nobody can upload into another workspace, a foreign conversation or in someone else's name", async () => {
    await rejects(upload(ctx(U.viewer, A), A, convA), RLS);
    await rejects(upload(ctx(U.owner, A), B, convB), RLS);
    await rejects(upload(ctx(U.owner, A), A, convB), /foreign key/);
    await rejects(upload(ctx(U.agent, A), A, convA, U.admin), RLS);
  });
  it("crm_app cannot read the provider url, cannot insert an inbound row and cannot hard-delete", async () => {
    const id = await inboundRow(A, convA, msgA, "wamid-1");
    await rejects(q(app, ctx(U.owner, A), sql`SELECT provider_url FROM attachments WHERE id = ${id}::uuid`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`INSERT INTO attachments (workspace_id, conversation_id, direction, source, kind, status) VALUES (${A}::uuid, ${convA}::uuid, 'inbound', 'channel_download', 'image', 'pending')`), /permission denied|row-level security/);
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM attachments WHERE id = ${id}::uuid`), /permission denied/);
    await expect(root.query(`DELETE FROM attachments WHERE id = $1`, [id])).rejects.toThrow(/soft-deleted/);
  });
  it("the worker only writes inbound pending rows for its own workspace context", async () => {
    await rejects(inboundRow(B, convB, msgA, "x"), /foreign key/); // B's context cannot link a message of A
    await rejects(q(worker, ctx(undefined, A), sql`INSERT INTO attachments (workspace_id, conversation_id, direction, source, kind, status) VALUES (${B}::uuid, ${convB}::uuid, 'inbound', 'channel_download', 'image', 'pending')`), RLS);
  });
});

describe("shape and idempotency", () => {
  it("an inbound row is unique per (message, provider media id); another message may reuse the id", async () => {
    await inboundRow(A, convA, msgA2, "dup-1");
    await rejects(inboundRow(A, convA, msgA2, "dup-1"), /attachments_provider_uq/);
    await inboundRow(A, convA, msgA, "dup-1");
  });
  it("a message can only carry attachments of its own conversation", async () => {
    await rejects(inboundRow(A, convB, msgA, "cross"), /foreign key|row-level security/);
  });
  it("ready needs its content identity; the storage key must follow the layout; direction and source agree", async () => {
    await expect(root.query(`INSERT INTO attachments (workspace_id, conversation_id, direction, source, kind, status, created_by) VALUES ($1,$2,'outbound','user_upload','image','ready',$3)`, [A, convA, U.agent])).rejects.toThrow(/attachments_ready_shape/);
    await expect(root.query(`INSERT INTO attachments (workspace_id, conversation_id, direction, source, kind, status, mime, size_bytes, sha256, storage_key, created_by) VALUES ($1,$2,'outbound','user_upload','image','ready','image/png',1,$3,'../../etc/passwd',$4)`, [A, convA, SHA, U.agent])).rejects.toThrow(/attachments_key/);
    await expect(root.query(`INSERT INTO attachments (workspace_id, conversation_id, direction, source, kind, status) VALUES ($1,$2,'inbound','user_upload','image','pending')`, [A, convA])).rejects.toThrow(/attachments_source_shape/);
    await expect(root.query(`INSERT INTO attachments (workspace_id, conversation_id, direction, source, kind, status) VALUES ($1,$2,'inbound','channel_download','gif','pending')`, [A, convA])).rejects.toThrow(/attachments_kind/);
  });
});

describe("guard", () => {
  it("content identity is immutable once stored, for every role", async () => {
    const id = await upload(ctx(U.agent, A), A, convA);
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE attachments SET sha256 = ${"b".repeat(64)} WHERE id = ${id}::uuid`), /permission denied/);
    await expect(root.query(`UPDATE attachments SET sha256 = $2 WHERE id = $1`, [id, "b".repeat(64)])).rejects.toThrow(/immutable/);
    await expect(root.query(`UPDATE attachments SET storage_key = 'workspaces/x' WHERE id = $1`, [id])).rejects.toThrow(/immutable|attachments_key/);
    await expect(root.query(`UPDATE attachments SET workspace_id = $2 WHERE id = $1`, [id, B])).rejects.toThrow(/identity/);
  });
  it("a message link is set once, never moved", async () => {
    const id = await upload(ctx(U.agent, A), A, convA);
    await q(app, ctx(U.agent, A), sql`UPDATE attachments SET message_id = ${msgA}::uuid WHERE id = ${id}::uuid`);
    await rejects(q(app, ctx(U.agent, A), sql`UPDATE attachments SET message_id = ${msgA2}::uuid WHERE id = ${id}::uuid`), /another message/);
  });
  it("delete rights: owner/admin or the uploading agent; another agent and a viewer cannot (and a deleted row is final)", async () => {
    const del = (u: string, id: string) => q(app, ctx(u, A), sql`UPDATE attachments SET status = 'deleted', deleted_at = now() WHERE id = ${id}::uuid RETURNING id`);
    const a1 = await upload(ctx(U.agent, A), A, convA);
    expect(await del(U.viewer, a1)).toEqual([]); // not even visible to the update policy
    await rejects(del(U.agent2, a1), /only an owner, an admin or the uploader/);
    expect(await del(U.agent, a1)).toHaveLength(1);
    await rejects(del(U.admin, a1), /final/);
    expect(await del(U.admin, await upload(ctx(U.agent, A), A, convA))).toHaveLength(1);
    expect(await del(U.owner, await upload(ctx(U.agent2, A), A, convA))).toHaveLength(1);
  });
  it("worker status graph: pending -> ready/failed/missing; deleted is final", async () => {
    const id = await inboundRow(A, convA, msgA2, `g-${num()}`);
    await q(worker, ctx(undefined, A), sql`UPDATE attachments SET status = 'failed', error_code = 'download_failed' WHERE id = ${id}::uuid`);
    await q(app, ctx(U.agent, A), sql`UPDATE attachments SET status = 'pending', error_code = NULL, attempts = 0 WHERE id = ${id}::uuid`);
    await q(worker, ctx(undefined, A), sql`UPDATE attachments SET status = 'ready', mime = 'image/png', size_bytes = 3, sha256 = ${SHA}, storage_key = ${`workspaces/${A}/attachments/${id}`} WHERE id = ${id}::uuid`);
    await q(worker, ctx(undefined, A), sql`UPDATE attachments SET status = 'missing', error_code = 'blob_missing' WHERE id = ${id}::uuid`);
    await rejects(q(app, ctx(U.agent, A), sql`UPDATE attachments SET status = 'ready' WHERE id = ${id}::uuid`), /not allowed|permission/);
  });
});

describe("due queue and knowledge cascade", () => {
  it("attachments_due lists only pending channel downloads whose retry time has come (ids only)", async () => {
    const id = await inboundRow(A, convA, msgA, `due-${num()}`);
    const later = await inboundRow(A, convA, msgA2, `later-${num()}`);
    await q(worker, ctx(undefined, A), sql`UPDATE attachments SET next_attempt_at = now() + interval '1 hour' WHERE id = ${later}::uuid`);
    const due = (await worker.execute(sql`SELECT workspace_id, id FROM attachments_due(200)`)).rows as { workspace_id: string; id: string }[];
    expect(due.map((r) => r.id)).toContain(id);
    expect(due.map((r) => r.id)).not.toContain(later);
    await rejects(app.execute(sql`SELECT * FROM attachments_due(5)`), /permission denied/);
  });
  it("deleting an attachment soft-deletes knowledge sources that reference it, and removes their passages, even when the deleter holds no knowledge rights", async () => {
    const id = await upload(ctx(U.agent, A), A, convA);
    const src = (await one(`INSERT INTO knowledge_sources(workspace_id,type,title,source_ref,status,body,char_count,chunk_count,created_by) VALUES ($1,'file','Photo text',$2,'ready','secret text',11,1,$3) RETURNING id`, [A, `attachment:${id}`, U.owner])).id;
    await one(`INSERT INTO knowledge_chunks(workspace_id,source_id,position,content,token_estimate) VALUES ($1,$2,0,'secret text',3) RETURNING id`, [A, src]);
    const other = (await one(`INSERT INTO knowledge_sources(workspace_id,type,title,source_ref,status,created_by) VALUES ($1,'file','Other','attachment:other','ready',$2) RETURNING id`, [A, U.owner])).id;
    await q(app, ctx(U.agent, A), sql`UPDATE attachments SET status = 'deleted', deleted_at = now() WHERE id = ${id}::uuid`);
    const s = await one(`SELECT deleted_at, body FROM knowledge_sources WHERE id = $1`, [src]);
    expect(s.deleted_at).not.toBeNull();
    expect(s.body).toBeNull();
    expect((await one(`SELECT count(*)::int AS n FROM knowledge_chunks WHERE source_id = $1`, [src])).n).toBe(0);
    expect((await one(`SELECT deleted_at FROM knowledge_sources WHERE id = $1`, [other])).deleted_at).toBeNull();
  });
});
