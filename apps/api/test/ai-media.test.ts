import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiError, getProvider, MEDIA_LIMITS, type AiProvider } from "@crm/ai";
import { endpoints, MEDIA_LIMITS as CONTRACT_LIMITS } from "@crm/contracts";
import { createDb, type Db } from "@crm/db";
import { createSecretBox } from "@crm/integrations";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

// AI multimodal slice 1. The provider is the offline MOCK or a scripted FAKE: nothing here talks to a real AI service.
const DB = process.env.CRM_DB_NAME ?? "crm";
const box = createSecretBox({ k1: Buffer.alloc(32, 7).toString("base64") }, "k1");
const KEY = "sk-ant-VERYSECRET-" + "k".repeat(30);
let h: Harness, hl: Harness, workerDb: Db;
let owner: TestUser, admin: TestUser, agent: TestUser, viewer: TestUser, ownerB: TestUser, limitOwner: TestUser;
let A = "", B = "", L = "";
const as = (u: TestUser, hh = h) => hh.clientFor(u);
const p = (ws = A) => ({ workspaceId: ws });
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
const mp3 = Buffer.concat([Buffer.from("ID3\x03\0\0\0\0\0\0"), Buffer.alloc(200, 1)]);
const b64 = (b: Buffer) => b.toString("base64");
const img = { mime: "image/png", contentBase64: b64(png) };

// Scripted fake for the non-mock providers: counts real invocations per method.
const fakeCalls = { vision: 0, document: 0, transcribe: 0 };
let fakeOverride: Partial<AiProvider> | null = null;
const fake = (id: string): AiProvider => ({
  id,
  async generate() { throw new Error("unused"); },
  async vision() { fakeCalls.vision++; return { text: "SECRET-OUTPUT-TEXT a cup", usage: { inputTokens: 1000, outputTokens: 100 }, finishReason: "stop" }; },
  async document() { fakeCalls.document++; return { text: "SECRET-OUTPUT-TEXT pdf", usage: { inputTokens: 0, outputTokens: 50 }, finishReason: "stop" }; },
  async transcribe() { fakeCalls.transcribe++; return { text: "SECRET-OUTPUT-TEXT said", usage: { inputTokens: 0, outputTokens: 0 }, durationSec: 90 }; },
  ...fakeOverride,
});
const deps = () => ({ workerDb, box, backoffMs: 1, sleep: async () => {}, providerFor: (id: string, o: { baseUrl?: string; timeoutMs: number }) => (id === "mock" ? getProvider(id, o) : fake(id)) });

const connectMock = (u: TestUser, ws: string, hh = h) => as(u, hh).call(endpoints.setAiProvider, { params: { workspaceId: ws, provider: "mock" }, body: { isDefault: true } });
const connect = (u: TestUser, ws: string, provider: string, body: Record<string, unknown>) => as(u).call(endpoints.setAiProvider, { params: { workspaceId: ws, provider }, body: body as never });
const runs = (ws = A) => q("SELECT * FROM ai_runs WHERE workspace_id=$1 ORDER BY created_at, id", [ws]);
/** Which providers are enabled and which one is the default (a single default, always enabled: the table enforces it). */
const setup = async (ws: string, on: string[], def: string | null) => {
  await q("UPDATE ai_provider_configs SET is_default=false WHERE workspace_id=$1", [ws]);
  await q("UPDATE ai_provider_configs SET enabled = (provider = ANY($2)) WHERE workspace_id=$1", [ws, on]);
  if (def) await q("UPDATE ai_provider_configs SET is_default=true WHERE workspace_id=$1 AND provider=$2", [ws, def]);
};
const describe_ = (u: TestUser, body: { mime: string; contentBase64: string } = img, ws = A, hh = h) => as(u, hh).call(endpoints.describeMedia, { params: p(ws), body });

