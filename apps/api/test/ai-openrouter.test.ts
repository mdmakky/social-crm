import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AiError, getProvider, type GenerateRequest, type GenerateResult } from "@crm/ai";
import { endpoints } from "@crm/contracts";
import { createDb, type Db } from "@crm/db";
import { createSecretBox } from "@crm/integrations";
import { createModelBrowser, MOCK_OPENROUTER_MODELS } from "../src/ai/openrouter-browser.ts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

// OpenRouter gateway, slice A. Every provider and list fetch here is FAKE: nothing touches the network.
const DB = process.env.CRM_DB_NAME ?? "crm";
const box = createSecretBox({ k1: Buffer.alloc(32, 7).toString("base64") }, "k1");
const KEY = "sk-or-v1-VERYSECRETKEY-" + "q".repeat(30);
let h: Harness, workerDb: Db;
let owner: TestUser, admin: TestUser, agent: TestUser, viewer: TestUser, ownerB: TestUser;
let A = "", B = "";
const as = (u: TestUser) => h.clientFor(u);
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
let n = 0;
const digits = () => `${Date.now()}${n++}`;

const listCalls: { url: string; headers: unknown }[] = [];
let now = Date.now();
const listFetch = (async (url: string, init: RequestInit) => { listCalls.push({ url, headers: init.headers }); return new Response(JSON.stringify(MOCK_OPENROUTER_MODELS), { status: 200 }); }) as unknown as typeof fetch;
const calls: GenerateRequest[] = [];
let script: (req: GenerateRequest, call: number) => GenerateResult | AiError = () => ({ text: "Hi! Yes, we can look into it.", usage: { inputTokens: 1000, outputTokens: 1000 }, finishReason: "stop" });
const sleeps: number[] = [];
const seenOpts: { referer?: string; title?: string }[] = [];

