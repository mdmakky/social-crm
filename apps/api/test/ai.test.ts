import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { AiError, getProvider, type GenerateRequest, type GenerateResult } from "@crm/ai";
import { endpoints } from "@crm/contracts";
import { createDb, type Db } from "@crm/db";
import { createSecretBox } from "@crm/integrations";
import { safeBaseUrl } from "../src/ai/routes.ts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

// AI foundation slice 1. The provider is a FAKE (or the offline mock): nothing here talks to a real AI service.
const DB = process.env.CRM_DB_NAME ?? "crm";
const box = createSecretBox({ k1: Buffer.alloc(32, 7).toString("base64") }, "k1");
const KEY = "sk-ant-VERYSECRET-" + "k".repeat(30);
const KEY_B = "sk-ant-OTHERSECRET-" + "z".repeat(30);
const CUSTOMER_TEXT = "Do you deliver the blue sofa to Dhaka by Friday?";
let h: Harness, workerDb: Db;
let owner: TestUser, admin: TestUser, agent: TestUser, viewer: TestUser, ownerB: TestUser;
let A = "", B = "";
const as = (u: TestUser) => h.clientFor(u);
const p = (ws = A) => ({ workspaceId: ws });
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
let n = 0;
const digits = () => `${Date.now()}${n++}`;

// Scriptable fake provider. `calls` counts real provider invocations; `seen` keeps what it received.
const calls: GenerateRequest[] = [];
let script: (req: GenerateRequest, call: number) => GenerateResult | AiError = () => ({ text: "Hi! Yes, we can look into it.", usage: { inputTokens: 1000, outputTokens: 1000 }, finishReason: "stop" });
const sleeps: number[] = [];
let useFake = true;

async function conversation(ws: string, body: string | null = CUSTOMER_TEXT, name = "Rina Rahman") {
  const [a] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,'messenger',$2,'connected','Page') RETURNING id", [ws, digits()]);
  const [stage] = await q("SELECT id FROM lifecycle_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1", [ws]);
  const [ct] = await q("INSERT INTO contacts (workspace_id, name, lifecycle_stage_id, source) VALUES ($1,$2,$3,'messenger') RETURNING id", [ws, name, stage.id]);
  const [idn] = await q("INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, a.id, digits(), ct.id]);
  const [cv] = await q("INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, a.id, idn.id, ct.id]);
  if (body) await q("INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, delivery_state) VALUES ($1,$2,$3,'in',$4,'contact',$5,'received')", [ws, cv.id, a.id, `m.${digits()}`, body]);
  return cv.id as string;
}
const suggest = (u: TestUser, conv: string, ws = A) => as(u).call(endpoints.suggestReply, { params: { workspaceId: ws, conversationId: conv } });
const connect = (u = owner, ws = A, body: Record<string, unknown> = { apiKey: KEY, defaultModel: "claude-sonnet-4-5", isDefault: true }) => as(u).call(endpoints.setAiProvider, { params: { workspaceId: ws, provider: "anthropic" }, body: body as never });
const budget = async (cap: number | null, hardStop: boolean, ws = A) => ok(await as(owner).call(endpoints.setAiBudget, { params: p(ws), body: { monthlyCapMicro: cap, hardStop } }));
const runs = (ws = A) => q("SELECT * FROM ai_runs WHERE workspace_id=$1 ORDER BY id", [ws]);
const msgCount = async (conv: string) => Number((await q("SELECT count(*) AS n FROM messages WHERE conversation_id=$1", [conv]))[0].n);

beforeAll(async () => {
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  h = await bootstrap({ aiConfigsPerUser: 1000, aiSuggestionsPerUser: 1000 }, undefined, {
    workerDb, box, backoffMs: 10, sleep: async (ms) => { sleeps.push(ms); },
    providerFor: (id, o) => useFake ? { id, async generate(req) { calls.push(req); const r = script(req, calls.length); if (r instanceof AiError) throw r; return r; } } : getProvider(id, o),
  });
  [owner, admin, agent, viewer, ownerB] = (await Promise.all(["aio", "aia", "aig", "aiv", "aib"].map((l) => h.newUser(l)))) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  A = await h.workspace(owner, "AI A", { admin, agent, viewer });
  B = await h.workspace(ownerB, "AI B");
});
afterAll(async () => { await workerDb.$client.end(); await h.close(); });

describe("permissions", () => {
  it("owner and admin manage; agent and viewer cannot", async () => {
    ok(await connect(owner));
    ok(await connect(admin, A, { defaultModel: "claude-haiku-4-5" }));
    for (const u of [agent, viewer]) {
      expect(failure(await connect(u, A, { defaultModel: "claude-haiku-4-5" })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.listAiProviders, { params: p() })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.listAiPrompts, { params: p() })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.getAiBudget, { params: p() })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.setAiBudget, { params: p(), body: { monthlyCapMicro: 5, hardStop: true } })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.getAiUsage, { params: p(), query: {} })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.setAiPrompt, { params: { workspaceId: A, key: "reply_suggestion" }, body: { template: "x" } })).status).toBe(403);
    }
  });
  it("agent may use AI, viewer may not", async () => {
    expect(ok(await as(agent).call(endpoints.getAiStatus, { params: p() })).ready).toBe(true);
    expect(failure(await as(viewer).call(endpoints.getAiStatus, { params: p() })).status).toBe(403);
    const conv = await conversation(A);
    expect(failure(await suggest(viewer, conv)).status).toBe(403);
    ok(await suggest(agent, conv));
  });
});