beforeAll(async () => {
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  h = await bootstrap({ aiConfigsPerUser: 1000, mediaLimits: { perWorkspace: 1000 }, knowledge: { limits: { ingestPerUser: 1000 } } }, undefined, deps());
  hl = await bootstrap({ aiConfigsPerUser: 1000, mediaLimits: { perWorkspace: 2 } }, undefined, deps());
  [owner, admin, agent, viewer, ownerB] = (await Promise.all(["mmo", "mma", "mmg", "mmv", "mmb"].map((l) => h.newUser(l)))) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  A = await h.workspace(owner, "MM A", { admin, agent, viewer });
  B = await h.workspace(ownerB, "MM B");
  limitOwner = await hl.newUser("mml");
  L = await hl.workspace(limitOwner, "MM L");
});
afterAll(async () => { await workerDb.$client.end(); await h.close(); await hl.close(); });

describe("contract", () => {
  it("limits in contracts match the package", () => { expect(CONTRACT_LIMITS).toEqual(MEDIA_LIMITS); });
});

describe("nothing configured", () => {
  it("capabilities are empty and every media call says capability_not_configured, without a provider call or a run", async () => {
    expect(ok(await as(owner).call(endpoints.getAiCapabilities, { params: p() }))).toEqual({ providers: [], available: { vision: false, ocr: false, transcription: false } });
    expect(failure(await describe_(owner))).toMatchObject({ status: 409, code: "capability_not_configured" });
    expect(await runs()).toEqual([]);
  });
});

describe("permissions and tenancy", () => {
  it("owner, admin and agent may use media; viewer and non-members may not", async () => {
    ok(await connectMock(owner, A));
    for (const u of [owner, admin, agent]) { ok(await describe_(u)); ok(await as(u).call(endpoints.getAiCapabilities, { params: p() })); }
    expect(failure(await describe_(viewer)).status).toBe(403);
    expect(failure(await as(viewer).call(endpoints.getAiCapabilities, { params: p() })).status).toBe(403);
    expect(failure(await as(viewer).call(endpoints.transcribeMedia, { params: p(), body: { mime: "audio/mpeg", contentBase64: b64(mp3) } })).status).toBe(403);
    expect(failure(await describe_(ownerB, img, A)).status).toBe(404);
    expect(failure(await as(ownerB).call(endpoints.getAiCapabilities, { params: p(A) })).status).toBe(404);
  });
  it("another workspace's provider config is invisible: B has no capability even though A has the mock", async () => {
    expect(ok(await as(ownerB).call(endpoints.getAiCapabilities, { params: p(B) })).providers).toEqual([]);
    expect(failure(await describe_(ownerB, img, B)).code).toBe("capability_not_configured");
    expect((await runs(B)).length).toBe(0);
  });
});

