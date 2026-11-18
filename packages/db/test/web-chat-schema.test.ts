import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, schema, withContext, type Db } from "../src/index.ts";

// Web chat tables: forced RLS per role, the key lookup function, token hash shape, and tenancy of visitor sessions.
const NAME = process.env.CRM_DB_NAME ?? "crm";
const url = (u: string, p: string) => `postgres://${u}:${p}@127.0.0.1:5436/${NAME}`;
const run = Date.now().toString(36);
const U = { owner: `wc-owner-${run}`, agent: `wc-agent-${run}`, ownerB: `wc-ownerb-${run}` };
let app: Db, worker: Db, root: pg.Client;
let A = "", B = "";
let widgetA = "", widgetB = "";
const keyA = `A${run}`.padEnd(32, "a");
const keyB = `B${run}`.padEnd(32, "b");
const hashA = `a${Date.now().toString(16)}`.padEnd(64, "a"); // unique per run: the database is reused between runs
const hashB = `b${Date.now().toString(16)}`.padEnd(64, "b");
const ctx = (userId?: string, workspaceId?: string) => ({ userId, workspaceId });
const q = <T = Record<string, unknown>>(db: Db, c: ReturnType<typeof ctx>, s: ReturnType<typeof sql>) => withContext(db, c, async (tx) => (await tx.execute(s)).rows as T[]);
const one = async (text: string, params: unknown[] = []) => (await root.query(text, params)).rows[0];
let n = 0;
const num = () => `${Date.now()}${String(n++).padStart(4, "0")}`;

beforeAll(async () => {
  root = new pg.Client({ connectionString: process.env.DATABASE_URL_ADMIN ?? url("postgres", "postgres") });
  await root.connect();
  app = createDb(url("crm_app", "app_dev"));
  worker = createDb(url("crm_worker", "worker_dev"));
  for (const id of Object.values(U)) await root.query(`INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,$1,$2,true) ON CONFLICT (id) DO NOTHING`, [id, `${id}@t.test`]);
  const mk = (owner: string, slug: string) => withContext(app, { userId: owner }, async (tx) => {
    const [w] = await tx.insert(schema.workspaces).values({ name: slug, slug, ownerUserId: owner }).returning();
    await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId: owner, role: "owner" });
    return w!.id;
  });
  A = await mk(U.owner, `wc-a-${run}`);
  B = await mk(U.ownerB, `wc-b-${run}`);
  await withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.memberships).values({ workspaceId: A, userId: U.agent, role: "agent" }));
  const acct = async (ws: string, owner: string) => (await q<{ id: string }>(worker, ctx(undefined, ws), sql`INSERT INTO integration_accounts(workspace_id,platform,external_account_id,connected_by) VALUES (${ws},'web_chat',${num()},${owner}) RETURNING id`))[0]!.id;
  const accA = await acct(A, U.owner);
  const accB = await acct(B, U.ownerB);
  widgetA = (await q<{ id: string }>(app, ctx(U.owner, A), sql`INSERT INTO chat_widgets(workspace_id,integration_account_id,public_key,name,created_by) VALUES (${A},${accA},${keyA},'A widget',${U.owner}) RETURNING id`))[0]!.id;
  widgetB = (await q<{ id: string }>(app, ctx(U.ownerB, B), sql`INSERT INTO chat_widgets(workspace_id,integration_account_id,public_key,name,created_by) VALUES (${B},${accB},${keyB},'B widget',${U.ownerB}) RETURNING id`))[0]!.id;
  await q(worker, ctx(undefined, A), sql`INSERT INTO chat_visitor_sessions(workspace_id,widget_id,token_hash,visitor_ref) VALUES (${A},${widgetA},${hashA},${num()})`);
  await q(worker, ctx(undefined, B), sql`INSERT INTO chat_visitor_sessions(workspace_id,widget_id,token_hash,visitor_ref) VALUES (${B},${widgetB},${hashB},${num()})`);
});
afterAll(async () => { await Promise.all([app.$client.end(), worker.$client.end(), root.end()]); });

