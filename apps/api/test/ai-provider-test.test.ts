import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiError, getProvider, type AiProvider } from "@crm/ai";
import { endpoints } from "@crm/contracts";
import { createDb, type Db } from "@crm/db";
import { createSecretBox } from "@crm/integrations";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

// Test connection: one tiny real-shaped call through the provider. Providers are the offline MOCK or a scripted FAKE.
const DB = process.env.CRM_DB_NAME ?? "crm";
const box = createSecretBox({ k1: Buffer.alloc(32, 7).toString("base64") }, "k1");
let h: Harness, workerDb: Db, owner: TestUser, viewer: TestUser, A = "", reject = false;
const as = (u: TestUser) => h.clientFor(u);
const fake = (id: string): AiProvider => ({
  id,
  async generate() { if (reject) throw new AiError("auth", 401); return { text: "OK", usage: { inputTokens: 5, outputTokens: 1 }, finishReason: "stop" }; },
});

beforeAll(async () => {
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  h = await bootstrap({ aiConfigsPerUser: 1000 }, undefined, { workerDb, box, backoffMs: 1, sleep: async () => {}, providerFor: (id, o) => (id === "mock" ? getProvider(id, o) : fake(id)) });
  [owner, viewer] = (await Promise.all(["ptw", "ptv"].map((l) => h.newUser(l)))) as [TestUser, TestUser];
  A = await h.workspace(owner, "PT A", { viewer });
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
