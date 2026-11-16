import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, schema, withContext, type Db } from "../src/index.ts";

// CAPI slice 1: datasets, sealed tokens, consent and the event queue are tenant isolated, role scoped, and guarded.
const NAME = process.env.CRM_DB_NAME ?? "crm";
const url = (u: string, p: string) => `postgres://${u}:${p}@127.0.0.1:5436/${NAME}`;
const run = Date.now().toString(36);
const U = { owner: `cp-owner-${run}`, agent: `cp-agent-${run}`, viewer: `cp-viewer-${run}`, ownerB: `cp-ownerb-${run}` };
let app: Db, worker: Db, root: pg.Client;
let A = "", B = "", dsA = "", dsB = "", contactA = "";
let n = 0;
const ctx = (userId?: string, workspaceId?: string) => ({ userId, workspaceId });
const q = <T = Record<string, unknown>>(db: Db, c: ReturnType<typeof ctx>, s: ReturnType<typeof sql>) => withContext(db, c, async (tx) => (await tx.execute(s)).rows as T[]);
const rejects = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toMatchObject({ cause: { message: expect.stringMatching(re) } });
const payload = JSON.stringify({ event_name: "Lead", user_data: { em: ["a".repeat(64)] } });
const event = (ws: string, ds: string, status = "pending", eid = `e${run}${n++}`) =>
  sql`INSERT INTO capi_events(workspace_id,dataset_id,contact_id,event_name,event_id,crm_event_ref,event_time,payload,status) VALUES (${ws},${ds},${ws === A ? contactA : null},'Lead',${eid},'ref',now(),${payload}::jsonb,${status})`;

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
  A = await mk(U.owner, `cp-a-${run}`); B = await mk(U.ownerB, `cp-b-${run}`);
  await withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.memberships).values([{ workspaceId: A, userId: U.agent, role: "agent" }, { workspaceId: A, userId: U.viewer, role: "viewer" }]));
  const stage = (await root.query(`INSERT INTO lifecycle_stages(workspace_id,name,position) VALUES ($1,'New',0) RETURNING id`, [A])).rows[0].id;
  contactA = (await root.query(`INSERT INTO contacts(workspace_id,name,lifecycle_stage_id,source) VALUES ($1,'C',$2,'manual') RETURNING id`, [A, stage])).rows[0].id;
  const ds = (ws: string, d: string) => root.query(`INSERT INTO capi_datasets(workspace_id,dataset_id,name,token_last4) VALUES ($1,$2,'ds','abcd') RETURNING id`, [ws, d]).then((r) => r.rows[0].id as string);
  dsA = await ds(A, "1001"); dsB = await ds(B, "1002");
  for (const [ws, d] of [[A, dsA], [B, dsB]] as const) await root.query(`INSERT INTO capi_dataset_secrets(workspace_id,dataset_id,ciphertext,nonce,key_id) VALUES ($1,$2,decode(repeat('ab',20),'hex'),decode(repeat('cd',12),'hex'),'k1')`, [ws, d]);
});
afterAll(async () => { await Promise.all([app.$client.end(), worker.$client.end(), root.end()]); });

