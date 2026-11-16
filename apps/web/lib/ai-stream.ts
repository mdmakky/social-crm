/**
 * Client side of the streamed reply suggestion (POST .../ai/suggest-reply/stream, Server-Sent Events). Same-origin through the /v1 proxy, cookie session.
 * The text is only handed to the caller as it arrives; nothing here stores it. Draft only: this never sends a message.
 */
export type StreamResult =
  | { ok: true; text: string; mock: boolean }
  | { ok: false; code: string; message: string; status?: number }
  /** The person pressed Stop (or left). `text` is what had arrived. */
  | { ok: false; aborted: true; code: "aborted"; message: string; text: string }
  /** The stream route is not usable here (old server, a proxy that answered with something else): the caller should use the plain JSON endpoint instead. */
  | { ok: false; fallback: true; code: "no_stream"; message: string };

export type SseEvent = { event: string; data: unknown };

/** Splits a text buffer into complete SSE events plus the unfinished rest. Handles CRLF, comment lines (`:`) and multi-line data. Malformed JSON data is dropped. */
export function parseSseBuffer(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const norm = buffer.replace(/\r\n|\r/g, "\n");
  const cut = norm.lastIndexOf("\n\n");
  if (cut < 0) return { events, rest: norm };
  for (const block of norm.slice(0, cut).split("\n\n")) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":") || line === "") continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) continue;
    try { events.push({ event, data: JSON.parse(data.join("\n")) }); } catch { /* ignore a malformed event */ }
  }
  return { events, rest: norm.slice(cut + 2) };
}

const GENERIC = "The suggestion could not be generated. Write your reply by hand or try again.";

export async function streamSuggestion(
  workspaceId: string, conversationId: string,
  o: { signal: AbortSignal; onStart?: () => void; onDelta: (text: string) => void; fetchImpl?: typeof fetch },
): Promise<StreamResult> {
  const f = o.fetchImpl ?? fetch;
  let acc = "";
  try {
    const res = await f(`/v1/workspaces/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}/ai/suggest-reply/stream`, { method: "POST", headers: { accept: "text/event-stream" }, credentials: "include", signal: o.signal });
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      // 404 can also mean "conversation gone"; the plain endpoint then answers the same 404 and the caller shows it.
      return { ok: false, fallback: true, code: "no_stream", message: "Streaming is not available." };
    }
    if (!res.ok || !res.body) {
      const j = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      return { ok: false, code: j?.error?.code ?? "unavailable", message: j?.error?.message ?? GENERIC, status: res.status };
    }
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) return { ok: false, fallback: true, code: "no_stream", message: "Streaming is not available." };
    o.onStart?.();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let mock = false;
    let done = false;
    for (;;) {
      const { value, done: end } = await reader.read();
      buf += dec.decode(value, { stream: !end });
      const p = parseSseBuffer(end ? buf + "\n\n" : buf);
      buf = p.rest;
      for (const ev of p.events) {
        const d = ev.data as { text?: string; mock?: boolean; code?: string; message?: string; status?: number };
        if (ev.event === "delta" && typeof d.text === "string") { acc += d.text; o.onDelta(acc); }
        else if (ev.event === "done") { done = true; mock = d.mock === true; }
        else if (ev.event === "error") return { ok: false, code: d.code ?? "unavailable", message: d.message ?? GENERIC, status: d.status };
      }
      if (end) break;
    }
    return done ? { ok: true, text: acc, mock } : { ok: false, code: "interrupted", message: "The connection ended before the draft was complete. Write your reply by hand or try again." };
  } catch (e) {
    if (o.signal.aborted || (e as { name?: string })?.name === "AbortError") return { ok: false, aborted: true, code: "aborted", message: "Stopped.", text: acc };
    return { ok: false, code: "network", message: "The connection was lost. Check your network and try again." };
  }
}
