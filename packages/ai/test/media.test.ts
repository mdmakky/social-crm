import { describe, expect, it } from "vitest";
import { AiError, checkMedia, createAnthropic, createMockProvider, createOpenAiCompatible, estimateAudioSeconds, estimateMediaTokens, invokeMedia, MEDIA_LIMITS, perMinuteCostMicro, pickModel, priceOf, supports, type MediaInput } from "../src/index.ts";

// Everything here is a FAKE fetch or the offline mock. No real provider is contacted: real-provider behaviour is UNVERIFIED.
const png = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const jpg = () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const pdf = () => new TextEncoder().encode("%PDF-1.4\n1 0 obj");
const wav = () => new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt ");
const mp3 = () => new TextEncoder().encode("ID3\x03\0\0\0\0\0\0");
const img = (): MediaInput => ({ kind: "image", mime: "image/png", bytes: png() });
const aud = (): MediaInput => ({ kind: "audio", mime: "audio/wav", bytes: wav() });
const doc = (): MediaInput => ({ kind: "document", mime: "application/pdf", bytes: pdf() });
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof AiError ? e.code : `other:${String(e)}`));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("capabilities in the catalog", () => {
  it("supports() answers per provider and model; unknown models support nothing", () => {
    expect(supports("mock", "mock-1", "transcription")).toBe(true);
    expect(supports("anthropic", "claude-sonnet-4-5", "vision")).toBe(true);
    expect(supports("anthropic", "claude-sonnet-4-5", "document")).toBe(true);
    expect(supports("anthropic", "claude-sonnet-4-5", "transcription")).toBe(false);
    expect(supports("openai", "gpt-4o", "document")).toBe(false);
    expect(supports("openai", "whisper-1", "transcription")).toBe(true);
    expect(supports("openai", "nope", "text")).toBe(false);
    expect(supports("openai", "my-local", "vision", { "my-local": { inputMicroPer1M: 1, outputMicroPer1M: 1 } })).toBe(false); // workspace-added models are text only
    expect(supports("openai", "my-local", "text", { "my-local": { inputMicroPer1M: 1, outputMicroPer1M: 1 } })).toBe(true);
  });
  it("pickModel prefers the default model, then any model that qualifies, in the order of the wanted capabilities", () => {
    expect(pickModel("openai", "gpt-4o", ["vision"])?.model.id).toBe("gpt-4o");
    expect(pickModel("openai", "gpt-4o", ["transcription"])?.model.id).toBe("whisper-1");
    expect(pickModel("openai", "gpt-4o", ["document", "vision"])).toMatchObject({ via: "vision" });
    expect(pickModel("openai", "gpt-4o", ["document"])).toBeNull();
    expect(priceOf("openai", "whisper-1")?.transcriptionMicroPerMinute).toBe(6000);
  });
});

describe("magic bytes, allowlist and size caps", () => {
  it("accepts real files with the right mime (aliases included) and normalises the mime", () => {
    expect(checkMedia("image/png", png(), ["image"])).toMatchObject({ ok: true, media: { kind: "image", mime: "image/png" } });
    expect(checkMedia("IMAGE/JPG; charset=x", jpg(), ["image"])).toMatchObject({ ok: true, media: { mime: "image/jpeg" } });
    expect(checkMedia("application/pdf", pdf(), ["image", "document"])).toMatchObject({ ok: true, media: { kind: "document" } });
    expect(checkMedia("audio/x-wav", wav(), ["audio"])).toMatchObject({ ok: true, media: { mime: "audio/wav" } });
    expect(checkMedia("audio/mp3", mp3(), ["audio"])).toMatchObject({ ok: true, media: { mime: "audio/mpeg" } });
  });
  it("rejects a spoofed mime: bytes decide", () => {
    expect(checkMedia("image/png", pdf(), ["image", "document"])).toEqual({ ok: false, code: "mime_mismatch" });
    expect(checkMedia("image/png", jpg(), ["image"])).toEqual({ ok: false, code: "mime_mismatch" });
    expect(checkMedia("application/pdf", png(), ["image", "document"])).toEqual({ ok: false, code: "mime_mismatch" });
    expect(checkMedia("image/png", new TextEncoder().encode("<script>alert(1)</script>"), ["image"])).toEqual({ ok: false, code: "unsupported_media" });
    expect(checkMedia("image/svg+xml", new TextEncoder().encode("<svg/>"), ["image"])).toEqual({ ok: false, code: "unsupported_media" });
  });
  it("refuses kinds the call does not take, and empty input", () => {
    expect(checkMedia("audio/wav", wav(), ["image"])).toEqual({ ok: false, code: "unsupported_media" });
    expect(checkMedia("application/pdf", pdf(), ["image"])).toEqual({ ok: false, code: "unsupported_media" });
    expect(checkMedia("image/png", new Uint8Array(0), ["image"])).toEqual({ ok: false, code: "empty_media" });
  });
  it("enforces the size cap per kind", () => {
    const big = (head: Uint8Array, n: number) => { const b = new Uint8Array(n); b.set(head); return b; };
    expect(checkMedia("image/png", big(png(), MEDIA_LIMITS.image), ["image"]).ok).toBe(true);
    expect(checkMedia("image/png", big(png(), MEDIA_LIMITS.image + 1), ["image"])).toEqual({ ok: false, code: "media_too_large" });
    expect(checkMedia("application/pdf", big(pdf(), MEDIA_LIMITS.document + 1), ["document"])).toEqual({ ok: false, code: "media_too_large" });
    expect(checkMedia("audio/wav", big(wav(), MEDIA_LIMITS.audio + 1), ["audio"])).toEqual({ ok: false, code: "media_too_large" });
    expect(MEDIA_LIMITS).toEqual({ image: 5 * 1048576, audio: 20 * 1048576, document: 10 * 1048576 });
  });
});

