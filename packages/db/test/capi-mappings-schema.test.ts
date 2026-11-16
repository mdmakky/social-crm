import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, schema, withContext, type Db } from "../src/index.ts";

// Migration 0034: capi_event_mappings is tenant isolated, role scoped, constrained, capped at 50 per dataset; the seed is additive and idempotent.
const NAME = process.env.CRM_DB_NAME ?? "crm";
const url = (u: string, p: string) => `postgres://${u}:${p}@127.0.0.1:5436/${NAME}`;
const run = Date.now().toString(36);
const U = { owner: `cm-owner-${run}`, admin: `cm-admin-${run}`, agent: `cm-agent-${run}`, viewer: `cm-viewer-${run}`, ownerB: `cm-ownerb-${run}` };
let app: Db, worker: Db, root: pg.Client;
let A = "", B = "", dsA = "", dsB = "", stageA = "", stageB = "";
let n = 0;
const ctx = (userId?: string, workspaceId?: string) => ({ userId, workspaceId });
const q = <T = Record<string, unknown>>(db: Db, c: ReturnType<typeof ctx>, s: ReturnType<typeof sql>) => withContext(db, c, async (tx) => (await tx.execute(s)).rows as T[]);
const rejects = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toMatchObject({ cause: { message: expect.stringMatching(re) } });
const ins = (ws: string, ds: string, o: Record<string, unknown> = {}, by = U.owner) => {
  const v = { trigger_type: "lead_won", stage_id: null, event_name: "Purchase", value_mode: "lead_value", fixed_value_minor: null, currency: null, ...o };
  return sql`INSERT INTO capi_event_mappings(workspace_id,dataset_id,trigger_type,stage_id,event_name,value_mode,fixed_value_minor,currency,created_by) VALUES (${ws},${ds},${v.trigger_type},${v.stage_id},${v.event_name},${v.value_mode},${v.fixed_value_minor},${v.currency},${by})`;
};
const mkDs = async (ws: string, events = "{}") => (await root.query(`INSERT INTO capi_datasets(workspace_id,dataset_id,name,token_last4,events) VALUES ($1,$2,'ds','abcd',$3) RETURNING id`, [ws, `9${Date.now()}${n++}`, events])).rows[0].id as string;

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
  A = await mk(U.owner, `cm-a-${run}`); B = await mk(U.ownerB, `cm-b-${run}`);
  await withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.memberships).values([{ workspaceId: A, userId: U.admin, role: "admin" }, { workspaceId: A, userId: U.agent, role: "agent" }, { workspaceId: A, userId: U.viewer, role: "viewer" }]));
  const stageOf = async (ws: string) => {
    const pl = (await root.query(`INSERT INTO pipelines(workspace_id,name,kind,position,is_default) VALUES ($1,'P','lead',1,true) RETURNING id`, [ws])).rows[0].id;
    return (await root.query(`INSERT INTO pipeline_stages(workspace_id,pipeline_id,name,kind,default_probability,position) VALUES ($1,$2,'S','open',10,1) RETURNING id`, [ws, pl])).rows[0].id as string;
  };
  stageA = await stageOf(A); stageB = await stageOf(B);
  dsA = await mkDs(A); dsB = await mkDs(B);
});
afterAll(async () => { await Promise.all([app.$client.end(), worker.$client.end(), root.end()]); });