describe("datasets and sealed tokens", () => {
  it("datasets are visible to owner and agent of their workspace only; viewers and outsiders see nothing", async () => {
    expect(await q(app, ctx(U.owner, A), sql`SELECT id FROM capi_datasets`)).toHaveLength(1);
    expect(await q(app, ctx(U.agent, A), sql`SELECT id FROM capi_datasets`)).toHaveLength(1);
    expect(await q(app, ctx(U.viewer, A), sql`SELECT id FROM capi_datasets`)).toEqual([]);
    expect(await q(app, ctx(U.ownerB, A), sql`SELECT id FROM capi_datasets`)).toEqual([]);
    expect(await q(app, ctx(U.ownerB, B), sql`SELECT id FROM capi_datasets WHERE id = ${dsA}`)).toEqual([]);
    expect(await q(app, ctx(U.owner), sql`SELECT id FROM capi_datasets`)).toEqual([]);
  });
  it("the app role can never read, update or delete the sealed token; the worker reads only its workspace's", async () => {
    await rejects(q(app, ctx(U.owner, A), sql`SELECT ciphertext FROM capi_dataset_secrets`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`SELECT count(*) FROM capi_dataset_secrets`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE capi_dataset_secrets SET key_id = 'x'`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM capi_dataset_secrets`), /permission denied/);
    expect(await q(worker, ctx(undefined, A), sql`SELECT dataset_id FROM capi_dataset_secrets`)).toHaveLength(1);
    expect(await q(worker, ctx(undefined, A), sql`SELECT dataset_id FROM capi_dataset_secrets WHERE dataset_id = ${dsB}`)).toEqual([]);
    expect(await q(worker, ctx(), sql`SELECT dataset_id FROM capi_dataset_secrets`)).toEqual([]);
  });
  it("only owner/admin create datasets, and only in their own workspace", async () => {
    const ins = (ws: string, d: string) => sql`INSERT INTO capi_datasets(workspace_id,dataset_id,name,token_last4) VALUES (${ws},${d},'x','1234')`;
    await rejects(q(app, ctx(U.agent, A), ins(A, "2001")), /row-level security/);
    await rejects(q(app, ctx(U.owner, A), ins(B, "2002")), /row-level security/);
    await q(app, ctx(U.owner, A), ins(A, `3${Date.now()}`));
    await rejects(q(app, ctx(U.owner, A), sql`INSERT INTO capi_datasets(workspace_id,dataset_id,name,token_last4) VALUES (${A},'1001','dup','1234')`), /capi_datasets_ws_dataset/);
    await rejects(q(app, ctx(U.owner, A), sql`INSERT INTO capi_datasets(workspace_id,dataset_id,name,token_last4,events) VALUES (${A},'4001','x','1234','{PageView}')`), /capi_datasets_events/);
  });
  it("a dataset keeps its identity and a disabled one cannot come back", async () => {
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE capi_datasets SET dataset_id = '9' WHERE id = ${dsA}`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE capi_datasets SET token_last4 = 'zzzz' WHERE id = ${dsA}`), /permission denied/);
    await rejects(q(worker, ctx(undefined, A), sql`UPDATE capi_datasets SET status = 'disabled'`), /permission denied/);
    const d = (await root.query(`INSERT INTO capi_datasets(workspace_id,dataset_id,name,token_last4) VALUES ($1,'5001','d','1234') RETURNING id`, [A])).rows[0].id;
    await q(app, ctx(U.owner, A), sql`UPDATE capi_datasets SET status = 'disabled', updated_at = now() WHERE id = ${d}`);
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE capi_datasets SET status = 'active' WHERE id = ${d}`), /cannot be re-enabled/);
    expect(await q(app, ctx(U.ownerB, B), sql`UPDATE capi_datasets SET status = 'disabled' WHERE id = ${dsA} RETURNING id`)).toEqual([]);
  });
});

describe("consent_records", () => {
  it("is append-only, written by owner/admin/agent as themselves, never by viewers", async () => {
    const ins = (u: string, status = "granted") => sql`INSERT INTO consent_records(workspace_id,contact_id,status,source,recorded_by) VALUES (${A},${contactA},${status},'manual',${u}) RETURNING id`;
    await q(app, ctx(U.agent, A), ins(U.agent));
    await rejects(q(app, ctx(U.viewer, A), ins(U.viewer)), /row-level security/);
    await rejects(q(app, ctx(U.agent, A), ins(U.owner)), /row-level security/); // cannot record as someone else
    const id = (await q<{ id: string }>(app, ctx(U.owner, A), ins(U.owner, "revoked")))[0]!.id;
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE consent_records SET status = 'granted' WHERE id = ${id}`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM consent_records`), /permission denied/);
    await expect(root.query(`UPDATE consent_records SET status = 'granted'`)).rejects.toThrow(/append-only/);
    await expect(root.query(`DELETE FROM consent_records`)).rejects.toThrow(/append-only/);
  });
  it("is isolated per workspace and readable by the worker only under its workspace", async () => {
    expect((await q(app, ctx(U.owner, A), sql`SELECT id FROM consent_records`)).length).toBeGreaterThan(0);
    expect(await q(app, ctx(U.ownerB, B), sql`SELECT id FROM consent_records`)).toEqual([]);
    expect((await q(worker, ctx(undefined, A), sql`SELECT id FROM consent_records`)).length).toBeGreaterThan(0);
    expect(await q(worker, ctx(undefined, B), sql`SELECT id FROM consent_records`)).toEqual([]);
    await rejects(q(app, ctx(U.owner, A), sql`INSERT INTO consent_records(workspace_id,contact_id,status,source,recorded_by) VALUES (${B},${contactA},'granted','manual',${U.owner})`), /row-level security/);
  });
});

describe("capi_events", () => {
  it("the app role may enqueue pending or skipped events only, and event_id is unique per dataset", async () => {
    const eid = `dup${run}`;
    await q(app, ctx(U.agent, A), event(A, dsA, "pending", eid));
    await rejects(q(app, ctx(U.agent, A), event(A, dsA, "pending", eid)), /capi_events_dataset_event/);
    await q(app, ctx(U.agent, A), event(A, dsA, "skipped_no_consent"));
    await rejects(q(app, ctx(U.agent, A), event(A, dsA, "sent")), /row-level security/);
    await rejects(q(app, ctx(U.viewer, A), event(A, dsA)), /row-level security/);
    await rejects(q(app, ctx(U.agent, A), event(B, dsB)), /row-level security/);
    await rejects(q(app, ctx(U.agent, A), event(A, dsB)), /capi_events_dataset_fk|row-level security|violates foreign key/); // another workspace's dataset
  });
  it("rows are visible to owner/admin/agent of the workspace only (the endpoint narrows it to owner/admin)", async () => {
    const mine = await q(app, ctx(U.owner, A), sql`SELECT id FROM capi_events`);
    expect(mine.length).toBeGreaterThan(0);
    expect((await q(app, ctx(U.agent, A), sql`SELECT id FROM capi_events`)).length).toBeGreaterThan(0);
    expect(await q(app, ctx(U.viewer, A), sql`SELECT id FROM capi_events`)).toEqual([]);
    expect(await q(app, ctx(U.ownerB, B), sql`SELECT id FROM capi_events`)).toEqual([]);
    expect(await q(app, ctx(U.ownerB, A), sql`SELECT id FROM capi_events`)).toEqual([]);
  });
  it("the app role cannot update or delete events", async () => {
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE capi_events SET event_id = 'x'`), /permission denied/); // only status/payload/last_error/updated_at are granted (0029), and only for deleted contacts
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM capi_events`), /permission denied/);
    await expect(root.query(`DELETE FROM capi_events`)).rejects.toThrow(/append-only/);
  });
  it("the worker moves a pending event forward but cannot change identity, rewrite the payload, or touch a final row", async () => {
    const id = (await root.query(`INSERT INTO capi_events(workspace_id,dataset_id,event_name,event_id,crm_event_ref,event_time,payload) VALUES ($1,$2,'Lead','w${run}','r',now(),$3::jsonb) RETURNING id`, [A, dsA, payload])).rows[0].id;
    await rejects(q(worker, ctx(undefined, A), sql`UPDATE capi_events SET event_id = 'other' WHERE id = ${id}`), /permission denied/);
    await rejects(q(worker, ctx(undefined, A), sql`UPDATE capi_events SET payload = '{"event_name":"Purchase"}'::jsonb WHERE id = ${id}`), /only have its user_data blanked/);
    await q(worker, ctx(undefined, A), sql`UPDATE capi_events SET attempts = attempts + 1, next_attempt_at = now() + interval '2 minutes', updated_at = now() WHERE id = ${id}`);
    await rejects(q(worker, ctx(undefined, A), sql`UPDATE capi_events SET attempts = 0 WHERE id = ${id}`), /attempts only go up/);
    await rejects(q(worker, ctx(undefined, A), sql`UPDATE capi_events SET last_error = 'Bad Value With Spaces' WHERE id = ${id}`), /capi_events_last_error/);
    await q(worker, ctx(undefined, A), sql`UPDATE capi_events SET payload = jsonb_set(payload, '{user_data}', '{}'::jsonb) WHERE id = ${id}`); // blanking identifiers is allowed
    await rejects(q(worker, ctx(undefined, A), sql`UPDATE capi_events SET status = 'sent' WHERE id = ${id}`), /capi_events_sent/); // sent needs sent_at
    await q(worker, ctx(undefined, A), sql`UPDATE capi_events SET status = 'sent', sent_at = now() WHERE id = ${id}`);
    await rejects(q(worker, ctx(undefined, A), sql`UPDATE capi_events SET status = 'failed' WHERE id = ${id}`), /is final/);
  });
  it("the worker claims across workspaces (the queue), but sees nothing without a workspace for datasets", async () => {
    expect((await q(worker, ctx(), sql`SELECT workspace_id FROM capi_events WHERE status = 'pending'`)).length).toBeGreaterThan(0);
    expect(await q(worker, ctx(), sql`SELECT id FROM capi_datasets`)).toEqual([]);
    expect(await q(worker, ctx(undefined, B), sql`SELECT id FROM capi_datasets WHERE id = ${dsA}`)).toEqual([]);
  });
});

describe("capi contact cleanup (0029)", () => {
  it("the app role can cancel or scrub events only for a soft-deleted contact, and only in the allowed shape", async () => {
    const c = (await root.query(`INSERT INTO contacts(workspace_id,name,lifecycle_stage_id,source) VALUES ($1,'D',(SELECT id FROM lifecycle_stages WHERE workspace_id=$1 LIMIT 1),'manual') RETURNING id`, [A])).rows[0].id as string;
    const mk = async (status: string) => (await root.query(`INSERT INTO capi_events(workspace_id,dataset_id,contact_id,event_name,event_id,crm_event_ref,event_time,payload,status,sent_at) VALUES ($1,$2,$3,'Lead',$4,'r',now(),$5::jsonb,$6,${status === "sent" ? "now()" : "NULL"}) RETURNING id`, [A, dsA, c, `x${run}${n++}`, payload, status])).rows[0].id as string;
    const pend = await mk("pending"), sent = await mk("sent");
    const stat = async (id: string) => (await root.query(`SELECT status, payload FROM capi_events WHERE id=$1`, [id])).rows[0];
    await q(app, ctx(U.owner, A), sql`UPDATE capi_events SET status='cancelled', payload='{}'::jsonb WHERE id = ${pend}`);
    expect((await stat(pend)).status).toBe("pending"); // contact is live: the policy matches no row
    await root.query(`UPDATE contacts SET deleted_at = now() WHERE id=$1`, [c]);
    await q(app, ctx(U.agent, A), sql`UPDATE capi_events SET payload='{}'::jsonb WHERE id = ${sent}`);
    expect((await stat(sent)).payload).not.toEqual({}); // agent: no row matches
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE capi_events SET status='failed' WHERE id = ${pend}`), /./); // not a cancel: the guard refuses
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE capi_events SET status='failed', payload='{}'::jsonb WHERE id = ${sent}`), /is final/);
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE capi_events SET status='cancelled' WHERE id = ${pend}`), /must have its payload purged/);
    await q(app, ctx(U.owner, A), sql`UPDATE capi_events SET status='cancelled', payload='{}'::jsonb, last_error='contact_deleted' WHERE id = ${pend}`);
    await q(app, ctx(U.owner, A), sql`UPDATE capi_events SET payload='{}'::jsonb WHERE id = ${sent}`);
    expect(await stat(pend)).toEqual({ status: "cancelled", payload: {} });
    expect(await stat(sent)).toEqual({ status: "sent", payload: {} });
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE capi_events SET status='sent' WHERE id = ${pend}`), /./);
    await expect(root.query(`DELETE FROM capi_events WHERE id=$1`, [sent])).rejects.toThrow(/append-only/);
  });
});