describe("cost data", () => {
  it("per-minute pricing is integer and rounds up", () => {
    expect(perMinuteCostMicro(6000, 60)).toBe(6000);
    expect(perMinuteCostMicro(6000, 1)).toBe(100);
    expect(perMinuteCostMicro(6000, 7)).toBe(700);
    expect(perMinuteCostMicro(1, 1)).toBe(1); // 1/60 rounds up
    expect(() => perMinuteCostMicro(1.5, 1)).toThrow(RangeError);
  });
  it("documented estimates are bounded", () => {
    expect(estimateMediaTokens("image", 10)).toBe(85);
    expect(estimateMediaTokens("image", 5 * 1048576)).toBe(1600);
    expect(estimateMediaTokens("document", 3200)).toBe(100);
    expect(estimateAudioSeconds(160_000)).toBe(10);
  });
});

describe("unsupported capability is a typed error, never a crash", () => {
  it("a provider without the method, or the wrong media kind, throws unsupported_capability", async () => {
    const textOnly = { id: "t", generate: async () => { throw new Error("unused"); } };
    const a = { apiKey: "k", model: "m", prompt: "p", maxOutputTokens: 10 };
    expect(await codeOf(invokeMedia(textOnly, "vision", { ...a, media: img() }))).toBe("unsupported_capability");
    expect(await codeOf(invokeMedia(textOnly, "transcription", { ...a, media: aud() }))).toBe("unsupported_capability");
    const mock = createMockProvider();
    expect(await codeOf(invokeMedia(mock, "vision", { ...a, media: aud() }))).toBe("unsupported_capability");
    expect(await codeOf(invokeMedia(mock, "document", { ...a, media: aud() }))).toBe("unsupported_capability");
    expect(await codeOf(invokeMedia(mock, "transcription", { ...a, media: img() }))).toBe("unsupported_capability");
    expect(await codeOf(invokeMedia(createOpenAiCompatible({ fetch: async () => json(200, {}) }), "document", { ...a, media: doc() }))).toBe("unsupported_capability");
  });
});

describe("mock provider", () => {
  const mock = createMockProvider();
  const a = { apiKey: "", model: "mock-1", prompt: "Describe", maxOutputTokens: 100 };
  it("is deterministic, labelled, and derived from size and hash only", async () => {
    const one = await invokeMedia(mock, "vision", { ...a, media: img() });
    const two = await invokeMedia(mock, "vision", { ...a, media: img() });
    expect(one).toEqual(two);
    expect(one.text).toMatch(/^\[MOCK IMAGE DESCRIPTION\].*12 bytes, hash [0-9a-f]{8}/);
    const other = await invokeMedia(mock, "vision", { ...a, media: { ...img(), bytes: jpg() } });
    expect(other.text).not.toBe(one.text);
    expect((await invokeMedia(mock, "vision", { ...a, prompt: "Question: what?", media: img() })).text).toMatch(/^\[MOCK ANSWER\]/);
    expect((await invokeMedia(mock, "document", { ...a, media: doc() })).text).toMatch(/^\[MOCK DOCUMENT TEXT\]/);
    const t = await invokeMedia(mock, "transcription", { ...a, media: aud() });
    expect(t.text).toMatch(/^\[MOCK TRANSCRIPT\]/);
    expect(t.durationSec).toBe(1);
    expect(one.usage.inputTokens).toBeGreaterThan(80);
  });
});

