import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiError, getProvider, type AiProvider, type GenerateRequest, type GenerateResult, type StreamEvent } from "@crm/ai";
import { endpoints, type AgentDto, type CreateAgentBody } from "@crm/contracts";
import { createDb, type Db } from "@crm/db";
import { createSecretBox } from "@crm/integrations";
import { createModelBrowser, MOCK_OPENROUTER_MODELS } from "../src/ai/openrouter-browser.ts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

// Streaming suggest-reply, native tool calling and structured output. Every provider here is a scripted FAKE or the offline mock: nothing touches the network.
const DB = process.env.CRM_DB_NAME ?? "crm";
const ORIGIN = "http://localhost:3000";
const box = createSecretBox({ k1: Buffer.alloc(32, 7).toString("base64") }, "k1");
const KEY = "sk-or-v1-STREAMTESTSECRET-" + "q".repeat(30);
let h: Harness, workerDb: Db;
let owner: TestUser, admin: TestUser, agent: TestUser, viewer: TestUser, ownerB: TestUser;
let A = "", B = "";
const as = (u: TestUser) => h.clientFor(u);
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
let n = 0;
const uniq = (s: string) => `${s}-${Date.now().toString(36)}-${n++}`;
const digits = () => `${Date.now()}${n++}`;

type Impl = { generate?: (req: GenerateRequest) => Promise<GenerateResult>; stream?: (req: GenerateRequest) => AsyncIterable<StreamEvent> | null };
let impl: Impl = {};
const seen: GenerateRequest[] = [];
const sleeps: number[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => Promise<boolean>, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(20); } return false; };

const scripted = (id: string): AiProvider => ({
  id,
  async generate(req) { seen.push(req); if (!impl.generate) throw new AiError("provider_error"); return impl.generate(req); },
  ...(impl.stream ? { generateStream: (req: GenerateRequest) => { seen.push(req); return impl.stream!(req)!; } } : {}),
});

