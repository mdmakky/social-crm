import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentDefinition, AiError, composeNativeSystemPrompt, createMockProvider, createOpenAiCompatible, defineTool, getProvider, MAX_ACTIONS_PER_RUN, parseNativeReply, sseData, supportsStructuredOutput, supportsTools, toolRegistry, toolSpecs, wireToolName, type StreamEvent } from "../src/index.ts";

// Everything here uses a FAKE fetch or in-memory streams: nothing touches the network.
const enc = new TextEncoder();
const bytesStream = (chunks: (string | Uint8Array)[], opts: { hangAfter?: boolean } = {}) =>
  new ReadableStream<Uint8Array>({
    start(c) { for (const x of chunks) c.enqueue(typeof x === "string" ? enc.encode(x) : x); if (!opts.hangAfter) c.close(); },
  });
const collect = async <T>(it: AsyncIterable<T>) => { const out: T[] = []; for await (const x of it) out.push(x); return out; };
const sse = (body: ReadableStream<Uint8Array>, o: { idleMs?: number; signal?: AbortSignal } = {}) => collect(sseData(body, { idleMs: o.idleMs ?? 1000, signal: o.signal }));
const KEY = "sk-or-v1-STREAMSECRET0123456789";
const req = { apiKey: KEY, model: "m/x", maxOutputTokens: 50, messages: [{ role: "user" as const, content: "hi" }] };

describe("sseData parser", () => {
  it("splits mid-line, mid-JSON and across events; handles CRLF and CR", async () => {
    const out = await sse(bytesStream(['da', 'ta: {"a":', '1}\r\n\r', "\n", 'data: {"b":2}\n\n', 'data: x\rdata: y\r\r']));
    expect(out).toEqual(['{"a":1}', '{"b":2}', "x\ny"]);
  });
  it("ignores comments, unknown fields and blank noise; keeps [DONE] as a payload", async () => {
    const out = await sse(bytesStream([": OPENROUTER PROCESSING\n\n", "event: ping\nid: 1\ndata: 1\n\n", ":c\ndata: [DONE]\n\n"]));
    expect(out).toEqual(["1", "[DONE]"]);
  });
  it("a UTF-8 sequence split across chunks is decoded intact", async () => {
    const all = enc.encode('data: {"t":"héllo 😀"}\n\n');
    const cut = all.indexOf(0xf0) + 2; // inside the 4-byte emoji
    const out = await sse(bytesStream([all.slice(0, cut), all.slice(cut)]));
    expect(JSON.parse(out[0]!).t).toBe("héllo 😀");
  });
  it("delivers a final event that has no trailing blank line", async () => {
    expect(await sse(bytesStream(["data: last"]))).toEqual(["last"]);
  });
  it("idle gap throws timeout", async () => {
    const e = await sse(bytesStream(["data: 1\n\n"], { hangAfter: true }), { idleMs: 20 }).then(() => null, (x: unknown) => x as AiError);
    expect(e).toBeInstanceOf(AiError);
    expect(e!.code).toBe("timeout");
  });
  it("abort ends the iteration quietly", async () => {
    const ac = new AbortController();
    const it = sseData(bytesStream(["data: 1\n\n"], { hangAfter: true }), { idleMs: 5000, signal: ac.signal });
    expect((await it.next()).value).toBe("1");
    setTimeout(() => ac.abort(), 10);
    expect((await it.next()).done).toBe(true);
  });
  it("a runaway line without a newline is refused", async () => {
    const e = await collect(sseData(bytesStream(["data: " + "x".repeat(200)]), { idleMs: 100, maxLineBytes: 100 })).then(() => null, (x: unknown) => x as AiError);
    expect(e!.code).toBe("provider_error");
  });
});

