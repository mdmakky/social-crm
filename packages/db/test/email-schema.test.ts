import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, schema, withContext, type Db } from "../src/index.ts";

// Email channel (migration 0039): tenant isolation of the three new tables, the token/identity shapes, and the guard triggers.
const NAME = process.env.CRM_DB_NAME ?? "crm";
const url = (u: string, p: string) => `postgres://${u}:${p}@127.0.0.1:5436/${NAME}`;
const ADMIN = process.env.DATABASE_URL_ADMIN ?? url("postgres", "postgres");
const run = Date.now().toString(36);
const U = { owner: `em-owner-${run}`, viewer: `em-viewer-${run}`, ownerB: `em-ownerb-${run}` };
let app: Db, worker: Db, root: pg.Client;
let A = "", B = "", accA = "", accB = "", msgA = "", convA = "";
const tok = () => Array.from({ length: 20 }, () => "abcdefghijklmnopqrstuvwxyz234567"[Math.floor(Math.random() * 32)]).join("");
const ctx = (userId?: string, workspaceId?: string) => ({ userId, workspaceId });
const q = <T = Record<string, unknown>>(db: Db, c: ReturnType<typeof ctx>, s: ReturnType<typeof sql>) => withContext(db, c, async (tx) => (await tx.execute(s)).rows as T[]);
const rejects = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toMatchObject({ cause: { message: expect.stringMatching(re) } });

beforeAll(async () => {
  root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  app = createDb(url("crm_app", "app_dev")); worker = createDb(url("crm_worker", "worker_dev"));
  for (const id of Object.values(U)) await root.query(`INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,$1,$2,true) ON CONFLICT (id) DO NOTHING`, [id, `${id}@t.test`]);
  const mk = (owner: string, slug: string) => withContext(app, { userId: owner }, async (tx) => {
    const [w] = await tx.insert(schema.workspaces).values({ name: slug, slug, ownerUserId: owner }).returning();
    await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId: owner, role: "owner" });
    return w!.id;
  });
  A = await mk(U.owner, `em-a-${run}`); B = await mk(U.ownerB, `em-b-${run}`);
  await withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.memberships).values([{ workspaceId: A, userId: U.viewer, role: "viewer" }]));
  const tokA = tok(), tokB = tok();
  accA = (await root.query(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES ($1,'email',$2) RETURNING id`, [A, tokA])).rows[0].id;
  accB = (await root.query(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES ($1,'email',$2) RETURNING id`, [B, tokB])).rows[0].id;
  await root.query(`INSERT INTO email_accounts(workspace_id,integration_account_id,inbound_token,from_address,display_name,provider) VALUES ($1,$2,$3,'support@a.test','A','mock')`, [A, accA, tokA]);
  await root.query(`INSERT INTO email_accounts(workspace_id,integration_account_id,inbound_token,from_address,display_name,provider) VALUES ($1,$2,$3,'support@b.test','B','mock')`, [B, accB, tokB]);
  const stage = (await root.query(`INSERT INTO lifecycle_stages(workspace_id,name,position) VALUES ($1,'New',0) RETURNING id`, [A])).rows[0].id;
  const ct = (await root.query(`INSERT INTO contacts(workspace_id,name,lifecycle_stage_id,source) VALUES ($1,'C',$2,'email') RETURNING id`, [A, stage])).rows[0].id;
  const idn = (await root.query(`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES ($1,$2,'email:c@example.org',$3) RETURNING id`, [A, accA, ct])).rows[0].id;
  convA = (await root.query(`INSERT INTO conversations(workspace_id,integration_account_id,identity_id,contact_id) VALUES ($1,$2,$3,$4) RETURNING id`, [A, accA, idn, ct])).rows[0].id;
  msgA = (await root.query(`INSERT INTO messages(workspace_id,conversation_id,integration_account_id,direction,external_id,sender_kind,body,delivery_state) VALUES ($1,$2,$3,'in','mid1@example.org','contact','hi','received') RETURNING id`, [A, convA, accA])).rows[0].id;
  await root.query(`INSERT INTO email_message_meta(workspace_id,integration_account_id,message_id,header_message_id) VALUES ($1,$2,$3,'mid1@example.org')`, [A, accA, msgA]);
  await root.query(`INSERT INTO email_threads(workspace_id,conversation_id,conv_token) VALUES ($1,$2,$3)`, [A, convA, tok().slice(0, 16)]);
});
afterAll(async () => { await Promise.all([app.$client.end(), worker.$client.end(), root.end()]); });