describe("mock provider end to end", () => {
  it("describe, ask, extract (pdf and image) and transcribe return labelled text with usage and a run id", async () => {
    const d = ok(await describe_(owner));
    expect(d).toMatchObject({ provider: "mock", model: "mock-1", mock: true, usage: { costMicro: 0 } });
    expect(d.text).toMatch(/^\[MOCK IMAGE DESCRIPTION\]/);
    expect(d.usage.inputTokens).toBeGreaterThan(0);
    expect(d.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ok(await as(owner).call(endpoints.askMedia, { params: p(), body: { ...img, question: "What colour is it?" } })).text).toMatch(/^\[MOCK ANSWER\]/);
    expect(ok(await as(owner).call(endpoints.extractMedia, { params: p(), body: { mime: "application/pdf", contentBase64: b64(pdf) } })).text).toMatch(/^\[MOCK DOCUMENT TEXT\] Mock extracted text of a document/);
    expect(ok(await as(owner).call(endpoints.extractMedia, { params: p(), body: img })).text).toMatch(/of a image/);
    expect(ok(await as(owner).call(endpoints.transcribeMedia, { params: p(), body: { mime: "audio/mpeg", contentBase64: b64(mp3), language: "en" } })).text).toMatch(/^\[MOCK TRANSCRIPT\]/);
    expect(ok(await describe_(owner)).text).toBe(d.text); // deterministic
  });
  it("capabilities show the mock with every capability, labelled mock and not unverified", async () => {
    const c = ok(await as(agent).call(endpoints.getAiCapabilities, { params: p() }));
    expect(c.available).toEqual({ vision: true, ocr: true, transcription: true });
    expect(c.providers[0]).toMatchObject({ provider: "mock", mock: true, unverified: false, models: [{ id: "mock-1", capabilities: ["text", "vision", "transcription", "document"] }] });
  });
  it("runs are logged with capability labels and no media or output bodies", async () => {
    const rows = await runs();
    expect(new Set(rows.map((r) => r.capability))).toEqual(new Set(["vision", "ocr", "transcription"]));
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("MOCK");
    expect(dump).not.toContain(b64(png).slice(0, 12));
    expect(dump).not.toContain("colour");
    const r = rows.find((x) => x.prompt_key === "media_describe")!;
    expect(r).toMatchObject({ status: "ok", provider: "mock", requested_by: owner.id });
    expect(r.summary).toMatch(/^media image image\/png 15 bytes, out \d+ chars$/);
    expect(r.input_hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("validation before any provider call", () => {
  it("spoofed mime, wrong kind, empty, junk and oversize are refused", async () => {
    const before = (await runs()).length;
    expect(failure(await describe_(owner, { mime: "image/png", contentBase64: b64(pdf) }))).toMatchObject({ status: 422, code: "unsupported_media" }); // a PDF is not an image
    expect(failure(await as(owner).call(endpoints.extractMedia, { params: p(), body: { mime: "image/png", contentBase64: b64(pdf) } }))).toMatchObject({ status: 422, code: "mime_mismatch" });
    expect(failure(await describe_(owner, { mime: "image/png", contentBase64: b64(Buffer.from("<svg onload=alert(1)>")) }))).toMatchObject({ status: 422, code: "unsupported_media" });
    expect(failure(await describe_(owner, { mime: "application/pdf", contentBase64: b64(pdf) }))).toMatchObject({ code: "unsupported_media" }); // describe takes images only
    expect(failure(await as(owner).call(endpoints.transcribeMedia, { params: p(), body: img })).code).toBe("unsupported_media");
    expect(failure(await as(owner).call(endpoints.transcribeMedia, { params: p(), body: { mime: "audio/mpeg", contentBase64: b64(Buffer.from("RIFF\0\0\0\0WAVEfmt ")) } })).code).toBe("mime_mismatch");
    expect(failure(await describe_(owner, { mime: "image/png", contentBase64: "A" })).code).toBe("empty_media");
    const big = Buffer.alloc(MEDIA_LIMITS.image + 1);
    png.copy(big);
    expect(failure(await describe_(owner, { mime: "image/png", contentBase64: b64(big) }))).toMatchObject({ status: 413, code: "media_too_large" });
    expect(failure(await describe_(owner, { mime: "image/png", contentBase64: "not base64!!" })).kind).toBe("invalid_request");
    expect((await runs()).length).toBe(before);
  });
});

describe("a real-provider config with a fake adapter", () => {
  it("anthropic: vision and OCR yes, transcription no; the key never appears in any response", async () => {
    ok(await connect(owner, A, "anthropic", { apiKey: KEY, defaultModel: "claude-haiku-4-5", isDefault: true }));
    const c = ok(await as(owner).call(endpoints.getAiCapabilities, { params: p() }));
    const a = c.providers.find((x) => x.provider === "anthropic")!;
    expect(a).toMatchObject({ unverified: true, mock: false, isDefault: true });
    expect(a.models.find((m) => m.id === "claude-haiku-4-5")!.capabilities).toEqual(["text", "vision", "document"]);
    expect(JSON.stringify(c)).not.toContain(KEY);
    const d = ok(await describe_(owner));
    expect(d).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5", mock: false, usage: { inputTokens: 1000, outputTokens: 100 } });
    expect(d.usage.costMicro).toBe(1000 * 1 + 100 * 5); // 1 000 000/1M * 1000 + 5 000 000/1M * 100
    expect(JSON.stringify(d)).not.toContain(KEY);
    // PDF goes to the document capability; a provider-reported 0 input tokens falls back to the documented estimate.
    const x = ok(await as(owner).call(endpoints.extractMedia, { params: p(), body: { mime: "application/pdf", contentBase64: b64(pdf) } }));
    expect(fakeCalls.document).toBe(1);
    expect(x.usage.inputTokens).toBe(Math.ceil(pdf.length / 32));
  });
  it("transcription falls through to another enabled provider with the capability (default first), else is not configured", async () => {
    const before = { ...fakeCalls };
    // anthropic is default and cannot transcribe; the mock (also enabled, not default) can.
    const t = ok(await as(owner).call(endpoints.transcribeMedia, { params: p(), body: { mime: "audio/mpeg", contentBase64: b64(mp3) } }));
    expect(t.provider).toBe("mock");
    expect(fakeCalls).toEqual(before);
    await setup(A, ["anthropic"], "anthropic"); // the mock is switched off; anthropic is the default
    const f = failure(await as(owner).call(endpoints.transcribeMedia, { params: p(), body: { mime: "audio/mpeg", contentBase64: b64(mp3) } }));
    expect(f).toMatchObject({ status: 409, code: "capability_not_configured" });
    expect(fakeCalls).toEqual(before); // the unsupported call never reached a provider
  });
  it("openai: a whisper model is chosen for transcription and priced per minute", async () => {
    ok(await connect(owner, A, "openai", { apiKey: KEY, defaultModel: "gpt-4o", isDefault: true }));
    const t = ok(await as(owner).call(endpoints.transcribeMedia, { params: p(), body: { mime: "audio/mpeg", contentBase64: b64(mp3) } }));
    expect(t).toMatchObject({ provider: "openai", model: "whisper-1", usage: { costMicro: 9000 } }); // 90 s at 6000 micro per minute
    expect((await runs()).at(-1)).toMatchObject({ capability: "transcription", model: "whisper-1", cost_micro: "9000" });
  });
  it("a PDF with only vision models available is not configured; images still OCR through vision", async () => {
    await setup(A, ["openai"], "openai");
    expect(failure(await as(owner).call(endpoints.extractMedia, { params: p(), body: { mime: "application/pdf", contentBase64: b64(pdf) } })).code).toBe("capability_not_configured");
    const before = fakeCalls.vision;
    ok(await as(owner).call(endpoints.extractMedia, { params: p(), body: img }));
    expect(fakeCalls.vision).toBe(before + 1);
  });
  it("a provider that lacks the method answers unsupported_capability and the run is logged as an error", async () => {
    fakeOverride = { vision: undefined };
    try {
      expect(failure(await describe_(owner))).toMatchObject({ status: 422, code: "unsupported_capability" });
    } finally { fakeOverride = null; }
    expect((await runs()).at(-1)).toMatchObject({ status: "error", error_code: "unsupported_capability" });
  });
  it("provider errors map to clear statuses", async () => {
    for (const [code, status] of [["rate_limit", 429], ["auth", 502], ["provider_error", 502], ["timeout", 502]] as const) {
      fakeOverride = { async vision() { throw new AiError(code); } };
      try { expect(failure(await describe_(owner)), code).toMatchObject({ status, code }); } finally { fakeOverride = null; }
    }
  });
  it("logs hold no output text, no key and no media after all of the above", async () => {
    const dump = JSON.stringify(await runs());
    for (const bad of ["SECRET-OUTPUT-TEXT", KEY, b64(png)]) expect(dump).not.toContain(bad);
    const audit = JSON.stringify(await q("SELECT summary FROM audit_log WHERE workspace_id=$1", [A]));
    expect(audit).not.toContain(KEY);
  });
});

describe("budget hard stop", () => {
  it("blocks media calls without contacting the provider, and logs the block", async () => {
    await setup(A, ["anthropic"], "anthropic");

    ok(await as(owner).call(endpoints.setAiBudget, { params: p(), body: { monthlyCapMicro: 1, hardStop: true } }));
    const before = { ...fakeCalls };
    for (const call of [
      () => describe_(owner),
      () => as(owner).call(endpoints.askMedia, { params: p(), body: { ...img, question: "?" } }),
      () => as(owner).call(endpoints.extractMedia, { params: p(), body: { mime: "application/pdf", contentBase64: b64(pdf) } }),
    ]) expect(failure(await call())).toMatchObject({ status: 409, code: "budget_exceeded" });
    expect(fakeCalls).toEqual(before);
    const blocked = (await runs()).filter((r) => r.status === "blocked_budget");
    expect(blocked.length).toBe(3);
    expect(blocked[0]).toMatchObject({ error_code: "budget_exceeded", cost_micro: "0" });
    ok(await as(owner).call(endpoints.setAiBudget, { params: p(), body: { monthlyCapMicro: null, hardStop: true } }));
  });
});

describe("rate limit", () => {
  it("answers 429 with Retry-After once the per-workspace window is used up", async () => {
    ok(await as(limitOwner, hl).call(endpoints.setAiProvider, { params: { workspaceId: L, provider: "mock" }, body: { isDefault: true } }));
    ok(await describe_(limitOwner, img, L, hl));
    ok(await describe_(limitOwner, img, L, hl));
    const res = await hl.app.request(`/v1/workspaces/${L}/ai/media/describe`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie: limitOwner.cookie }, body: JSON.stringify(img) });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect((await res.json()).error.code).toBe("rate_limited");
  });
});

describe("knowledge base ingestion of PDF, image and audio", () => {
  const upload = (u: TestUser, filename: string, bytes: Buffer, ws = A) => as(u).call(endpoints.createKnowledgeFile, { params: p(ws), body: { filename, contentBase64: b64(bytes) } });
  const sources = async (ws = A, u = owner) => ok(await as(u).call(endpoints.listKnowledgeSources, { params: p(ws) })).items;
  it("with a mock provider each becomes a ready file source with searchable passages", async () => {
    await setup(A, ["mock"], "mock");


    for (const [name, bytes] of [["manual.pdf", pdf], ["receipt.png", png], ["voicemail.mp3", mp3]] as const) {
      const s = ok(await upload(owner, name, bytes));
      expect(s).toMatchObject({ type: "file", status: "ready", sourceRef: name, error: null });
      expect(s.chunkCount).toBeGreaterThan(0);
    }
    const hits = ok(await as(owner).call(endpoints.searchKnowledge, { params: p(), query: { q: "transcript" } })).items;
    expect(hits[0]).toMatchObject({ title: "voicemail.mp3", sourceRef: "voicemail.mp3" });
    expect(ok(await as(viewer).call(endpoints.searchKnowledge, { params: p(), query: { q: "extracted" } })).items.length).toBeGreaterThanOrEqual(2);
    const rows = await runs();
    expect(rows.filter((r) => r.capability === "ocr").length).toBeGreaterThanOrEqual(2);
  });
  it("a spoofed file (a PNG named .pdf) becomes a failed source with a clear code and a 422", async () => {
    const n = (await sources()).length;
    expect(failure(await upload(owner, "fake.pdf", png))).toMatchObject({ status: 422, code: "unsupported_media" });
    const s = await sources();
    expect(s.length).toBe(n + 1);
    expect(s.find((x) => x.title === "fake.pdf")).toMatchObject({ status: "failed", error: "unsupported_media", chunkCount: 0, charCount: 0 });
  });
  it("viewers and agents cannot upload; text formats still work and stay capped at 2 MB", async () => {
    expect(failure(await upload(viewer, "a.pdf", pdf)).status).toBe(403);
    expect(failure(await upload(agent, "a.pdf", pdf)).status).toBe(403);
    expect(ok(await as(owner).call(endpoints.createKnowledgeFile, { params: p(), body: { filename: "faq.txt", content: "Delivery takes three days." } })).status).toBe("ready");
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 97);
    expect(failure(await upload(owner, "big.txt", big))).toMatchObject({ status: 413, code: "too_large" });
  });
  it("with no capable provider the failed source says capability_not_configured; budget stop says budget_exceeded", async () => {
    await setup(A, [], null);
    expect(failure(await upload(owner, "late.pdf", pdf))).toMatchObject({ status: 409, code: "capability_not_configured" });
    expect((await sources()).find((x) => x.title === "late.pdf")).toMatchObject({ status: "failed", error: "capability_not_configured" });
    await setup(A, ["anthropic"], "anthropic");
    ok(await as(owner).call(endpoints.setAiBudget, { params: p(), body: { monthlyCapMicro: 1, hardStop: true } }));
    expect(failure(await upload(owner, "budget.pdf", pdf))).toMatchObject({ status: 409, code: "budget_exceeded" });
    ok(await as(owner).call(endpoints.setAiBudget, { params: p(), body: { monthlyCapMicro: null, hardStop: true } }));
  });
  it("another workspace sees none of it", async () => {
    expect(await sources(B, ownerB)).toEqual([]);
  });
});
