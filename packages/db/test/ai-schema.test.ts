import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, schema, withContext, type Db } from "../src/index.ts";

// AI foundation (migration 0030): configs, sealed keys, prompts, runs and budgets are tenant isolated, role scoped and guarded.
const NAME = process.env.CRM_DB_NAME ?? "crm";
const url = (u: string, p: string) => `postgres://${u}:${p}@127.0.0.1:5436/${NAME}`;
const run = Date.now().toString(36);
const U = { owner: `ai-owner-${run}`, agent: `ai-agent-${run}`, viewer: `ai-viewer-${run}`, ownerB: `ai-ownerb-${run}` };
let app: Db, worker: Db, root: pg.Client;
let A = "", B = "", cfgA = "", cfgB = "";
const ctx = (userId?: string, workspaceId?: string) => ({ userId, workspaceId });
const q = <T = Record<string, unknown>>(db: Db, c: ReturnType<typeof ctx>, s: ReturnType<typeof sql>) => withContext(db, c, async (tx) => (await tx.execute(s)).rows as T[]);
const rejects = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toMatchObject({ cause: { message: expect.stringMatching(re) } });
const runRow = (ws: string, status = "ok", extra = "") => sql.raw(`INSERT INTO ai_runs(workspace_id,capability,provider,model,prompt_key,prompt_version,status,error_code${extra ? "," + extra.split("=")[0] : ""}) VALUES ('${ws}','reply_suggestion','mock','mock-1','reply_suggestion',0,'${status}',${status === "ok" ? "NULL" : "'budget_exceeded'"}${extra ? "," + extra.split("=")[1] : ""})`);

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
  A = await mk(U.owner, `ai-a-${run}`); B = await mk(U.ownerB, `ai-b-${run}`);
  await withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.memberships).values([{ workspaceId: A, userId: U.agent, role: "agent" }, { workspaceId: A, userId: U.viewer, role: "viewer" }]));
  const cfg = (ws: string) => root.query(`INSERT INTO ai_provider_configs(workspace_id,provider,default_model,key_last4) VALUES ($1,'anthropic','claude-haiku-4-5','abcd') RETURNING id`, [ws]).then((r) => r.rows[0].id as string);
  cfgA = await cfg(A); cfgB = await cfg(B);
  for (const [ws, c] of [[A, cfgA], [B, cfgB]] as const) await root.query(`INSERT INTO ai_provider_secrets(workspace_id,config_id,ciphertext,nonce,key_id) VALUES ($1,$2,decode(repeat('ab',20),'hex'),decode(repeat('cd',12),'hex'),'k1')`, [ws, c]);
});
afterAll(async () => { await Promise.all([app.$client.end(), worker.$client.end(), root.end()]); });

describe("tenant isolation", () => {
  it("each workspace sees only its own config, and viewers see none", async () => {
    expect((await q(app, ctx(U.owner, A), sql`SELECT id FROM ai_provider_configs`)).map((r) => r.id)).toEqual([cfgA]);
    expect((await q(app, ctx(U.ownerB, B), sql`SELECT id FROM ai_provider_configs`)).map((r) => r.id)).toEqual([cfgB]);
    expect(await q(app, ctx(U.agent, A), sql`SELECT id FROM ai_provider_configs`)).toHaveLength(1); // the composer asks whether AI is ready; configs hold no secret
    expect(await q(app, ctx(U.viewer, A), sql`SELECT id FROM ai_provider_configs`)).toHaveLength(0);
    expect(await q(app, ctx(U.owner, A), sql`SELECT id FROM ai_provider_configs WHERE workspace_id = ${B}`)).toHaveLength(0);
  });
  it("cannot write another workspace's rows", async () => {
    await rejects(withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.aiBudgets).values({ workspaceId: B, monthlyCapMicro: 1 })), /row-level security/);
    await rejects(withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.aiProviderConfigs).values({ workspaceId: B, provider: "openai", keyLast4: "abcd" })), /row-level security/);
    expect(await q(app, ctx(U.owner, A), sql`UPDATE ai_provider_configs SET enabled = false WHERE workspace_id = ${B} RETURNING id`)).toHaveLength(0);
  });
  it("agents and viewers cannot configure, publish prompts or set budgets", async () => {
    for (const u of [U.agent, U.viewer]) {
      await rejects(withContext(app, ctx(u, A), (tx) => tx.insert(schema.aiBudgets).values({ workspaceId: A, monthlyCapMicro: 1 })), /row-level security/);
      await rejects(withContext(app, ctx(u, A), (tx) => tx.insert(schema.aiPrompts).values({ workspaceId: A, key: "reply_suggestion", version: 1, template: "x", createdBy: u })), /row-level security/);
      await rejects(withContext(app, ctx(u, A), (tx) => tx.insert(schema.aiProviderConfigs).values({ workspaceId: A, provider: "openai", keyLast4: "abcd" })), /row-level security/);
    }
    expect(await q(app, ctx(U.agent, A), sql`SELECT id FROM ai_runs`)).toHaveLength(0);
  });
  it("the worker sees only the workspace in its context", async () => {
    expect((await q(worker, ctx(undefined, A), sql`SELECT config_id FROM ai_provider_secrets`)).map((r) => r.config_id)).toEqual([cfgA]);
    expect(await q(worker, ctx(undefined, undefined), sql`SELECT id FROM ai_provider_secrets`)).toHaveLength(0);
  });
});

