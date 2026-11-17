import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, schema, withContext, type Db } from "../src/index.ts";

// Telegram (MOCK ONLY so far): telegram_accounts is tenant isolated (forced RLS, column grants that hide the path id and the secret hash, guard trigger), the ingest lookup function, the dedupe index and the unreachable flag.
const NAME = process.env.CRM_DB_NAME ?? "crm";
const url = (u: string, p: string) => `postgres://${u}:${p}@127.0.0.1:5436/${NAME}`;
const ADMIN = process.env.DATABASE_URL_ADMIN ?? url("postgres", "postgres");
const run = Date.now().toString(36);
const U = { owner: `tg-owner-${run}`, viewer: `tg-viewer-${run}`, ownerB: `tg-ownerb-${run}` };
let app: Db, worker: Db, ingest: Db, root: pg.Client;
let A = "", B = "", tgA = "", tgB = "", rowA = "";
const botOf = new Map<string, string>();
const HASH = "ab".repeat(32);
const path = () => `p${Date.now()}${String(n++).padStart(6, "0")}`.padEnd(30, "x");
let n = 0;
const num = () => `9${Date.now()}${String(n++).padStart(4, "0")}`;
const ctx = (userId?: string, workspaceId?: string) => ({ userId, workspaceId });
const q = <T = Record<string, unknown>>(db: Db, c: ReturnType<typeof ctx>, s: ReturnType<typeof sql>) => withContext(db, c, async (tx) => (await tx.execute(s)).rows as T[]);
const rejects = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toMatchObject({ cause: { message: expect.stringMatching(re) } });
const acct = async (ws: string, platform: string) => { const bot = num(); const id = (await root.query(`INSERT INTO integration_accounts(workspace_id,platform,external_account_id) VALUES ($1,$2,$3) RETURNING id`, [ws, platform, bot])).rows[0].id as string; botOf.set(id, bot); return id; };

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
  A = await mk(U.owner, `tg-a-${run}`); B = await mk(U.ownerB, `tg-b-${run}`);
  await withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.memberships).values([{ workspaceId: A, userId: U.viewer, role: "viewer" }]));
  tgA = await acct(A, "telegram"); tgB = await acct(B, "telegram");
  rowA = (await root.query(`INSERT INTO telegram_accounts(workspace_id,integration_account_id,bot_id,bot_username,webhook_path_id,secret_hash) VALUES ($1,$2,$3,'a_bot',$4,$5) RETURNING id`, [A, tgA, botOf.get(tgA), path(), HASH])).rows[0].id;
  await root.query(`INSERT INTO telegram_accounts(workspace_id,integration_account_id,bot_id,webhook_path_id,secret_hash) VALUES ($1,$2,$3,$4,$5)`, [B, tgB, botOf.get(tgB), path(), HASH]);
});
afterAll(async () => { await Promise.all([app.$client.end(), worker.$client.end(), ingest.$client.end(), root.end()]); });


describe("telegram_accounts", () => {
  it("members see their workspace's rows only, and never the path id or the secret hash", async () => {
    expect(await q(app, ctx(U.owner, A), sql`SELECT bot_id, bot_username FROM telegram_accounts`)).toHaveLength(1);
    expect(await q(app, ctx(U.viewer, A), sql`SELECT bot_id FROM telegram_accounts`)).toHaveLength(1);
    expect(await q(app, ctx(U.ownerB, A), sql`SELECT bot_id FROM telegram_accounts`)).toEqual([]);
    expect(await q(app, ctx(U.owner), sql`SELECT bot_id FROM telegram_accounts`)).toEqual([]);
    await rejects(q(app, ctx(U.owner, A), sql`SELECT secret_hash FROM telegram_accounts`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`SELECT webhook_path_id FROM telegram_accounts`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`SELECT * FROM telegram_accounts`), /permission denied/);
  });
  it("the application and ingest roles cannot write; the worker is bound to its workspace context", async () => {
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE telegram_accounts SET bot_username = 'x'`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM telegram_accounts`), /permission denied/);
    await rejects(q(ingest, ctx(), sql`SELECT 1 FROM telegram_accounts`), /permission denied/);
    await rejects(q(ingest, ctx(), sql`INSERT INTO telegram_accounts(workspace_id,integration_account_id,bot_id,webhook_path_id,secret_hash) VALUES (${A},${tgA},'1','${sql.raw(path())}','${sql.raw(HASH)}')`), /permission denied/);
    await q(worker, ctx(undefined, A), sql`UPDATE telegram_accounts SET bot_username = 'renamed', secret_hash = ${"cd".repeat(32)}, updated_at = now() WHERE id = ${rowA}`);
    expect(await q(worker, ctx(undefined, B), sql`UPDATE telegram_accounts SET bot_username = 'hijack' WHERE id = ${rowA} RETURNING id`)).toEqual([]);
    expect(await q(worker, ctx(), sql`SELECT id FROM telegram_accounts`)).toEqual([]);
    const b = await acct(B, "telegram");
    await rejects(q(worker, ctx(undefined, A), sql`INSERT INTO telegram_accounts(workspace_id,integration_account_id,bot_id,webhook_path_id,secret_hash) VALUES (${B},${b},${botOf.get(b)!},${path()},${HASH})`), /row-level security/);
  });
  it("guard and constraints: only a telegram account of the same workspace and bot, fixed identity, unique path, well-formed values", async () => {
    const messenger = await acct(A, "messenger");
    const ins = (ws: string, id: string, bot: string, p = path(), h = HASH) => root.query(`INSERT INTO telegram_accounts(workspace_id,integration_account_id,bot_id,webhook_path_id,secret_hash) VALUES ($1,$2,$3,$4,$5)`, [ws, id, bot, p, h]);
    await expect(ins(A, messenger, botOf.get(messenger)!)).rejects.toThrow(/telegram integration account/);
    await expect(ins(B, tgA, botOf.get(tgA)!)).rejects.toThrow(/telegram integration account/); // another workspace's account
    await expect(ins(A, tgA, botOf.get(tgA)!)).rejects.toThrow(/telegram_accounts_account/); // second side row
    const fresh = await acct(A, "telegram");
    await expect(ins(A, fresh, "999999")).rejects.toThrow(/telegram integration account/); // bot id must equal the account's external id
    await expect(ins(A, fresh, botOf.get(fresh)!, "short")).rejects.toThrow(/telegram_accounts_path_fmt/);
    await expect(ins(A, fresh, botOf.get(fresh)!, path(), "nothex")).rejects.toThrow(/telegram_accounts_secret_fmt/);
    await expect(root.query(`UPDATE telegram_accounts SET bot_id = '1' WHERE id = $1`, [rowA])).rejects.toThrow(/cannot change its identity/);
    const [taken] = (await root.query(`SELECT webhook_path_id FROM telegram_accounts WHERE id = $1`, [rowA])).rows;
    await expect(ins(A, fresh, botOf.get(fresh)!, taken.webhook_path_id)).rejects.toThrow(/telegram_accounts_path/);
  });
});

