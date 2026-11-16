import { AiError, type AiProvider, type FinishReason, type MediaRequest } from "../types.ts";
import { int, postJson, type HttpOptions } from "./http.ts";

type Reply = { content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number }; stop_reason?: string };

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Anthropic Messages API. UNVERIFIED against the live service: only exercised with a fake fetch (see docs/project/known-limitations.md). */
export function createAnthropic(o: HttpOptions & { baseUrl?: string } = {}): AiProvider {
  const base = (o.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const call = async (apiKey: string, body: Record<string, unknown>) => {
    const j = (await postJson(`${base}/v1/messages`, { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body, o)) as Reply | null;
    if (!j || !Array.isArray(j.content)) throw new AiError("provider_error");
    const text = j.content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
    const finishReason: FinishReason = j.stop_reason === "end_turn" || j.stop_reason === "stop_sequence" ? "stop" : j.stop_reason === "max_tokens" ? "length" : "other";
    return { text, usage: { inputTokens: int(j.usage?.input_tokens), outputTokens: int(j.usage?.output_tokens) }, finishReason };
  };
  /** One user turn with a base64 content block (image or PDF) followed by the instruction. */
  const withMedia = (r: MediaRequest, allowPdf: boolean) => {
    const m = r.media;
    const block = m.kind === "image" && IMAGE_MIMES.has(m.mime) ? { type: "image", source: { type: "base64", media_type: m.mime, data: b64(m.bytes) } }
      : allowPdf && m.kind === "document" && m.mime === "application/pdf" ? { type: "document", source: { type: "base64", media_type: m.mime, data: b64(m.bytes) } }
      : null;
    if (!block) throw new AiError("unsupported_capability");
    return call(r.apiKey, { model: r.model, max_tokens: r.maxOutputTokens, messages: [{ role: "user", content: [block, { type: "text", text: r.prompt }] }] });
  };
  return {
    id: "anthropic",
    async generate(req) {
      const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const messages = req.messages.filter((m) => m.role !== "system");
      return call(req.apiKey, { model: req.model, max_tokens: req.maxOutputTokens, ...(system ? { system } : {}), messages, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) });
    },
    vision: (r) => withMedia(r, false),
    document: (r) => withMedia(r, true),
  };
}
