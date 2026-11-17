import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, schema, withContext, type Db } from "../src/index.ts";

// WhatsApp slice 1: the platform is accepted, whatsapp_accounts is tenant isolated (forced RLS, column grants, guard trigger).
const NAME = process.env.CRM_DB_NAME ?? "crm";
const url = (u: string, p: string) => `postgres://${u}:${p}@127.0.0.1:5436/${NAME}`;
const ADMIN = process.env.DATABASE_URL_ADMIN ?? url("postgres", "postgres");
const run = Date.now().toString(36);
const U = { owner: `wa-owner-${run}`, viewer: `wa-viewer-${run}`, ownerB: `wa-ownerb-${run}` };
let app: Db, worker: Db, ingest: Db, root: pg.Client;
let A = "", B = "", waA = "", waB = "", msgA = "";
let n = 0;
const num = () => `9${Date.now()}${String(n++).padStart(4, "0")}`;
const ctx = (userId?: string, workspaceId?: string) => ({ userId, workspaceId });
const q = <T = Record<string, unknown>>(db: Db, c: ReturnType<typeof ctx>, s: ReturnType<typeof sql>) => withContext(db, c, async (tx) => (await tx.execute(s)).rows as T[]);
const rejects = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toMatchObject({ cause: { message: expect.stringMatching(re) } });
const acct = async (ws: string, platform: string) => (await root.query(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES ($1,$2,$3) RETURNING id`, [ws, platform, num()])).rows[0].id as string;

beforeAll(async () => {
  root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  app = createDb(url("crm_app", "app_dev")); worker = createDb(url("crm_worker", "worker_dev")); ingest = createDb(url("crm_ingest", "ingest_dev"));
  for (const id of Object.values(U)) await root.query(`INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,$1,$2,true) ON CONFLICT (id) DO NOTHING`, [id, `${id}@t.test`]);
  const mk = (owner: string, slug: string) => withContext(app, { userId: owner }, async (tx) => {
    const [w] = await tx.insert(schema.workspaces).values({ name: slug, slug, ownerUserId: owner }).returning();
    await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId: owner, role: "owner" });
    return w!.id;
  });
  A = await mk(U.owner, `wa-a-${run}`); B = await mk(U.ownerB, `wa-b-${run}`);
  await withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.memberships).values([{ workspaceId: A, userId: U.viewer, role: "viewer" }]));
  waA = await acct(A, "whatsapp"); waB = await acct(B, "whatsapp");
  msgA = (await root.query(`INSERT INTO whatsapp_accounts(workspace_id,integration_account_id,waba_id,display_phone_number) VALUES ($1,$2,$3,'+1 555 0100') RETURNING id`, [A, waA, num()])).rows[0].id;
  await root.query(`INSERT INTO whatsapp_accounts(workspace_id,integration_account_id,waba_id) VALUES ($1,$2,$3)`, [B, waB, num()]);
});
afterAll(async () => { await Promise.all([app.$client.end(), worker.$client.end(), ingest.$client.end(), root.end()]); });

describe("whatsapp platform", () => {
  it("is accepted by accounts and webhook events, and other platforms are still rejected", async () => {
    expect(waA).toMatch(/^[0-9a-f-]{36}$/);
    await root.query(`INSERT INTO webhook_events(platform,signature_valid,raw_body,body_sha256,body_size,account_ref,status) VALUES ('whatsapp',true,'\\x7b7d',decode(repeat('ab',32),'hex'),2,$1,'received')`, [num()]);
    await expect(acct(A, "tiktok")).rejects.toThrow(/integration_accounts_platform/);
    await expect(root.query(`INSERT INTO webhook_events(platform,signature_valid,raw_body,body_sha256,body_size,status) VALUES ('tiktok',true,'\\x7b7d',decode(repeat('ab',32),'hex'),2,'received')`)).rejects.toThrow(/webhook_events_platform/);
  });
  it("lets the worker create WhatsApp contacts and detected methods, and still guards placeholder names", async () => {
    const stage = (await root.query(`INSERT INTO lifecycle_stages(workspace_id,name,position) VALUES ($1,'New',0) RETURNING id`, [A])).rows[0].id;
    const c = (await q<{ id: string }>(worker, ctx(undefined, A), sql`INSERT INTO contacts(workspace_id,name,lifecycle_stage_id,source) VALUES (${A},'WhatsApp user 1234',${stage},'whatsapp') RETURNING id`))[0]!.id;
    await q(worker, ctx(undefined, A), sql`UPDATE contacts SET name = 'Real Name', version = version + 1 WHERE id = ${c}`); // placeholder: allowed
    await rejects(q(worker, ctx(undefined, A), sql`UPDATE contacts SET name = 'Other', version = version + 1 WHERE id = ${c}`), /placeholder contact name/); // a real name: refused
    await q(worker, ctx(undefined, A), sql`INSERT INTO contact_methods(workspace_id,contact_id,kind,value,source,verified) VALUES (${A},${c},'phone','+15550100','whatsapp',false)`);
    await rejects(q(worker, ctx(undefined, A), sql`INSERT INTO contacts(workspace_id,name,lifecycle_stage_id,source) VALUES (${A},'x',${stage},'tiktok')`), /row-level security|permission denied/); // an unknown source is refused (the worker's policy only lists the inbox channels)
  });
});

describe("whatsapp_accounts", () => {
  it("is visible to members of the owning workspace only", async () => {
    expect(await q(app, ctx(U.owner, A), sql`SELECT waba_id FROM whatsapp_accounts`)).toHaveLength(1);
    expect(await q(app, ctx(U.viewer, A), sql`SELECT waba_id FROM whatsapp_accounts`)).toHaveLength(1);
    expect(await q(app, ctx(U.ownerB, B), sql`SELECT id FROM whatsapp_accounts WHERE id = ${msgA}`)).toEqual([]);
    expect(await q(app, ctx(U.ownerB, A), sql`SELECT id FROM whatsapp_accounts`)).toEqual([]); // a member of B naming workspace A sees nothing
    expect(await q(app, ctx(U.owner), sql`SELECT id FROM whatsapp_accounts`)).toEqual([]); // no workspace context
    expect(await q(worker, ctx(undefined, B), sql`SELECT id FROM whatsapp_accounts WHERE id = ${msgA}`)).toEqual([]);
    expect(await q(worker, ctx(), sql`SELECT id FROM whatsapp_accounts`)).toEqual([]);
  });
  it("cannot be written by the app role or the ingress role", async () => {
    const acct2 = await acct(A, "whatsapp");
    await rejects(q(app, ctx(U.owner, A), sql`INSERT INTO whatsapp_accounts(workspace_id,integration_account_id,waba_id) VALUES (${A},${acct2},'123')`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE whatsapp_accounts SET display_phone_number = 'x'`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM whatsapp_accounts`), /permission denied/);
    await rejects(q(ingest, ctx(), sql`SELECT 1 FROM whatsapp_accounts`), /permission denied/);
  });
  it("is written by the worker inside its own workspace only", async () => {
    const a = await acct(A, "whatsapp");
    await q(worker, ctx(undefined, A), sql`INSERT INTO whatsapp_accounts(workspace_id,integration_account_id,waba_id) VALUES (${A},${a},${num()})`);
    const b = await acct(B, "whatsapp");
    await rejects(q(worker, ctx(undefined, A), sql`INSERT INTO whatsapp_accounts(workspace_id,integration_account_id,waba_id) VALUES (${B},${b},${num()})`), /row-level security/); // context says A, row says B
    await q(worker, ctx(undefined, A), sql`UPDATE whatsapp_accounts SET display_phone_number = '+1 555 0199', updated_at = now() WHERE id = ${msgA}`);
    expect(await q(worker, ctx(undefined, B), sql`UPDATE whatsapp_accounts SET display_phone_number = 'hijack' WHERE id = ${msgA} RETURNING id`)).toEqual([]);
  });
  it("only describes a WhatsApp account of the same workspace, one row per account, and never changes identity", async () => {
    const messenger = await acct(A, "messenger");
    await expect(root.query(`INSERT INTO whatsapp_accounts(workspace_id,integration_account_id,waba_id) VALUES ($1,$2,'1')`, [A, messenger])).rejects.toThrow(/whatsapp integration account/);
    await expect(root.query(`INSERT INTO whatsapp_accounts(workspace_id,integration_account_id,waba_id) VALUES ($1,$2,'1')`, [B, waA])).rejects.toThrow(/whatsapp integration account/); // another workspace's account (the guard fires before the foreign key)
    await expect(root.query(`INSERT INTO whatsapp_accounts(workspace_id,integration_account_id,waba_id) VALUES ($1,$2,'1')`, [A, waA])).rejects.toThrow(/whatsapp_accounts_account/); // second side row
    const fresh = await acct(A, "whatsapp");
    await expect(root.query(`INSERT INTO whatsapp_accounts(workspace_id,integration_account_id,waba_id) VALUES ($1,$2,'0123')`, [A, fresh])).rejects.toThrow(/whatsapp_accounts_waba/);
    await expect(root.query(`INSERT INTO whatsapp_accounts(workspace_id,integration_account_id,waba_id,mode) VALUES ($1,$2,'5','carrier_pigeon')`, [A, fresh])).rejects.toThrow(/whatsapp_accounts_mode/);
    await expect(root.query(`UPDATE whatsapp_accounts SET waba_id = '999' WHERE id = $1`, [msgA])).rejects.toThrow(/cannot change its identity/);
    await expect(root.query(`UPDATE whatsapp_accounts SET mode = 'coexistence' WHERE id = $1`, [msgA])).rejects.toThrow(/cannot change its identity/);
  });
});
