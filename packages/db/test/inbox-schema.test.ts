import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, schema, withContext, type Db } from "../src/index.ts";

// Meta Inbox slice 1: constraints, composite FKs, forced RLS per role, column grants, secret protection, state graph, ingress role, purge, concurrency.
const NAME = process.env.CRM_DB_NAME ?? "crm";
const url = (u: string, p: string) => `postgres://${u}:${p}@127.0.0.1:5436/${NAME}`;
const ADMIN = process.env.DATABASE_URL_ADMIN ?? url("postgres", "postgres");
const run = Date.now().toString(36);
const U = { owner: `ib-owner-${run}`, admin: `ib-admin-${run}`, agent: `ib-agent-${run}`, viewer: `ib-viewer-${run}`, ownerB: `ib-ownerb-${run}` };
let app: Db, ingest: Db, worker: Db, root: pg.Client;
let A = "", B = "", acctA = "", acctA2 = "", acctB = "", identA = "", identA2 = "", convA = "", contactA = "", contactB = "";
let page = 0;
const ctx = (userId?: string, workspaceId?: string) => ({ userId, workspaceId });
const denied = /row-level security|permission denied/;
const rejects = (p: Promise<unknown>, re: RegExp = denied) => expect(p).rejects.toMatchObject({ cause: { message: expect.stringMatching(re) } });
const q = <T = Record<string, unknown>>(db: Db, c: ReturnType<typeof ctx>, s: ReturnType<typeof sql>) => withContext(db, c, async (tx) => (await tx.execute(s)).rows as T[]);
const fresh = (p = "p") => `${p}-${run}-${page++}`;

/** Superuser inserts (constraints and triggers still apply; RLS does not). */
const one = async (text: string, params: unknown[] = []) => (await root.query(text, params)).rows[0];
const badInsert = (text: string, params: unknown[], re: RegExp) => expect(root.query(text, params)).rejects.toThrow(re);

async function mkAccount(ws: string, owner: string, platform = "messenger") {
  return (await withContext(app, ctx(owner, ws), (tx) => tx.insert(schema.integrationAccounts).values({ workspaceId: ws, platform, externalAccountId: fresh("page"), connectedBy: owner }).returning()))[0]!.id;
}
async function mkIdentity(ws: string, acct: string, contact: string) {
  return (await one(`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES ($1,$2,$3,$4) RETURNING id`, [ws, acct, fresh("psid"), contact])).id as string;
}
async function mkConv(ws: string, acct: string, ident: string, contact: string) {
  return (await one(`INSERT INTO conversations(workspace_id,integration_account_id,identity_id,contact_id) VALUES ($1,$2,$3,$4) RETURNING id`, [ws, acct, ident, contact])).id as string;
}
const inbound = (ws: string, conv: string, acct: string, mid = fresh("mid")) => root.query(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,external_id,sender_kind,body,delivery_state,occurred_at) VALUES ($1,$2,$3,'in',$4,'contact','hi','received',now()) RETURNING id`, [ws, conv, acct, mid]);
async function outbound(state = "pending", by = U.agent) {
  return (await one(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,client_msg_id,sender_kind,sender_user_id,body,delivery_state,occurred_at) VALUES ($1,$2,$3,'out',gen_random_uuid(),'user',$4,'hello',$5,now()) RETURNING id`, [A, convA, acctA, by, state])).id as string;
}
const setState = (db: Db, c: ReturnType<typeof ctx>, id: string, st: string) => q(db, c, sql`UPDATE messages SET delivery_state = ${st} WHERE id = ${id}`);

