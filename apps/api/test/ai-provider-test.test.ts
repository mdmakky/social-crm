import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiError, createGemini, getProvider, type AiProvider } from "@crm/ai";
import { endpoints } from "@crm/contracts";
import { createDb, type Db } from "@crm/db";
import { createSecretBox } from "@crm/integrations";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

// Test connection: one tiny real-shaped call through the provider. Providers are the offline MOCK or a scripted FAKE.
const DB = process.env.CRM_DB_NAME ?? "crm";
const box = createSecretBox({ k1: Buffer.alloc(32, 7).toString("base64") }, "k1");
const SERVER_KEY = "AIzaSy-SERVER-KEY-0123456789";
const gemSeen: { url: string; key: string; mime: string }[] = [];
const geminiFetch = (async (url: string, init: RequestInit) => {
  const b = JSON.parse(init.body as string);
  gemSeen.push({ url, key: (init.headers as Record<string, string>)["x-goog-api-key"]!, mime: b.contents[0].parts[1].inline_data.mime_type });
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 0 } }), { status: 200 });
}) as unknown as typeof fetch;
let h: Harness, workerDb: Db, owner: TestUser, viewer: TestUser, A = "", B = "", reject = false;
const as = (u: TestUser) => h.clientFor(u);
const fake = (id: string): AiProvider => ({
  id,
  async generate() { if (reject) throw new AiError("auth", 401); return { text: "OK", usage: { inputTokens: 5, outputTokens: 1 }, finishReason: "stop" }; },
});

beforeAll(async () => {
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  h = await bootstrap({ aiConfigsPerUser: 1000 }, undefined, { workerDb, box, backoffMs: 1, sleep: async () => {}, envKeys: { gemini: SERVER_KEY }, envModels: { gemini: "gemini-2.5-flash-lite" }, providerFor: (id, o) => (id === "mock" ? getProvider(id, o) : id === "gemini" ? createGemini({ fetch: geminiFetch, timeoutMs: o.timeoutMs }) : fake(id)) });
  [owner, viewer] = (await Promise.all(["ptw", "ptv"].map((l) => h.newUser(l)))) as [TestUser, TestUser];
  A = await h.workspace(owner, "PT A", { viewer });
  B = await h.workspace(owner, "PT B");
  ok(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "anthropic" }, body: { apiKey: "sk-ant-" + "k".repeat(30), defaultModel: "claude-sonnet-4-5", isDefault: true } }));
});
afterAll(async () => { await workerDb.$client.end(); await h.close(); });

describe("test connection", () => {
  const providers = async () => ok(await as(owner).call(endpoints.listAiProviders, { params: { workspaceId: A } })).items;
  it("is unproven until a real call works, then records it", async () => {
    expect((await providers()).find((p) => p.id === "anthropic")!.lastOkAt).toBeNull();
    reject = true;
    expect(failure(await as(owner).call(endpoints.testAiProvider, { params: { workspaceId: A, provider: "anthropic" } })).code).toBe("ai_key_rejected");
    expect((await providers()).find((p) => p.id === "anthropic")!.lastOkAt).toBeNull();
    reject = false;
    const r = ok(await as(owner).call(endpoints.testAiProvider, { params: { workspaceId: A, provider: "anthropic" } }));
    expect(r).toMatchObject({ ok: true, model: "claude-sonnet-4-5", mock: false });
    expect((await providers()).find((p) => p.id === "anthropic")!.lastOkAt).not.toBeNull();
  });
  it("is owner/admin only and refuses an unknown provider", async () => {
    expect(failure(await as(viewer).call(endpoints.testAiProvider, { params: { workspaceId: A, provider: "anthropic" } })).code).toBe("forbidden");
    expect(failure(await as(owner).call(endpoints.testAiProvider, { params: { workspaceId: A, provider: "nope" } })).code).toBe("not_found");
  });
});

describe("gemini speech to text (fake fetch, no real key)", () => {
  const gem = async (ws = A) => ok(await as(owner).call(endpoints.listAiProviders, { params: { workspaceId: ws } })).items.find((p) => p.id === "gemini")!;
  it("shows that the server holds a key, without ever returning it", async () => {
    const g = await gem();
    expect(g).toMatchObject({ configured: false, serverKey: true, keyLast4: null });
    expect(JSON.stringify(g)).not.toContain(SERVER_KEY);
    expect((await gem()).models.map((m) => m.id)).toEqual(["gemini-2.5-flash", "gemini-2.5-flash-lite"]);
  });
  it("connects with no pasted key, uses the operator's model, and stays out of the way of text jobs", async () => {
    const r = ok(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "gemini" }, body: { enabled: true, isDefault: false } }));
    expect(r).toMatchObject({ configured: true, defaultModel: "gemini-2.5-flash-lite", keyLast4: null, isDefault: false });
    const items = ok(await as(owner).call(endpoints.listAiProviders, { params: { workspaceId: A } })).items;
    expect(items.find((p) => p.id === "anthropic")!.isDefault).toBe(true); // the text provider is untouched
    const jobs = ok(await as(owner).call(endpoints.listAiJobModels, { params: { workspaceId: A } })).items;
    expect(jobs.find((j) => j.job === "reply")!.effective?.provider).toBe("anthropic");
    expect(jobs.find((j) => j.job === "transcription")!.effective).toMatchObject({ provider: "gemini", model: "gemini-2.5-flash-lite" });
  });
  it("test connection sends silence as audio/wav with the server key in a header, and records a real run", async () => {
    gemSeen.length = 0;
    const t = ok(await as(owner).call(endpoints.testAiProvider, { params: { workspaceId: A, provider: "gemini" } }));
    expect(t).toMatchObject({ ok: true, model: "gemini-2.5-flash-lite", mock: false });
    expect(gemSeen).toHaveLength(1);
    expect(gemSeen[0]).toMatchObject({ key: SERVER_KEY, mime: "audio/wav", url: expect.stringContaining("/models/gemini-2.5-flash-lite:generateContent") });
    expect((await gem()).lastOkAt).not.toBeNull();
    const [run] = (await h.admin.query("SELECT provider, status, capability FROM ai_runs WHERE workspace_id=$1 AND provider='gemini' ORDER BY id DESC LIMIT 1", [A])).rows;
    expect(run).toMatchObject({ provider: "gemini", status: "ok", capability: "connection_test" });
  });
  it("a workspace key beats the server key", async () => {
    ok(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "gemini" }, body: { apiKey: "AIzaSy-WORKSPACE-KEY-0123456789" } }));
    gemSeen.length = 0;
    ok(await as(owner).call(endpoints.testAiProvider, { params: { workspaceId: A, provider: "gemini" } }));
    expect(gemSeen[0]!.key).toBe("AIzaSy-WORKSPACE-KEY-0123456789");
  });
  it("a provider without a server key still needs a pasted key", async () => {
    expect(failure(await as(owner).call(endpoints.setAiProvider, { params: { workspaceId: B, provider: "anthropic" }, body: { enabled: true } })).code).toBe("key_required");
  });
});