describe("provider configuration", () => {
  it("validates provider, key, model and URL", async () => {
    expect(failure(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "nope" }, body: {} })).status).toBe(404);
    expect(failure(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "mock" }, body: { apiKey: KEY } })).status).toBe(400);
    expect(failure(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: B, provider: "openai" }, body: { defaultModel: "gpt-4o" } })).status).toBe(404); // owner A is not in B
    expect(failure(await as(ownerB).call(endpoints.setAiProvider, { params: { workspaceId: B, provider: "openai" }, body: { defaultModel: "gpt-4o" } })).code).toBe("key_required");
    expect(failure(await connect(ownerB, B, { apiKey: KEY_B, defaultModel: "not-a-model" })).code).toBe("unknown_model");
    expect(failure(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "openai" }, body: { apiKey: KEY, baseUrl: "http://example.com/v1" } })).kind).toBe("invalid_request"); // the shared schema wants https
    expect(failure(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "openai" }, body: { apiKey: KEY, baseUrl: "https://10.0.0.5/v1" } })).code).toBe("invalid_body");
    expect(failure(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "anthropic" }, body: { baseUrl: "https://example.com" } })).status).toBe(400);
  });
  it("a workspace price override makes an unlisted model choosable and drives the cost", async () => {
    const r = ok(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "openai" }, body: { apiKey: KEY, baseUrl: "https://llm.example.com/v1", defaultModel: "my-model", modelPrices: { "my-model": { inputMicroPer1M: 2_000_000, outputMicroPer1M: 4_000_000 } } } }));
    expect(r.models.find((m) => m.id === "my-model")?.outputMicroPer1M).toBe(4_000_000);
    expect(r.baseUrl).toBe("https://llm.example.com/v1");
    // back to anthropic as the default for the other tests
    ok(await connect(owner, A, { isDefault: true }));
    const list = ok(await as(owner).call(endpoints.listAiProviders, { params: p() })).items;
    expect(list.filter((x) => x.isDefault).map((x) => x.id)).toEqual(["anthropic"]);
  });
  it("safeBaseUrl", () => {
    for (const bad of ["http://x.com", "https://localhost/v1", "https://127.0.0.1/", "https://192.168.1.4", "https://172.20.0.1", "https://169.254.169.254", "https://[::1]/", "https://u:p@x.com", "https://x.com/?a=1", "https://box.internal", "ftp://x.com", "nope"]) expect(safeBaseUrl(bad), bad).toBeNull();
    expect(safeBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
  });
  it("is rate limited", async () => {
    const h2 = await bootstrap({ aiConfigsPerUser: 2 });
    try {
      const u = await h2.newUser("rl");
      const ws = await h2.workspace(u, "RL");
      const put = () => h2.clientFor(u).call(endpoints.setAiProvider, { params: { workspaceId: ws, provider: "mock" }, body: {} });
      ok(await put()); ok(await put());
      expect(failure(await put()).status).toBe(429);
    } finally { await h2.close(); }
  });
});

