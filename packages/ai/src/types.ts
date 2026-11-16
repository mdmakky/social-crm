export type AiErrorCode = "auth" | "rate_limit" | "timeout" | "invalid_request" | "provider_error" | "unsupported_capability" | "payment_required" | "blocked";

/**
 * Message and cause never carry prompt text, response text or keys: provider bodies are dropped, only the code and HTTP status survive.
 * `retryable` (when set) overrides the default retry rule (rate_limit and timeout only). `retryAfterMs` is the provider's Retry-After, already capped at 30 s.
 * `payment_required` (402, out of credits) and `blocked` (403 guardrail or moderation) are only produced by the OpenRouter provider; other providers keep 401 and 403 as auth.
 */
export class AiError extends Error {
  constructor(readonly code: AiErrorCode, readonly status?: number, readonly extra: { retryable?: boolean; retryAfterMs?: number } = {}) {
    super(`ai provider error: ${code}${status ? ` (${status})` : ""}`);
    this.name = "AiError";
  }
  get retryable() { return this.extra.retryable; }
  get retryAfterMs() { return this.extra.retryAfterMs; }
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
/** `reportedCostMicro`: the provider's own cost for the call (OpenRouter `usage.cost`, USD credits) in micro-units, rounded UP; absent when the provider reported none. */
export type TokenUsage = { inputTokens: number; outputTokens: number; reportedCostMicro?: number };
export type FinishReason = "stop" | "length" | "other";
/** `routedModel`: the model that actually answered, when the provider says so (a gateway may route to a different one than requested). */
export type GenerateResult = { text: string; usage: TokenUsage; finishReason: FinishReason; routedModel?: string };

/** What a model can do. `document` = PDF or scanned-page text extraction; `vision` = understanding an image; `transcription` = audio to text. */
export type Capability = "text" | "vision" | "transcription" | "document";
export type MediaKind = "image" | "audio" | "document";
/** Validated media (see checkMedia). Bytes are sent to the provider and dropped: never stored or logged. */
export type MediaInput = { kind: MediaKind; mime: string; bytes: Uint8Array };
export type MediaRequest = { apiKey: string; model: string; media: MediaInput; prompt: string; maxOutputTokens: number };
export type TranscribeRequest = { apiKey: string; model: string; media: MediaInput; language?: string };
/** `durationSec` only when the provider reports it; cost falls back to a documented size estimate otherwise. */
export type TranscribeResult = { text: string; usage: TokenUsage; durationSec?: number };

/**
 * The one port every provider implements. Adapters throw AiError and nothing else.
 * Capability methods are optional: a provider that lacks one (or does not take that media kind) throws AiError("unsupported_capability").
 */
export interface AiProvider {
  readonly id: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  vision?(req: MediaRequest): Promise<GenerateResult>;
  document?(req: MediaRequest): Promise<GenerateResult>;
  transcribe?(req: TranscribeRequest): Promise<TranscribeResult>;
}