describe("secrets", () => {
  it("the app role can insert a sealed key but never read, change or delete it", async () => {
    await withContext(app, ctx(U.owner, A), (tx) => tx.execute(sql`INSERT INTO ai_provider_secrets(workspace_id,config_id,ciphertext,nonce,key_id) VALUES (${A},${cfgA},decode(repeat('ab',20),'hex'),decode(repeat('cd',12),'hex'),'k2')`));
    await rejects(q(app, ctx(U.owner, A), sql`SELECT ciphertext FROM ai_provider_secrets`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE ai_provider_secrets SET key_id = 'x'`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM ai_provider_secrets`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`INSERT INTO ai_provider_secrets(workspace_id,config_id,ciphertext,nonce,key_id) VALUES (${A},${cfgB},decode(repeat('ab',20),'hex'),decode(repeat('cd',12),'hex'),'k2')`), /foreign key|violates/);
  });
  it("is append-only even for the table owner (trigger)", async () => {
    await expect(root.query("UPDATE ai_provider_secrets SET key_id = 'x'")).rejects.toThrow(/append-only/);
    await expect(root.query("DELETE FROM ai_provider_secrets")).rejects.toThrow(/append-only/);
  });
  it("rejects a malformed envelope", async () => {
    await expect(root.query(`INSERT INTO ai_provider_secrets(workspace_id,config_id,ciphertext,nonce,key_id) VALUES ($1,$2,decode('ab','hex'),decode('cd','hex'),'k')`, [A, cfgA])).rejects.toThrow(/check constraint/);
  });
});