describe("web chat tenancy", () => {
  it("a session token of workspace A is invisible inside workspace B's context, for the only role that can read sessions", async () => {
    expect(await q(worker, ctx(undefined, B), sql`SELECT 1 FROM chat_visitor_sessions WHERE token_hash = ${hashA}`)).toHaveLength(0);
    expect(await q(worker, ctx(undefined, A), sql`SELECT 1 FROM chat_visitor_sessions WHERE token_hash = ${hashA}`)).toHaveLength(1);
    expect(await q(worker, ctx(), sql`SELECT 1 FROM chat_visitor_sessions`)).toHaveLength(0); // no context, no rows
  });
  it("a session cannot be written into another workspace or point at another workspace's widget", async () => {
    await expect(q(worker, ctx(undefined, B), sql`INSERT INTO chat_visitor_sessions(workspace_id,widget_id,token_hash,visitor_ref) VALUES (${A},${widgetA},${"c".repeat(64)},${num()})`)).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } });
    await expect(root.query(`INSERT INTO chat_visitor_sessions(workspace_id,widget_id,token_hash,visitor_ref) VALUES ($1,$2,$3,$4)`, [B, widgetA, "d".repeat(64), num()])).rejects.toThrow(/foreign key/);
  });
  it("the application role never reads or writes sessions; widgets are for owner/admin only", async () => {
    await expect(q(app, ctx(U.owner, A), sql`SELECT * FROM chat_visitor_sessions`)).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
    expect(await q(app, ctx(U.agent, A), sql`SELECT id FROM chat_widgets`)).toHaveLength(0);
    expect((await q(app, ctx(U.owner, A), sql`SELECT id FROM chat_widgets`)).map((r) => r.id)).toEqual([widgetA]); // never B's
    expect(await q(app, ctx(U.owner, A), sql`UPDATE chat_widgets SET name = 'x' WHERE id = ${widgetB} RETURNING id`)).toHaveLength(0);
    await expect(q(app, ctx(U.agent, A), sql`INSERT INTO chat_widgets(workspace_id,integration_account_id,public_key,name,created_by) VALUES (${A},${widgetA},${"k".repeat(32)},'x',${U.agent})`)).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security|foreign key/) } });
    await expect(q(app, ctx(U.owner, A), sql`DELETE FROM chat_widgets WHERE id = ${widgetA}`)).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
  });
  it("chat_widget_resolve: only the worker role may call it; it returns the widget's own workspace for its key and nothing for another key", async () => {
    const r = await q<{ workspace_id: string; id: string }>(worker, ctx(), sql`SELECT * FROM chat_widget_resolve(${keyA})`);
    expect(r.map((x) => [x.id, x.workspace_id])).toEqual([[widgetA, A]]);
    expect(await q(worker, ctx(), sql`SELECT * FROM chat_widget_resolve(${"z".repeat(32)})`)).toHaveLength(0);
    await expect(q(app, ctx(U.owner, A), sql`SELECT * FROM chat_widget_resolve(${keyA})`)).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
    const fn = await one(`SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'chat_widget_resolve'`);
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toEqual(expect.arrayContaining([expect.stringMatching(/^search_path=/)]));
  });
  it("tokens are stored as 64 hex characters only, and a session's contact and conversation come together", async () => {
    await expect(root.query(`INSERT INTO chat_visitor_sessions(workspace_id,widget_id,token_hash,visitor_ref) VALUES ($1,$2,'raw-token',$3)`, [A, widgetA, num()])).rejects.toThrow(/chat_visitor_sessions_hash_shape/);
    await expect(root.query(`INSERT INTO chat_visitor_sessions(workspace_id,widget_id,token_hash,visitor_ref,contact_id) VALUES ($1,$2,$3,$4,gen_random_uuid())`, [A, widgetA, "e".repeat(64), num()])).rejects.toThrow(/chat_visitor_sessions_pair|foreign key/);
  });
  it("widget constraints: key shape, color, origins cap", async () => {
    const acc = (await one(`SELECT integration_account_id AS id FROM chat_widgets WHERE id = $1`, [widgetA])).id;
    await expect(root.query(`INSERT INTO chat_widgets(workspace_id,integration_account_id,public_key,name,created_by) VALUES ($1,$2,'short','x',$3)`, [A, acc, U.owner])).rejects.toThrow(/chat_widgets_key_shape/);
    await expect(root.query(`INSERT INTO chat_widgets(workspace_id,integration_account_id,public_key,name,color,created_by) VALUES ($1,$2,$3,'x','red',$4)`, [A, acc, "q".repeat(32), U.owner])).rejects.toThrow(/chat_widgets_color/);
  });
  it("appearance columns (0041): same RLS, constraints, resolve returns them, last_page_url is worker-only and read by the Inbox only through the narrow function", async () => {
    // owner of A can edit appearance of A's widget, never B's; an agent cannot
    expect(await q(app, ctx(U.owner, A), sql`UPDATE chat_widgets SET subtitle = 'Ask us', quick_replies = ARRAY['a','b'], position = 'left' WHERE id = ${widgetA} RETURNING id`)).toHaveLength(1);
    expect(await q(app, ctx(U.owner, A), sql`UPDATE chat_widgets SET subtitle = 'x' WHERE id = ${widgetB} RETURNING id`)).toHaveLength(0);
    expect(await q(app, ctx(U.agent, A), sql`UPDATE chat_widgets SET subtitle = 'x' WHERE id = ${widgetA} RETURNING id`)).toHaveLength(0);
    await expect(root.query(`UPDATE chat_widgets SET quick_replies = ARRAY['a','b','c','d'] WHERE id = $1`, [widgetA])).rejects.toThrow(/chat_widgets_quick/);
    await expect(root.query(`UPDATE chat_widgets SET quick_replies = ARRAY['x'||repeat('y',30)] WHERE id = $1`, [widgetA])).rejects.toThrow(/chat_widgets_quick/);
    await expect(root.query(`UPDATE chat_widgets SET avatar_url = 'http://a.example/x.png' WHERE id = $1`, [widgetA])).rejects.toThrow(/chat_widgets_avatar/);
    await expect(root.query(`UPDATE chat_widgets SET default_language = 'fr' WHERE id = $1`, [widgetA])).rejects.toThrow(/chat_widgets_lang/);
    const r = await q<{ subtitle: string; quick_replies: string[]; position: string }>(worker, ctx(), sql`SELECT * FROM chat_widget_resolve(${keyA})`);
    expect(r[0]).toMatchObject({ subtitle: "Ask us", quick_replies: ["a", "b"], position: "left" });
    // page url: worker writes, application role cannot, shape is enforced
    expect(await q(worker, ctx(undefined, A), sql`UPDATE chat_visitor_sessions SET last_page_url = 'https://a.example/p' WHERE token_hash = ${hashA} RETURNING id`)).toHaveLength(1);
    await expect(q(app, ctx(U.owner, A), sql`UPDATE chat_visitor_sessions SET last_page_url = 'https://evil.example/' WHERE token_hash = ${hashA}`)).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
    await expect(root.query(`UPDATE chat_visitor_sessions SET last_page_url = 'javascript:alert(1)' WHERE token_hash = $1`, [hashA])).rejects.toThrow(/chat_visitor_sessions_page/);
    // the Inbox lookup is scoped to the caller's workspace
    const conv = (await one(`SELECT gen_random_uuid() AS id`)).id as string;
    expect(await q(app, ctx(U.owner, B), sql`SELECT chat_conversation_page(${conv}::uuid) AS p`)).toEqual([{ p: null }]);
  });
});

