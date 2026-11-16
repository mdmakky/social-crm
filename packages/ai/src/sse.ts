import { AiError } from "./types.ts";

export type SseOptions = { idleMs: number; signal?: AbortSignal; maxLineBytes?: number };

/**
 * Yields the `data` payload of each SSE event of a byte stream. Handles chunks split anywhere (mid-line, mid-UTF-8 sequence), LF / CRLF / CR line ends,
 * comment lines (start with ':', ignored: OpenRouter sends keep-alives), other fields (`event:` `id:` `retry:` ignored) and multi-line data (joined with \n).
 * It does NOT interpret the payload: `[DONE]` and JSON are the caller's business. An idle gap longer than idleMs throws AiError("timeout"); an abort ends the iteration quietly
 * (the caller owns the abort reason); an over-long line throws provider_error. The reader is always cancelled on exit.
 */
export async function* sseData(body: ReadableStream<Uint8Array>, o: SseOptions): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const maxLine = o.maxLineBytes ?? 1_048_576;
  let buf = "";
  let data: string[] = [];
  let sawCr = false;
  const onAbort = () => { reader.cancel().catch(() => undefined); };
  o.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (o.signal?.aborted) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new AiError("timeout")), o.idleMs); });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await Promise.race([reader.read(), idle]); } catch (e) { if (o.signal?.aborted) return; throw e instanceof AiError ? e : new AiError("provider_error"); } finally { clearTimeout(timer); }
      if (o.signal?.aborted) return;
      buf += dec.decode(chunk.value, { stream: !chunk.done });
      if (sawCr && buf.startsWith("\n")) buf = buf.slice(1); // CRLF split across chunks
      sawCr = false;
      for (;;) {
        const m = /\r\n|\n|\r/.exec(buf);
        if (!m) break;
        if (m[0] === "\r" && m.index === buf.length - 1 && !chunk.done) { sawCr = true; }
        const line = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        if (line === "") { if (data.length) { yield data.join("\n"); data = []; } continue; }
        if (line.startsWith(":")) continue;
        const c = line.indexOf(":");
        const field = c < 0 ? line : line.slice(0, c);
        if (field === "data") { const v = c < 0 ? "" : line.slice(c + 1); data.push(v.startsWith(" ") ? v.slice(1) : v); }
      }
      if (buf.length > maxLine) throw new AiError("provider_error");
      if (chunk.done) {
        // A final event without its blank line is still delivered.
        if (buf && !buf.startsWith(":") && buf.startsWith("data:")) { const v = buf.slice(5); data.push(v.startsWith(" ") ? v.slice(1) : v); }
        if (data.length) yield data.join("\n");
        return;
      }
    }
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => undefined);
  }
}