describe("configs", () => {
  it("identity is fixed; one default per workspace; a default must be enabled; https only", async () => {
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE ai_provider_configs SET provider = 'openai'`), /permission denied/);
    await expect(root.query(`UPDATE ai_provider_configs SET provider = 'openai' WHERE id = $1`, [cfgA])).rejects.toThrow(/identity/);
    await root.query(`UPDATE ai_provider_configs SET is_default = true WHERE id = $1`, [cfgA]);
    await expect(root.query(`INSERT INTO ai_provider_configs(workspace_id,provider,key_last4,is_default) VALUES ($1,'openai','abcd',true)`, [A])).rejects.toThrow(/duplicate key|unique/);
    await expect(root.query(`UPDATE ai_provider_configs SET enabled = false WHERE id = $1`, [cfgA])).rejects.toThrow(/ai_provider_configs_default_enabled/);
    await expect(root.query(`UPDATE ai_provider_configs SET base_url = 'http://x.com' WHERE id = $1`, [cfgA])).rejects.toThrow(/base_url/);
    await root.query(`UPDATE ai_provider_configs SET base_url = 'https://llm.example.com/v1/' || repeat('a', 280) WHERE id = $1`, [cfgA]);
  });
});

describe("prompts", () => {
  it("versions are unique, one is active, text is immutable, nothing is deleted", async () => {
    await withContext(app, ctx(U.owner, A), async (tx) => {
      await tx.insert(schema.aiPrompts).values({ workspaceId: A, key: "reply_suggestion", version: 1, template: "one {{contact_name}}", active: true, createdBy: U.owner });
    });
    await rejects(withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.aiPrompts).values({ workspaceId: A, key: "reply_suggestion", version: 1, template: "dup", createdBy: U.owner })), /duplicate key|unique/);
    await rejects(withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.aiPrompts).values({ workspaceId: A, key: "reply_suggestion", version: 2, template: "two", active: true, createdBy: U.owner })), /duplicate key|unique/); // one active
    await rejects(withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.aiPrompts).values({ workspaceId: A, key: "reply_suggestion", version: 2, template: "two", createdBy: U.ownerB })), /row-level security/); // created_by must be the caller
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE ai_prompts SET template = 'tampered'`), /permission denied/);
    await expect(root.query(`UPDATE ai_prompts SET template = 'tampered' WHERE workspace_id = $1`, [A])).rejects.toThrow(/immutable/);
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM ai_prompts`), /permission denied/);
    expect(await q(app, ctx(U.owner, A), sql`UPDATE ai_prompts SET active = false RETURNING id`)).toHaveLength(1);
    expect(await q(app, ctx(U.agent, A), sql`SELECT id FROM ai_prompts`)).toHaveLength(0);
    expect(await q(worker, ctx(undefined, A), sql`SELECT id FROM ai_prompts`)).toHaveLength(1);
    await rejects(q(worker, ctx(undefined, A), sql`UPDATE ai_prompts SET active = true`), /permission denied/);
  });
});

describe("runs", () => {
  it("only the worker writes runs (own workspace only); owner/admin read; append-only; constraints hold", async () => {
    await q(worker, ctx(U.owner, A), runRow(A));
    await rejects(q(worker, ctx(U.owner, A), runRow(B)), /row-level security/);
    await rejects(q(app, ctx(U.owner, A), runRow(A)), /permission denied/);
    expect(await q(app, ctx(U.owner, A), sql`SELECT id FROM ai_runs`)).toHaveLength(1);
    expect(await q(app, ctx(U.ownerB, B), sql`SELECT id FROM ai_runs`)).toHaveLength(0);
    expect(await q(app, ctx(U.agent, A), sql`SELECT id FROM ai_runs`)).toHaveLength(0);
    await expect(root.query("UPDATE ai_runs SET status = 'error'")).rejects.toThrow(/append-only/);
    await expect(root.query("DELETE FROM ai_runs")).rejects.toThrow(/append-only/);
    await rejects(q(worker, ctx(undefined, A), sql`UPDATE ai_runs SET cost_micro = 0`), /permission denied/);
    await q(worker, ctx(undefined, A), runRow(A, "blocked_budget"));
    await rejects(q(worker, ctx(undefined, A), runRow(A, "blocked_budget", "input_tokens=5")), /ai_runs_blocked_free/); // a blocked run never costs tokens
    await rejects(q(worker, ctx(undefined, A), runRow(A, "ok", "cost_micro=-1")), /ai_runs_numbers/);
    await rejects(q(worker, ctx(undefined, A), runRow(A, "ok", "input_hash='not-a-hash'")), /ai_runs_hash/);
    await rejects(q(worker, ctx(undefined, A), sql`INSERT INTO ai_runs(workspace_id,capability,provider,model,prompt_key,prompt_version,status) VALUES (${A},'reply_suggestion','mock','m','reply_suggestion',0,'error')`), /ai_runs_error_code/); // an error needs a code
    await rejects(q(worker, ctx(undefined, A), runRow(A, "ok", `summary='${"x".repeat(201)}'`)), /ai_runs_summary/); // no room for prompt text
  });
});

describe("budgets", () => {
  it("one per workspace, owner/admin only, caps are non-negative integers", async () => {
    await withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.aiBudgets).values({ workspaceId: A, monthlyCapMicro: 5_000_000, updatedBy: U.owner }));
    await rejects(withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.aiBudgets).values({ workspaceId: A, monthlyCapMicro: 1 })), /duplicate key|unique/);
    await expect(root.query(`UPDATE ai_budgets SET monthly_cap_micro = -1 WHERE workspace_id = $1`, [A])).rejects.toThrow(/ai_budgets_cap/);
    expect(await q(app, ctx(U.agent, A), sql`SELECT id FROM ai_budgets`)).toHaveLength(0);
    expect(await q(worker, ctx(undefined, A), sql`SELECT monthly_cap_micro FROM ai_budgets`)).toHaveLength(1);
    await rejects(q(worker, ctx(undefined, A), sql`UPDATE ai_budgets SET hard_stop = false`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM ai_budgets`), /permission denied/);
  });
});