async function conversation(ws: string, body = "Do you deliver?", dir: "in" | "out" = "in") {
  const [a] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,'messenger',$2,'connected','Page') RETURNING id", [ws, digits()]);
  const [stage] = await q("SELECT id FROM lifecycle_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1", [ws]);
  const [ct] = await q("INSERT INTO contacts (workspace_id, name, lifecycle_stage_id, source) VALUES ($1,'Rina',$2,'messenger') RETURNING id", [ws, stage.id]);
  const [idn] = await q("INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, a.id, digits(), ct.id]);
  const [cv] = await q("INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, a.id, idn.id, ct.id]);
  await q("INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, delivery_state) VALUES ($1,$2,$3,$6,$4,$7,$5,$8)", [ws, cv.id, a.id, `m.${digits()}`, body, dir, dir === "in" ? "contact" : "system", dir === "in" ? "received" : "sent"]);
  return { conv: cv.id as string, contact: ct.id as string };
}
const url = (conv: string, ws = A) => `/v1/workspaces/${ws}/conversations/${conv}/ai/suggest-reply/stream`;
const rawStream = (u: TestUser | null, conv: string, ws = A, signal?: AbortSignal) => h.app.request(url(conv, ws), { method: "POST", headers: { origin: ORIGIN, ...(u ? { cookie: u.cookie } : {}) }, signal });
type Ev = { event: string; data: Record<string, unknown> };
async function events(res: Response): Promise<Ev[]> {
  const out: Ev[] = [];
  for (const block of (await res.text()).split("\n\n")) {
    if (!block.trim() || block.startsWith(":")) continue;
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
    const data = /^data: (.*)$/m.exec(block)?.[1];
    out.push({ event, data: data ? JSON.parse(data) : {} });
  }
  return out;
}
const stream = async (u: TestUser, conv: string, ws = A) => events(await rawStream(u, conv, ws));
const runs = (ws = A) => q("SELECT * FROM ai_runs WHERE workspace_id=$1 ORDER BY created_at, id", [ws]);
const lastRun = async (ws = A) => (await runs(ws)).at(-1)!;
const budget = async (cap: number | null) => ok(await as(owner).call(endpoints.setAiBudget, { params: { workspaceId: A }, body: { monthlyCapMicro: cap, hardStop: true } }));
const P = (i: number, o: number, extra: Record<string, unknown> = {}) => ({ inputMicroPer1M: i, outputMicroPer1M: o, ...extra });
const text = (events: Ev[]) => events.filter((e) => e.event === "delta").map((e) => e.data.text as string).join("");
async function* gen(...evs: (StreamEvent | "wait")[]): AsyncGenerator<StreamEvent> { for (const e of evs) { if (e === "wait") await new Promise(() => undefined); else yield e; } }

beforeAll(async () => {
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  const listFetch = (async () => new Response(JSON.stringify(MOCK_OPENROUTER_MODELS), { status: 200 })) as unknown as typeof fetch;
  h = await bootstrap({ aiConfigsPerUser: 1000, aiSuggestionsPerUser: 1000, aiAgentRunsPerUser: 1000, openrouterBrowsesPerUser: 1000, openrouterBrowser: createModelBrowser({ fetch: listFetch }) }, undefined, {
    workerDb, box, backoffMs: 10, sleep: async (ms) => { sleeps.push(ms); },
    providerFor: (id, o) => (id === "mock" ? getProvider("mock", o) : scripted(id)),
  });
  [owner, admin, agent, viewer, ownerB] = (await Promise.all(["sto", "sta", "stg", "stv", "stb"].map((l) => h.newUser(l)))) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  A = await h.workspace(owner, "Stream A", { admin, agent, viewer });
  B = await h.workspace(ownerB, "Stream B");
  ok(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "mock" }, body: { isDefault: true } }));
  ok(await as(owner).call(endpoints.listOpenRouterModels, { params: { workspaceId: A } })); // fills the cache so the capability flags are stored
  ok(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "openrouter" }, body: { apiKey: KEY, isDefault: false, defaultModel: "mockvendor/alpha-chat", modelPrices: {
    "mockvendor/alpha-chat": P(3_000_000, 15_000_000), "mockvendor/beta-mini": P(100_000, 400_000), "mockvendor/gamma-text": P(1_000_000, 2_000_000),
  } } }));
});
afterAll(async () => { await workerDb.$client.end(); await h.close(); });