async function conversation(ws: string) {
  const [a] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,'messenger',$2,'connected','Page') RETURNING id", [ws, digits()]);
  const [stage] = await q("SELECT id FROM lifecycle_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1", [ws]);
  const [ct] = await q("INSERT INTO contacts (workspace_id, name, lifecycle_stage_id, source) VALUES ($1,'Rina',$2,'messenger') RETURNING id", [ws, stage.id]);
  const [idn] = await q("INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, a.id, digits(), ct.id]);
  const [cv] = await q("INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, a.id, idn.id, ct.id]);
  await q("INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, delivery_state) VALUES ($1,$2,$3,'in',$4,'contact','Do you deliver?','received')", [ws, cv.id, a.id, `m.${digits()}`]);
  return cv.id as string;
}
const suggest = (conv: string, ws = A) => as(owner).call(endpoints.suggestReply, { params: { workspaceId: ws, conversationId: conv } });
const put = (u: TestUser, body: Record<string, unknown>, ws = A) => as(u).call(endpoints.setAiProvider, { params: { workspaceId: ws, provider: "openrouter" }, body: body as never });
const browse = (u: TestUser, ws = A) => as(u).call(endpoints.listOpenRouterModels, { params: { workspaceId: ws } });
const P = (i: number, o: number, extra: Record<string, unknown> = {}) => ({ inputMicroPer1M: i, outputMicroPer1M: o, ...extra });
const runs = (ws = A) => q("SELECT * FROM ai_runs WHERE workspace_id=$1 ORDER BY id", [ws]);
const budget = async (cap: number | null) => ok(await as(owner).call(endpoints.setAiBudget, { params: { workspaceId: A }, body: { monthlyCapMicro: cap, hardStop: true } }));

beforeAll(async () => {
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  h = await bootstrap({ aiConfigsPerUser: 1000, aiSuggestionsPerUser: 1000, openrouterBrowsesPerUser: 4, openrouterBrowser: createModelBrowser({ fetch: listFetch, now: () => now }) }, undefined, {
    workerDb, box, backoffMs: 10, sleep: async (ms) => { sleeps.push(ms); }, referer: "https://crm.example", title: "Social CRM",
    providerFor: (id, o) => { seenOpts.push({ referer: o.referer, title: o.title }); return { id, async generate(req) { calls.push(req); const r = script(req, calls.length); if (r instanceof AiError) throw r; return r; } }; },
  });
  [owner, admin, agent, viewer, ownerB] = (await Promise.all(["oro", "ora", "org", "orv", "orb"].map((l) => h.newUser(l)))) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  A = await h.workspace(owner, "OR A", { admin, agent, viewer });
  B = await h.workspace(ownerB, "OR B");
});
afterAll(async () => { await workerDb.$client.end(); await h.close(); });

describe("model browser", () => {
  it("owner and admin only; no key is sent; trimmed, parsed list with syncedAt", async () => {
    for (const u of [agent, viewer]) expect((await browse(u)).ok).toBe(false);
    const r = ok(await browse(owner));
    expect(r.items.map((m) => m.id)).toEqual(["mockvendor/alpha-chat", "mockvendor/beta-mini", "mockvendor/gamma-text"]);
    expect(r.items[0]).toMatchObject({ inputMicroPer1M: 3_000_000, outputMicroPer1M: 15_000_000, capabilities: ["text", "vision"], supports: { tools: true, structuredOutput: true } });
    expect(r.items[2]!.capabilities).toEqual(["text"]);
    expect(r.unverified).toBe(true);
    expect(new Date(r.syncedAt).getTime()).toBeGreaterThan(0);
    expect(listCalls[0]!.url).toBe("https://openrouter.ai/api/v1/models");
    expect(JSON.stringify(listCalls)).not.toMatch(/authorization|Bearer/i);
  });
  it("caches for 10 minutes, then refetches", async () => {
    const before = listCalls.length;
    ok(await browse(admin));
    expect(listCalls.length).toBe(before);
    now += 11 * 60_000;
    ok(await browse(admin));
    expect(listCalls.length).toBe(before + 1);
  });
  it("is rate limited per user", async () => {
    const r = await browse(ownerB, B);
    expect(r.ok).toBe(true);
    for (let i = 0; i < 3; i++) await browse(ownerB, B);
    expect(failure(await browse(ownerB, B)).status).toBe(429);
  });
  it("a failing list is a 502 without leaking anything", async () => {
    const bad = createModelBrowser({ fetch: (async () => new Response("<html>SECRET</html>", { status: 200 })) as unknown as typeof fetch });
    await expect(bad.list()).rejects.toThrow();
    expect(bad.peek()).toBeNull();
  });
});

describe("enabling models (PUT)", () => {
  it("needs a model; more than 50 or a router alias is rejected; other providers stay at 20", async () => {
    expect(failure(await put(owner, { apiKey: KEY })).status).toBe(400);
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`v/m${i}`, P(1, 1)]));
    expect(failure(await put(owner, { apiKey: KEY, modelPrices: many, defaultModel: "v/m0" }))).toBeTruthy(); // refused by the contract (50 max)
    expect(failure(await put(owner, { apiKey: KEY, modelPrices: { "openrouter/auto": P(1, 1) }, defaultModel: "openrouter/auto" })).status).toBe(400);
    const twentyOne = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`m${i}`, P(1, 1)]));
    const r = await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "openai" }, body: { apiKey: KEY, modelPrices: twentyOne, defaultModel: "m0" } });
    expect(failure(r).status).toBe(400);
    const fifty = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`v/m${i}`, P(1, 1)]));
    ok(await put(owner, { apiKey: KEY, modelPrices: fifty, defaultModel: "v/m0", enabled: false }));
  });
  it("default must be an enabled model", async () => {
    expect(failure(await put(owner, { modelPrices: { "v/a": P(1, 1) }, defaultModel: "v/zzz" })).status).toBe(400);
  });
  it("capabilities are intersected with the cached list; unknown ids and an empty cache are text only", async () => {
    ok(await browse(owner)); // fills the cache (a fresh window)
    const r = ok(await put(owner, {
      modelPrices: { "mockvendor/alpha-chat": P(3_000_000, 15_000_000, { capabilities: ["vision", "document", "transcription"], contextLength: 1, supports: { tools: false, structuredOutput: false } }), "mockvendor/gamma-text": P(1_000_000, 2_000_000, { capabilities: ["vision"] }), "other/unlisted": P(5, 5, { capabilities: ["vision"] }) },
      defaultModel: "mockvendor/alpha-chat", enabled: true, isDefault: true,
    }));
    const by = (id: string) => r.models.find((m) => m.id === id)!;
    expect(by("mockvendor/alpha-chat")).toMatchObject({ capabilities: ["text", "vision"], contextLength: 128000, supports: { tools: true, structuredOutput: true } });
    expect(by("mockvendor/gamma-text").capabilities).toEqual(["text"]);
    expect(by("other/unlisted").capabilities).toEqual(["text"]);
    // The cache expires: re-saving keeps what was already confirmed, and never grants more.
    now += 11 * 60_000;
    const again = ok(await put(owner, { modelPrices: { "mockvendor/alpha-chat": P(3_000_000, 15_000_000, { capabilities: ["vision", "document"] }), "other/unlisted": P(5, 5, { capabilities: ["vision"] }) }, defaultModel: "mockvendor/alpha-chat" }));
    expect(again.models.find((m) => m.id === "mockvendor/alpha-chat")!.capabilities).toEqual(["text", "vision"]);
    expect(again.models.find((m) => m.id === "other/unlisted")!.capabilities).toEqual(["text"]);
    expect(again.keyLast4).toBe(KEY.slice(-4));
  });
  it("capabilities panel and the media picker see stored capabilities", async () => {
    const c = ok(await as(owner).call(endpoints.getAiCapabilities, { params: { workspaceId: A } }));
    const or = c.providers.find((p) => p.provider === "openrouter")!;
    expect(or.models.find((m) => m.id === "mockvendor/alpha-chat")!.capabilities).toContain("vision");
    expect(c.available.vision).toBe(true);
  });
  it("tenant isolation: workspace B sees none of A's models or key", async () => {
    const list = ok(await as(ownerB).call(endpoints.listAiProviders, { params: { workspaceId: B } }));
    const or = list.items.find((p) => p.id === "openrouter")!;
    expect(or.configured).toBe(false);
    expect(or.models).toEqual([]);
    expect(failure(await as(ownerB).call(endpoints.listAiProviders, { params: { workspaceId: A } })).status).toBe(404);
  });
});

