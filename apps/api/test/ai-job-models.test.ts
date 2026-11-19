import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getProvider, type AiProvider } from "@crm/ai";
import { endpoints } from "@crm/contracts";
import { createDb, type Db } from "@crm/db";
import { createSecretBox } from "@crm/integrations";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

// Pinning one model per job. Providers are the offline MOCK or a scripted FAKE: nothing here talks to a real AI service.
const DB = process.env.CRM_DB_NAME ?? "crm";
const box = createSecretBox({ k1: Buffer.alloc(32, 7).toString("base64") }, "k1");
const KEY = "sk-ant-VERYSECRET-" + "k".repeat(30);
let h: Harness, workerDb: Db;
let owner: TestUser, admin: TestUser, agent: TestUser, viewer: TestUser, ownerB: TestUser;
let A = "", B = "";
const as = (u: TestUser) => h.clientFor(u);
const p = (ws = A) => ({ workspaceId: ws });
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
let n = 0;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const img = { mime: "image/png", contentBase64: png.toString("base64") };
const fake = (id: string): AiProvider => ({
  id,
  async generate() { return { text: "Sure, we can help.", usage: { inputTokens: 10, outputTokens: 10 }, finishReason: "stop" }; },
  async vision() { return { text: "a cup", usage: { inputTokens: 10, outputTokens: 10 }, finishReason: "stop" }; },
});
const lastRun = async (cap: string, ws = A) => (await q("SELECT provider, model FROM ai_runs WHERE workspace_id=$1 AND capability=$2 ORDER BY id DESC LIMIT 1", [ws, cap]))[0];
const list = async (u = owner, ws = A) => ok(await as(u).call(endpoints.listAiJobModels, { params: p(ws) })).items;
const jobOf = async (job: string, u = owner, ws = A) => (await list(u, ws)).find((j) => j.job === job)!;
const pin = (job: string, provider: string, model: string, u = owner, ws = A) => as(u).call(endpoints.setAiJobModel, { params: { workspaceId: ws, job: job as never }, body: { provider, model } });
const clear = (job: string, u = owner, ws = A) => as(u).call(endpoints.clearAiJobModel, { params: { workspaceId: ws, job: job as never } });
const enable = (ws: string, on: string[], def: string) => q("UPDATE ai_provider_configs SET enabled = (provider = ANY($2)), is_default = (provider = $3) WHERE workspace_id=$1", [ws, on, def]);
async function conversation(ws: string) {
  const [a] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,'messenger',$2,'connected','Page') RETURNING id", [ws, `${Date.now()}${n++}`]);
  const [stage] = await q("SELECT id FROM lifecycle_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1", [ws]);
  const [ct] = await q("INSERT INTO contacts (workspace_id, name, lifecycle_stage_id, source) VALUES ($1,'Rina',$2,'messenger') RETURNING id", [ws, stage.id]);
  const [idn] = await q("INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, a.id, `${Date.now()}${n++}`, ct.id]);
  const [cv] = await q("INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, a.id, idn.id, ct.id]);
  await q("INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, delivery_state) VALUES ($1,$2,$3,'in',$4,'contact','Do you deliver?','received')", [ws, cv.id, a.id, `${Date.now()}${n++}`]);
  return cv.id as string;
}

beforeAll(async () => {
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  h = await bootstrap({ aiConfigsPerUser: 1000, aiSuggestionsPerUser: 1000, mediaLimits: { perWorkspace: 1000 } }, undefined, {
    workerDb, box, backoffMs: 1, sleep: async () => {}, providerFor: (id, o) => (id === "mock" ? getProvider(id, o) : fake(id)),
  });
  [owner, admin, agent, viewer, ownerB] = (await Promise.all(["jmo", "jma", "jmg", "jmv", "jmb"].map((l) => h.newUser(l)))) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  A = await h.workspace(owner, "JM A", { admin, agent, viewer });
  B = await h.workspace(ownerB, "JM B");
  ok(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "mock" }, body: { isDefault: true } }));
  ok(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "anthropic" }, body: { apiKey: KEY, defaultModel: "claude-sonnet-4-5" } }));
});
afterAll(async () => { await workerDb.$client.end(); await h.close(); });

