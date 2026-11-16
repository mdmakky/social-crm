import { AiError, type AiProvider, type FinishReason } from "../types.ts";
import { int, postJson, type HttpOptions } from "./http.ts";

type Reply = { choices?: { message?: { content?: string | null }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };

/** OpenAI-compatible chat completions (OpenAI itself, or any server that speaks the same API via baseUrl). UNVERIFIED against a live service: fake fetch only. */
export function createOpenAiCompatible(o: HttpOptions & { baseUrl?: string } = {}): AiProvider {
  const base = (o.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    id: "openai",
    async generate(req) {
      const j = (await postJson(`${base}/chat/completions`, { authorization: `Bearer ${req.apiKey}` },
        { model: req.model, messages: req.messages, max_tokens: req.maxOutputTokens, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) }, o)) as Reply | null;
      const choice = j?.choices?.[0];
      if (!choice || typeof choice.message?.content !== "string") throw new AiError("provider_error");
      const finishReason: FinishReason = choice.finish_reason === "stop" ? "stop" : choice.finish_reason === "length" ? "length" : "other";
      return { text: choice.message.content, usage: { inputTokens: int(j?.usage?.prompt_tokens), outputTokens: int(j?.usage?.completion_tokens) }, finishReason };
    },
  };
}
