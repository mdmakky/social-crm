import { AiError, type AiProvider, type FinishReason, type GenerateRequest, type StreamEvent, type ToolCall } from "../types.ts";
import { sseData } from "../sse.ts";
import { errorForStatus, int, parseRetryAfter, post, postJson, usdToMicroCeil, type HttpOptions } from "./http.ts";

type RawCall = { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
type Reply = { model?: unknown; choices?: { message?: { content?: string | null; tool_calls?: unknown }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: unknown } };
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const EXT: Record<string, string> = { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/webm": "webm" };

/** OpenAI-compatible chat completions (OpenAI itself, or any server that speaks the same API via baseUrl). UNVERIFIED against a live service: fake fetch only. */
const finish = (r: unknown): FinishReason => (r === "stop" ? "stop" : r === "length" ? "length" : r === "tool_calls" ? "tool_calls" : "other");
/** Keeps only well-formed calls (string name, string arguments). Anything else is dropped here; the agent layer still validates what is left. */
function parseToolCalls(v: unknown): ToolCall[] {
  if (!Array.isArray(v)) return [];
  return (v as RawCall[]).flatMap((c, i) => (c && typeof c === "object" && typeof c.function?.name === "string" && typeof c.function.arguments === "string" ? [{ id: typeof c.id === "string" ? c.id.slice(0, 100) : `call_${i}`, name: c.function.name.slice(0, 100), arguments: c.function.arguments.slice(0, 20_000) }] : []));
}
/** Request fields shared by generate and generateStream. */
const common = (req: GenerateRequest) => ({
  model: req.model, messages: req.messages, max_tokens: req.maxOutputTokens, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  ...(req.tools?.length ? { tools: req.tools } : {}), ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
});
/** Hard cap on text accumulated from one stream (characters). Reaching it ends the stream as finishReason "length". */
export const MAX_STREAM_CHARS = 64_000;

export function createOpenAiCompatible(o: HttpOptions & { baseUrl?: string; id?: string; extraHeaders?: Record<string, string>; streamTimeoutMs?: number; streamIdleMs?: number } = {}): AiProvider {
  const base = (o.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const gateway = !!o.gateway;
  const chat = async (apiKey: string, body: Record<string, unknown>, signal?: AbortSignal) => {
    const j = (await postJson(`${base}/chat/completions`, { authorization: `Bearer ${apiKey}`, ...o.extraHeaders }, body, { ...o, signal })) as Reply | null;
    const choice = j?.choices?.[0];
    const toolCalls = parseToolCalls(choice?.message?.tool_calls);
    // A tool-call answer has null content: that is valid. Anything else without text is not.
    // A reasoning model can spend the whole token budget thinking and answer with null content and finish_reason "length": that is an empty, truncated answer, not a broken provider.
    const content = typeof choice?.message?.content === "string" ? choice.message.content : toolCalls.length || choice?.finish_reason === "length" ? "" : null;
    if (!choice || content === null) throw new AiError("provider_error");
    const finishReason = finish(choice.finish_reason);
    const usage: { inputTokens: number; outputTokens: number; reportedCostMicro?: number } = { inputTokens: int(j?.usage?.prompt_tokens), outputTokens: int(j?.usage?.completion_tokens) };
    const tc = toolCalls.length ? { toolCalls } : {};
    if (!gateway) return { text: content, usage, finishReason, ...tc };
    const cost = usdToMicroCeil(j?.usage?.cost);
    if (cost !== undefined) usage.reportedCostMicro = cost;
    const routed = typeof j?.model === "string" && j.model.length > 0 && j.model.length <= 200 ? j.model : undefined;
    return { text: content, usage, finishReason, ...tc, ...(routed ? { routedModel: routed } : {}) };
  };
  return {
    id: o.id ?? "openai",
    generate: (req) => chat(req.apiKey, common(req), req.signal),
    /**
     * SSE stream. `stream_options.include_usage` makes OpenAI-compatible servers send a final usage chunk (OpenRouter documents usage in the last chunk; the option itself is UNVERIFIED there and harmless if ignored).
     * Ends with usage then done. Comments, malformed JSON lines and unknown fields are ignored; `{error}` events and a stream that ends without a finish reason become an error event. Never stores the text.
     */
    async *generateStream(req): AsyncGenerator<StreamEvent> {
      const ac = new AbortController();
      const hard = setTimeout(() => ac.abort(), o.streamTimeoutMs ?? 120_000);
      const onExternal = () => ac.abort();
      if (req.signal?.aborted) ac.abort(); else req.signal?.addEventListener("abort", onExternal, { once: true });
      try {
        let res: Response;
        try {
          res = await (o.fetch ?? fetch)(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${req.apiKey}`, ...o.extraHeaders }, body: JSON.stringify({ ...common(req), stream: true, stream_options: { include_usage: true } }), signal: ac.signal });
        } catch {
          throw new AiError(ac.signal.aborted ? "timeout" : "provider_error");
        }
        if (!res.ok) throw errorForStatus(res.status, gateway, gateway ? parseRetryAfter(res.headers?.get("retry-after")) : undefined);
        if (!res.body) throw new AiError("provider_error", res.status);
        let chars = 0, finishReason: FinishReason | null = null, routed: string | undefined, usage: { inputTokens: number; outputTokens: number; reportedCostMicro?: number } | null = null;
        for await (const payload of sseData(res.body, { idleMs: o.streamIdleMs ?? 30_000, signal: ac.signal })) {
          if (payload.trim() === "[DONE]") break;
          let j: Reply & { error?: { code?: unknown } | null; choices?: { delta?: { content?: unknown }; finish_reason?: string | null }[] };
          try { j = JSON.parse(payload); } catch { continue; }
          if (!j || typeof j !== "object") continue;
          if (j.error) {
            const code = typeof j.error.code === "number" && Number.isInteger(j.error.code) && j.error.code >= 400 && j.error.code < 600 ? j.error.code : 500;
            const e = errorForStatus(code, gateway);
            yield { type: "error", code: e.code, status: code, ...(e.retryable !== undefined ? { retryable: e.retryable } : {}) };
            return;
          }
          if (gateway && typeof j.model === "string" && j.model.length > 0 && j.model.length <= 200) routed = j.model;
          const ch = j.choices?.[0];
          const text = ch?.delta?.content;
          if (typeof text === "string" && text) {
            const room = MAX_STREAM_CHARS - chars;
            const piece = text.length > room ? text.slice(0, room) : text;
            chars += piece.length;
            if (piece) yield { type: "delta", text: piece };
            if (chars >= MAX_STREAM_CHARS) { finishReason = "length"; break; }
          }
          if (ch?.finish_reason) finishReason = finish(ch.finish_reason);
          if (j.usage && typeof j.usage === "object") {
            usage = { inputTokens: int(j.usage.prompt_tokens), outputTokens: int(j.usage.completion_tokens) };
            const cost = gateway ? usdToMicroCeil(j.usage.cost) : undefined;
            if (cost !== undefined) usage.reportedCostMicro = cost;
          }
        }
        if (ac.signal.aborted) { yield { type: "error", code: "timeout" }; return; }
        if (!finishReason) { yield { type: "error", code: "provider_error" }; return; } // ended early: truncated stream
        if (usage) yield { type: "usage", ...usage };
        yield { type: "done", finishReason, ...(routed ? { routedModel: routed } : {}) };
      } finally {
        clearTimeout(hard);
        req.signal?.removeEventListener("abort", onExternal);
        ac.abort();
      }
    },
    /** Image input as a data URI in an image_url part. No `document` capability: PDFs are not accepted here. */
    vision(r) {
      if (r.media.kind !== "image" || !IMAGE_MIMES.has(r.media.mime)) throw new AiError("unsupported_capability");
      const url = `data:${r.media.mime};base64,${Buffer.from(r.media.bytes).toString("base64")}`;
      return chat(r.apiKey, { model: r.model, max_tokens: r.maxOutputTokens, messages: [{ role: "user", content: [{ type: "text", text: r.prompt }, { type: "image_url", image_url: { url } }] }] });
    },
    /** Multipart POST to /audio/transcriptions. `verbose_json` returns the audio duration, which is what the per-minute price is applied to. */
    async transcribe(r) {
      const ext = EXT[r.media.mime];
      if (gateway) throw new AiError("unsupported_capability"); // no audio endpoint on the gateway adapter
      if (r.media.kind !== "audio" || !ext) throw new AiError("unsupported_capability");
      const form = new FormData();
      form.append("file", new Blob([Buffer.from(r.media.bytes)], { type: r.media.mime }), `audio.${ext}`);
      form.append("model", r.model);
      form.append("response_format", "verbose_json");
      if (r.language) form.append("language", r.language);
      const j = (await post(`${base}/audio/transcriptions`, { authorization: `Bearer ${r.apiKey}` }, form, o)) as { text?: unknown; duration?: unknown } | null;
      if (!j || typeof j.text !== "string") throw new AiError("provider_error");
      const d = typeof j.duration === "number" && Number.isFinite(j.duration) && j.duration >= 0 ? Math.ceil(j.duration) : undefined;
      return { text: j.text, usage: { inputTokens: 0, outputTokens: 0 }, ...(d !== undefined ? { durationSec: d } : {}) };
    },
  };
}