describe("the key never leaks", () => {
  it("is write-only: not in any response, the audit log, the database for the app role, or any log line", async () => {
    const logs: string[] = [];
    const spies = (["log", "error", "warn", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }));
    try {
      ok(await connect(ownerB, B, { apiKey: KEY_B, defaultModel: "claude-haiku-4-5" }));
      const conv = await conversation(B);
      ok(await suggest(ownerB, conv, B));
      script = () => new AiError("provider_error", 500);
      await suggest(ownerB, conv, B);
      script = () => ({ text: "Hi! Yes, we can look into it.", usage: { inputTokens: 1000, outputTokens: 1000 }, finishReason: "stop" });
      const bodies = [
        JSON.stringify(ok(await as(ownerB).call(endpoints.listAiProviders, { params: p(B) }))),
        JSON.stringify(ok(await connect(ownerB, B, { apiKey: KEY_B }))),
        JSON.stringify(ok(await as(ownerB).call(endpoints.getAiUsage, { params: p(B), query: {} }))),
        JSON.stringify(ok(await as(ownerB).call(endpoints.listAiPrompts, { params: p(B) }))),
        JSON.stringify(ok(await suggest(ownerB, conv, B))),
        JSON.stringify(await q("SELECT * FROM audit_log WHERE workspace_id=$1", [B])),
        JSON.stringify(await q("SELECT * FROM ai_provider_configs WHERE workspace_id=$1", [B])),
        JSON.stringify(await q("SELECT * FROM ai_runs WHERE workspace_id=$1", [B])),
        logs.join("\n"),
      ];
      for (const b of bodies) { expect(b).not.toContain(KEY_B); expect(b).not.toContain("OTHERSECRET"); }
      expect(JSON.stringify(ok(await as(ownerB).call(endpoints.listAiProviders, { params: p(B) })))).toContain(KEY_B.slice(-4)); // only the last four
      expect(logs.join("\n")).not.toContain(CUSTOMER_TEXT);
      // the worker received the real key (decrypted), proving the seal round-trips
      expect(calls.some((c) => c.apiKey === KEY_B)).toBe(true);
      // the stored value is sealed
      const sec = await q("SELECT ciphertext FROM ai_provider_secrets WHERE workspace_id=$1", [B]);
      expect(sec.length).toBeGreaterThanOrEqual(1);
      expect(Buffer.from(sec[0].ciphertext).toString("latin1")).not.toContain("OTHERSECRET");
    } finally { spies.forEach((s) => s.mockRestore()); }
    // the app role cannot read, update or delete secrets or write runs
    const app = new pg.Client({ connectionString: `postgres://crm_app:app_dev@127.0.0.1:5436/${DB}` });
    await app.connect();
    try {
      for (const sql of ["SELECT ciphertext FROM ai_provider_secrets", "UPDATE ai_provider_secrets SET key_id='x'", "DELETE FROM ai_provider_secrets", "INSERT INTO ai_runs(workspace_id,capability,provider,model,prompt_key,prompt_version,status) VALUES (gen_random_uuid(),'a1','mock','m','k1',0,'ok')"]) {
        await app.query("BEGIN");
        await expect(app.query(sql), sql).rejects.toThrow(/permission denied/);
        await app.query("ROLLBACK");
      }
    } finally { await app.end(); }
  });
  it("rotating the key adds a sealed version and the worker uses the newest", async () => {
    const NEW = "sk-ant-ROTATED-" + "r".repeat(30);
    ok(await connect(ownerB, B, { apiKey: NEW }));
    const conv = await conversation(B);
    calls.length = 0;
    ok(await suggest(ownerB, conv, B));
    expect(calls[0]!.apiKey).toBe(NEW);
    expect(Number((await q("SELECT count(*) AS n FROM ai_provider_secrets WHERE workspace_id=$1", [B]))[0].n)).toBe(3); // initial + same key resent + rotation
  });
});

