export type AiErrorCode = "auth" | "rate_limit" | "timeout" | "invalid_request" | "provider_error";

/** Message and cause never carry prompt text, response text or keys: provider bodies are dropped, only the code and HTTP status survive. */
export class AiError extends Error {
  constructor(readonly code: AiErrorCode, readonly status?: number) {
    super(`ai provider error: ${code}${status ? ` (${status})` : ""}`);
    this.name = "AiError";
  }
}

export type AiMessage = { role: "system" | "user" | "assistant"; content: string };
export type GenerateRequest = {
  /** Workspace secret. Passed per call, never stored on the adapter. */
  apiKey: string;
  model: string;
  messages: AiMessage[];
  maxOutputTokens: number;
  temperature?: number;
};
export type TokenUsage = { inputTokens: number; outputTokens: number };
export type FinishReason = "stop" | "length" | "other";
export type GenerateResult = { text: string; usage: TokenUsage; finishReason: FinishReason };

/** The one port every provider implements. Adapters throw AiError and nothing else. */
export interface AiProvider {
  readonly id: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