beforeAll(async () => {
  root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  app = createDb(url("crm_app", "app_dev")); ingest = createDb(url("crm_ingest", "ingest_dev")); worker = createDb(url("crm_worker", "worker_dev"));
  for (const id of Object.values(U)) await root.query(`INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,$1,$2,true) ON CONFLICT (id) DO NOTHING`, [id, `${id}@t.test`]);
  const mk = (owner: string, slug: string) => withContext(app, { userId: owner }, async (tx) => {
    const [w] = await tx.insert(schema.workspaces).values({ name: slug, slug, ownerUserId: owner }).returning();
    await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId: owner, role: "owner" });
    return w!.id;
  });
  A = await mk(U.owner, `ib-a-${run}`); B = await mk(U.ownerB, `ib-b-${run}`);
  await withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.memberships).values([{ workspaceId: A, userId: U.admin, role: "admin" }, { workspaceId: A, userId: U.agent, role: "agent" }, { workspaceId: A, userId: U.viewer, role: "viewer" }]));
  const stageA = (await one(`INSERT INTO lifecycle_stages(workspace_id,name,position) VALUES ($1,'New',0) RETURNING id`, [A])).id;
  const stageB = (await one(`INSERT INTO lifecycle_stages(workspace_id,name,position) VALUES ($1,'New',0) RETURNING id`, [B])).id;
  contactA = (await one(`INSERT INTO contacts(workspace_id,name,lifecycle_stage_id) VALUES ($1,'Ann',$2) RETURNING id`, [A, stageA])).id;
  contactB = (await one(`INSERT INTO contacts(workspace_id,name,lifecycle_stage_id) VALUES ($1,'Bob',$2) RETURNING id`, [B, stageB])).id;
  acctA = await mkAccount(A, U.owner); acctA2 = await mkAccount(A, U.owner, "instagram"); acctB = await mkAccount(B, U.ownerB);
  identA = await mkIdentity(A, acctA, contactA); identA2 = await mkIdentity(A, acctA2, contactA);
  convA = await mkConv(A, acctA, identA, contactA);
});
afterAll(async () => { await Promise.all([app.$client.end(), ingest.$client.end(), worker.$client.end(), root.end()]); });