describe("runs through the gateway", () => {
  const prep = async (modelPrices: Record<string, unknown>, model: string) => { ok(await put(owner, { modelPrices, defaultModel: model, enabled: true, isDefault: true })); calls.length = 0; sleeps.length = 0; await budget(null); return conversation(A); };
  it("passes referer and title, retries 503 with Retry-After honoured and capped", async () => {
    const conv = await prep({ "v/a": P(1_000_000, 1_000_000) }, "v/a");
    script = (_r, call) => call === 1 ? new AiError("provider_error", 503, { retryable: true, retryAfterMs: 2000 }) : call === 2 ? new AiError("rate_limit", 429, { retryable: true, retryAfterMs: 30_000 }) : { text: "ok", usage: { inputTokens: 10, outputTokens: 10 }, finishReason: "stop" };
    const r = ok(await suggest(conv));
    expect(r.draft).toBe("ok");
    expect(sleeps).toEqual([2000, 30_000]);
    expect(seenOpts.at(-1)).toEqual({ referer: "https://crm.example", title: "Social CRM" });
    // non-retryable codes are not retried
    calls.length = 0; sleeps.length = 0;
    script = () => new AiError("provider_error", 502, { retryable: false });
    expect(failure(await suggest(conv)).status).toBe(502);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
  it("retries stop at maxRetries even when the provider keeps asking", async () => {
    const conv = await prep({ "v/a": P(1, 1) }, "v/a");
    script = () => new AiError("rate_limit", 429, { retryable: true, retryAfterMs: 1 });
    expect(failure(await suggest(conv)).status).toBe(429);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([10, 20]);
  });
  it("payment_required is 402 and blocked is 422, never auth", async () => {
    const conv = await prep({ "v/a": P(1, 1) }, "v/a");
    script = () => new AiError("payment_required", 402, { retryable: false });
    const p = failure(await suggest(conv));
    expect(p.status).toBe(402);
    expect(p).toMatchObject({ code: "payment_required", message: "The provider account is out of credits" });
    script = () => new AiError("blocked", 403, { retryable: false });
    const b = failure(await suggest(conv));
    expect(b.status).toBe(422);
    expect(b).toMatchObject({ code: "blocked" });
    expect((await runs(A)).at(-1)!.error_code).toBe("blocked");
  });
  it("cost is the higher of the estimate and the reported cost; the routed model is logged", async () => {
    const conv = await prep({ "v/a": P(1_000_000, 1_000_000) }, "v/a"); // estimate for 100+100 tokens = 200 micro
    script = () => ({ text: "x", usage: { inputTokens: 100, outputTokens: 100, reportedCostMicro: 5000 }, finishReason: "stop", routedModel: "other/routed" });
    ok(await suggest(conv));
    script = () => ({ text: "x", usage: { inputTokens: 100, outputTokens: 100, reportedCostMicro: 10 }, finishReason: "stop", routedModel: "v/a" });
    ok(await suggest(conv));
    const rs = await runs(A);
    const [a, b] = rs.slice(-2) as { cost_micro: string; summary: string }[];
    expect(Number(a!.cost_micro)).toBe(5000);
    expect(a!.summary).toContain("routed to other/routed");
    expect(Number(b!.cost_micro)).toBe(200);
    expect(b!.summary).not.toContain("routed");
  });
  it("the budget hard stop uses the reported cost", async () => {
    const conv = await prep({ "v/cheap": P(1, 1) }, "v/cheap"); // a stale price: estimate ~0
    const used = Number((await q("SELECT coalesce(sum(cost_micro),0) AS s FROM ai_runs WHERE workspace_id=$1", [A]))[0].s);
    await budget(used + 1000);
    script = () => ({ text: "x", usage: { inputTokens: 1, outputTokens: 1, reportedCostMicro: 2000 }, finishReason: "stop" });
    ok(await suggest(conv));
    calls.length = 0;
    expect(failure(await suggest(conv))).toMatchObject({ code: "budget_exceeded" });
    expect(calls).toHaveLength(0);
  });
  it("no key anywhere: responses, run rows, logs", async () => {
    const spy = vi.spyOn(console, "error");
    const all = JSON.stringify([ok(await as(owner).call(endpoints.listAiProviders, { params: { workspaceId: A } })), await runs(A), await q("SELECT summary FROM audit_log WHERE workspace_id=$1", [A]).catch(() => []), spy.mock.calls]);
    expect(all).not.toContain("VERYSECRETKEY");
    spy.mockRestore();
  });
});

describe("real registry adapter is reachable by id", () => {
  it("openrouter has a fixed base URL and no custom URL", async () => {
    expect(getProvider("openrouter").id).toBe("openrouter");
    expect(failure(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "openrouter" }, body: { baseUrl: "https://evil.example/v1" } as never })).status).toBe(400);
  });
});