describe("email tables are tenant isolated", () => {
  for (const t of ["email_accounts", "email_threads", "email_message_meta"]) {
    it(`${t}: members of the owning workspace see it, others and contextless sessions do not`, async () => {
      expect(await q(app, ctx(U.owner, A), sql.raw(`SELECT id FROM ${t}`))).toHaveLength(1);
      expect(await q(app, ctx(U.viewer, A), sql.raw(`SELECT id FROM ${t}`))).toHaveLength(1);
      expect(await q(app, ctx(U.ownerB, B), sql.raw(`SELECT id FROM ${t} WHERE workspace_id = '${A}'`))).toEqual([]);
      expect(await q(app, ctx(U.ownerB, A), sql.raw(`SELECT id FROM ${t}`))).toEqual([]);
      expect(await q(app, ctx(U.owner), sql.raw(`SELECT id FROM ${t}`))).toEqual([]);
      expect(await q(worker, ctx(undefined, B), sql.raw(`SELECT id FROM ${t} WHERE workspace_id = '${A}'`))).toEqual([]);
    });
  }
  it("the application role cannot write them; the worker cannot write into another workspace", async () => {
    await rejects(q(app, ctx(U.owner, A), sql`INSERT INTO email_threads(workspace_id,conversation_id,conv_token) VALUES (${A},${convA},'bbbbbbbbbbbbbbbb')`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE email_accounts SET display_name = 'x'`), /permission denied/);
    await rejects(q(worker, ctx(undefined, B), sql`INSERT INTO email_message_meta(workspace_id,integration_account_id,message_id,header_message_id) VALUES (${A},${accA},${msgA},'x@y')`), /row-level security/);
  });
});

describe("shapes and guards", () => {
  it("an email account's external id is its token; other platforms still need digits", async () => {
    await expect(root.query(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES ($1,'email','not-a-token')`, [A])).rejects.toThrow(/integration_accounts_external_id/);
    await expect(root.query(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES ($1,'messenger',$2)`, [A, "a".repeat(20)])).rejects.toThrow(/integration_accounts_external_id/);
  });
  it("an email_accounts row must match an email integration account and its token, and its identity never changes", async () => {
    await expect(root.query(`INSERT INTO email_accounts(workspace_id,integration_account_id,inbound_token,from_address,display_name,provider) VALUES ($1,$2,$3,'s@a.test','A','mock')`, [A, accA, "z".repeat(20)])).rejects.toThrow(/same token|email_accounts_account/);
    await expect(root.query(`UPDATE email_accounts SET from_address = 'other@a.test' WHERE integration_account_id = $1`, [accA])).rejects.toThrow(/cannot change its identity/);
    await rejects(q(worker, ctx(undefined, A), sql`UPDATE email_accounts SET inbound_token = ${"q".repeat(20)} WHERE integration_account_id = ${accA}`), /permission denied/);
    await q(worker, ctx(undefined, A), sql`UPDATE email_accounts SET verified_domain_status = 'verified', last_checked_at = now() WHERE integration_account_id = ${accA}`);
  });
  it("identities accept email:<addr> and email-unverified:<addr> but nothing else non-numeric", async () => {
    const [{ contact_id }] = (await root.query(`SELECT contact_id FROM platform_identities WHERE workspace_id = $1 LIMIT 1`, [A])).rows;
    const ins = (v: string) => root.query(`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES ($1,$2,$3,$4)`, [A, accA, v, contact_id]);
    await ins("email-unverified:c@example.org");
    for (const bad of ["c@example.org", "email:", "email:not an address", "emailx:c@example.org", "email:a@b>"]) await expect(ins(bad)).rejects.toThrow(/platform_identities_external_user/);
  });
  it("header ids are unique per account; meta and threads are append-only", async () => {
    await expect(root.query(`INSERT INTO email_message_meta(workspace_id,integration_account_id,message_id,header_message_id) VALUES ($1,$2,$3,'mid1@example.org')`, [A, accA, msgA])).rejects.toThrow(/email_message_meta/);
    await expect(root.query(`UPDATE email_message_meta SET subject = 'x'`)).rejects.toThrow(/append-only/);
    await expect(root.query(`DELETE FROM email_threads`)).rejects.toThrow(/append-only/);
  });
  it("the worker may mark an email method undeliverable and nothing else on contact_methods", async () => {
    const [{ id: ct }] = (await root.query(`SELECT contact_id AS id FROM platform_identities WHERE workspace_id = $1 LIMIT 1`, [A])).rows;
    await root.query(`INSERT INTO contact_methods(workspace_id,contact_id,kind,value,source) VALUES ($1,$2,'email','c@example.org','email')`, [A, ct]);
    await q(worker, ctx(undefined, A), sql`UPDATE contact_methods SET undeliverable_at = now(), undeliverable_reason = 'bounce' WHERE contact_id = ${ct}`);
    await rejects(q(worker, ctx(undefined, A), sql`UPDATE contact_methods SET value = 'x@y.z' WHERE contact_id = ${ct}`), /permission denied/);
    await rejects(q(worker, ctx(undefined, B), sql`UPDATE contact_methods SET undeliverable_at = NULL WHERE contact_id = ${ct}`).then((r) => { if (r.length) throw new Error("cross-workspace update touched rows"); throw Object.assign(new Error(), { cause: { message: "row-level security" } }); }), /row-level security/);
  });
});