describe("constraints and composite foreign keys", () => {
  it("platform, status and external id are validated", async () => {
    await badInsert(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES ($1,'tiktok','x')`, [A], /integration_accounts_platform/);
    await badInsert(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id,status) VALUES ($1,'messenger','x','paused')`, [A], /integration_accounts_status/);
    await badInsert(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES ($1,'messenger','')`, [A], /integration_accounts_external_id/);
  });
  it("(platform, external_account_id) is globally unique across workspaces (D-F); the same id on another platform is a different account", async () => {
    const ext = fresh("shared");
    await root.query(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES ($1,'messenger',$2)`, [A, ext]);
    await badInsert(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES ($1,'messenger',$2)`, [B, ext], /integration_accounts_platform_external/);
    await root.query(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES ($1,'instagram',$2)`, [B, ext]);
  });
  it("identities, conversations and messages cannot cross workspaces or accounts", async () => {
    await badInsert(`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES ($1,$2,'x',$3)`, [A, acctB, contactA], /foreign key/); // account of another workspace
    await badInsert(`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES ($1,$2,'x',$3)`, [A, acctA, contactB], /foreign key/); // contact of another workspace
    await badInsert(`INSERT INTO conversations(workspace_id,integration_account_id,identity_id,contact_id) VALUES ($1,$2,$3,$4)`, [A, acctA, identA2, contactA], /foreign key/); // identity belongs to another account
    await badInsert(`INSERT INTO conversations(workspace_id,integration_account_id,identity_id,contact_id) VALUES ($1,$2,$3,$4)`, [B, acctB, identA, contactB], /foreign key/);
    await badInsert(`INSERT INTO conversations(workspace_id,integration_account_id,identity_id,contact_id) VALUES ($1,$2,$3,$4)`, [A, acctA, identA, contactA], /conversations_account_identity/); // one conversation per identity
    await badInsert(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,external_id,sender_kind,body,delivery_state,occurred_at) VALUES ($1,$2,$3,'in','m','contact','x','received',now())`, [B, convA, acctB], /foreign key/);
    await badInsert(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,external_id,sender_kind,body,delivery_state,occurred_at) VALUES ($1,$2,$3,'in','m','contact','x','received',now())`, [A, convA, acctA2], /foreign key/); // message account differs from its conversation's account
  });
  it("message shape: inbound is received from the contact with an external id; outbound is never 'received'; content is required and bounded", async () => {
    const base = (dir: string, st: string, kind: string, ext: string | null, body: string | null, cm: string | null = null, by: string | null = null) =>
      root.query(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,external_id,client_msg_id,sender_kind,sender_user_id,body,delivery_state,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`, [A, convA, acctA, dir, ext, cm, kind, by, body, st]);
    await expect(base("in", "received", "contact", null, "x")).rejects.toThrow(/messages_direction_shape/);
    await expect(base("in", "pending", "contact", fresh("m"), "x")).rejects.toThrow(/messages_direction_shape/);
    await expect(base("out", "received", "user", null, "x", crypto.randomUUID(), U.agent)).rejects.toThrow(/messages_direction_shape/);
    await expect(base("out", "pending", "contact", null, "x")).rejects.toThrow(/messages_direction_shape/);
    await expect(base("out", "pending", "user", null, "x", crypto.randomUUID(), null)).rejects.toThrow(/messages_user_sender/);
    await expect(base("in", "received", "contact", fresh("m"), null)).rejects.toThrow(/messages_content/);
    await expect(base("in", "received", "contact", fresh("m"), "x".repeat(20001))).rejects.toThrow(/messages_body_len/);
    await expect(root.query(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,external_id,sender_kind,attachments,delivery_state,occurred_at) VALUES ($1,$2,$3,'in',$4,'contact','{"a":1}','received',now())`, [A, convA, acctA, fresh("m")])).rejects.toThrow(/messages_attachments|invalid input|messages_content/);
    await base("in", "received", "contact", fresh("m"), "fine");
  });
  it("a platform message id is unique per account and a client message id per workspace", async () => {
    const mid = fresh("dup");
    await inbound(A, convA, acctA, mid);
    await expect(inbound(A, convA, acctA, mid)).rejects.toThrow(/messages_account_external_uq/);
    const cm = crypto.randomUUID();
    const ins = (ws: string, conv: string, acct: string) => root.query(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,client_msg_id,sender_kind,sender_user_id,body,delivery_state,occurred_at) VALUES ($1,$2,$3,'out',$4,'user',$5,'x','pending',now())`, [ws, conv, acct, cm, U.agent]);
    await ins(A, convA, acctA);
    await expect(ins(A, convA, acctA)).rejects.toThrow(/messages_ws_client_msg_uq/);
  });
  it("webhook events: a bad signature can only be a rejected row without a body; bodies are bounded; secrets are shape-checked", async () => {
    const ins = (valid: boolean, status: string, body: Buffer | null, size: number, purged: string | null = null) =>
      root.query(`INSERT INTO webhook_events(platform,signature_valid,raw_body,body_size,status,body_purged_at) VALUES ('messenger',$1,$2,$3,$4,$5)`, [valid, body, size, status, purged]);
    await expect(ins(false, "received", Buffer.from("{}"), 2)).rejects.toThrow(/webhook_events_signature/);
    await expect(ins(false, "processed", null, 2)).rejects.toThrow(/webhook_events_(signature|body_present)/);
    await ins(false, "rejected", null, 2);
    await expect(ins(true, "received", null, 2)).rejects.toThrow(/webhook_events_body_present/);
    await expect(ins(true, "received", Buffer.alloc(1048577), 1048577)).rejects.toThrow(/webhook_events_body_size|webhook_events_body_limit/);
    await ins(true, "received", Buffer.from("{}"), 2);
    await expect(root.query(`INSERT INTO integration_secrets(workspace_id,integration_account_id,version,ciphertext,nonce,key_id) VALUES ($1,$2,1,$3,$4,'k1')`, [A, acctA, Buffer.alloc(32), Buffer.alloc(8)])).rejects.toThrow(/integration_secrets_nonce_len/);
    await expect(root.query(`INSERT INTO integration_secrets(workspace_id,integration_account_id,version,ciphertext,nonce,key_id) VALUES ($1,$2,1,$3,$4,'k1')`, [A, acctA, Buffer.alloc(3), Buffer.alloc(12)])).rejects.toThrow(/integration_secrets_ciphertext_len/);
  });
});

describe("integration accounts: RLS by role", () => {
  it("every role reads its workspace; only owner/admin connect or change; nobody deletes; other workspaces see nothing", async () => {
    for (const u of [U.owner, U.admin, U.agent, U.viewer]) expect((await q(app, ctx(u, A), sql`SELECT id FROM integration_accounts`)).length).toBeGreaterThanOrEqual(2);
    expect(await q(app, ctx(U.ownerB, B), sql`SELECT id FROM integration_accounts WHERE workspace_id = ${A}`)).toEqual([]);
    for (const u of [U.agent, U.viewer]) await rejects(q(app, ctx(u, A), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES (${A},'messenger',${fresh("x")})`));
    await q(app, ctx(U.admin, A), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES (${A},'messenger',${fresh("x")})`);
    await rejects(q(app, ctx(U.ownerB, B), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES (${A},'messenger',${fresh("x")})`)); // cannot write into another workspace
    expect(await q(app, ctx(U.agent, A), sql`UPDATE integration_accounts SET status = 'disabled' WHERE id = ${acctA} RETURNING id`)).toEqual([]);
    expect(await q(app, ctx(U.admin, A), sql`UPDATE integration_accounts SET status = 'reauth_required' WHERE id = ${acctA} RETURNING id`)).toHaveLength(1);
    await q(app, ctx(U.admin, A), sql`UPDATE integration_accounts SET status = 'connected' WHERE id = ${acctA}`);
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM integration_accounts WHERE id = ${acctA}`));
  });
  it("an account cannot be moved to another workspace or renamed (the routing key is immutable)", async () => {
    await expect(root.query(`UPDATE integration_accounts SET workspace_id = $1 WHERE id = $2`, [B, acctA])).rejects.toThrow();
    await expect(root.query(`UPDATE integration_accounts SET external_account_id = 'other' WHERE id = $1`, [acctA])).rejects.toThrow(/cannot change workspace, platform or external id/);
    await rejects(q(app, ctx(U.admin, A), sql`UPDATE integration_accounts SET external_account_id = 'other' WHERE id = ${acctA}`), /cannot change workspace, platform or external id/);
  });
  it("global uniqueness holds through the application role: a second workspace cannot connect the same Page", async () => {
    const ext = fresh("claimed");
    await q(app, ctx(U.owner, A), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES (${A},'messenger',${ext})`);
    await expect(q(app, ctx(U.ownerB, B), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES (${B},'messenger',${ext})`)).rejects.toMatchObject({ cause: { code: "23505" } });
  });
});

describe("integration secrets are never readable by the application role", () => {
  it("owner/admin can store a secret; agents and viewers cannot; the app role has no SELECT, UPDATE or DELETE even as owner", async () => {
    const ins = (u: string, ws: string, acct: string, v: number) => q(app, ctx(u, ws), sql`INSERT INTO integration_secrets(workspace_id,integration_account_id,version,ciphertext,nonce,key_id) VALUES (${ws},${acct},${v},decode(repeat('ab',32),'hex'),decode(repeat('01',12),'hex'),'k1')`);
    await ins(U.admin, A, acctA, 1);
    for (const u of [U.agent, U.viewer]) await rejects(ins(u, A, acctA, 2));
    await rejects(ins(U.ownerB, B, acctA, 2), /foreign key|row-level security/); // another workspace's account
    for (const u of [U.owner, U.admin]) {
      await rejects(q(app, ctx(u, A), sql`SELECT * FROM integration_secrets`));
      await rejects(q(app, ctx(u, A), sql`SELECT count(*) FROM integration_secrets`));
      await rejects(q(app, ctx(u, A), sql`UPDATE integration_secrets SET key_id = 'x'`));
      await rejects(q(app, ctx(u, A), sql`DELETE FROM integration_secrets`));
    }
    await rejects(q(app, ctx(U.owner, A), sql`INSERT INTO integration_secrets(workspace_id,integration_account_id,version,ciphertext,nonce,key_id) VALUES (${A},${acctA},3,decode(repeat('ab',32),'hex'),decode(repeat('01',12),'hex'),'k1') RETURNING id`)); // RETURNING needs SELECT
  });
  it("the ingress role cannot read secrets either; the worker reads only inside the workspace context and can rotate", async () => {
    await rejects(q(ingest, ctx(), sql`SELECT * FROM integration_secrets`));
    expect((await q(worker, ctx(undefined, A), sql`SELECT version FROM integration_secrets`)).map((r) => (r as { version: number }).version)).toContain(1);
    expect(await q(worker, ctx(undefined, B), sql`SELECT version FROM integration_secrets`)).toEqual([]);
    expect(await q(worker, ctx(), sql`SELECT version FROM integration_secrets`)).toEqual([]);
    await q(worker, ctx(undefined, A), sql`INSERT INTO integration_secrets(workspace_id,integration_account_id,version,ciphertext,nonce,key_id) VALUES (${A},${acctA},9,decode(repeat('cd',32),'hex'),decode(repeat('02',12),'hex'),'k2')`);
    await q(worker, ctx(undefined, A), sql`DELETE FROM integration_secrets WHERE version = 1`);
    await rejects(q(worker, ctx(undefined, B), sql`INSERT INTO integration_secrets(workspace_id,integration_account_id,version,ciphertext,nonce,key_id) VALUES (${A},${acctA},10,decode(repeat('cd',32),'hex'),decode(repeat('02',12),'hex'),'k2')`)); // context says B, row says A
    await expect(root.query(`INSERT INTO integration_secrets(workspace_id,integration_account_id,version,ciphertext,nonce,key_id) VALUES ($1,$2,11,decode(repeat('ab',32),'hex'),decode(repeat('01',12),'hex'),'k1')`, [B, acctA])).rejects.toThrow(/foreign key/); // a secret cannot point at another workspace's account
  });
});

describe("conversations, identities and messages: RLS by role and column grants", () => {
  it("the app role reads by workspace but cannot create conversations or identities; agents update status/assignee only", async () => {
    for (const u of [U.owner, U.admin, U.agent, U.viewer]) expect((await q(app, ctx(u, A), sql`SELECT id FROM conversations`)).length).toBeGreaterThanOrEqual(1);
    expect(await q(app, ctx(U.ownerB, B), sql`SELECT id FROM conversations WHERE workspace_id = ${A}`)).toEqual([]);
    expect(await q(app, ctx(U.ownerB, B), sql`SELECT id FROM platform_identities WHERE workspace_id = ${A}`)).toEqual([]);
    await rejects(q(app, ctx(U.owner, A), sql`INSERT INTO conversations(workspace_id,integration_account_id,identity_id,contact_id) VALUES (${A},${acctA2},${identA2},${contactA})`));
    await rejects(q(app, ctx(U.owner, A), sql`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES (${A},${acctA},'z',${contactA})`));
    expect(await q(app, ctx(U.agent, A), sql`UPDATE conversations SET status = 'pending', assignee_user_id = ${U.agent} WHERE id = ${convA} RETURNING id`)).toHaveLength(1);
    expect(await q(app, ctx(U.viewer, A), sql`UPDATE conversations SET status = 'open' WHERE id = ${convA} RETURNING id`)).toEqual([]);
    await rejects(q(app, ctx(U.agent, A), sql`UPDATE conversations SET unread_count = 0 WHERE id = ${convA}`)); // worker-owned column
    await rejects(q(app, ctx(U.agent, A), sql`UPDATE conversations SET contact_id = ${contactA} WHERE id = ${convA}`));
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM conversations WHERE id = ${convA}`));
    await expect(root.query(`UPDATE conversations SET identity_id = $1 WHERE id = $2`, [identA2, convA])).rejects.toThrow();
  });
  it("the worker creates conversations only inside the matching workspace context", async () => {
    const id = await q(worker, ctx(undefined, A), sql`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES (${A},${acctA2},${fresh("w")},${contactA}) RETURNING id`);
    expect(id).toHaveLength(1);
    await rejects(q(worker, ctx(undefined, B), sql`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES (${A},${acctA2},${fresh("w")},${contactA})`));
    await rejects(q(worker, ctx(), sql`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES (${A},${acctA2},${fresh("w")},${contactA})`));
  });
  it("outbound insert by the app: pending, from a writer, as themselves, with a client message id; nothing else", async () => {
    const ins = (u: string, extra = "'out','pending','user'", sender = U.agent, ext = "NULL", cm = "gen_random_uuid()") =>
      q(app, ctx(u, A), sql.raw(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,delivery_state,sender_kind,sender_user_id,external_id,client_msg_id,body,occurred_at) VALUES ('${A}','${convA}','${acctA}',${extra},'${sender}',${ext},${cm},'hello',now())`));
    await ins(U.agent);
    await ins(U.owner, "'out','pending','user'", U.owner);
    await rejects(ins(U.viewer, "'out','pending','user'", U.viewer));
    await rejects(ins(U.agent, "'out','pending','user'", U.admin)); // as someone else
    await rejects(ins(U.agent, "'in','received','contact'", U.agent, "'forged'")); // forging an inbound message
    await rejects(ins(U.agent, "'out','sent','user'")); // skipping the state graph
    await rejects(ins(U.agent, "'out','pending','user'", U.agent, "'mid.1'")); // claiming a platform id
    await rejects(ins(U.agent, "'out','pending','user'", U.agent, "NULL", "NULL")); // no idempotency key
    expect(await q(app, ctx(U.ownerB, B), sql`SELECT id FROM messages WHERE workspace_id = ${A}`)).toEqual([]);
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM messages`));
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE messages SET body = 'edited'`));
  });
  it("delivery state graph per role: app resolves unknown and retries failed; worker drives pending, sending, sent, failed, unknown; sent is final", async () => {
    const m1 = await outbound("unknown");
    await rejects(setState(app, ctx(U.agent, A), m1, "pending"), /not allowed for role crm_app/);
    expect(await setState(app, ctx(U.agent, A), m1, "sent")).toEqual([]);
    await rejects(setState(app, ctx(U.agent, A), m1, "failed"), /not allowed/); // sent is final
    const m2 = await outbound("unknown");
    await setState(app, ctx(U.agent, A), m2, "failed");
    const m3 = await outbound("pending");
    await rejects(setState(app, ctx(U.agent, A), m3, "sent"), /not allowed for role crm_app/); // the app role cannot claim a send happened
    await rejects(setState(app, ctx(U.agent, A), m3, "sending"), /not allowed for role crm_app/);
    await setState(worker, ctx(undefined, A), m3, "sending");
    await rejects(setState(worker, ctx(undefined, A), m3, "pending"), /not allowed for role crm_worker/);
    await setState(worker, ctx(undefined, A), m3, "unknown");
    await rejects(setState(worker, ctx(undefined, A), m3, "sending"), /not allowed/); // never resent automatically
    await setState(worker, ctx(undefined, A), m3, "sent");
    const m4 = await outbound("failed");
    await rejects(setState(worker, ctx(undefined, A), m4, "pending"), /not allowed for role crm_worker/); // retry is a human action
    await q(app, ctx(U.agent, A), sql`UPDATE messages SET delivery_state = 'pending', client_msg_id = gen_random_uuid() WHERE id = ${m4}`);
    const m5 = await outbound("pending");
    await expect(root.query(`UPDATE messages SET delivery_state = 'sent' WHERE id = $1`, [m5])).rejects.toThrow(/not allowed/); // even a superuser cannot skip the graph
    await q(worker, ctx(undefined, A), sql`UPDATE messages SET delivery_state = 'failed', failure_code = 'token' WHERE id = ${m5}`); // refused before any request
    const inboundId = (await inbound(A, convA, acctA)).rows[0].id;
    await expect(root.query(`UPDATE messages SET delivery_state = 'sending' WHERE id = $1`, [inboundId])).rejects.toThrow(/not allowed/);
  });
  it("message content and identity are immutable; the platform id is set once; the client id changes only on retry", async () => {
    const m = await outbound("pending");
    await expect(root.query(`UPDATE messages SET body = 'x' WHERE id = $1`, [m])).rejects.toThrow(/immutable/);
    await expect(root.query(`UPDATE messages SET conversation_id = $2 WHERE id = $1`, [m, convA])).resolves.toBeDefined(); // same value is not a change
    await expect(root.query(`UPDATE messages SET client_msg_id = gen_random_uuid() WHERE id = $1`, [m])).rejects.toThrow(/client message id/);
    await q(worker, ctx(undefined, A), sql`UPDATE messages SET delivery_state = 'sending' WHERE id = ${m}`);
    await q(worker, ctx(undefined, A), sql`UPDATE messages SET external_id = ${fresh("mid")}, delivery_state = 'sent', sent_at = now() WHERE id = ${m}`);
    await expect(root.query(`UPDATE messages SET external_id = 'other' WHERE id = $1`, [m])).rejects.toThrow(/immutable once set/);
    await expect(root.query(`DELETE FROM messages WHERE id = $1`, [m])).rejects.toThrow(/never deleted/);
    await expect(root.query(`TRUNCATE messages`)).rejects.toThrow(/never deleted|cannot truncate/);
  });
  it("read markers are personal", async () => {
    await q(app, ctx(U.agent, A), sql`INSERT INTO conversation_reads(workspace_id,conversation_id,user_id) VALUES (${A},${convA},${U.agent})`);
    await rejects(q(app, ctx(U.agent, A), sql`INSERT INTO conversation_reads(workspace_id,conversation_id,user_id) VALUES (${A},${convA},${U.admin})`));
    expect(await q(app, ctx(U.admin, A), sql`SELECT * FROM conversation_reads`)).toEqual([]);
  });
});

describe("webhook ingress role and raw body retention", () => {
  const ev = (ws: string | null = null, status = "received") => q(ingest, ctx(), sql.raw(`INSERT INTO webhook_events(id,platform,signature_valid,raw_body,body_size,status,workspace_id) VALUES (uuidv7(),'messenger',true,'\\x7b7d',2,'${status}',${ws ? `'${ws}'` : "NULL"})`));
  it("the ingress role can insert unrouted events only, cannot read them back or touch anything else, and sees only the routing columns of accounts", async () => {
    await ev();
    await ev(null, "orphan");
    await rejects(ev(A)); // it never decides the workspace
    await rejects(ev(null, "processed"));
    await rejects(q(ingest, ctx(), sql`SELECT * FROM webhook_events`));
    await rejects(q(ingest, ctx(), sql`UPDATE webhook_events SET status = 'processed'`));
    for (const t of ["messages", "conversations", "contacts", "workspaces", "memberships", "tasks", "leads", "integration_secrets", "platform_identities"]) await rejects(q(ingest, ctx(), sql.raw(`SELECT 1 FROM ${t} LIMIT 1`)));
    const route = await q(ingest, ctx(), sql`SELECT id, workspace_id, platform, external_account_id, status FROM integration_accounts WHERE platform = 'messenger' AND external_account_id = (SELECT external_account_id FROM integration_accounts LIMIT 1)`).catch((e) => e);
    expect(Array.isArray(route)).toBe(true);
    await rejects(q(ingest, ctx(), sql`SELECT display_name FROM integration_accounts`));
    await rejects(q(ingest, ctx(), sql`SELECT connected_by FROM integration_accounts`));
    await rejects(q(ingest, ctx(), sql`UPDATE integration_accounts SET status = 'disabled'`));
  });
  it("the worker routes and processes events within the status graph; it can purge a body but never rewrite it", async () => {
    const id = (await one(`INSERT INTO webhook_events(platform,signature_valid,raw_body,body_size,account_ref) VALUES ('messenger',true,'\\x7b7d',2,'p') RETURNING id`)).id as string;
    await q(worker, ctx(), sql`UPDATE webhook_events SET workspace_id = ${A}, status = 'processed', processed_at = now() WHERE id = ${id}`);
    await rejects(q(worker, ctx(), sql`UPDATE webhook_events SET status = 'received' WHERE id = ${id}`), /not allowed/);
    await rejects(q(worker, ctx(), sql`UPDATE webhook_events SET workspace_id = ${B} WHERE id = ${id}`), /cannot move/);
    await rejects(q(worker, ctx(), sql`UPDATE webhook_events SET raw_body = '\\x00' WHERE id = ${id}`), /only be purged/);
    await rejects(q(worker, ctx(), sql`UPDATE webhook_events SET signature_valid = false WHERE id = ${id}`)); // not a column the worker may change
    await rejects(q(worker, ctx(), sql`DELETE FROM webhook_events WHERE id = ${id}`));
    const failed = (await one(`INSERT INTO webhook_events(platform,signature_valid,raw_body,body_size) VALUES ('messenger',true,'\\x7b7d',2) RETURNING id`)).id as string;
    await q(worker, ctx(), sql`UPDATE webhook_events SET status = 'failed', attempts = 1, last_error = 'parse' WHERE id = ${failed}`);
    await q(worker, ctx(), sql`UPDATE webhook_events SET status = 'received' WHERE id = ${failed}`); // replay
  });
  it("the API shows an admin the metadata of its own workspace's events, never the raw body, and nothing to agents or other workspaces", async () => {
    const id = (await one(`INSERT INTO webhook_events(platform,signature_valid,raw_body,body_size,workspace_id,status) VALUES ('messenger',true,'\\x7b2273656372657422',9,$1,'processed') RETURNING id`, [A])).id as string;
    expect((await q(app, ctx(U.admin, A), sql`SELECT id, status, body_size FROM webhook_events WHERE id = ${id}`))).toHaveLength(1);
    await rejects(q(app, ctx(U.admin, A), sql`SELECT raw_body FROM webhook_events`));
    await rejects(q(app, ctx(U.admin, A), sql`SELECT * FROM webhook_events`));
    expect(await q(app, ctx(U.agent, A), sql`SELECT id FROM webhook_events`)).toEqual([]);
    expect(await q(app, ctx(U.ownerB, B), sql`SELECT id FROM webhook_events`)).toEqual([]);
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE webhook_events SET status = 'failed'`));
    await rejects(q(app, ctx(U.owner, A), sql`INSERT INTO webhook_events(platform,signature_valid,raw_body,body_size) VALUES ('messenger',true,'\\x7b7d',2)`));
  });
  it("raw bodies older than 30 days are purged and nothing newer is touched; the retention cannot be set above 30 days; only the worker may run it", async () => {
    const old = (await one(`INSERT INTO webhook_events(platform,signature_valid,raw_body,body_size,received_at) VALUES ('messenger',true,'\\x7b7d',2, now() - interval '31 days') RETURNING id`)).id as string;
    const edge = (await one(`INSERT INTO webhook_events(platform,signature_valid,raw_body,body_size,received_at) VALUES ('messenger',true,'\\x7b7d',2, now() - interval '29 days') RETURNING id`)).id as string;
    const n = (await q<{ purge_webhook_event_bodies: number }>(worker, ctx(), sql`SELECT purge_webhook_event_bodies()`))[0]!.purge_webhook_event_bodies;
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await one(`SELECT raw_body IS NULL AS gone, body_purged_at IS NOT NULL AS stamped FROM webhook_events WHERE id = $1`, [old]))).toEqual({ gone: true, stamped: true });
    expect((await one(`SELECT raw_body IS NOT NULL AS kept FROM webhook_events WHERE id = $1`, [edge])).kept).toBe(true);
    await rejects(q(worker, ctx(), sql`SELECT purge_webhook_event_bodies(interval '60 days')`), /at most 30 days/);
    await rejects(q(app, ctx(U.owner, A), sql`SELECT purge_webhook_event_bodies()`));
    await rejects(q(ingest, ctx(), sql`SELECT purge_webhook_event_bodies()`));
  });
});

