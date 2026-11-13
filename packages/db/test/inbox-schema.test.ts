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
const rls = /row-level security/;
const perm = /permission denied/;
const denied = /row-level security|permission denied/;
/** `re` should name the mechanism being tested (policy or grant); the loose default is used only where either is a correct outcome. */
const rejects = (p: Promise<unknown>, re: RegExp = denied) => expect(p).rejects.toMatchObject({ cause: { message: expect.stringMatching(re) } });
const q = <T = Record<string, unknown>>(db: Db, c: ReturnType<typeof ctx>, s: ReturnType<typeof sql>) => withContext(db, c, async (tx) => (await tx.execute(s)).rows as T[]);
const fresh = (p = "p") => `${p}-${run}-${page++}`;
/** Platform account and user ids are numeric strings. */
const num = () => `${Date.now()}${String(page++).padStart(4, "0")}`;
/** Superuser can bypass triggers for one statement to age a row (tests only). */
const aged = async (id: string, minutes = 11) => { await root.query("SET session_replication_role = replica"); await root.query(`UPDATE messages SET state_changed_at = now() - make_interval(mins => $2) WHERE id = $1`, [id, minutes]); await root.query("SET session_replication_role = DEFAULT"); };

/** Superuser inserts (constraints and triggers still apply; RLS does not). */
const one = async (text: string, params: unknown[] = []) => (await root.query(text, params)).rows[0];
const badInsert = (text: string, params: unknown[], re: RegExp) => expect(root.query(text, params)).rejects.toThrow(re);

