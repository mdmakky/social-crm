import { describe, expect, it } from "vitest";
import { AiError, checkTemplate, costMicro, createAnthropic, createOpenAiCompatible, describeText, formatMicro, getProvider, modelsFor, PROVIDERS, priceOf, redact, renderTemplate, safeError, TemplateError } from "../src/index.ts";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const req = { apiKey: "sk-test-SECRETKEY1234", model: "m", messages: [{ role: "system" as const, content: "be brief" }, { role: "user" as const, content: "hello there" }], maxOutputTokens: 100 };
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof AiError ? e.code : `other:${String(e)}`));

describe("cost", () => {
  it("is integer math, rounded up", () => {
    expect(costMicro({ inputMicroPer1M: 3_000_000, outputMicroPer1M: 15_000_000 }, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(18_000_000);
    expect(costMicro({ inputMicroPer1M: 3_000_000, outputMicroPer1M: 15_000_000 }, { inputTokens: 1000, outputTokens: 200 })).toBe(6000); // 3000 + 3000
    expect(costMicro({ inputMicroPer1M: 150_000, outputMicroPer1M: 600_000 }, { inputTokens: 1, outputTokens: 0 })).toBe(1); // 0.15 micro rounds up
    expect(costMicro({ inputMicroPer1M: 1, outputMicroPer1M: 1 }, { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
  it("is exact where floats are not", () => {
    // 0.1 + 0.2 style traps: 7 tokens at 300_000 per 1M = 2.1 micro -> 3, never 2.0000000000000004 -> 3 by luck
    expect(costMicro({ inputMicroPer1M: 300_000, outputMicroPer1M: 0 }, { inputTokens: 7, outputTokens: 0 })).toBe(3);
    expect(costMicro({ inputMicroPer1M: 1_000_000, outputMicroPer1M: 0 }, { inputTokens: 5, outputTokens: 0 })).toBe(5);
    expect(costMicro({ inputMicroPer1M: 90_000_000_000, outputMicroPer1M: 0 }, { inputTokens: 90_000_000, outputTokens: 0 })).toBe(8_100_000_000_000);
  });
  it("rejects non-integers and negatives", () => {
    expect(() => costMicro({ inputMicroPer1M: 1.5, outputMicroPer1M: 0 }, { inputTokens: 1, outputTokens: 1 })).toThrow(RangeError);
    expect(() => costMicro({ inputMicroPer1M: 1, outputMicroPer1M: 0 }, { inputTokens: -1, outputTokens: 1 })).toThrow(RangeError);
  });
  it("formats micro-units", () => {
    expect(formatMicro(0)).toBe("0.00");
    expect(formatMicro(3_000_000)).toBe("3.00");
    expect(formatMicro(1_234_567)).toBe("1.234567");
    expect(formatMicro(500)).toBe("0.0005");
  });
});

describe("catalog", () => {
  it("has a free mock model and priced real ones", () => {
    expect(priceOf("mock", "mock-1")).toMatchObject({ inputMicroPer1M: 0, outputMicroPer1M: 0 });
    expect(priceOf("anthropic", "claude-haiku-4-5")?.inputMicroPer1M).toBeGreaterThan(0);
    expect(priceOf("anthropic", "gpt-4o")).toBeNull();
  });
  it("workspace overrides win and can add model ids", () => {
    const o = { "gpt-4o": { inputMicroPer1M: 1, outputMicroPer1M: 2 }, "my-local-model": { inputMicroPer1M: 5, outputMicroPer1M: 6 } };
    expect(priceOf("openai", "gpt-4o", o)).toMatchObject({ inputMicroPer1M: 1, outputMicroPer1M: 2, label: "GPT-4o" });
    expect(priceOf("openai", "my-local-model", o)).toMatchObject({ outputMicroPer1M: 6 });
    expect(modelsFor("openai").some((m) => m.id === "my-local-model")).toBe(false);
  });
});

describe("template", () => {
  it("renders named variables, extra ones ignored", () => {
    expect(renderTemplate("Hi {{name}}, via {{ channel }}.", { name: "Ana", channel: "WhatsApp", unused: "x" })).toBe("Hi Ana, via WhatsApp.");
  });
  it("a missing variable is an error, not an empty string", () => {
    expect(() => renderTemplate("Hi {{name}}", {})).toThrow(TemplateError);
    expect(() => renderTemplate("Hi {{name}}", {})).toThrow(/missing_variable: name/);
  });
  it("does not evaluate or re-scan values", () => {
    expect(renderTemplate("{{a}}", { a: "{{b}}", b: "boom" })).toBe("{{b}}");
    expect(() => renderTemplate("{{ 1 + 1 }}", {})).toThrow(/invalid_template/);
    expect(() => renderTemplate("{{constructor}}", {})).toThrow(/missing_variable/);
    expect(() => renderTemplate("{{__proto__}}", {})).toThrow(/invalid_template/);
  });
  it("checkTemplate enforces the allowed list", () => {
    expect(() => checkTemplate("{{a}} {{b}}", ["a"])).toThrow(/unknown_variable: b/);
    expect(() => checkTemplate("{{a}}", ["a", "b"])).not.toThrow();
  });
});

describe("logging helpers", () => {
  it("redacts emails, numbers and keys, and truncates", () => {
    const out = redact("mail ana@example.com or +1 (555) 123-4567 key sk-abcdef123456 Bearer abcdefgh12345678");
    expect(out).not.toMatch(/ana@|555|abcdef123456|abcdefgh1234/);
    expect(redact("x".repeat(200), 10)).toBe("xxxxxxxxxx...");
  });
  it("describes text without keeping it", () => {
    const d = describeText("secret words");
    expect(d.chars).toBe(12);
    expect(d.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(d)).not.toContain("secret");
  });
  it("safeError keeps only name and code", () => {
    expect(safeError(new AiError("rate_limit", 429))).toEqual({ name: "AiError", code: "rate_limit", status: 429 });
    expect(safeError(new Error("contains the prompt"))).toEqual({ name: "Error" });
  });
});

describe("registry and mock", () => {
  it("keys providers by id; unknown is an error", () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(["anthropic", "mock", "openai"]);
    expect(getProvider("mock").id).toBe("mock");
    expect(() => getProvider("nope")).toThrow(/unknown ai provider/);
    expect(PROVIDERS.mock!.mock).toBe(true);
    expect(PROVIDERS.anthropic!.mock).toBe(false);
  });
  it("mock is deterministic, labelled, offline", async () => {
    const p = getProvider("mock");
    const a = await p.generate(req);
    const b = await p.generate(req);
    expect(a).toEqual(b);
    expect(a.text).toContain("[MOCK");
    expect(a.usage.inputTokens).toBeGreaterThan(0);
    expect(a.finishReason).toBe("stop");
  });
});

describe("anthropic adapter (fake fetch)", () => {
  it("sends the Messages API shape and parses the reply", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const p = createAnthropic({ fetch: (async (url: string, init: RequestInit) => { seen = { url, init }; return json(200, { content: [{ type: "text", text: "Hello" }, { type: "text", text: " world" }], usage: { input_tokens: 11, output_tokens: 3 }, stop_reason: "end_turn" }); }) as unknown as typeof fetch });
    const r = await p.generate(req);
    expect(r).toEqual({ text: "Hello world", usage: { inputTokens: 11, outputTokens: 3 }, finishReason: "stop" });
    expect(seen!.url).toBe("https://api.anthropic.com/v1/messages");
    const h = seen!.init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe(req.apiKey);
    expect(h["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(seen!.init.body as string);
    expect(body).toMatchObject({ model: "m", max_tokens: 100, system: "be brief", messages: [{ role: "user", content: "hello there" }] });
    expect(JSON.stringify(body)).not.toContain(req.apiKey); // key only in the header
  });
  it("maps max_tokens to length", async () => {
    const p = createAnthropic({ fetch: (async () => json(200, { content: [{ type: "text", text: "x" }], usage: {}, stop_reason: "max_tokens" })) as unknown as typeof fetch });
    expect((await p.generate(req)).finishReason).toBe("length");
  });
  it.each([[401, "auth"], [403, "auth"], [429, "rate_limit"], [400, "invalid_request"], [404, "invalid_request"], [500, "provider_error"], [529, "provider_error"], [504, "timeout"]] as const)("maps HTTP %i to %s without leaking the body", async (status, code) => {
    const p = createAnthropic({ fetch: (async () => json(status, { error: { message: "echo hello there sk-test-SECRETKEY1234" } })) as unknown as typeof fetch });
    const err = (await p.generate(req).catch((e: unknown) => e)) as AiError;
    expect(err.code).toBe(code);
    expect(err.message).not.toMatch(/hello there|SECRETKEY/);
  });
  it("times out on a hung request", async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    expect(await codeOf(createAnthropic({ fetch: hang, timeoutMs: 20 }).generate(req))).toBe("timeout");
  });
  it("network failure and malformed body are provider_error", async () => {
    expect(await codeOf(createAnthropic({ fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch }).generate(req))).toBe("provider_error");
    expect(await codeOf(createAnthropic({ fetch: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch }).generate(req))).toBe("provider_error");
    expect(await codeOf(createAnthropic({ fetch: (async () => json(200, { nope: 1 })) as unknown as typeof fetch }).generate(req))).toBe("provider_error");
  });
});

describe("openai-compatible adapter (fake fetch)", () => {
  it("sends chat completions with a bearer key and parses usage", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const p = createOpenAiCompatible({ baseUrl: "https://llm.example.com/v1/", fetch: (async (url: string, init: RequestInit) => { seen = { url, init }; return json(200, { choices: [{ message: { content: "Hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 2 } }); }) as unknown as typeof fetch });
    expect(await p.generate(req)).toEqual({ text: "Hi", usage: { inputTokens: 9, outputTokens: 2 }, finishReason: "stop" });
    expect(seen!.url).toBe("https://llm.example.com/v1/chat/completions");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${req.apiKey}`);
    expect(JSON.parse(seen!.init.body as string).messages).toHaveLength(2);
  });
  it("maps length and errors", async () => {
    const mk = (status: number, body: unknown) => createOpenAiCompatible({ fetch: (async () => json(status, body)) as unknown as typeof fetch });
    expect((await mk(200, { choices: [{ message: { content: "" }, finish_reason: "length" }] }).generate(req)).finishReason).toBe("length");
    expect(await codeOf(mk(401, {}).generate(req))).toBe("auth");
    expect(await codeOf(mk(429, {}).generate(req))).toBe("rate_limit");
    expect(await codeOf(mk(422, {}).generate(req))).toBe("invalid_request");
    expect(await codeOf(mk(503, {}).generate(req))).toBe("provider_error");
    expect(await codeOf(mk(200, { choices: [] }).generate(req))).toBe("provider_error");
  });
  it("times out", async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    expect(await codeOf(createOpenAiCompatible({ fetch: hang, timeoutMs: 20 }).generate(req))).toBe("timeout");
  });
});
