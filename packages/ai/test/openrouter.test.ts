import { describe, expect, it } from "vitest";
import { AiError, createOpenAiCompatible, getProvider, modelsFor, parseOpenRouterModels, pickModel, pricePerTokenToMicroPer1M, supports } from "../src/index.ts";
import { parseRetryAfter, usdToMicroCeil } from "../src/providers/http.ts";

const req = { apiKey: "sk-or-v1-SECRETKEY0123456789", model: "anthropic/claude-sonnet-4.5", maxOutputTokens: 50, messages: [{ role: "user" as const, content: "hi" }] };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const ok = { model: "openai/gpt-4o-mini", choices: [{ message: { content: "Hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 2, cost: 0.0000153 } };
const orWith = (f: () => Response, extra: { referer?: string; title?: string } = {}) => getProvider("openrouter", { fetch: (async () => f()) as unknown as typeof fetch, ...extra });
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AiError;

describe("openrouter adapter (fake fetch)", () => {
  it("request shape: fixed URL, bearer, optional attribution headers, OpenAI body", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const p = getProvider("openrouter", { baseUrl: "https://evil.example/v1", referer: "https://crm.example", title: "Social CRM", fetch: (async (url: string, init: RequestInit) => { seen = { url, init }; return json(200, ok); }) as unknown as typeof fetch });
    await p.generate(req);
    expect(p.id).toBe("openrouter");
    expect(seen!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const h = seen!.init.headers as Record<string, string>;
    expect(h).toMatchObject({ authorization: `Bearer ${req.apiKey}`, "HTTP-Referer": "https://crm.example", "X-OpenRouter-Title": "Social CRM" });
    expect(JSON.parse(seen!.init.body as string)).toMatchObject({ model: req.model, max_tokens: 50 });
  });
  it("omits attribution headers when not configured", async () => {
    let h: Record<string, string> = {};
    await getProvider("openrouter", { fetch: (async (_u: string, init: RequestInit) => { h = init.headers as Record<string, string>; return json(200, ok); }) as unknown as typeof fetch }).generate(req);
    expect(Object.keys(h).sort()).toEqual(["authorization", "content-type"]);
  });
  it("parses usage.cost (rounded up to a micro-unit) and the routed model", async () => {
    const r = await orWith(() => json(200, ok)).generate(req);
    expect(r.usage).toEqual({ inputTokens: 9, outputTokens: 2, reportedCostMicro: 16 });
    expect(r.routedModel).toBe("openai/gpt-4o-mini");
  });
  it("usdToMicroCeil: exact, rounds up, never negative or NaN", () => {
    expect(usdToMicroCeil(0.00001)).toBe(10);
    expect(usdToMicroCeil(0.0000010001)).toBe(2);
    expect(usdToMicroCeil(0)).toBe(0);
    for (const bad of [-1, NaN, Infinity, "1", null, 2_000_000]) expect(usdToMicroCeil(bad)).toBeUndefined();
  });
  it("no cost field gives no reportedCostMicro", async () => {
    const r = await orWith(() => json(200, { ...ok, usage: { prompt_tokens: 1, completion_tokens: 1 } })).generate(req);
    expect(r.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
  });
  it("vision uses image_url data URL; audio is unsupported", async () => {
    let body: { messages: { content: { type: string }[] }[] } | null = null;
    const p = getProvider("openrouter", { fetch: (async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return json(200, ok); }) as unknown as typeof fetch });
    await p.vision!({ apiKey: "k".repeat(10), model: "m/x", prompt: "?", maxOutputTokens: 10, media: { kind: "image", mime: "image/png", bytes: new Uint8Array([1, 2]) } });
    expect(body!.messages[0]!.content.map((c) => c.type)).toEqual(["text", "image_url"]);
    expect((await err(p.transcribe!({ apiKey: "k".repeat(10), model: "m/x", media: { kind: "audio", mime: "audio/mpeg", bytes: new Uint8Array([1]) } }))).code).toBe("unsupported_capability");
  });

  it.each([
    [400, "invalid_request", false], [401, "auth", false], [402, "payment_required", false], [403, "blocked", false], [408, "timeout", true], [429, "rate_limit", true], [502, "provider_error", true], [503, "provider_error", true],
  ])("HTTP %i maps to %s (retryable %s)", async (status, code, retryable) => {
    const e = await err(orWith(() => json(status, { error: { code: status, message: "SECRET prompt text " + req.apiKey } })).generate(req));
    expect(e).toBeInstanceOf(AiError);
    expect(e.code).toBe(code);
    expect(e.retryable).toBe(retryable);
    expect(e.message).not.toContain("SECRET");
    expect(JSON.stringify(e)).not.toContain("SECRET");
  });
  it("Retry-After as seconds and as an HTTP date, capped at 30 s", async () => {
    expect((await err(orWith(() => json(429, {}, { "retry-after": "7" })).generate(req))).retryAfterMs).toBe(7000);
    expect((await err(orWith(() => json(503, {}, { "retry-after": "999" })).generate(req))).retryAfterMs).toBe(30_000);
    const e = await err(orWith(() => json(429, {}, { "retry-after": new Date(Date.now() + 12_000).toUTCString() })).generate(req));
    expect(e.retryAfterMs).toBeGreaterThan(9_000);
    expect(e.retryAfterMs).toBeLessThanOrEqual(12_000);
    expect(parseRetryAfter("junk")).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() - 5000).toUTCString())).toBe(0);
  });
  it("HTTP 200 with an error body maps by error.code; no choices is provider_error", async () => {
    expect((await err(orWith(() => json(200, { error: { code: 402, message: "x" } })).generate(req))).code).toBe("payment_required");
    expect((await err(orWith(() => json(200, { error: { code: 403, message: "x", metadata: { error_type: "moderation" } } })).generate(req))).code).toBe("blocked");
    expect((await err(orWith(() => json(200, { error: { code: 502 } })).generate(req))).retryable).toBe(true);
    expect((await err(orWith(() => json(200, { error: { message: "no code" } })).generate(req))).code).toBe("provider_error");
    expect((await err(orWith(() => json(200, { id: "x" })).generate(req))).code).toBe("provider_error");
    expect((await err(orWith(() => json(200, { choices: [] })).generate(req))).code).toBe("provider_error");
  });
  it("malformed JSON and network failures are provider_error", async () => {
    expect((await err(orWith(() => new Response("<html>", { status: 200 })).generate(req))).code).toBe("provider_error");
    expect((await err(getProvider("openrouter", { fetch: (async () => { throw new TypeError("boom"); }) as unknown as typeof fetch }).generate(req))).code).toBe("provider_error");
  });
});

describe("plain openai provider is unchanged", () => {
  const mk = (status: number, body: unknown, headers: Record<string, string> = {}) => createOpenAiCompatible({ fetch: (async () => json(status, body, headers)) as unknown as typeof fetch });
  it("keeps 401/403 as auth, 402 as invalid_request, no routedModel or cost, no retry hints", async () => {
    expect((await err(mk(403, {}).generate(req))).code).toBe("auth");
    expect((await err(mk(402, {}).generate(req))).code).toBe("invalid_request");
    const e = await err(mk(429, {}, { "retry-after": "5" }).generate(req));
    expect(e.retryAfterMs).toBeUndefined();
    expect(e.retryable).toBeUndefined();
    expect(await mk(200, ok).generate(req)).toEqual({ text: "Hi", usage: { inputTokens: 9, outputTokens: 2 }, finishReason: "stop" });
    expect((await err(mk(200, { error: { code: 402 }, choices: [] }).generate(req))).code).toBe("provider_error");
  });
});

describe("OpenRouter model list parsing", () => {
  it("converts USD-per-token decimal strings exactly", () => {
    expect(pricePerTokenToMicroPer1M("0.000003")).toBe(3_000_000);
    expect(pricePerTokenToMicroPer1M("0.0000001")).toBe(100_000);
    expect(pricePerTokenToMicroPer1M("0")).toBe(0);
    expect(pricePerTokenToMicroPer1M("0.0000000000001")).toBe(1); // below one micro: rounded up
    for (const bad of ["-1", "NaN", "", "1e-6", " 1", "0x1", null, undefined, 3e-6, "0.0.1"]) expect(pricePerTokenToMicroPer1M(bad)).toBeNull();
  });
  const item = (over: Record<string, unknown>) => ({ id: "v/m", name: "M", context_length: 1000, pricing: { prompt: "0.000001", completion: "0.000002" }, ...over });
  it("refuses unsafe items and derives capabilities", () => {
    const out = parseOpenRouterModels({ data: [
      item({ id: "v/vision", architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["tools", "structured_outputs"] }),
      item({ id: "v/noarch" }),
      item({ id: "v/textonly", architecture: { input_modalities: ["text"] }, supported_parameters: ["tool_choice"] }),
      item({ id: "openrouter/auto" }), item({ id: "v/neg", pricing: { prompt: "-1", completion: "-1" } }), item({ id: "v/nan", pricing: { prompt: "NaN", completion: "1" } }),
      item({ id: "v/missing", pricing: {} }), item({ id: "bad id with spaces" }), "junk", null,
    ] });
    expect(out.map((m) => m.id)).toEqual(["v/vision", "v/noarch", "v/textonly"]);
    expect(out[0]).toMatchObject({ capabilities: ["text", "vision"], supports: { tools: true, structuredOutput: true }, inputMicroPer1M: 1_000_000, outputMicroPer1M: 2_000_000, contextLength: 1000 });
    expect(out[1]!.capabilities).toEqual(["text"]); // absent input_modalities = text only
    expect(out[2]!.supports).toEqual({ tools: false, structuredOutput: false });
  });
  it("trims to 600 and rejects a malformed document", () => {
    expect(parseOpenRouterModels({ data: Array.from({ length: 700 }, (_, i) => item({ id: `v/m${i}` })) })).toHaveLength(600);
    expect(() => parseOpenRouterModels({ nope: 1 })).toThrow();
    expect(() => parseOpenRouterModels("x")).toThrow();
  });
});

describe("catalog uses stored capabilities for added OpenRouter models", () => {
  const o = { "v/vis": { inputMicroPer1M: 1, outputMicroPer1M: 2, capabilities: ["vision" as const], contextLength: 5000, supports: { tools: true, structuredOutput: false } }, "v/plain": { inputMicroPer1M: 1, outputMicroPer1M: 2 } };
  it("added model without stored capabilities is text only", () => {
    expect(supports("openrouter", "v/vis", "vision", o)).toBe(true);
    expect(supports("openrouter", "v/plain", "vision", o)).toBe(false);
    expect(supports("openrouter", "v/plain", "text", o)).toBe(true);
    expect(modelsFor("openrouter", o).find((m) => m.id === "v/vis")).toMatchObject({ contextLength: 5000, capabilities: ["text", "vision"] });
    expect(pickModel("openrouter", "v/plain", ["vision"], o)?.model.id).toBe("v/vis");
  });
  it("catalog models ignore stored capabilities", () => {
    expect(supports("openai", "gpt-4o", "transcription", { "gpt-4o": { inputMicroPer1M: 1, outputMicroPer1M: 1, capabilities: ["transcription"] } })).toBe(false);
  });
});