describe("ai job models", () => {
  it("lists every job as automatic with the default provider's pick", async () => {
    const items = await list();
    expect(items.map((j) => j.job).sort()).toEqual(["agent", "document", "reply", "transcription", "vision"]);
    expect(items.every((j) => j.pinned === null && j.problem === null && j.effective?.automatic === true)).toBe(true);
    expect(await jobOf("reply")).toMatchObject({ effective: { provider: "mock", model: "mock-1" } });
  });

  it("permissions: owner and admin change, agent reads, viewer neither; no key in the audit entry", async () => {
    expect(failure(await pin("reply", "anthropic", "claude-haiku-4-5", agent)).status).toBe(403);
    expect(failure(await clear("reply", agent)).status).toBe(403);
    expect(failure(await pin("reply", "anthropic", "claude-haiku-4-5", viewer)).status).toBe(403);
    expect(await list(agent)).toHaveLength(5);
    expect(failure(await as(viewer).call(endpoints.listAiJobModels, { params: p() })).status).toBe(403);
    ok(await pin("reply", "anthropic", "claude-haiku-4-5", admin));
    const audit = await q("SELECT action, summary FROM audit_log WHERE workspace_id=$1 AND action='ai.job_model_set'", [A]);
    expect(audit[0].summary).toEqual({ job: "reply", provider: "anthropic", model: "claude-haiku-4-5" });
    expect(JSON.stringify(audit)).not.toContain("VERYSECRET");
    ok(await clear("reply", admin));
    expect(await q("SELECT 1 FROM audit_log WHERE workspace_id=$1 AND action='ai.job_model_cleared'", [A])).toHaveLength(1);
  });

  it("422 for a model without the ability, an unknown model, or a provider that is not set up; the pin stays unset", async () => {
    expect(failure(await pin("transcription", "anthropic", "claude-haiku-4-5")).status).toBe(422);
    expect(failure(await pin("reply", "anthropic", "no-such-model")).status).toBe(422);
    expect(failure(await pin("reply", "openai", "gpt-4o")).status).toBe(422);
    expect(failure(await pin("nope", "mock", "mock-1")).status).toBe(404);
    expect((await jobOf("transcription")).pinned).toBeNull();
  });

  it("a pinned model is used by a reply suggestion and by a media call (run log)", async () => {
    const dto = ok(await pin("reply", "anthropic", "claude-haiku-4-5"));
    expect(dto).toMatchObject({ job: "reply", pinned: { provider: "anthropic", model: "claude-haiku-4-5" }, effective: { provider: "anthropic", model: "claude-haiku-4-5", automatic: false }, problem: null });
    ok(await as(agent).call(endpoints.suggestReply, { params: { workspaceId: A, conversationId: await conversation(A) } }));
    expect(await lastRun("reply_suggestion")).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });

    ok(await as(owner).call(endpoints.describeMedia, { params: p(), body: img }));
    expect(await lastRun("vision")).toEqual({ provider: "mock", model: "mock-1" });
    ok(await pin("vision", "anthropic", "claude-haiku-4-5"));
    ok(await as(owner).call(endpoints.describeMedia, { params: p(), body: img }));
    expect(await lastRun("vision")).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  it("falls back to automatic, with a plain problem, when the pin stops working", async () => {
    await enable(A, ["mock"], "mock"); // anthropic turned off
    const r = await jobOf("reply");
    expect(r.pinned).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
    expect(r.problem).toMatch(/not set up or is turned off/);
    expect(r.effective).toEqual({ provider: "mock", model: "mock-1", automatic: true });
    ok(await as(agent).call(endpoints.suggestReply, { params: { workspaceId: A, conversationId: await conversation(A) } }));
    expect(await lastRun("reply_suggestion")).toEqual({ provider: "mock", model: "mock-1" });
    ok(await as(owner).call(endpoints.describeMedia, { params: p(), body: img }));
    expect(await lastRun("vision")).toEqual({ provider: "mock", model: "mock-1" });
    await enable(A, ["mock", "anthropic"], "mock");
    expect((await jobOf("vision")).problem).toBeNull();
  });

  it("clear removes the pin", async () => {
    expect(ok(await clear("reply"))).toMatchObject({ pinned: null, effective: { automatic: true } });
    expect(ok(await clear("reply"))).toMatchObject({ pinned: null }); // clearing twice is fine
  });

  it("another workspace sees and changes none of it", async () => {
    expect((await list(ownerB, B)).every((j) => j.pinned === null && j.effective === null)).toBe(true);
    expect(failure(await as(ownerB).call(endpoints.listAiJobModels, { params: p(A) })).status).toBe(404);
    expect(failure(await pin("vision", "mock", "mock-1", ownerB, A)).status).toBe(404);
    expect(failure(await pin("vision", "mock", "mock-1", ownerB, B)).status).toBe(422); // B has no provider set up
    expect((await jobOf("vision")).pinned).not.toBeNull(); // A's pin is untouched
  });
});