describe("telegram ingest", () => {
  it("telegram_ingest_lookup gives the ingest role the bot id and secret hash of one path id, nothing else, and nothing for an unknown path", async () => {
    const [{ webhook_path_id }] = (await root.query(`SELECT webhook_path_id FROM telegram_accounts WHERE id = $1`, [rowA])).rows;
    const found = (await ingest.$client.query("SELECT bot_id, secret_hash FROM telegram_ingest_lookup($1)", [webhook_path_id])).rows;
    expect(found).toEqual([{ bot_id: botOf.get(tgA), secret_hash: "cd".repeat(32) }]);
    expect((await ingest.$client.query("SELECT * FROM telegram_ingest_lookup($1)", ["x".repeat(30)])).rows).toEqual([]);
    await expect(app.$client.query("SELECT * FROM telegram_ingest_lookup($1)", [webhook_path_id])).rejects.toThrow(/permission denied/);
  });
  it("an identical telegram body for one bot is stored once (ON CONFLICT DO NOTHING); the same body for another bot is a different event", async () => {
    const ins = (ref: string) => ingest.$client.query(`INSERT INTO webhook_events(platform,signature_valid,raw_body,body_sha256,body_size,account_ref,status) VALUES ('telegram',true,'\\x7b7d',decode(repeat('ab',32),'hex'),2,$1,'received') ON CONFLICT DO NOTHING`, [ref]);
    const ref = botOf.get(tgA)!;
    expect((await ins(ref)).rowCount).toBe(1);
    expect((await ins(ref)).rowCount).toBe(0);
    expect((await ins(botOf.get(tgB)!)).rowCount).toBe(1);
    // rejected rows (no account, no hash) are never deduped
    const rej = () => ingest.$client.query(`INSERT INTO webhook_events(platform,signature_valid,raw_body,body_sha256,body_size,account_ref,status) VALUES ('telegram',false,NULL,NULL,5,NULL,'rejected')`);
    expect((await rej()).rowCount).toBe(1);
    expect((await rej()).rowCount).toBe(1);
  });
  it("the unreachable flag is writable by the worker only", async () => {
    const stage = { id: (await root.query(`INSERT INTO lifecycle_stages(workspace_id,name,position) VALUES ($1,'New',0) RETURNING id`, [A])).rows[0].id };
    const c = (await root.query(`INSERT INTO contacts(workspace_id,name,lifecycle_stage_id,source) VALUES ($1,'Telegram user 1234',$2,'telegram') RETURNING id`, [A, stage.id])).rows[0].id;
    const idn = (await root.query(`INSERT INTO platform_identities(workspace_id,integration_account_id,external_user_id,contact_id) VALUES ($1,$2,'424242',$3) RETURNING id`, [A, tgA, c])).rows[0].id;
    const cv = (await root.query(`INSERT INTO conversations(workspace_id,integration_account_id,identity_id,contact_id) VALUES ($1,$2,$3,$4) RETURNING id`, [A, tgA, idn, c])).rows[0].id;
    await q(worker, ctx(undefined, A), sql`UPDATE conversations SET contact_unreachable_at = now() WHERE id = ${cv}`);
    expect((await q<{ contact_unreachable_at: string | null }>(app, ctx(U.owner, A), sql`SELECT contact_unreachable_at FROM conversations WHERE id = ${cv}`))[0]!.contact_unreachable_at).not.toBeNull();
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE conversations SET contact_unreachable_at = NULL WHERE id = ${cv}`), /permission denied/);
  });
});
