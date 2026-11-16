import { AiError, type AiProvider, type FinishReason } from "../types.ts";
import { int, postJson, type HttpOptions } from "./http.ts";

type Reply = { content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number }; stop_reason?: string };

/** Anthropic Messages API. UNVERIFIED against the live service: only exercised with a fake fetch (see docs/project/known-limitations.md). */
export function createAnthropic(o: HttpOptions & { baseUrl?: string } = {}): AiProvider {
  const base = (o.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  return {
    id: "anthropic",
    async generate(req) {
      const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const messages = req.messages.filter((m) => m.role !== "system");
      const j = (await postJson(`${base}/v1/messages`, { "x-api-key": req.apiKey, "anthropic-version": "2023-06-01" },
        { model: req.model, max_tokens: req.maxOutputTokens, ...(system ? { system } : {}), messages, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) }, o)) as Reply | null;
      const text = (j?.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
      if (!j || !Array.isArray(j.content)) throw new AiError("provider_error");
      const finishReason: FinishReason = j.stop_reason === "end_turn" || j.stop_reason === "stop_sequence" ? "stop" : j.stop_reason === "max_tokens" ? "length" : "other";
      return { text, usage: { inputTokens: int(j.usage?.input_tokens), outputTokens: int(j.usage?.output_tokens) }, finishReason };
    },
  };
}