describe("Anthropic adapter against a fake fetch (UNVERIFIED against the live service)", () => {
  const reply = { content: [{ type: "text", text: "A red cup." }], usage: { input_tokens: 1500, output_tokens: 7 }, stop_reason: "end_turn" };
  const run = (media: MediaInput, via: "vision" | "document", fetchImpl: typeof fetch) => invokeMedia(createAnthropic({ fetch: fetchImpl }), via, { apiKey: "sk-ant-KEY", model: "claude-sonnet-4-5", media, prompt: "Describe it", maxOutputTokens: 300 });
  it("vision sends a base64 image block then the instruction, and reads usage", async () => {
    let seen: { url: string; headers: Record<string, string>; body: any } | undefined;
    const r = await run(img(), "vision", async (url, init) => { seen = { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) }; return json(200, reply); });
    expect(r).toMatchObject({ text: "A red cup.", usage: { inputTokens: 1500, outputTokens: 7 } });
    expect(seen!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen!.headers["x-api-key"]).toBe("sk-ant-KEY");
    expect(seen!.body).toMatchObject({ model: "claude-sonnet-4-5", max_tokens: 300 });
    expect(seen!.body.messages[0].content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(png()).toString("base64") } }, { type: "text", text: "Describe it" }]);
  });
  it("document sends a PDF document block; an image also works; audio is unsupported", async () => {
    const bodies: any[] = [];
    const f: typeof fetch = async (_u, init) => { bodies.push(JSON.parse(String(init?.body))); return json(200, reply); };
    await run(doc(), "document", f);
    await run(img(), "document", f);
    expect(bodies[0].messages[0].content[0]).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf" } });
    expect(bodies[1].messages[0].content[0].type).toBe("image");
    expect(await codeOf(run(aud(), "document", f))).toBe("unsupported_capability");
    expect(await codeOf(run(doc(), "vision", f))).toBe("unsupported_capability"); // vision takes images only
    expect(bodies).toHaveLength(2); // the unsupported calls never reached the network
  });
  it("maps errors and timeouts without echoing the response body", async () => {
    expect(await codeOf(run(img(), "vision", async () => json(401, { error: "bad key sk-ant-KEY" })))).toBe("auth");
    expect(await codeOf(run(img(), "vision", async () => json(429, {})))).toBe("rate_limit");
    expect(await codeOf(run(img(), "vision", async () => json(529, {})))).toBe("provider_error");
    expect(await codeOf(run(img(), "vision", async () => json(200, { nope: true })))).toBe("provider_error");
    expect(await codeOf(run(img(), "vision", async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }))).toBe("timeout");
  });
});

describe("OpenAI-compatible adapter against a fake fetch (UNVERIFIED against a live service)", () => {
  const oa = (f: typeof fetch) => createOpenAiCompatible({ fetch: f, baseUrl: "https://llm.example.com/v1/" });
  it("vision sends an image_url data URI", async () => {
    let seen: { url: string; headers: Record<string, string>; body: any } | undefined;
    const r = await invokeMedia(oa(async (url, init) => { seen = { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) }; return json(200, { choices: [{ message: { content: "A cup" }, finish_reason: "stop" }], usage: { prompt_tokens: 800, completion_tokens: 3 } }); }), "vision",
      { apiKey: "sk-KEY", model: "gpt-4o", media: img(), prompt: "What is this?", maxOutputTokens: 100 });
    expect(r).toMatchObject({ text: "A cup", usage: { inputTokens: 800, outputTokens: 3 } });
    expect(seen!.url).toBe("https://llm.example.com/v1/chat/completions");
    expect(seen!.headers.authorization).toBe("Bearer sk-KEY");
    expect(seen!.body.messages[0].content).toEqual([{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(png()).toString("base64")}` } }]);
  });
  it("transcription posts multipart to /audio/transcriptions and reads the duration", async () => {
    let url = "", headers: Record<string, string> = {}, form: FormData | undefined;
    const r = await invokeMedia(oa(async (u, init) => { url = String(u); headers = init?.headers as Record<string, string>; form = init?.body as FormData; return json(200, { text: "hello world", duration: 61.2 }); }), "transcription",
      { apiKey: "sk-KEY", model: "whisper-1", media: aud(), prompt: "", maxOutputTokens: 0, language: "en" });
    expect(r).toEqual({ text: "hello world", usage: { inputTokens: 0, outputTokens: 0 }, durationSec: 62 });
    expect(url).toBe("https://llm.example.com/v1/audio/transcriptions");
    expect(headers.authorization).toBe("Bearer sk-KEY");
    expect(headers["content-type"]).toBeUndefined(); // fetch sets the multipart boundary
    expect(form).toBeInstanceOf(FormData);
    expect(form!.get("model")).toBe("whisper-1");
    expect(form!.get("language")).toBe("en");
    expect(form!.get("response_format")).toBe("verbose_json");
    const f = form!.get("file") as File;
    expect(f.name).toBe("audio.wav");
    expect(f.type).toBe("audio/wav");
    expect(f.size).toBe(wav().byteLength);
  });
  it("maps errors, a malformed reply and timeouts", async () => {
    const t = (f: typeof fetch) => invokeMedia(oa(f), "transcription", { apiKey: "k", model: "whisper-1", media: aud(), prompt: "", maxOutputTokens: 0 });
    expect(await codeOf(t(async () => json(401, {})))).toBe("auth");
    expect(await codeOf(t(async () => json(413, {})))).toBe("invalid_request");
    expect(await codeOf(t(async () => json(200, { duration: 3 })))).toBe("provider_error");
    expect(await codeOf(t(async () => { throw Object.assign(new Error("a"), { name: "AbortError" }); }))).toBe("timeout");
    expect(await codeOf(invokeMedia(oa(async () => json(200, {})), "vision", { apiKey: "k", model: "m", media: aud(), prompt: "", maxOutputTokens: 1 }))).toBe("unsupported_capability");
  });
});