const chunk = (delta: unknown, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ model: "openai/gpt-4o-mini", choices: [{ delta, finish_reason: null }], ...extra })}\n\n`;
const sseRes = (parts: string[], status = 200) => new Response(bytesStream(parts), { status, headers: { "content-type": "text/event-stream" } });
const or = (f: (url: string, init: RequestInit) => Response | Promise<Response>, o: { streamIdleMs?: number; streamTimeoutMs?: number } = {}) => createOpenAiCompatible({ id: "openrouter", gateway: true, baseUrl: "https://openrouter.ai/api/v1", fetch: (async (u: string, i: RequestInit) => f(u, i)) as unknown as typeof fetch, ...o });
const run = (p: ReturnType<typeof or>, r = req) => collect(p.generateStream!(r));

describe("openai-compatible generateStream (fake fetch)", () => {
  const good = [
    ": OPENROUTER PROCESSING\n\n", chunk({ role: "assistant", content: "Hel" }), chunk({ content: "lo" }), "data: {not json\n\n",
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.0000153 } })}\n\n`, "data: [DONE]\n\n",
  ];
  it("request shape: stream true, include_usage, bearer, tools and response_format passed through", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const tools = [{ type: "function" as const, function: { name: "a__b", description: "d", parameters: { type: "object" } } }];
    await run(or((url, init) => { seen = { url, init }; return sseRes(good); }), { ...req, tools, responseFormat: { type: "json_object" } });
    expect(seen!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(seen!.init.body as string)).toMatchObject({ model: "m/x", stream: true, stream_options: { include_usage: true }, tools, response_format: { type: "json_object" } });
  });
  it("yields deltas, then usage (cost rounded up), then done with the routed model; ignores comments and bad JSON", async () => {
    const ev = await run(or(() => sseRes(good)));
    expect(ev).toEqual([
      { type: "delta", text: "Hel" }, { type: "delta", text: "lo" },
      { type: "usage", inputTokens: 12, outputTokens: 3, reportedCostMicro: 16 }, { type: "done", finishReason: "stop", routedModel: "openai/gpt-4o-mini" },
    ]);
  });
  it("without a usage chunk there is no usage event", async () => {
    const ev = await run(or(() => sseRes([chunk({ content: "x" }), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`])));
    expect(ev.map((e) => e.type)).toEqual(["delta", "done"]);
    expect(ev[1]).toMatchObject({ finishReason: "length" });
  });
  it.each([[402, "payment_required", false], [403, "blocked", false], [429, "rate_limit", true], [502, "provider_error", true], [500, "provider_error", false]])("mid-stream error object %i maps like non-stream", async (code, mapped, retryable) => {
    const ev = await run(or(() => sseRes([chunk({ content: "partial" }), `data: ${JSON.stringify({ error: { code, message: "SECRET prompt " + KEY } })}\n\n`])));
    expect(ev[0]).toEqual({ type: "delta", text: "partial" });
    expect(ev[1]).toEqual({ type: "error", code: mapped, status: code, retryable });
    expect(JSON.stringify(ev)).not.toContain("SECRET");
  });
  it("HTTP errors before the stream are thrown with the same table", async () => {
    const e = await run(or(() => new Response("{}", { status: 402 }))).then(() => null, (x: unknown) => x as AiError);
    expect(e!.code).toBe("payment_required");
    const e2 = await run(or(() => new Response("{}", { status: 503, headers: { "retry-after": "2" } }))).then(() => null, (x: unknown) => x as AiError);
    expect(e2).toMatchObject({ code: "provider_error", retryable: true, retryAfterMs: 2000 });
  });
  it("a stream that ends with no finish reason is an error (truncated)", async () => {
    const ev = await run(or(() => sseRes([chunk({ content: "x" })])));
    expect(ev.at(-1)).toEqual({ type: "error", code: "provider_error" });
  });
  it("idle timeout between chunks throws timeout", async () => {
    const p = or(() => new Response(bytesStream([chunk({ content: "x" })], { hangAfter: true })), { streamIdleMs: 20 });
    const e = await run(p).then(() => null, (x: unknown) => x as AiError);
    expect(e!.code).toBe("timeout");
  });
  it("hard timeout for the whole stream ends it with a timeout error", async () => {
    const p = or(() => new Response(bytesStream([chunk({ content: "x" })], { hangAfter: true })), { streamIdleMs: 5000, streamTimeoutMs: 30 });
    const ev = await run(p);
    expect(ev.at(-1)).toEqual({ type: "error", code: "timeout" });
  });
  it("caller abort aborts the upstream request and stops quietly", async () => {
    const ac = new AbortController();
    let upstream: AbortSignal | null | undefined;
    const p = or((_u, init) => { upstream = init.signal; return new Response(bytesStream([chunk({ content: "x" })], { hangAfter: true })); });
    const got: StreamEvent[] = [];
    setTimeout(() => ac.abort(), 20);
    for await (const e of p.generateStream!({ ...req, signal: ac.signal })) got.push(e);
    expect(got[0]).toEqual({ type: "delta", text: "x" });
    expect(upstream!.aborted).toBe(true);
  });
  it("text is capped: stops reading and finishes as length", async () => {
    const big = "y".repeat(40_000);
    const ev = await run(or(() => sseRes([chunk({ content: big }), chunk({ content: big }), chunk({ content: big })])));
    const text = ev.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(text.length).toBe(64_000);
    expect(ev.at(-1)).toMatchObject({ type: "done", finishReason: "length" });
  });
  it("non-gateway adapters ignore cost and routed model", async () => {
    const ev = await run(createOpenAiCompatible({ fetch: (async () => sseRes(good)) as unknown as typeof fetch }));
    expect(ev.find((e) => e.type === "usage")).toEqual({ type: "usage", inputTokens: 12, outputTokens: 3 });
    expect(ev.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });
});

describe("tools and response_format mapping (non-stream)", () => {
  it("sends tools and response_format, parses tool_calls and finish_reason tool_calls (null content is valid)", async () => {
    let body: Record<string, unknown> = {};
    const p = createOpenAiCompatible({ gateway: true, fetch: (async (_u: string, i: RequestInit) => { body = JSON.parse(i.body as string); return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "crm__add_note", arguments: '{"body":"x"}' } }, { nope: 1 }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }); }) as unknown as typeof fetch });
    const r = await p.generate({ ...req, tools: [{ type: "function", function: { name: "crm__add_note", description: "d", parameters: {} } }], responseFormat: { type: "json_schema", json_schema: { name: "n", schema: { type: "object" } } } });
    expect(body).toMatchObject({ tools: [{ type: "function" }], response_format: { type: "json_schema" } });
    expect(r).toMatchObject({ text: "", finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "crm__add_note", arguments: '{"body":"x"}' }] });
    expect(r.toolCalls).toHaveLength(1);
  });
  it("no tools and no response_format when not asked", async () => {
    let body: Record<string, unknown> = {};
    await createOpenAiCompatible({ fetch: (async (_u: string, i: RequestInit) => { body = JSON.parse(i.body as string); return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 }); }) as unknown as typeof fetch }).generate(req);
    expect(Object.keys(body)).not.toContain("tools");
    expect(Object.keys(body)).not.toContain("response_format");
  });
});

const t = (name: string, sensitivity: "read" | "write" | "sensitive") => defineTool<unknown, z.ZodObject<{ x: z.ZodString }>>({ name, description: `does ${name}`, argsSchema: z.object({ x: z.string() }).strict(), sensitivity, requiredPermission: "contact.edit", execute: async () => ({}) });
const reg = toolRegistry([t("t.read", "read"), t("t.write", "write"), t("t.sens", "sensitive"), t("t.other", "write")]);
const grants = [{ tool: "t.read", mode: "auto" as const }, { tool: "t.write", mode: "approval" as const }, { tool: "t.sens", mode: "auto" as const }];
const call = (name: string, args: unknown) => ({ name, arguments: typeof args === "string" ? args : JSON.stringify(args) });

describe("native tool calls", () => {
  it("tool specs come from the registry and grants, with wire-safe names", () => {
    const s = toolSpecs(grants, reg);
    expect(s.map((x) => x.function.name)).toEqual(["t__read", "t__write", "t__sens"]);
    expect(s.every((x) => /^[a-zA-Z0-9_-]{1,64}$/.test(x.function.name))).toBe(true);
    expect(s[0]!.function.parameters).toMatchObject({ type: "object", properties: { x: { type: "string" } } });
    expect(JSON.stringify(s)).not.toContain("$schema");
    expect(wireToolName("crm.add_note")).toBe("crm__add_note");
  });
  it("native system prompt keeps safety and instructions but drops the JSON protocol", () => {
    const p = composeNativeSystemPrompt(AgentDefinition.parse({ instructions: "Sell shoes.", toolGrants: grants }), reg);
    expect(p).toContain("Sell shoes.");
    expect(p).toContain("plain text");
    expect(p).not.toContain('"actions"');
    expect(p).not.toContain("Args JSON schema");
  });
  it("plans granted calls with the same approval rules (auto, approval, sensitive)", () => {
    const p = parseNativeReply("Draft.", [call("t__read", { x: "1" }), call("t__write", { x: "2" }), call("t__sens", { x: "3" })], grants, reg);
    expect(p.reply).toBe("Draft.");
    expect(p.planned.map((a) => [a.tool, a.disposition, a.pendingReason])).toEqual([["t.read", "execute", null], ["t.write", "pending", "approval_granted"], ["t.sens", "pending", "sensitive"]]);
  });
  it("rejects malformed arguments JSON, non-object arguments, bad args, unknown and ungranted tools", () => {
    const p = parseNativeReply("d", [call("t__read", "{not json"), call("t__read", "[1]"), call("t__read", { x: 5 }), call("nope", {}), call("t__other", { x: "1" })], grants, reg);
    expect(p.planned).toEqual([]);
    expect(p.rejected.map((r) => r.reason)).toEqual(["invalid_args", "invalid_args", "invalid_args", "unknown_tool", "not_granted"]);
  });
  it("more than the maximum actions: the rest is rejected as too_many", () => {
    const p = parseNativeReply("d", Array.from({ length: MAX_ACTIONS_PER_RUN + 2 }, () => call("t__read", { x: "1" })), grants, reg);
    expect(p.planned).toHaveLength(MAX_ACTIONS_PER_RUN);
    expect(p.rejected.map((r) => r.reason)).toEqual(["too_many", "too_many"]);
  });
  it("a dotted name sent on the wire is not a granted wire name", () => {
    expect(parseNativeReply("d", [call("t.read", { x: "1" })], grants, reg).planned).toEqual([]);
  });
  it("no tool_calls: plain text is the draft, a JSON-in-text envelope is still honoured", () => {
    expect(parseNativeReply("Just text", undefined, grants, reg)).toEqual({ reply: "Just text", malformed: false, planned: [], rejected: [] });
    const env = JSON.stringify({ reply: "r", actions: [{ tool: "t.read", args: { x: "1" } }] });
    expect(parseNativeReply(env, [], grants, reg).planned.map((a) => a.tool)).toEqual(["t.read"]);
  });
});

describe("capability gates and the mock", () => {
  it("read the stored flags only; unknown is false", () => {
    const o = { "a/b": { inputMicroPer1M: 1, outputMicroPer1M: 1, supports: { tools: true, structuredOutput: false } }, "c/d": { inputMicroPer1M: 1, outputMicroPer1M: 1 } };
    expect(supportsTools("openrouter", "a/b", o)).toBe(true);
    expect(supportsStructuredOutput("openrouter", "a/b", o)).toBe(false);
    expect(supportsTools("openrouter", "c/d", o)).toBe(false);
    expect(supportsTools("openrouter", "zzz", o)).toBe(false);
    expect(supportsTools("openai", "gpt-4o")).toBe(false);
    expect(supportsTools("mock", "mock-1")).toBe(true);
    expect(supportsStructuredOutput("mock", "mock-1")).toBe(true);
  });
  it("mock streams deterministic chunks and honours the tool marker only when the tool was offered", async () => {
    const m = createMockProvider();
    const msgs = [{ role: "user" as const, content: 'hello [[MOCK_TOOL:t__read:{"x":"1"}]]' }];
    const base = { apiKey: "", model: "mock-1", maxOutputTokens: 100, messages: msgs };
    const a = await collect(m.generateStream!(base));
    const b = await collect(m.generateStream!(base));
    expect(a).toEqual(b);
    expect(a.at(-1)).toEqual({ type: "done", finishReason: "stop" });
    expect(a.filter((e) => e.type === "delta").length).toBeGreaterThan(2);
    expect((await m.generate(base)).toolCalls).toBeUndefined();
    expect((await m.generate({ ...base, tools: toolSpecs(grants, reg) })).toolCalls).toEqual([{ id: "call_mock_1", name: "t__read", arguments: '{"x":"1"}' }]);
    const e = await m.generate({ ...base, messages: [{ role: "user", content: "[[MOCK_ERROR:blocked]]" }] }).then(() => null, (x: unknown) => x as AiError);
    expect(e!.code).toBe("blocked");
    expect(getProvider("mock").generateStream).toBeTypeOf("function");
  });
});
