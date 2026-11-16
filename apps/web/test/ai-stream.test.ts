import { describe, expect, it } from "vitest";
import { parseSseBuffer, streamSuggestion } from "@/lib/ai-stream";

const enc = new TextEncoder();
const sse = (parts: string[], init: ResponseInit = { status: 200, headers: { "content-type": "text/event-stream" } }) =>
  new Response(new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } }), init);
const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const run = (res: () => Response | Promise<Response>, signal = new AbortController().signal) => {
  const seen: string[] = [];
  return streamSuggestion("w", "c", { signal, onDelta: (t) => seen.push(t), fetchImpl: (async () => res()) as unknown as typeof fetch }).then((r) => ({ r, seen }));
};

describe("parseSseBuffer", () => {
  it("returns complete events and keeps the unfinished rest; handles CRLF and comments", () => {
    const a = parseSseBuffer(': keepalive\r\n\r\nevent: delta\r\ndata: {"text":"a"}\r\n\r\nevent: delta\ndata: {"te');
    expect(a.events).toEqual([{ event: "delta", data: { text: "a" } }]);
    expect(a.rest).toBe('event: delta\ndata: {"te');
    expect(parseSseBuffer(a.rest + 'xt":"b"}\n\n').events).toEqual([{ event: "delta", data: { text: "b" } }]);
  });
  it("drops malformed JSON and events without data", () => {
    expect(parseSseBuffer("event: x\ndata: {nope\n\nevent: y\n\n").events).toEqual([]);
  });
});

describe("streamSuggestion", () => {
  it("accumulates deltas progressively and ends ok with the mock flag", async () => {
    const { r, seen } = await run(() => sse([ev("delta", { text: "Hel" }), ": ka\n\n", ev("delta", { text: "lo" }).slice(0, 12), ev("delta", { text: "lo" }).slice(12), ev("usage", { inputTokens: 1 }), ev("done", { mock: true })]));
    expect(seen).toEqual(["Hel", "Hello"]);
    expect(r).toEqual({ ok: true, text: "Hello", mock: true });
  });
  it("an error event ends it with the server's code and message", async () => {
    const { r, seen } = await run(() => sse([ev("delta", { text: "x" }), ev("error", { code: "payment_required", message: "Out of credits", status: 402 })]));
    expect(seen).toEqual(["x"]);
    expect(r).toMatchObject({ ok: false, code: "payment_required", message: "Out of credits", status: 402 });
  });
  it("a non-200 JSON error (budget, permission, rate limit) is reported with its code", async () => {
    const { r } = await run(() => new Response(JSON.stringify({ error: { code: "forbidden", message: "No." } }), { status: 403 }));
    expect(r).toMatchObject({ ok: false, code: "forbidden", status: 403 });
  });
  it("404 or a non-event-stream answer asks the caller to fall back to the JSON endpoint", async () => {
    expect((await run(() => new Response("{}", { status: 404 }))).r).toMatchObject({ fallback: true });
    expect((await run(() => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))).r).toMatchObject({ fallback: true });
  });
  it("a stream that ends without done is an interruption, not a success", async () => {
    const { r } = await run(() => sse([ev("delta", { text: "half" })]));
    expect(r).toMatchObject({ ok: false, code: "interrupted" });
  });
  it("Stop (abort) returns what arrived and the aborted flag", async () => {
    const ac = new AbortController();
    // Like a browser: aborting the request makes the body reader reject with an AbortError. The body never closes by itself.
    const p = streamSuggestion("w", "c", { signal: ac.signal, onDelta: () => ac.abort(), fetchImpl: (async (_u: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(ev("delta", { text: "part" }))); init.signal!.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError"))); } });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch });
    expect(await p).toMatchObject({ ok: false, aborted: true, text: "part" });
  });
  it("a network failure is a friendly error", async () => {
    const { r } = await run(() => { throw new TypeError("fetch failed"); });
    expect(r).toMatchObject({ ok: false, code: "network" });
  });
});