describe("append-only records", () => {
  it("integration events are append-only; send attempts finish once and are never deleted", async () => {
    await q(app, ctx(U.admin, A), sql`INSERT INTO integration_events(workspace_id,integration_account_id,kind,actor_user_id) VALUES (${A},${acctA},'connected',${U.admin})`);
    await rejects(q(app, ctx(U.admin, A), sql`INSERT INTO integration_events(workspace_id,integration_account_id,kind,actor_user_id) VALUES (${A},${acctA},'connected',${U.owner})`)); // actor must be the caller
    await rejects(q(app, ctx(U.agent, A), sql`INSERT INTO integration_events(workspace_id,integration_account_id,kind,actor_user_id) VALUES (${A},${acctA},'connected',${U.agent})`));
    await rejects(q(app, ctx(U.admin, A), sql`UPDATE integration_events SET kind = 'disconnected'`));
    await expect(root.query(`UPDATE integration_events SET kind = 'disconnected'`)).rejects.toThrow(/append-only/);
    await expect(root.query(`DELETE FROM integration_events`)).rejects.toThrow(/append-only/);
    const m = await outbound("pending");
    const a = (await q<{ id: string }>(worker, ctx(undefined, A), sql`INSERT INTO outbound_attempts(workspace_id,message_id,attempt) VALUES (${A},${m},1) RETURNING id`))[0]!.id;
    await q(worker, ctx(undefined, A), sql`UPDATE outbound_attempts SET outcome = 'ambiguous', finished_at = now(), http_status = 504 WHERE id = ${a}`);
    await rejects(q(worker, ctx(undefined, A), sql`UPDATE outbound_attempts SET outcome = 'accepted' WHERE id = ${a}`), /cannot change/);
    await expect(root.query(`DELETE FROM outbound_attempts WHERE id = $1`, [a])).rejects.toThrow(/append-only/);
    await rejects(q(app, ctx(U.admin, A), sql`INSERT INTO outbound_attempts(workspace_id,message_id,attempt) VALUES (${A},${m},2)`));
    expect(await q(app, ctx(U.viewer, A), sql`SELECT id FROM outbound_attempts`)).toEqual([]);
    expect((await q(app, ctx(U.agent, A), sql`SELECT id FROM outbound_attempts`)).length).toBeGreaterThanOrEqual(1);
    await expect(root.query(`INSERT INTO outbound_attempts(workspace_id,message_id,attempt) VALUES ($1,$2,1)`, [A, m])).rejects.toThrow(/outbound_attempts_message_attempt/);
  });
});

