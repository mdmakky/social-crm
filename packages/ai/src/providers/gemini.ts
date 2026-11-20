import { AiError, type AiProvider } from "../types.ts";
import { errorForStatus, int, type HttpOptions } from "./http.ts";

/** Google Gemini API (generativelanguage.googleapis.com), used for speech to text only: no `generate`, no `vision`, no `document`. UNVERIFIED against a live service: fake fetch only. */
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/** Audio sent inline (base64 in the JSON body). Gemini caps a whole inline request at 20 MB, base64 adds a third, so raw audio above this goes to a files API we do not use. */
export const GEMINI_MAX_INLINE_BYTES = 14 * 1024 * 1024;
/** Gemini documents wav, mp3, aiff, aac, ogg and flac. mp4/m4a and webm are what chat apps actually send; they are passed through under their real type and are UNVERIFIED. */
const AUDIO_MIMES: Record<string, string> = { "audio/wav": "audio/wav", "audio/mpeg": "audio/mp3", "audio/ogg": "audio/ogg", "audio/mp4": "audio/mp4", "audio/webm": "audio/webm" };
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,60}$/i;

/** Keeps the speaker's language (Bengali, English or a mix) and never translates. Empty speech gives an empty text. */
export const TRANSCRIBE_PROMPT = "Transcribe this audio exactly as spoken. Keep the original language or languages (for example Bengali, English, or a mix of both) and the original script; do not translate, summarise or explain. Output only the transcript text. If there is no speech, output nothing.";

type Reply = {
  candidates?: { content?: { parts?: { text?: unknown }[] }; finishReason?: unknown }[];
  promptFeedback?: { blockReason?: unknown };
  usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
};

export function createGemini(o: HttpOptions & { baseUrl?: string } = {}): AiProvider {
  const base = (o.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, "");
  return {
    id: "gemini",
    /** Not offered: no catalog model claims "text", so nothing routes chat here. */
    generate: () => Promise.reject(new AiError("unsupported_capability")),
    async transcribe(r) {
      const mime = AUDIO_MIMES[r.media.mime];
      if (r.media.kind !== "audio" || !mime) throw new AiError("unsupported_capability");
      if (r.media.bytes.byteLength === 0 || r.media.bytes.byteLength > GEMINI_MAX_INLINE_BYTES) throw new AiError("invalid_request");
      if (!MODEL_ID.test(r.model)) throw new AiError("invalid_request");
      const lang = r.language && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(r.language) ? ` The language is ${r.language}.` : "";
      const body = {
        contents: [{ role: "user", parts: [{ text: TRANSCRIBE_PROMPT + lang }, { inline_data: { mime_type: mime, data: Buffer.from(r.media.bytes).toString("base64") } }] }],
        generationConfig: { temperature: 0 },
      };
      // The key travels in a header, never in the URL, so it cannot end up in a proxy or access log line.
      const res = await call(`${base}/models/${encodeURIComponent(r.model)}:generateContent`, { "content-type": "application/json", "x-goog-api-key": r.apiKey }, JSON.stringify(body), o);
      const j = res as Reply | null;
      if (!j || typeof j !== "object") throw new AiError("provider_error");
      if (j.promptFeedback?.blockReason) throw new AiError("blocked");
      const parts = j.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts) ? parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("").trim() : "";
      if (!Array.isArray(parts) && !j.candidates?.length) throw new AiError("provider_error"); // no answer at all (not the same as silence)
      return { text, usage: { inputTokens: int(j.usageMetadata?.promptTokenCount), outputTokens: int(j.usageMetadata?.candidatesTokenCount) } };
    },
  };
}

/** One POST. Gemini answers a bad key with HTTP 400 (reason API_KEY_INVALID), so that one body field is read; nothing else from an error body is kept. */
async function call(url: string, headers: Record<string, string>, body: string, o: HttpOptions): Promise<unknown> {
  const f = o.fetch ?? fetch;
  const t = o.timeoutMs ?? 30_000;
  let res: Response;
  try {
    res = await f(url, { method: "POST", headers, body, signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(t)]) : AbortSignal.timeout(t) });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    throw new AiError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "provider_error");
  }
  if (!res.ok) {
    if (res.status === 400) {
      const reason = await res.json().then((j: { error?: { details?: { reason?: unknown }[] } }) => j?.error?.details?.find((d) => typeof d?.reason === "string")?.reason, () => undefined);
      if (reason === "API_KEY_INVALID") throw new AiError("auth", 400);
    }
    throw errorForStatus(res.status, false);
  }
  try {
    return await res.json();
  } catch {
    throw new AiError("provider_error", res.status);
  }
}