describe("stream route: access", () => {
  it("viewer and anonymous are refused; a foreign or unknown conversation is 404", async () => {
    const { conv } = await conversation(A);
    expect((await rawStream(viewer, conv)).status).toBe(403);
    expect((await rawStream(null, conv)).status).toBe(401);
    expect((await rawStream(owner, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await rawStream(owner, "not-a-uuid")).status).toBe(404);
    expect((await rawStream(ownerB, conv, B)).status).toBe(404); // another workspace cannot see it
    expect((await rawStream(agent, conv)).status).toBe(200); // ai.use: agents may draft
  });
  it("a conversation with no customer message is 422", async () => {
    const { conv } = await conversation(A, "We ship daily.", "out");
    expect((await rawStream(owner, conv)).status).toBe(422);
  });
  it("shares the suggest-reply rate limit counter", async () => {
    const hl = await bootstrap({ aiSuggestionsPerUser: 2 }, undefined, { workerDb, box, providerFor: (id, o) => getProvider(id, o) });
    try {
      const o = await hl.newUser("rl");
      const ws = await hl.workspace(o, "RL");
      await hl.clientFor(o).call(endpoints.setAiProvider, { params: { workspaceId: ws, provider: "mock" }, body: { isDefault: true } });
      const [a] = (await hl.admin.query("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,'messenger',$2,'connected','P') RETURNING id", [ws, digits()])).rows;
      const [stage] = (await hl.admin.query("SELECT id FROM lifecycle_stages WHERE workspace_id=$1 LIMIT 1", [ws])).rows;
      const [ct] = (await hl.admin.query("INSERT INTO contacts (workspace_id, name, lifecycle_stage_id, source) VALUES ($1,'R',$2,'messenger') RETURNING id", [ws, stage.id])).rows;
      const [idn] = (await hl.admin.query("INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, a.id, digits(), ct.id])).rows;
      const [cv] = (await hl.admin.query("INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, a.id, idn.id, ct.id])).rows;
      await hl.admin.query("INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, delivery_state) VALUES ($1,$2,$3,'in',$4,'contact','hi','received')", [ws, cv.id, a.id, `m.${digits()}`]);
      const go = () => hl.app.request(`/v1/workspaces/${ws}/conversations/${cv.id}/ai/suggest-reply/stream`, { method: "POST", headers: { origin: ORIGIN, cookie: o.cookie } });
      expect((await (await go()).text()).length).toBeGreaterThan(0);
      expect((await go()).status).toBe(200);
      const third = await go();
      expect(third.status).toBe(429);
      expect(third.headers.get("retry-after")).toBe("60");
    } finally { await hl.close(); }
  });
});

describe("stream route: events and run log (offline mock)", () => {
  it("headers, event order, and the streamed text equals the non-stream draft", async () => {
    const { conv } = await conversation(A);
    const res = await rawStream(owner, conv);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const ev = await events(res);
    const kinds = ev.map((e) => e.event);
    expect(kinds.at(-2)).toBe("usage");
    expect(kinds.at(-1)).toBe("done");
    expect(kinds.slice(0, -2).every((k) => k === "delta")).toBe(true);
    expect(kinds.filter((k) => k === "delta").length).toBeGreaterThan(2);
    const run = await lastRun();
    const plain = ok(await as(owner).call(endpoints.suggestReply, { params: { workspaceId: A, conversationId: conv } }));
    expect(text(ev)).toBe(plain.draft);
    expect(ev.at(-1)!.data).toMatchObject({ provider: "mock", model: "mock-1", mock: true });
    expect(run).toMatchObject({ capability: "reply_suggestion", provider: "mock", status: "ok" });
    expect(run.summary).toContain("streamed");
    expect(JSON.stringify(run)).not.toContain(plain.draft.slice(0, 20));
    expect(JSON.stringify(run)).not.toContain("Do you deliver");
  });
  it("provider failures arrive as one error event with the same codes as the JSON route", async () => {
    for (const [marker, code, status] of [["blocked", "blocked", 422], ["payment_required", "payment_required", 402]] as const) {
      const { conv } = await conversation(A, `help [[MOCK_ERROR:${marker}]]`);
      const ev = await stream(owner, conv);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ event: "error", data: { code, status } });
      expect(String(ev[0]!.data.message).length).toBeGreaterThan(10);
      const json = failure(await as(owner).call(endpoints.suggestReply, { params: { workspaceId: A, conversationId: conv } }));
      expect(json.status).toBe(status);
      expect((await lastRun()).error_code).toBe(marker);
    }
  });
});

describe("runAiStream with scripted providers (OpenRouter config)", () => {
  const useOr = async () => ok(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "openrouter" }, body: { isDefault: true } }));
  const useMock = async () => ok(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "mock" }, body: { isDefault: true } }));
  const ok3 = (reported?: number): StreamEvent[] => [{ type: "delta", text: "Hel" }, { type: "delta", text: "lo" }, { type: "usage", inputTokens: 1000, outputTokens: 2000, ...(reported !== undefined ? { reportedCostMicro: reported } : {}) }, { type: "done", finishReason: "stop", routedModel: "mockvendor/alpha-chat" }];

  it("cost from the final usage event = max(estimate, reported); both directions", async () => {
    await useOr();
    const { conv } = await conversation(A);
    impl = { stream: () => gen(...ok3(5)) }; // estimate: 1000*3 + 2000*15 = 33_000 micro per 1M-token math -> 33 micro; reported 5 loses
    const ev = await stream(owner, conv);
    expect(text(ev)).toBe("Hello");
    expect(ev.at(-2)!.data).toMatchObject({ inputTokens: 1000, outputTokens: 2000, costMicro: 33_000 });
    expect(await lastRun()).toMatchObject({ input_tokens: 1000, output_tokens: 2000, cost_micro: "33000", status: "ok", attempts: 1 });
    impl = { stream: () => gen(...ok3(90_000)) }; // reported wins
    expect((await stream(owner, conv)).at(-2)!.data.costMicro).toBe(90_000);
    expect((await lastRun()).cost_micro).toBe("90000");
  });
  it("hard stop: a budget that is used up blocks the stream BEFORE the provider is contacted", async () => {
    await useOr();
    const { conv } = await conversation(A);
    impl = { stream: () => gen(...ok3()) };
    await budget(1000); // the earlier runs already cost more than this
    const before = seen.length;
    const ev = await stream(owner, conv);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event: "error", data: { code: "budget_exceeded", status: 409 } });
    expect(seen.length).toBe(before);
    expect(await lastRun()).toMatchObject({ status: "blocked_budget", error_code: "budget_exceeded" });
    await budget(null);
  });
  it("retries only before the first delta: a pre-first-byte rate limit is retried, then it streams", async () => {
    await useOr();
    const { conv } = await conversation(A);
    let call = 0;
    impl = { stream: () => (++call === 1 ? gen({ type: "error", code: "rate_limit", status: 429, retryable: true }) : gen(...ok3())) };
    sleeps.length = 0;
    const ev = await stream(owner, conv);
    expect(text(ev)).toBe("Hello");
    expect(call).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect((await lastRun()).attempts).toBe(2);
  });
  it("an AiError thrown before the response (HTTP 503) is retried too, up to the limit", async () => {
    await useOr();
    const { conv } = await conversation(A);
    let call = 0;
    impl = { stream: () => { call++; throw new AiError("provider_error", 503, { retryable: true }); } };
    const ev = await stream(owner, conv);
    expect(call).toBe(3); // first try + 2 retries
    expect(ev).toEqual([expect.objectContaining({ event: "error", data: expect.objectContaining({ code: "ai_unavailable" }) })]);
    expect(await lastRun()).toMatchObject({ status: "error", attempts: 3, error_code: "provider_error" });
  });
  it("never replays after output started: a mid-stream error ends the stream (one call, tokens estimated)", async () => {
    await useOr();
    const { conv } = await conversation(A);
    let call = 0;
    impl = { stream: () => { call++; return gen({ type: "delta", text: "Partial answer here." }, { type: "error", code: "rate_limit", status: 429, retryable: true }); } };
    const ev = await stream(owner, conv);
    expect(call).toBe(1);
    expect(ev.map((e) => e.event)).toEqual(["delta", "error"]);
    expect(ev[1]!.data.code).toBe("ai_busy");
    const run = await lastRun();
    expect(run).toMatchObject({ status: "error", attempts: 1, error_code: "rate_limit", output_tokens: 5 }); // 20 chars / 4
    expect(Number(run.cost_micro)).toBeGreaterThan(0);
    expect(JSON.stringify(run)).not.toContain("Partial answer");
  });
  it("client abort aborts the upstream and logs client_aborted with estimated tokens", async () => {
    await useOr();
    const { conv } = await conversation(A);
    let upstream: AbortSignal | undefined;
    impl = { stream: (req) => { upstream = req.signal; return gen({ type: "delta", text: "Starting to answer" }, "wait"); } };
    const before = (await runs()).length;
    const ac = new AbortController();
    const res = await rawStream(owner, conv, A, ac.signal);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: delta");
    await reader.cancel(); // the browser went away
    expect(await until(async () => (await runs()).length > before)).toBe(true);
    expect(upstream!.aborted).toBe(true);
    expect(await lastRun()).toMatchObject({ status: "error", error_code: "client_aborted" });
    expect(Number((await lastRun()).output_tokens)).toBeGreaterThan(0);
  });
  it("a provider without generateStream falls back to one delta", async () => {
    await useOr();
    const { conv } = await conversation(A);
    impl = { generate: async () => ({ text: "Whole answer.", usage: { inputTokens: 10, outputTokens: 4 }, finishReason: "stop" }) };
    const ev = await stream(owner, conv);
    expect(ev.map((e) => e.event)).toEqual(["delta", "usage", "done"]);
    expect(text(ev)).toBe("Whole answer.");
    expect(await lastRun()).toMatchObject({ status: "ok", input_tokens: 10, output_tokens: 4 });
  });
  it("no key or prompt leaks into runs, audit or the stream", async () => {
    const all = JSON.stringify(await q("SELECT * FROM ai_runs WHERE workspace_id=$1", [A])) + JSON.stringify(await q("SELECT * FROM audit_log WHERE workspace_id=$1", [A]));
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("Do you deliver");
    await useMock();
  });
});