describe("concurrency", () => {
  it("the same platform message delivered 12 times at once produces exactly one row", async () => {
    const mid = fresh("race");
    const tries = await Promise.all(Array.from({ length: 12 }, () => q(worker, ctx(undefined, A), sql`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,external_id,sender_kind,body,delivery_state,occurred_at) VALUES (${A},${convA},${acctA},'in',${mid},'contact','x','received',now()) ON CONFLICT (integration_account_id, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id`)));
    expect(tries.filter((r) => r.length === 1)).toHaveLength(1);
    expect((await one(`SELECT count(*)::int n FROM messages WHERE external_id = $1`, [mid])).n).toBe(1);
  });
  it("two workspaces racing to connect the same Page: exactly one wins", async () => {
    for (let round = 0; round < 5; round++) {
      const ext = fresh("page-race");
      const r = await Promise.allSettled([
        q(app, ctx(U.owner, A), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES (${A},'messenger',${ext})`),
        q(app, ctx(U.ownerB, B), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES (${B},'messenger',${ext})`),
      ]);
      expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      expect((await one(`SELECT count(*)::int n FROM integration_accounts WHERE external_account_id = $1`, [ext])).n).toBe(1);
    }
  });
  it("a human decision and the worker's echo racing on an unknown message: one transition wins, the other is refused", async () => {
    for (let round = 0; round < 5; round++) {
      const m = await outbound("unknown");
      const r = await Promise.allSettled([
        setState(worker, ctx(undefined, A), m, "sent"),
        setState(app, ctx(U.agent, A), m, "failed"),
      ]);
      expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      expect(["sent", "failed"]).toContain((await one(`SELECT delivery_state s FROM messages WHERE id = $1`, [m])).s);
    }
  });
  it("a double-clicked send with the same client message id creates one message", async () => {
    const cm = crypto.randomUUID();
    const r = await Promise.allSettled(Array.from({ length: 6 }, () => q(app, ctx(U.agent, A), sql`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,delivery_state,sender_kind,sender_user_id,client_msg_id,body,occurred_at) VALUES (${A},${convA},${acctA},'out','pending','user',${U.agent},${cm},'hi',now())`)));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });
});
