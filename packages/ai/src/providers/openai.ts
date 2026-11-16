import { AiError, type AiProvider, type FinishReason } from "../types.ts";
import { int, post, postJson, usdToMicroCeil, type HttpOptions } from "./http.ts";

type Reply = { model?: unknown; choices?: { message?: { content?: string | null }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: unknown } };
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const EXT: Record<string, string> = { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/webm": "webm" };

/** OpenAI-compatible chat completions (OpenAI itself, or any server that speaks the same API via baseUrl). UNVERIFIED against a live service: fake fetch only. */
export function createOpenAiCompatible(o: HttpOptions & { baseUrl?: string; id?: string; extraHeaders?: Record<string, string> } = {}): AiProvider {
  const base = (o.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const gateway = !!o.gateway;
  const chat = async (apiKey: string, body: Record<string, unknown>) => {
    const j = (await postJson(`${base}/chat/completions`, { authorization: `Bearer ${apiKey}`, ...o.extraHeaders }, body, o)) as Reply | null;
    const choice = j?.choices?.[0];
    if (!choice || typeof choice.message?.content !== "string") throw new AiError("provider_error");
    const finishReason: FinishReason = choice.finish_reason === "stop" ? "stop" : choice.finish_reason === "length" ? "length" : "other";
    const usage: { inputTokens: number; outputTokens: number; reportedCostMicro?: number } = { inputTokens: int(j?.usage?.prompt_tokens), outputTokens: int(j?.usage?.completion_tokens) };
    if (!gateway) return { text: choice.message.content, usage, finishReason };
    const cost = usdToMicroCeil(j?.usage?.cost);
    if (cost !== undefined) usage.reportedCostMicro = cost;
    const routed = typeof j?.model === "string" && j.model.length > 0 && j.model.length <= 200 ? j.model : undefined;
    return { text: choice.message.content, usage, finishReason, ...(routed ? { routedModel: routed } : {}) };
  };
  return {
    id: o.id ?? "openai",
    generate: (req) => chat(req.apiKey, { model: req.model, messages: req.messages, max_tokens: req.maxOutputTokens, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) }),
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
