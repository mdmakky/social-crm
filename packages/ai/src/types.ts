export type AiErrorCode = "auth" | "rate_limit" | "timeout" | "invalid_request" | "provider_error" | "unsupported_capability";

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