describe("roles and tenancy", () => {
  it("owner and admin write; agent reads only; viewer, outsiders and the worker see nothing", async () => {
    await q(app, ctx(U.owner, A), ins(A, dsA, { event_name: "Lead", trigger_type: "lead_created" }));
    await q(app, ctx(U.admin, A), ins(A, dsA, { event_name: "Contact", trigger_type: "lead_created" }, U.admin));
    await rejects(q(app, ctx(U.agent, A), ins(A, dsA, { event_name: "Schedule", trigger_type: "lead_created" }, U.agent)), /row-level security/);
    await rejects(q(app, ctx(U.viewer, A), ins(A, dsA, { event_name: "Schedule", trigger_type: "lead_created" }, U.viewer)), /row-level security/);
    expect(await q(app, ctx(U.agent, A), sql`SELECT id FROM capi_event_mappings`)).toHaveLength(2);
    expect(await q(app, ctx(U.viewer, A), sql`SELECT id FROM capi_event_mappings`)).toEqual([]);
    expect(await q(app, ctx(U.ownerB, B), sql`SELECT id FROM capi_event_mappings`)).toEqual([]);
    expect(await q(app, ctx(U.ownerB, A), sql`SELECT id FROM capi_event_mappings`)).toEqual([]);
    expect(await q(app, ctx(U.owner), sql`SELECT id FROM capi_event_mappings`)).toEqual([]);
    await rejects(q(worker, ctx(undefined, A), sql`SELECT id FROM capi_event_mappings`), /permission denied/);
  });
  it("cannot write into another workspace, spoof created_by, point at another workspace's dataset or stage; the agent cannot update or delete", async () => {
    await rejects(q(app, ctx(U.owner, A), ins(B, dsB)), /row-level security/);
    await rejects(q(app, ctx(U.owner, A), ins(A, dsA, { event_name: "Donate", trigger_type: "lead_created" }, U.admin)), /row-level security/);
    await rejects(q(app, ctx(U.owner, A), ins(A, dsB, { event_name: "Donate", trigger_type: "lead_created" })), /foreign key/);
    await rejects(q(app, ctx(U.owner, A), ins(A, dsA, { trigger_type: "lead_stage_entered", stage_id: stageB, event_name: "Lead" })), /foreign key/);
    await q(app, ctx(U.owner, A), ins(A, dsA, { trigger_type: "lead_stage_entered", stage_id: stageA, event_name: "Lead" }));
    expect(await q(app, ctx(U.agent, A), sql`UPDATE capi_event_mappings SET enabled = false RETURNING id`)).toEqual([]);
    expect(await q(app, ctx(U.agent, A), sql`DELETE FROM capi_event_mappings RETURNING id`)).toEqual([]);
    expect(await q(app, ctx(U.ownerB, B), sql`DELETE FROM capi_event_mappings RETURNING id`)).toEqual([]);
  });
  it("identity columns cannot be changed", async () => {
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE capi_event_mappings SET dataset_id = ${dsB}`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE capi_event_mappings SET created_by = ${U.admin}`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE capi_event_mappings SET workspace_id = ${B}`), /permission denied/);
  });
});

describe("constraints", () => {
  it("rejects bad triggers, stage rules, names, value rules; allows custom names", async () => {
    const d = await mkDs(A);
    const bad = (o: Record<string, unknown>, re = /check constraint/) => rejects(q(app, ctx(U.owner, A), ins(A, d, o)), re);
    await bad({ trigger_type: "lead_deleted" });
    await bad({ trigger_type: "lead_stage_entered" }); // needs a stage
    await bad({ trigger_type: "lead_won", stage_id: stageA }); // a stage only with stage entered
    await bad({ event_name: "1Bad" }); await bad({ event_name: "Has Space" }); await bad({ event_name: "x".repeat(41) }); await bad({ event_name: "" });
    await bad({ value_mode: "weird" });
    await bad({ value_mode: "fixed" }); await bad({ value_mode: "fixed", fixed_value_minor: 100 }); await bad({ value_mode: "fixed", currency: "USD" });
    await bad({ value_mode: "fixed", fixed_value_minor: -1, currency: "USD" });
    await bad({ value_mode: "lead_value", fixed_value_minor: 100, currency: "USD" });
    await bad({ value_mode: "fixed", fixed_value_minor: 100, currency: "usd" });
    await bad({ event_name: "Purchase", value_mode: "none" });
    await q(app, ctx(U.owner, A), ins(A, d, { event_name: "Custom_Event_1", value_mode: "none" }));
    await q(app, ctx(U.owner, A), ins(A, d, { event_name: "Subscribe", value_mode: "fixed", fixed_value_minor: 0, currency: "USD" }));
  });
  it("the same (dataset, trigger, stage, event) is unique even when the stage is null; the same rule on another dataset is fine", async () => {
    const d = await mkDs(A), d2 = await mkDs(A);
    await q(app, ctx(U.owner, A), ins(A, d, { event_name: "Lead", trigger_type: "lead_created" }));
    await rejects(q(app, ctx(U.owner, A), ins(A, d, { event_name: "Lead", trigger_type: "lead_created" })), /duplicate key/);
    await q(app, ctx(U.owner, A), ins(A, d, { event_name: "Contact", trigger_type: "lead_created" }));
    await q(app, ctx(U.owner, A), ins(A, d2, { event_name: "Lead", trigger_type: "lead_created" }));
    await q(app, ctx(U.owner, A), ins(A, d, { event_name: "Lead", trigger_type: "lead_stage_entered", stage_id: stageA }));
    await rejects(q(app, ctx(U.owner, A), ins(A, d, { event_name: "Lead", trigger_type: "lead_stage_entered", stage_id: stageA })), /duplicate key/);
  });
  it("at most 50 per dataset, also under concurrent inserts", async () => {
    const d = await mkDs(A);
    await Promise.all(Array.from({ length: 30 }, (_, i) => q(app, ctx(U.owner, A), ins(A, d, { event_name: `E${i}`, value_mode: "none" }))));
    await Promise.all(Array.from({ length: 30 }, (_, i) => q(app, ctx(U.owner, A), ins(A, d, { event_name: `F${i}`, value_mode: "none" })).catch(() => null)));
    expect(Number((await root.query(`SELECT count(*) FROM capi_event_mappings WHERE dataset_id=$1`, [d])).rows[0].count)).toBe(50);
    await rejects(q(app, ctx(U.owner, A), ins(A, d, { event_name: "Over", value_mode: "none" })), /at most 50/);
  });
});

describe("seed (migration 0034)", () => {
  const seed = readFileSync(new URL("../drizzle/0034_capi_event_mappings.sql", import.meta.url), "utf8").match(/INSERT INTO capi_event_mappings[\s\S]*?ON CONFLICT DO NOTHING;/)![0];
  it("creates lead won -> Purchase for a dataset with no mapping (on only if it opted in), never touches the others, and is idempotent", async () => {
    const withPurchase = await mkDs(A, "{Purchase}"), without = await mkDs(A, "{Lead}"), edited = await mkDs(A, "{Purchase}");
    await root.query(`INSERT INTO capi_event_mappings(workspace_id,dataset_id,trigger_type,event_name,value_mode,enabled) VALUES ($1,$2,'lead_created','Lead','none',false)`, [A, edited]);
    await root.query(seed);
    await root.query(seed);
    const of = async (d: string) => (await root.query(`SELECT trigger_type,event_name,value_mode,enabled,stage_id FROM capi_event_mappings WHERE dataset_id=$1 ORDER BY event_name`, [d])).rows;
    expect(await of(withPurchase)).toEqual([{ trigger_type: "lead_won", event_name: "Purchase", value_mode: "lead_value", enabled: true, stage_id: null }]);
    expect(await of(without)).toEqual([{ trigger_type: "lead_won", event_name: "Purchase", value_mode: "lead_value", enabled: false, stage_id: null }]);
    expect(await of(edited)).toEqual([{ trigger_type: "lead_created", event_name: "Lead", value_mode: "none", enabled: false, stage_id: null }]); // had a rule: untouched
  });
});

describe("capi_events skipped status", () => {
  it("the app can record a skipped row (final, empty payload); the history row cannot be changed afterwards", async () => {
    const d = await mkDs(A);
    const e = (status: string) => sql`INSERT INTO capi_events(workspace_id,dataset_id,event_name,event_id,crm_event_ref,event_time,payload,status,last_error) VALUES (${A},${d},'Purchase',${`sk${run}${n++}`},'r',now(),'{}'::jsonb,${status},'no_value') RETURNING id`;
    const [row] = await q<{ id: string }>(app, ctx(U.agent, A), e("skipped"));
    await rejects(q(app, ctx(U.agent, A), e("bogus")), /check constraint|row-level security/);
    expect(await q(app, ctx(U.owner, A), sql`UPDATE capi_events SET status = 'pending' WHERE id = ${row!.id} RETURNING id`)).toEqual([]); // no policy lets the app touch it
  });
});