async function mkAccount(ws: string, owner: string, platform = "messenger") {
  return (await q<{ id: string }>(worker, ctx(undefined, ws), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id,connected_by) VALUES (${ws},${platform},${num()},${owner}) RETURNING id`))[0]!.id;
}
async function mkIdentity(ws: string, acct: string, contact: string) {
  return (await one(`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES ($1,$2,$3,$4) RETURNING id`, [ws, acct, num(), contact])).id as string;
}
async function mkConv(ws: string, acct: string, ident: string, contact: string) {
  return (await one(`INSERT INTO conversations(workspace_id,integration_account_id,identity_id,contact_id) VALUES ($1,$2,$3,$4) RETURNING id`, [ws, acct, ident, contact])).id as string;
}
const inbound = (ws: string, conv: string, acct: string, mid = fresh("mid")) => root.query(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,external_id,sender_kind,body,delivery_state,occurred_at) VALUES ($1,$2,$3,'in',$4,'contact','hi','received',now()) RETURNING id`, [ws, conv, acct, mid]);
async function outbound(state = "pending", by = U.agent) {
  return (await one(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,client_msg_id,sender_kind,sender_user_id,body,delivery_state,occurred_at) VALUES ($1,$2,$3,'out',gen_random_uuid(),'user',$4,'hello',$5,now()) RETURNING id`, [A, convA, acctA, by, state])).id as string;
}
const setState = (db: Db, c: ReturnType<typeof ctx>, id: string, st: string) => q(db, c, sql`UPDATE messages SET delivery_state = ${st} WHERE id = ${id} RETURNING id`);

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
    await badInsert(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES ($1,'tiktok','1')`, [A], /integration_accounts_platform/);
    await badInsert(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id,status) VALUES ($1,'messenger','1','paused')`, [A], /integration_accounts_status/);
  });
  it("(platform, external_account_id) is globally unique across workspaces (D-F); the same id on another platform is a different account", async () => {
    const ext = num();
    await root.query(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES ($1,'messenger',$2)`, [A, ext]);
    await badInsert(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES ($1,'messenger',$2)`, [B, ext], /integration_accounts_platform_external/);
    await root.query(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES ($1,'instagram',$2)`, [B, ext]);
  });
  it("identities, conversations and messages cannot cross workspaces or accounts", async () => {
    await badInsert(`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES ($1,$2,'1',$3)`, [A, acctB, contactA], /foreign key/); // account of another workspace
    await badInsert(`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES ($1,$2,'1',$3)`, [A, acctA, contactB], /foreign key/); // contact of another workspace
    await badInsert(`INSERT INTO conversations(workspace_id,integration_account_id,identity_id,contact_id) VALUES ($1,$2,$3,$4)`, [A, acctA, identA2, contactA], /foreign key/); // identity belongs to another account
    await badInsert(`INSERT INTO conversations(workspace_id,integration_account_id,identity_id,contact_id) VALUES ($1,$2,$3,$4)`, [B, acctB, identA, contactB], /foreign key/);
    await badInsert(`INSERT INTO conversations(workspace_id,integration_account_id,identity_id,contact_id) VALUES ($1,$2,$3,$4)`, [A, acctA, identA, contactA], /conversations_account_identity/); // one conversation per identity
    await badInsert(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,external_id,sender_kind,body,delivery_state,occurred_at) VALUES ($1,$2,$3,'in','m','contact','x','received',now())`, [B, convA, acctB], /foreign key|conversation not found/);
    await badInsert(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,external_id,sender_kind,body,delivery_state,occurred_at) VALUES ($1,$2,$3,'in','m','contact','x','received',now())`, [A, convA, acctA2], /foreign key|conversation not found/); // message account differs from its conversation's account
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

describe("integration accounts: only the worker creates them; the API cannot squat, flip health or enumerate", () => {
  it("every role reads its workspace; no API role can insert an account (a Page id cannot be squatted); other workspaces see nothing", async () => {
    for (const u of [U.owner, U.admin, U.agent, U.viewer]) expect((await q(app, ctx(u, A), sql`SELECT id FROM integration_accounts`)).length).toBeGreaterThanOrEqual(2);
    expect(await q(app, ctx(U.ownerB, B), sql`SELECT id FROM integration_accounts WHERE workspace_id = ${A}`)).toEqual([]);
    for (const u of [U.owner, U.admin, U.agent, U.viewer]) await rejects(q(app, ctx(u, A), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES (${A},'messenger',${num()})`), perm);
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM integration_accounts WHERE id = ${acctA}`), perm);
  });
  it("the worker creates accounts only inside the matching workspace context", async () => {
    await q(worker, ctx(undefined, A), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES (${A},'messenger',${num()})`);
    await rejects(q(worker, ctx(undefined, B), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES (${A},'messenger',${num()})`), rls);
    await rejects(q(worker, ctx(), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES (${A},'messenger',${num()})`), rls);
  });
  it("an admin can rename an account but cannot change its health, scopes, token fields or owner; agents cannot change anything", async () => {
    expect(await q(app, ctx(U.admin, A), sql`UPDATE integration_accounts SET display_name = 'Main page' WHERE id = ${acctA} RETURNING id`)).toHaveLength(1);
    expect(await q(app, ctx(U.agent, A), sql`UPDATE integration_accounts SET display_name = 'x' WHERE id = ${acctA} RETURNING id`)).toEqual([]);
    for (const col of ["status = 'disabled'", "status = 'connected'", "token_expires_at = now()", "scopes = '{x}'", `connected_by = '${U.agent}'`, "version = 5"]) await rejects(q(app, ctx(U.admin, A), sql.raw(`UPDATE integration_accounts SET ${col} WHERE id = '${acctA}'`)), perm);
    expect(await q(worker, ctx(undefined, A), sql`UPDATE integration_accounts SET status = 'reauth_required' WHERE id = ${acctA} RETURNING id`)).toHaveLength(1);
    await q(worker, ctx(undefined, A), sql`UPDATE integration_accounts SET status = 'connected' WHERE id = ${acctA}`);
  });
  it("an account cannot be moved to another workspace or renamed (the routing key is immutable), even by the worker", async () => {
    await expect(root.query(`UPDATE integration_accounts SET workspace_id = $1 WHERE id = $2`, [B, acctA])).rejects.toThrow();
    await expect(root.query(`UPDATE integration_accounts SET external_account_id = '999' WHERE id = $1`, [acctA])).rejects.toThrow(/cannot change workspace, platform or external id/);
    await rejects(q(app, ctx(U.admin, A), sql`UPDATE integration_accounts SET external_account_id = '999' WHERE id = ${acctA}`), perm);
    await rejects(q(worker, ctx(undefined, A), sql`UPDATE integration_accounts SET external_account_id = '999' WHERE id = ${acctA}`), perm);
  });
  it("global uniqueness (D-F): a second workspace cannot connect a Page that is already connected", async () => {
    const ext = num();
    await q(worker, ctx(undefined, A), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES (${A},'messenger',${ext})`);
    await expect(q(worker, ctx(undefined, B), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES (${B},'messenger',${ext})`)).rejects.toMatchObject({ cause: { code: "23505" } });
  });
  it("account and user ids are digits only: whitespace, zero-padded, signed and look-alike variants cannot create a second key", async () => {
    for (const bad of [" 123", "123 ", "0123", "12a", "-5", "\u0661\u0662\u0663", "1".repeat(101), ""]) {
      await expect(root.query(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES ($1,'messenger',$2)`, [A, bad])).rejects.toThrow(/integration_accounts_external_id/);
      await expect(root.query(`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES ($1,$2,$3,$4)`, [A, acctA, bad, contactA])).rejects.toThrow(/platform_identities_external_user/);
    }
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
    await rejects(q(app, ctx(U.agent, A), sql`UPDATE conversations SET last_message_at = now() WHERE id = ${convA}`), perm); // worker-owned column
    await rejects(q(app, ctx(U.agent, A), sql`UPDATE conversations SET message_seq = 99 WHERE id = ${convA}`), perm); // only the message trigger advances it
    await rejects(q(app, ctx(U.agent, A), sql`UPDATE conversations SET contact_id = ${contactA} WHERE id = ${convA}`), perm);
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM conversations WHERE id = ${convA}`));
    await expect(root.query(`UPDATE conversations SET identity_id = $1 WHERE id = $2`, [identA2, convA])).rejects.toThrow();
  });
  it("the worker creates conversations only inside the matching workspace context", async () => {
    const id = await q(worker, ctx(undefined, A), sql`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES (${A},${acctA2},${num()},${contactA}) RETURNING id`);
    expect(id).toHaveLength(1);
    await rejects(q(worker, ctx(undefined, B), sql`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES (${A},${acctA2},${num()},${contactA})`));
    await rejects(q(worker, ctx(), sql`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES (${A},${acctA2},${num()},${contactA})`));
  });
  it("outbound insert by the app: pending, from a writer, as themselves, with a client message id; nothing else", async () => {
    const ins = (u: string, extra = "'out','pending','user'", sender = U.agent, ext = "NULL", cm = "gen_random_uuid()") =>
      q(app, ctx(u, A), sql.raw(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,delivery_state,sender_kind,sender_user_id,external_id,client_msg_id,body) VALUES ('${A}','${convA}','${acctA}',${extra},'${sender}',${ext},${cm},'hello')`));
    await ins(U.agent);
    await ins(U.owner, "'out','pending','user'", U.owner);
    await rejects(ins(U.viewer, "'out','pending','user'", U.viewer));
    await rejects(ins(U.agent, "'out','pending','user'", U.admin)); // as someone else
    await rejects(ins(U.agent, "'in','received','contact'", U.agent, "'forged'")); // forging an inbound message
    await rejects(ins(U.agent, "'out','sent','user'")); // skipping the state graph
    await rejects(ins(U.agent, "'out','pending','user'", U.agent, "'mid.1'")); // claiming a platform id
    await rejects(ins(U.agent, "'out','pending','user'", U.agent, "NULL", "NULL")); // no idempotency key
    await rejects(q(app, ctx(U.agent, A), sql`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,delivery_state,sender_kind,sender_user_id,client_msg_id,body,occurred_at) VALUES (${A},${convA},${acctA},'out','pending','user',${U.agent},gen_random_uuid(),'hi','2001-01-01')`), perm); // the clock is the database's: no backdating to reorder a thread
    await rejects(q(app, ctx(U.agent, A), sql`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,delivery_state,sender_kind,sender_user_id,client_msg_id,body,seq) VALUES (${A},${convA},${acctA},'out','pending','user',${U.agent},gen_random_uuid(),'hi',999)`), perm);
    expect(await q(app, ctx(U.ownerB, B), sql`SELECT id FROM messages WHERE workspace_id = ${A}`)).toEqual([]);
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM messages`));
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE messages SET body = 'edited'`));
  });
  it("delivery state graph per role: the app resolves unknown only after 10 minutes and retries failed with a new id; the worker drives the automatic part and can never fail an unknown send", async () => {
    const decide = (u: string, id: string, st: string) => q(app, ctx(u, A), sql`UPDATE messages SET delivery_state = ${st} WHERE id = ${id} RETURNING id`);
    const m1 = await outbound("unknown");
    await rejects(decide(U.agent, m1, "pending"), /not allowed for role crm_app/);
    await rejects(decide(U.agent, m1, "sent"), /only after 10 minutes/); // D-G: the window is enforced by the database
    await rejects(decide(U.agent, m1, "failed"), /only after 10 minutes/);
    await aged(m1);
    expect(await decide(U.agent, m1, "sent")).toHaveLength(1);
    await rejects(decide(U.agent, m1, "failed"), /not allowed/); // sent is final
    const m2 = await outbound("unknown");
    await aged(m2);
    expect(await decide(U.agent, m2, "failed")).toHaveLength(1);
    const m3 = await outbound("pending");
    await rejects(decide(U.agent, m3, "sent"), /not allowed for role crm_app/); // the app role cannot claim a send happened
    await rejects(decide(U.agent, m3, "sending"), /not allowed for role crm_app/);
    expect(await setState(worker, ctx(undefined, A), m3, "sending")).toHaveLength(1);
    await rejects(setState(worker, ctx(undefined, A), m3, "pending"), /not allowed for role crm_worker/);
    expect(await setState(worker, ctx(undefined, A), m3, "unknown")).toHaveLength(1);
    await rejects(setState(worker, ctx(undefined, A), m3, "sending"), /not allowed/); // never resent automatically
    await rejects(setState(worker, ctx(undefined, A), m3, "failed"), /not allowed for role crm_worker/); // leaving unknown is an echo match or a human decision (D-G)
    expect(await setState(worker, ctx(undefined, A), m3, "sent")).toHaveLength(1);
    const m4 = await outbound("failed");
    await rejects(setState(worker, ctx(undefined, A), m4, "pending"), /new client message id|not allowed for role crm_worker/); // retry is a human action
    await rejects(q(app, ctx(U.agent, A), sql`UPDATE messages SET delivery_state = 'pending' WHERE id = ${m4}`), /new client message id/); // same id would risk a double send
    expect(await q(app, ctx(U.agent, A), sql`UPDATE messages SET delivery_state = 'pending', client_msg_id = gen_random_uuid() WHERE id = ${m4} RETURNING id`)).toHaveLength(1);
    const m5 = await outbound("pending");
    await expect(root.query(`UPDATE messages SET delivery_state = 'sent' WHERE id = $1`, [m5])).rejects.toThrow(/not allowed/); // even a superuser cannot skip the graph
    expect(await q(worker, ctx(undefined, A), sql`UPDATE messages SET delivery_state = 'failed', failure_code = 'token' WHERE id = ${m5} RETURNING id`)).toHaveLength(1); // refused before any request
    await rejects(q(app, ctx(U.agent, A), sql`UPDATE messages SET failure_code = 'x' WHERE id = ${m5}`), /only together with the delivery state/);
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
  it("the ingress role can insert unrouted events only, cannot read them back, and cannot touch anything else (not even the account list)", async () => {
    await ev();
    await ev(null, "orphan");
    await rejects(ev(A)); // it never decides the workspace
    await rejects(ev(null, "processed"));
    await rejects(q(ingest, ctx(), sql`SELECT * FROM webhook_events`));
    await rejects(q(ingest, ctx(), sql`UPDATE webhook_events SET status = 'processed'`));
    for (const t of ["messages", "conversations", "contacts", "workspaces", "memberships", "tasks", "leads", "integration_secrets", "platform_identities"]) await rejects(q(ingest, ctx(), sql.raw(`SELECT 1 FROM ${t} LIMIT 1`)));
    // the ingress process cannot enumerate tenants: it has no access to accounts at all (routing is the worker's job)
    for (const col of ['*', 'id', 'workspace_id', 'external_account_id', 'display_name', 'connected_by']) await rejects(q(ingest, ctx(), sql.raw(`SELECT ${col} FROM integration_accounts`)), perm);
    await rejects(q(ingest, ctx(), sql`UPDATE integration_accounts SET status = 'disabled'`));
  });
  it("routing is bound in the database: an event can only be stamped with the workspace that owns the account it names", async () => {
    const ext = (await one(`SELECT external_account_id e FROM integration_accounts WHERE id = $1`, [acctA])).e as string;
    const mk = async (ref: string | null) => (await one(`INSERT INTO webhook_events(platform,signature_valid,raw_body,body_size,account_ref) VALUES ('messenger',true,'\\x7b7d',2,$1) RETURNING id`, [ref])).id as string;
    await rejects(q(worker, ctx(), sql`UPDATE webhook_events SET workspace_id = ${B} WHERE id = ${await mk(ext)}`), /only be routed to the workspace that owns its account/); // the wrong tenant
    await rejects(q(worker, ctx(), sql`UPDATE webhook_events SET workspace_id = ${A} WHERE id = ${await mk("123456789")}`), /only be routed/); // an account nobody owns
    await rejects(q(worker, ctx(), sql`UPDATE webhook_events SET workspace_id = ${A} WHERE id = ${await mk(null)}`), /only be routed/);
    expect(await q(worker, ctx(), sql`UPDATE webhook_events SET workspace_id = ${A} WHERE id = ${await mk(ext)} RETURNING id`)).toHaveLength(1);
  });
  it("the worker processes events within the status graph; it can purge a body but never rewrite it", async () => {
    const ext = (await one(`SELECT external_account_id e FROM integration_accounts WHERE id = $1`, [acctA])).e as string;
    const id = (await one(`INSERT INTO webhook_events(platform,signature_valid,raw_body,body_size,account_ref) VALUES ('messenger',true,'\\x7b7d',2,$1) RETURNING id`, [ext])).id as string;
    await q(worker, ctx(), sql`UPDATE webhook_events SET workspace_id = ${A}, status = 'processed', processed_at = now() WHERE id = ${id}`);
    await rejects(q(worker, ctx(), sql`UPDATE webhook_events SET status = 'received' WHERE id = ${id}`), /not allowed/);
    await rejects(q(worker, ctx(), sql`UPDATE webhook_events SET workspace_id = ${B} WHERE id = ${id}`), /cannot move/);
    await rejects(q(worker, ctx(), sql`UPDATE webhook_events SET raw_body = '\\x00' WHERE id = ${id}`), /only be purged/);
    await rejects(q(worker, ctx(), sql`UPDATE webhook_events SET signature_valid = false WHERE id = ${id}`), perm); // not a column the worker may change
    await rejects(q(worker, ctx(), sql`DELETE FROM webhook_events WHERE id = ${id}`), perm);
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

describe("per-user unread (conversation_reads is the source of truth)", () => {
  /** Fresh conversation with its own identity so counts are exact. */
  async function conv() {
    const ident = await mkIdentity(A, acctA, contactA);
    return mkConv(A, acctA, ident, contactA);
  }
  const incoming = (c: string, n: number) => Promise.all(Array.from({ length: n }, () => inbound(A, c, acctA)));
  const unread = async (u: string, c: string) => Number((await q<{ n: string }>(app, ctx(u, A), sql`SELECT conversation_unread_count(${c}) AS n`))[0]!.n);
  const seqOf = async (c: string) => Number((await one(`SELECT message_seq s FROM conversations WHERE id = $1`, [c])).s);
  const markRead = (u: string, c: string, seq: number) => q(app, ctx(u, A), sql`INSERT INTO conversation_reads(workspace_id,conversation_id,user_id,last_read_seq) VALUES (${A},${c},${u},${seq}) ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_seq = GREATEST(conversation_reads.last_read_seq, EXCLUDED.last_read_seq), updated_at = now()`);

  it("every message gets the next sequence number of its conversation; seq cannot be forged or edited", async () => {
    const c = await conv();
    await incoming(c, 3);
    const rows = (await root.query(`SELECT seq FROM messages WHERE conversation_id = $1 ORDER BY seq`, [c])).rows.map((r) => Number(r.seq));
    expect(rows).toEqual([1, 2, 3]);
    expect(await seqOf(c)).toBe(3);
    await expect(root.query(`UPDATE messages SET seq = 9 WHERE conversation_id = $1`, [c])).rejects.toThrow(/immutable/);
    await expect(root.query(`UPDATE conversations SET message_seq = 50 WHERE id = $1`, [c])).rejects.toThrow(/only advances by one/);
  });
  it("each user has an independent cursor: Agent A reading never clears Agent B", async () => {
    const c = await conv();
    await incoming(c, 4);
    expect(await unread(U.agent, c)).toBe(4);
    expect(await unread(U.admin, c)).toBe(4);
    await markRead(U.agent, c, 4);
    expect(await unread(U.agent, c)).toBe(0);
    expect(await unread(U.admin, c)).toBe(4); // untouched
    expect(await unread(U.viewer, c)).toBe(4);
    await incoming(c, 2);
    expect(await unread(U.agent, c)).toBe(2);
    expect(await unread(U.admin, c)).toBe(6);
  });
  it("own outbound messages and failed or pending sends never count as unread", async () => {
    const c = await conv();
    await incoming(c, 1);
    for (const st of ["pending", "failed", "unknown", "sent"]) await root.query(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,client_msg_id,external_id,sender_kind,sender_user_id,body,delivery_state) VALUES ($1,$2,$3,'out',gen_random_uuid(),$4,'user',$5,'mine',$6)`, [A, c, acctA, st === "sent" ? fresh("m") : null, U.agent, st]);
    expect(await unread(U.admin, c)).toBe(1);
    expect(await unread(U.agent, c)).toBe(1);
  });
  it("the cursor only moves forward, never passes the last message, and is private to its owner", async () => {
    const c = await conv();
    await incoming(c, 3);
    await markRead(U.agent, c, 3);
    await markRead(U.agent, c, 1); // a stale tab
    expect(Number((await one(`SELECT last_read_seq s FROM conversation_reads WHERE conversation_id = $1 AND user_id = $2`, [c, U.agent])).s)).toBe(3);
    await rejects(markRead(U.agent, c, 4), /cannot pass the last message/);
    await rejects(q(app, ctx(U.admin, A), sql`INSERT INTO conversation_reads(workspace_id,conversation_id,user_id,last_read_seq) VALUES (${A},${c},${U.agent},0)`), rls); // not someone else's marker
    await rejects(q(app, ctx(U.agent, A), sql`UPDATE conversation_reads SET user_id = ${U.admin} WHERE conversation_id = ${c}`), perm);
    expect((await q<{ last_read_seq: string }>(app, ctx(U.agent, A), sql`UPDATE conversation_reads SET last_read_seq = 0 WHERE conversation_id = ${c} RETURNING last_read_seq`))[0]!.last_read_seq).toBe("3"); // a direct attempt to move it back keeps 3
    expect(Number((await one(`SELECT last_read_seq s FROM conversation_reads WHERE conversation_id = $1 AND user_id = $2`, [c, U.agent])).s)).toBe(3);
  });
  it("a reader cannot see another workspace's counts", async () => {
    const c = await conv();
    await incoming(c, 2);
    expect(Number((await q<{ n: string }>(app, ctx(U.ownerB, B), sql`SELECT conversation_unread_count(${c}) AS n`))[0]!.n)).toBe(0);
  });
  it("marking read while messages arrive concurrently never clears a message the reader has not seen", async () => {
    for (let round = 0; round < 6; round++) {
      const c = await conv();
      await incoming(c, 3);
      const seen = await seqOf(c); // what the reader's screen showed
      await Promise.all([markRead(U.agent, c, seen), incoming(c, 5), markRead(U.agent, c, seen), incoming(c, 5)]);
      const total = await seqOf(c);
      expect(total).toBe(13);
      expect(await unread(U.agent, c)).toBe(total - seen); // exactly the 10 that arrived after the screen was drawn
      expect(await unread(U.admin, c)).toBe(total);
    }
  });
  it("sequence order is commit order: a slow earlier transaction cannot be skipped by a later reader", async () => {
    const c = await conv();
    const slow = new pg.Client({ connectionString: ADMIN }); await slow.connect();
    await slow.query("BEGIN");
    await slow.query(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,external_id,sender_kind,body,delivery_state) VALUES ($1,$2,$3,'in',$4,'contact','slow','received')`, [A, c, acctA, fresh("slow")]);
    const other = new pg.Client({ connectionString: ADMIN }); await other.connect();
    const fast = other.query(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,external_id,sender_kind,body,delivery_state) VALUES ($1,$2,$3,'in',$4,'contact','fast','received')`, [A, c, acctA, fresh("fast")]); // must wait for the slow transaction's row lock on the conversation
    await new Promise((r) => setTimeout(r, 150));
    expect((await root.query(`SELECT count(*)::int n FROM messages WHERE conversation_id = $1`, [c])).rows[0].n).toBe(0); // nothing visible yet, the fast insert is queued behind
    await slow.query("COMMIT"); await slow.end();
    await fast; await other.end();
    expect((await root.query(`SELECT body, seq FROM messages WHERE conversation_id = $1 ORDER BY seq`, [c])).rows.map((r) => `${r.body}:${r.seq}`)).toEqual(["slow:1", "fast:2"]);
  });
});

describe("review findings fixed (security review of slice 1)", () => {
  it("echo of a message sent elsewhere must carry a platform id (idempotency); our own composer messages may not have one yet", async () => {
    const ins = (kind: string, ext: string | null) => root.query(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,external_id,sender_kind,sender_user_id,body,delivery_state) VALUES ($1,$2,$3,'out',$4,$5,$6,'x','sent')`, [A, convA, acctA, ext, kind, kind === "user" ? U.agent : null]);
    await expect(ins("external", null)).rejects.toThrow(/messages_direction_shape/);
    await expect(ins("system", null)).rejects.toThrow(/messages_direction_shape/);
    await ins("external", fresh("echo"));
  });
  it("an assignee must be a member of the workspace, and agents assign only to themselves", async () => {
    const c = await mkConv(A, acctA, await mkIdentity(A, acctA, contactA), contactA);
    await expect(root.query(`UPDATE conversations SET assignee_user_id = $1 WHERE id = $2`, [U.ownerB, c])).rejects.toThrow(/foreign key/); // not a member of workspace A
    await rejects(q(app, ctx(U.agent, A), sql`UPDATE conversations SET assignee_user_id = ${U.admin} WHERE id = ${c}`), /only to themselves/);
    expect(await q(app, ctx(U.agent, A), sql`UPDATE conversations SET assignee_user_id = ${U.agent} WHERE id = ${c} RETURNING id`)).toHaveLength(1);
    expect(await q(app, ctx(U.viewer, A), sql`UPDATE conversations SET assignee_user_id = ${U.viewer} WHERE id = ${c} RETURNING id`)).toEqual([]); // viewers cannot assign
    expect(await q(app, ctx(U.admin, A), sql`UPDATE conversations SET assignee_user_id = ${U.owner} WHERE id = ${c} RETURNING id`)).toHaveLength(1); // admin may assign anyone
    await rejects(q(app, ctx(U.agent, A), sql`UPDATE conversations SET assignee_user_id = NULL WHERE id = ${c}`), /only to themselves/); // an agent cannot unassign someone else
    expect(await q(app, ctx(U.owner, A), sql`UPDATE conversations SET assignee_user_id = NULL WHERE id = ${c} RETURNING id`)).toHaveLength(1);
  });
  it("conversation timestamps and platform watermarks only move forward", async () => {
    const c = await mkConv(A, acctA, await mkIdentity(A, acctA, contactA), contactA);
    await q(worker, ctx(undefined, A), sql`UPDATE conversations SET last_message_at = '2026-01-02', last_inbound_at = '2026-01-02', contact_read_at = '2026-01-02', contact_delivered_at = '2026-01-02' WHERE id = ${c}`);
    for (const col of ["last_message_at", "last_inbound_at", "contact_read_at", "contact_delivered_at"]) {
      await rejects(q(worker, ctx(undefined, A), sql.raw(`UPDATE conversations SET ${col} = '2026-01-01' WHERE id = '${c}'`)), /only move forward/);
      await rejects(q(worker, ctx(undefined, A), sql.raw(`UPDATE conversations SET ${col} = NULL WHERE id = '${c}'`)), /only move forward/);
      expect(await q(worker, ctx(undefined, A), sql.raw(`UPDATE conversations SET ${col} = '2026-01-03' WHERE id = '${c}' RETURNING id`))).toHaveLength(1);
    }
  });
  it("a conversation's contact always equals its identity's contact: a merge updates both at once", async () => {
    const other = (await one(`INSERT INTO contacts(workspace_id,name,lifecycle_stage_id) SELECT $1,'Merged',id FROM lifecycle_stages WHERE workspace_id = $1 LIMIT 1 RETURNING id`, [A])).id as string;
    const ident = await mkIdentity(A, acctA, contactA);
    const c = await mkConv(A, acctA, ident, contactA);
    await expect(root.query(`INSERT INTO conversations(workspace_id,integration_account_id,identity_id,contact_id) VALUES ($1,$2,$3,$4)`, [A, acctA2, await mkIdentity(A, acctA2, contactA), other])).rejects.toThrow(/foreign key/); // contact differs from the identity's
    await q(worker, ctx(undefined, A), sql`UPDATE platform_identities SET contact_id = ${other} WHERE id = ${ident}`);
    expect((await one(`SELECT contact_id FROM conversations WHERE id = $1`, [c])).contact_id).toBe(other);
  });
  it("the unknown window also blocks a person from skipping the wait through the worker path", async () => {
    const m = await outbound("unknown");
    await rejects(q(app, ctx(U.admin, A), sql`UPDATE messages SET delivery_state = 'failed' WHERE id = ${m}`), /only after 10 minutes/);
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE messages SET state_changed_at = now() - interval '1 hour' WHERE id = ${m}`), perm); // the clock is not writable
    await rejects(q(worker, ctx(undefined, A), sql`UPDATE messages SET state_changed_at = now() - interval '1 hour' WHERE id = ${m}`), perm);
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
      const ext = num();
      const r = await Promise.allSettled([
        q(worker, ctx(undefined, A), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES (${A},'messenger',${ext})`),
        q(worker, ctx(undefined, B), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES (${B},'messenger',${ext})`),
      ]);
      expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      expect((await one(`SELECT count(*)::int n FROM integration_accounts WHERE external_account_id = $1`, [ext])).n).toBe(1);
    }
  });
  it("a human decision and the worker's echo racing on an unknown message: one transition wins, the other is refused", async () => {
    for (let round = 0; round < 5; round++) {
      const m = await outbound("unknown");
      await aged(m);
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
    const r = await Promise.allSettled(Array.from({ length: 6 }, () => q(app, ctx(U.agent, A), sql`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,delivery_state,sender_kind,sender_user_id,client_msg_id,body) VALUES (${A},${convA},${acctA},'out','pending','user',${U.agent},${cm},'hi')`)));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });
});