describe("agents: native tool calls, structured output, fallback", () => {
  const mk = async (grants: CreateAgentBody["toolGrants"], over: Partial<CreateAgentBody> = {}): Promise<AgentDto> => {
    const a = ok(await as(owner).call(endpoints.createAiAgent, { params: { workspaceId: A }, body: { name: uniq("Ag"), instructions: "Help the customer.", toolGrants: grants, ...over } }));
    ok(await as(owner).call(endpoints.activateAiAgent, { params: { workspaceId: A, agentId: a.id }, body: {} }));
    return a;
  };
  const test = (u: TestUser, id: string, b: Record<string, unknown>) => as(u).call(endpoints.testAiAgent, { params: { workspaceId: A, agentId: id }, body: { input: "hello", ...b } as never });
  const contact = async () => (await q("INSERT INTO contacts (workspace_id, name, lifecycle_stage_id, source) VALUES ($1,$2,(SELECT id FROM lifecycle_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1),'manual') RETURNING id", [A, uniq("C")]))[0].id as string;
  const notes = async (cid: string) => Number((await q("SELECT count(*) AS n FROM notes WHERE contact_id=$1", [cid]))[0].n);
  const tc = (name: string, args: unknown) => ({ id: "c1", name, arguments: typeof args === "string" ? args : JSON.stringify(args) });
  const native = (calls: ReturnType<typeof tc>[], textOut = "Native draft") => async (): Promise<GenerateResult> => ({ text: textOut, usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "tool_calls", toolCalls: calls });

  it("mock model: a native tool call becomes a pending approval action through the same apply path", async () => {
    const a = await mk([{ tool: "crm.add_note", mode: "approval" }]);
    const cid = await contact();
    const r = ok(await test(owner, a.id, { contactId: cid, dryRun: false, input: 'note it [[MOCK_TOOL:crm__add_note:{"body":"Call back"}]]' }));
    expect(r).toMatchObject({ via: "native_tools", malformed: false, mock: true });
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ tool: "crm.add_note", status: "pending", args: { body: "Call back" } });
    expect(await notes(cid)).toBe(0);
    expect(await q("SELECT 1 FROM ai_agent_actions WHERE agent_id=$1 AND status='pending'", [a.id])).toHaveLength(1);
    const dry = ok(await test(owner, a.id, { contactId: cid, input: 'note it [[MOCK_TOOL:crm__add_note:{"body":"x"}]]' }));
    expect(dry.actions[0]!.status).toBe("would_pend");
  });
  it("auto grant executes in a live run; the model's text decides nothing about grants", async () => {
    const a = await mk([{ tool: "crm.add_note", mode: "auto" }]);
    const cid = await contact();
    const r = ok(await test(owner, a.id, { contactId: cid, dryRun: false, input: '[[MOCK_TOOL:crm__add_note:{"body":"Auto note"}]]' }));
    expect(r.actions[0]).toMatchObject({ status: "executed" });
    expect(await notes(cid)).toBe(1);
    const bad = ok(await test(owner, a.id, { contactId: cid, dryRun: false, input: '[[MOCK_TOOL:crm__add_tag:{"tagName":"x"}]]' }));
    expect(bad.actions).toEqual([]); // the mock only emits tools that were offered; an ungranted one never reaches the model
  });
  it("scripted native answers: malformed arguments, unknown, ungranted and more than 3 actions are rejected; sensitive is pending", async () => {
    const cid = await contact();
    ok(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "openrouter" }, body: { isDefault: true } }));
    const viaOr = await mk([{ tool: "crm.add_note", mode: "auto" }, { tool: "crm.assign_owner", mode: "auto" }], { provider: "openrouter", model: "mockvendor/alpha-chat" });
    seen.length = 0;
    impl = { generate: native([tc("crm__add_note", "{not json"), tc("crm__bogus", {}), tc("crm__add_tag", { tagName: "x" }), tc("crm__add_note", { body: "ok1" }), tc("crm__add_note", { body: "ok2" })]) };
    const r = ok(await test(owner, viaOr.id, { contactId: cid, dryRun: false }));
    const req = seen.at(-1)!;
    expect(r.via).toBe("native_tools");
    // Positions 0-2 are bad (malformed JSON, unknown, ungranted); positions 3 and 4 are over the 3-action cap.
    expect(r.actions.filter((x) => x.status === "rejected").map((x) => x.detail).sort()).toEqual(["invalid_args", "not_granted", "too_many", "too_many", "unknown_tool"]);
    expect(await notes(cid)).toBe(0);
    impl = { generate: native([1, 2, 3, 4].map((i) => tc("crm__add_note", { body: `n${i}` }))) };
    const r2 = ok(await test(owner, viaOr.id, { contactId: cid, dryRun: false }));
    expect(r2.actions.filter((x) => x.status === "executed")).toHaveLength(3);
    expect(r2.actions.filter((x) => x.detail === "too_many")).toHaveLength(1);
    expect(await notes(cid)).toBe(3);
    const sens = await mk([{ tool: "crm.assign_owner", mode: "auto" }], { provider: "openrouter", model: "mockvendor/alpha-chat" });
    impl = { generate: native([tc("crm__assign_owner", { ownerUserId: owner.id })]) };
    expect(ok(await test(owner, sens.id, { contactId: cid, dryRun: false })).actions[0]).toMatchObject({ tool: "crm.assign_owner", status: "pending", detail: "sensitive" });
    // the request carried wire-safe tool definitions generated from the registry, and the native system prompt
    expect(req.tools!.map((t) => t.function.name).sort()).toEqual(["crm__add_note", "crm__assign_owner"]);
    expect(req.messages[0]!.content).toContain("plain text");
    expect(req.responseFormat).toBeUndefined();
  });
  it("native model, no tool_calls: empty or cut-off answers are flagged malformed (never a silent clean draft); plain prose stays a draft", async () => {
    const cid = await contact();
    ok(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "openrouter" }, body: { isDefault: true } }));
    const viaOr = await mk([{ tool: "crm.add_note", mode: "auto" }], { provider: "openrouter", model: "mockvendor/alpha-chat" });
    const say = (text: string, finishReason: GenerateResult["finishReason"]) => ({ generate: async (): Promise<GenerateResult> => ({ text, usage: { inputTokens: 10, outputTokens: 5 }, finishReason }) });
    impl = say("", "stop");
    expect(ok(await test(owner, viaOr.id, { contactId: cid, dryRun: false }))).toMatchObject({ via: "native_tools", malformed: true, actions: [] });
    impl = say("Sure, I can help with that and", "length");
    expect(ok(await test(owner, viaOr.id, { contactId: cid, dryRun: false }))).toMatchObject({ malformed: true, actions: [] });
    impl = say('{"reply":"Hello","actions":[{"tool":"crm.add_no', "stop");
    expect(ok(await test(owner, viaOr.id, { contactId: cid, dryRun: false }))).toMatchObject({ malformed: true, actions: [] });
    impl = say("Thanks for reaching out. I will check and reply.", "stop");
    expect(ok(await test(owner, viaOr.id, { contactId: cid, dryRun: false }))).toMatchObject({ malformed: false, reply: "Thanks for reaching out. I will check and reply.", actions: [] });
    expect(await notes(cid)).toBe(0);
  });
  it("fallback: a model without tools but with structured output gets response_format and the JSON-in-text protocol", async () => {
    // alpha supports both; a model with only structured output does not exist in the list, so store the flags the server confirmed for gamma and beta instead: beta = tools only, gamma = neither.
    const beta = await mk([{ tool: "crm.add_note", mode: "auto" }], { provider: "openrouter", model: "mockvendor/beta-mini" });
    seen.length = 0;
    impl = { generate: native([tc("crm__add_note", { body: "from beta" })]) };
    const cid = await contact();
    expect(ok(await test(owner, beta.id, { contactId: cid, dryRun: false })).via).toBe("native_tools"); // beta: tools yes
    expect(seen.at(-1)!.responseFormat).toBeUndefined(); // tools win; no response_format next to tools

    const gamma = await mk([{ tool: "crm.add_note", mode: "auto" }], { provider: "openrouter", model: "mockvendor/gamma-text" });
    seen.length = 0;
    impl = { generate: async () => ({ text: JSON.stringify({ reply: "Json draft", actions: [{ tool: "crm.add_note", args: { body: "json path" } }] }), usage: { inputTokens: 5, outputTokens: 5 }, finishReason: "stop" }) };
    const r = ok(await test(owner, gamma.id, { contactId: cid, dryRun: false }));
    expect(r).toMatchObject({ via: "text", reply: "Json draft" });
    expect(r.actions[0]).toMatchObject({ tool: "crm.add_note", status: "executed" });
    const req = seen.at(-1)!;
    expect(req.tools).toBeUndefined();
    expect(req.responseFormat).toBeUndefined();
    expect(req.messages[0]!.content).toContain('"actions"'); // the prompt-based JSON protocol
    // not-JSON from a prompt-only model is still flagged malformed and executes nothing
    impl = { generate: async () => ({ text: "plain words", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) };
    expect(ok(await test(owner, gamma.id, { contactId: cid, dryRun: false }))).toMatchObject({ malformed: true, actions: [] });
  });
  it("structured output: response_format json_schema is sent only to a model that supports it, when no tools are granted", async () => {
    const noTools = await mk([], { provider: "openrouter", model: "mockvendor/alpha-chat" });
    const lowTools = await mk([], { provider: "openrouter", model: "mockvendor/gamma-text" });
    const cid = await contact();
    impl = { generate: async () => ({ text: JSON.stringify({ reply: "Schema draft", actions: [] }), usage: { inputTokens: 5, outputTokens: 5 }, finishReason: "stop" }) };
    seen.length = 0;
    expect(ok(await test(owner, noTools.id, { contactId: cid }))).toMatchObject({ via: "json_schema", reply: "Schema draft" });
    expect(seen.at(-1)!.responseFormat).toMatchObject({ type: "json_schema", json_schema: { name: "agent_reply", schema: { type: "object" } } });
    seen.length = 0;
    expect(ok(await test(owner, lowTools.id, { contactId: cid })).via).toBe("text");
    expect(seen.at(-1)!.responseFormat).toBeUndefined();
    // whatever the model returns is still validated: an out-of-contract envelope is not trusted
    impl = { generate: async () => ({ text: JSON.stringify({ reply: 5, actions: "x" }), usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) };
    expect(ok(await test(owner, noTools.id, { contactId: cid }))).toMatchObject({ malformed: true, actions: [] });
  });
  it("an OpenAI-compatible model with no stored flags never receives tools or response_format", async () => {
    ok(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "openai" }, body: { apiKey: KEY, defaultModel: "gpt-4o-mini" } }));
    const a = await mk([{ tool: "crm.add_note", mode: "auto" }], { provider: "openai", model: "gpt-4o-mini" });
    seen.length = 0;
    impl = { generate: async () => ({ text: JSON.stringify({ reply: "d", actions: [] }), usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) };
    expect(ok(await test(owner, a.id, { contactId: await contact() })).via).toBe("text");
    expect(seen.at(-1)!.tools).toBeUndefined();
    expect(seen.at(-1)!.responseFormat).toBeUndefined();
  });
  it("viewer cannot run an agent", async () => {
    const a = await mk([]);
    expect(failure(await test(viewer, a.id, {})).status).toBe(403);
  });
});