describe("suggest reply", () => {
  it("returns a draft only: no message is created or sent", async () => {
    ok(await connect(owner, A, { isDefault: true, defaultModel: "claude-sonnet-4-5" }));
    const conv = await conversation(A);
    const before = await msgCount(conv);
    const attemptsBefore = Number((await q("SELECT count(*) AS n FROM outbound_attempts WHERE workspace_id=$1", [A]))[0].n);
    calls.length = 0;
    const r = ok(await suggest(agent, conv));
    expect(r.draft).toBe("Hi! Yes, we can look into it.");
    expect(r.mock).toBe(false);
    expect(await msgCount(conv)).toBe(before);
    expect(Number((await q("SELECT count(*) AS n FROM outbound_attempts WHERE workspace_id=$1", [A]))[0].n)).toBe(attemptsBefore);
    // the prompt was built from the conversation, with the customer's words as data and the contact name in the system prompt
    expect(calls[0]!.messages[0]!.role).toBe("system");
    expect(calls[0]!.messages[0]!.content).toContain("Rina Rahman");
    expect(calls[0]!.messages[1]!.content).toContain(`Customer: ${CUSTOMER_TEXT}`);
    // nothing readable is stored: the run keeps sizes, a fingerprint and counts
    const [run] = (await runs()).slice(-1);
    expect(run).toMatchObject({ capability: "reply_suggestion", provider: "anthropic", model: "claude-sonnet-4-5", status: "ok", input_tokens: 1000, output_tokens: 1000, cost_micro: "18000", entity_type: "conversation", entity_id: conv, requested_by: agent.id, prompt_version: 0 });
    expect(JSON.stringify(await runs())).not.toContain("blue sofa");
    expect(JSON.stringify(await runs())).not.toContain("look into it");
    expect(run.input_hash).toMatch(/^[0-9a-f]{16}$/);
  });
  it("404 for another workspace's conversation, 422 without a customer message, 409 when nothing is configured", async () => {
    const convB = await conversation(B);
    expect(failure(await suggest(owner, convB, A)).status).toBe(404); // B's conversation through A's path
    expect(failure(await suggest(owner, convB, B)).status).toBe(404); // owner A is not a member of B
    expect(failure(await suggest(owner, await conversation(A, null))).code).toBe("no_customer_message");
    const h3 = await bootstrap(undefined, undefined, { workerDb, box });
    try {
      const u = await h3.newUser("nc");
      const ws = await h3.workspace(u, "NC");
      const [a] = (await h3.admin.query("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,'messenger',$2,'connected','P') RETURNING id", [ws, digits()])).rows;
      const [st] = (await h3.admin.query("SELECT id FROM lifecycle_stages WHERE workspace_id=$1 LIMIT 1", [ws])).rows;
      const [ct] = (await h3.admin.query("INSERT INTO contacts (workspace_id, name, lifecycle_stage_id, source) VALUES ($1,'N',$2,'messenger') RETURNING id", [ws, st.id])).rows;
      const [idn] = (await h3.admin.query("INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, a.id, digits(), ct.id])).rows;
      const [cv] = (await h3.admin.query("INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, a.id, idn.id, ct.id])).rows;
      await h3.admin.query("INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, delivery_state) VALUES ($1,$2,$3,'in',$4,'contact','hello','received')", [ws, cv.id, a.id, `m.${digits()}`]);
      expect(failure(await suggest(u, cv.id, ws) as never).code).toBe("ai_not_configured");
      expect(ok(await h3.clientFor(u).call(endpoints.getAiStatus, { params: { workspaceId: ws } })).ready).toBe(false);
    } finally { await h3.close(); }
  });
  it("503 when the server has no worker role or secret key", async () => {
    const h4 = await bootstrap();
    try {
      const u = await h4.newUser("no-ai");
      const ws = await h4.workspace(u, "NoAI");
      expect(failure(await h4.clientFor(u).call(endpoints.suggestReply, { params: { workspaceId: ws, conversationId: "019a0000-0000-7000-8000-000000000000" } })).status).toBe(503);
      expect(failure(await h4.clientFor(u).call(endpoints.setAiProvider, { params: { workspaceId: ws, provider: "anthropic" }, body: { apiKey: KEY, defaultModel: "claude-haiku-4-5" } })).status).toBe(503);
    } finally { await h4.close(); }
  });
  it("keeps only the newest messages within the character budget", async () => {
    const conv = await conversation(A, "first message");
    const [m0] = await q("SELECT integration_account_id FROM messages WHERE conversation_id=$1", [conv]);
    for (let i = 0; i < 20; i++) await q("INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, delivery_state) VALUES ($1,$2,$3,'in',$4,'contact',$5,'received')", [A, conv, m0.integration_account_id, `m.${digits()}`, `msg-${i} ` + "x".repeat(900)]);
    calls.length = 0;
    ok(await suggest(owner, conv));
    const text = calls[0]!.messages[1]!.content;
    expect(text).toContain("msg-19");
    expect(text).not.toContain("first message");
    expect(text.length).toBeLessThan(6600);
    expect(text).not.toContain("x".repeat(601));
  });
  it("uses the mock provider end to end, labelled mock, at zero cost", async () => {
    useFake = false;
    try {
      ok(await as(ownerB).call(endpoints.setAiProvider, { params: { workspaceId: B, provider: "mock" }, body: { isDefault: true } }));
      const conv = await conversation(B);
      const r = ok(await suggest(ownerB, conv, B));
      expect(r).toMatchObject({ mock: true, provider: "mock", model: "mock-1" });
      expect(r.draft).toContain("[MOCK DRAFT]");
      const last = (await runs(B)).slice(-1)[0]!;
      expect(last).toMatchObject({ provider: "mock", status: "ok", cost_micro: "0" });
      expect(ok(await as(ownerB).call(endpoints.getAiStatus, { params: p(B) }))).toMatchObject({ ready: true, mock: true, provider: "mock" });
    } finally { useFake = true; }
  });
});

describe("prompts", () => {
  it("versions are append-only, validated, and drive the call; activate rolls back", async () => {
    const key = "reply_suggestion";
    expect(failure(await as(owner).call(endpoints.setAiPrompt, { params: { workspaceId: A, key }, body: { template: "Hi {{secret}}" } })).code).toBe("invalid_template");
    expect(failure(await as(owner).call(endpoints.setAiPrompt, { params: { workspaceId: A, key }, body: { template: "Hi {{ 1+1 }}" } })).code).toBe("invalid_template");
    expect(failure(await as(owner).call(endpoints.setAiPrompt, { params: { workspaceId: A, key: "nope" }, body: { template: "x" } })).status).toBe(404);
    const v1 = ok(await as(owner).call(endpoints.setAiPrompt, { params: { workspaceId: A, key }, body: { template: "VERSION-ONE for {{contact_name}} on {{channel}}" } }));
    expect(v1.activeVersion).toBe(1);
    const v2 = ok(await as(admin).call(endpoints.setAiPrompt, { params: { workspaceId: A, key }, body: { template: "VERSION-TWO for {{contact_name}}" } }));
    expect(v2.activeVersion).toBe(2);
    expect(v2.versions.map((v) => [v.version, v.active])).toEqual([[2, true], [1, false]]);
    const conv = await conversation(A);
    calls.length = 0;
    ok(await suggest(agent, conv));
    expect(calls[0]!.messages[0]!.content).toBe("VERSION-TWO for Rina Rahman");
    expect((await runs()).slice(-1)[0]!.prompt_version).toBe(2);
    const back = ok(await as(owner).call(endpoints.activateAiPrompt, { params: { workspaceId: A, key }, body: { version: 1 } }));
    expect(back.activeVersion).toBe(1);
    ok(await suggest(agent, conv));
    expect((await runs()).slice(-1)[0]!.prompt_version).toBe(1);
    const builtin = ok(await as(owner).call(endpoints.activateAiPrompt, { params: { workspaceId: A, key }, body: { version: 0 } }));
    expect(builtin.activeVersion).toBe(0);
    expect(failure(await as(owner).call(endpoints.activateAiPrompt, { params: { workspaceId: A, key }, body: { version: 9 } })).status).toBe(404);
    // the text of a published version is immutable
    await expect(q("UPDATE ai_prompts SET template='tampered' WHERE workspace_id=$1", [A])).rejects.toThrow(/immutable/);
    // another workspace sees none of it
    expect(ok(await as(ownerB).call(endpoints.listAiPrompts, { params: p(B) })).items[0]!.versions).toEqual([]);
  });
});

describe("budget hard stop", () => {
  it("blocks and logs without calling the provider; soft mode and a higher cap let calls through", async () => {
    ok(await connect(owner, A, { isDefault: true, defaultModel: "claude-sonnet-4-5" }));
    const conv = await conversation(A);
    const start = Number((await q("SELECT coalesce(sum(cost_micro),0) AS s FROM ai_runs WHERE workspace_id=$1", [A]))[0].s);
    await budget(start + 20_000, true); // each fake call costs 18 000
    calls.length = 0;
    ok(await suggest(agent, conv)); // used start+18000 < cap
    ok(await suggest(agent, conv)); // used start+18000 < cap check happens BEFORE: still under, runs, now start+36000
    expect(calls.length).toBe(2);
    const blocked = failure(await suggest(agent, conv));
    expect(blocked.status).toBe(409);
    expect(blocked.code).toBe("budget_exceeded");
    expect(calls.length).toBe(2); // the provider was NOT called
    const last = (await runs()).slice(-1)[0]!;
    expect(last).toMatchObject({ status: "blocked_budget", error_code: "budget_exceeded", input_tokens: 0, output_tokens: 0, cost_micro: "0", attempts: 0, requested_by: agent.id });
    // soft mode: over the cap but allowed
    await budget(start + 20_000, false);
    ok(await suggest(agent, conv));
    expect(calls.length).toBe(3);
    // hard stop again, then raise the cap
    await budget(start + 20_000, true);
    expect(failure(await suggest(agent, conv)).code).toBe("budget_exceeded");
    await budget(start + 1_000_000, true);
    ok(await suggest(agent, conv));
    expect(calls.length).toBe(4);
    // a zero cap blocks everything; no cap blocks nothing
    await budget(0, true);
    expect(failure(await suggest(agent, conv)).code).toBe("budget_exceeded");
    await budget(null, true);
    ok(await suggest(agent, conv));
    expect(calls.length).toBe(5);
    expect(ok(await as(owner).call(endpoints.getAiBudget, { params: p() }))).toEqual({ monthlyCapMicro: null, hardStop: true });
  });
  it("rejects negative or fractional caps and keeps budgets per workspace", async () => {
    expect(failure(await as(owner).call(endpoints.setAiBudget, { params: p(), body: { monthlyCapMicro: -1, hardStop: true } })).kind).toBe("invalid_request"); // refused by the shared schema before it is sent
    expect(failure(await as(owner).call(endpoints.setAiBudget, { params: p(), body: { monthlyCapMicro: 1.5, hardStop: true } })).kind).toBe("invalid_request");
    await budget(0, true, A);
    expect(ok(await as(ownerB).call(endpoints.getAiBudget, { params: p(B) })).monthlyCapMicro).toBeNull();
    const convB = await conversation(B);
    useFake = true;
    ok(await connect(ownerB, B, { isDefault: true, defaultModel: "claude-haiku-4-5" }));
    ok(await suggest(ownerB, convB, B)); // A's zero cap does not touch B
    await budget(null, true, A);
  });
});

describe("retry and errors", () => {
  const fresh = async () => { sleeps.length = 0; calls.length = 0; ok(await connect(owner, A, { isDefault: true, defaultModel: "claude-haiku-4-5" })); return conversation(A); };
  it("retries rate_limit with backoff, then succeeds", async () => {
    const conv = await fresh();
    script = (_r, n) => (n <= 2 ? new AiError("rate_limit", 429) : { text: "ok after retries", usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop" });
    expect(ok(await suggest(agent, conv)).draft).toBe("ok after retries");
    expect(calls.length).toBe(3);
    expect(sleeps).toEqual([10, 20]);
    expect((await runs()).slice(-1)[0]).toMatchObject({ status: "ok", attempts: 3 });
  });
  it("retries timeout, gives up after the bound, and reports busy for rate limits", async () => {
    let conv = await fresh();
    script = () => new AiError("timeout");
    const t = failure(await suggest(agent, conv));
    expect(t.status).toBe(502);
    expect(calls.length).toBe(3); // 1 + 2 retries
    expect((await runs()).slice(-1)[0]).toMatchObject({ status: "error", error_code: "timeout", attempts: 3 });
    conv = await fresh();
    script = () => new AiError("rate_limit", 429);
    expect(failure(await suggest(agent, conv)).code).toBe("ai_busy");
    expect(calls.length).toBe(3);
  });
  it.each(["auth", "invalid_request", "provider_error"] as const)("does NOT retry %s", async (code) => {
    const conv = await fresh();
    script = () => new AiError(code, 400);
    const e = failure(await suggest(agent, conv));
    expect(e.status).toBe(502);
    expect(calls.length).toBe(1);
    expect(sleeps).toEqual([]);
    expect((await runs()).slice(-1)[0]).toMatchObject({ status: "error", error_code: code, attempts: 1, cost_micro: "0" });
    if (code === "auth") expect(e.code).toBe("ai_key_rejected");
  });
  it("a non-AiError from a provider is a provider_error (never leaks its message)", async () => {
    const conv = await fresh();
    script = () => { throw new Error("leaks " + CUSTOMER_TEXT + KEY); };
    const e = failure(await suggest(agent, conv));
    expect(JSON.stringify(e)).not.toContain("blue sofa");
    expect(JSON.stringify(e)).not.toContain("VERYSECRET");
    expect((await runs()).slice(-1)[0]).toMatchObject({ status: "error", error_code: "provider_error" });
    script = () => ({ text: "Hi! Yes, we can look into it.", usage: { inputTokens: 1000, outputTokens: 1000 }, finishReason: "stop" });
  });
  it("suggest-reply is rate limited per user", async () => {
    const h5 = await bootstrap({ aiSuggestionsPerUser: 2 }, undefined, { workerDb, box, providerFor: (id) => ({ id, async generate() { return { text: "d", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }; } }) });
    try {
      const u = await h5.newUser("rl2");
      const ws = await h5.workspace(u, "RL2");
      ok(await h5.clientFor(u).call(endpoints.setAiProvider, { params: { workspaceId: ws, provider: "mock" }, body: {} }));
      const [a] = (await h5.admin.query("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,'messenger',$2,'connected','P') RETURNING id", [ws, digits()])).rows;
      const [st] = (await h5.admin.query("SELECT id FROM lifecycle_stages WHERE workspace_id=$1 LIMIT 1", [ws])).rows;
      const [ct] = (await h5.admin.query("INSERT INTO contacts (workspace_id, name, lifecycle_stage_id, source) VALUES ($1,'N',$2,'messenger') RETURNING id", [ws, st.id])).rows;
      const [idn] = (await h5.admin.query("INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, a.id, digits(), ct.id])).rows;
      const [cv] = (await h5.admin.query("INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, a.id, idn.id, ct.id])).rows;
      await h5.admin.query("INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, delivery_state) VALUES ($1,$2,$3,'in',$4,'contact','hello','received')", [ws, cv.id, a.id, `m.${digits()}`]);
      const go = () => h5.clientFor(u).call(endpoints.suggestReply, { params: { workspaceId: ws, conversationId: cv.id } });
      ok(await go()); ok(await go());
      expect(failure(await go()).status).toBe(429);
    } finally { await h5.close(); }
  });
});

describe("usage summary and tenancy", () => {
  it("summarises the month and days by capability for owner/admin, scoped to the workspace", async () => {
    const u = ok(await as(admin).call(endpoints.getAiUsage, { params: p(), query: { days: 7 } }));
    const dbRows = await runs();
    const used = dbRows.reduce((s, r) => s + Number(r.cost_micro), 0);
    expect(u.month.runs).toBe(dbRows.length);
    expect(u.month.usedMicro).toBe(used);
    expect(u.month.inputTokens).toBe(dbRows.reduce((s, r) => s + r.input_tokens, 0));
    expect(u.month.blockedRuns).toBe(dbRows.filter((r) => r.status === "blocked_budget").length);
    expect(u.month.blockedRuns).toBeGreaterThan(0);
    expect(u.month.capMicro).toBeNull();
    const day = u.byDay.filter((d) => d.capability === "reply_suggestion");
    expect(day.reduce((s, d) => s + d.runs, 0)).toBe(dbRows.length);
    expect(day.reduce((s, d) => s + d.costMicro, 0)).toBe(used);
    expect(day.reduce((s, d) => s + d.errors, 0)).toBe(dbRows.filter((r) => r.status === "error").length);
    // another workspace's numbers are its own
    const ub = ok(await as(ownerB).call(endpoints.getAiUsage, { params: p(B), query: {} }));
    expect(ub.month.runs).toBe((await runs(B)).length);
    expect(ub.month.runs).not.toBe(u.month.runs);
    // blocked flag follows cap and mode
    await budget(1, true);
    expect(ok(await as(owner).call(endpoints.getAiUsage, { params: p(), query: {} })).month.blocked).toBe(true);
    await budget(1, false);
    expect(ok(await as(owner).call(endpoints.getAiUsage, { params: p(), query: {} })).month.blocked).toBe(false);
    await budget(null, true);
    expect(failure(await as(owner).call(endpoints.getAiUsage, { params: p(), query: { days: 500 } as never })).kind).toBe("invalid_request");
  });
  it("a member of another workspace cannot read or change this workspace's AI settings", async () => {
    expect(failure(await as(ownerB).call(endpoints.listAiProviders, { params: p(A) })).status).toBe(404);
    expect(failure(await connect(ownerB, A)).status).toBe(404);
    expect(failure(await as(ownerB).call(endpoints.getAiUsage, { params: p(A), query: {} })).status).toBe(404);
    expect(failure(await suggest(ownerB, await conversation(A), A)).status).toBe(404);
  });
  it("runs are append-only and a workspace cannot write another's run (worker policy)", async () => {
    await expect(q("UPDATE ai_runs SET status='ok'")).rejects.toThrow(/append-only/);
    await expect(q("DELETE FROM ai_runs")).rejects.toThrow(/append-only/);
    const w = new pg.Client({ connectionString: `postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}` });
    await w.connect();
    try {
      await w.query("BEGIN");
      await w.query("SELECT set_config('app.workspace_id', $1, true)", [A]);
      await expect(w.query("INSERT INTO ai_runs(workspace_id,capability,provider,model,prompt_key,prompt_version,status) VALUES ($1,'a1','mock','m','k1',0,'ok')", [B])).rejects.toThrow(/row-level security/);
      await w.query("ROLLBACK");
    } finally { await w.end(); }
  });
});
