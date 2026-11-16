import { checkMedia, type Capability, type MediaErrorCode, type MediaInput, type MediaKind } from "@crm/ai";
import { WindowCounter } from "../throttle.ts";
import { runAi, type AiDeps, type RunFailure, type RunResult } from "./run.ts";

export type MediaFile = { mime: string; bytes: Uint8Array };
export type MediaFailure = MediaErrorCode | RunFailure | "rate_limited";
export type MediaOutcome = Extract<RunResult, { ok: true }> | { ok: false; code: MediaFailure; runId?: string };
type Who = { workspaceId: string; userId: string };

export type MediaService = {
  describeImage(who: Who, f: MediaFile): Promise<MediaOutcome>;
  askAboutImage(who: Who, f: MediaFile, question: string): Promise<MediaOutcome>;
  /** PDF or image text (OCR). */
  extractDocumentText(who: Who, f: MediaFile): Promise<MediaOutcome>;
  transcribeAudio(who: Who, f: MediaFile, language?: string): Promise<MediaOutcome>;
};

const DESCRIBE = "Describe this image for a customer support team in 2 to 4 plain sentences. Mention visible text, products, damage or the type of document. Do not guess who people are.";
const EXTRACT = "Extract all text from this file exactly as written, in reading order, keeping simple structure such as headings and lists. Output only the text, with no commentary.";

/**
 * Media processing (vision, OCR, transcription). Every call goes through runAi, so the monthly budget hard stop, provider selection, retries and the run log are the same as for text.
 * Checks before any provider is contacted: per-workspace rate limit, size cap, allowlist and magic bytes (a spoofed mime is refused). Bytes are held in memory for the call only:
 * never persisted, never logged; the run row keeps kind, mime, size and a hash. No database transaction is open while the provider call runs (runAi's rule).
 * ponytail: the rate limit is in-process (one API instance); move it to a shared store before running more than one instance.
 */
export function createMediaService(deps: AiDeps, o: { perWorkspace?: number; windowMs?: number } = {}): MediaService {
  const limiter = new WindowCounter(o.perWorkspace ?? 60, o.windowMs ?? 60_000);
  async function go(who: Who, f: MediaFile, allow: MediaKind[], run: (media: MediaInput) => Promise<RunResult>): Promise<MediaOutcome> {
    if (!limiter.allow(who.workspaceId)) return { ok: false, code: "rate_limited" };
    const c = checkMedia(f.mime, f.bytes, allow);
    if (!c.ok) return c;
    return run(c.media);
  }
  const call = (who: Who, media: MediaInput, capability: string, promptKey: string, needs: Capability[], prompt: string, maxOutputTokens: number, language?: string) =>
    runAi(deps, { ...who, capability, promptKey, vars: {}, input: "", system: "", maxOutputTokens, media: { needs, prompt, input: media, language } });
  return {
    describeImage: (who, f) => go(who, f, ["image"], (m) => call(who, m, "vision", "media_describe", ["vision"], DESCRIBE, 600)),
    askAboutImage: (who, f, q) => go(who, f, ["image"], (m) => call(who, m, "vision", "media_ask", ["vision"], `Answer the question about this image using only what is visible. If the image does not show the answer, say so.\nQuestion: ${q}`, 600)),
    extractDocumentText: (who, f) => go(who, f, ["image", "document"], (m) => call(who, m, "ocr", "media_extract", m.kind === "document" ? ["document"] : ["document", "vision"], EXTRACT, 4000)),
    transcribeAudio: (who, f, language) => go(who, f, ["audio"], (m) => call(who, m, "transcription", "media_transcribe", ["transcription"], "", 0, language)),
  };
}

/** HTTP status and a message the UI can show, per failure. Shared by the media routes and the knowledge upload. */
export const MEDIA_FAILURES: Record<MediaFailure, { status: 400 | 402 | 409 | 413 | 422 | 429 | 502; message: string }> = {
  payment_required: { status: 402, message: "The provider account is out of credits" },
  blocked: { status: 422, message: "The AI provider blocked this request (a guardrail or moderation rule). Change the content or the provider settings and try again." },
  empty_media: { status: 422, message: "The file is empty." },
  unsupported_media: { status: 422, message: "This file type is not supported here. Images: png, jpeg, webp, gif. Audio: mp3, wav, m4a, ogg, webm. Documents: pdf." },
  mime_mismatch: { status: 422, message: "The file does not match its declared type." },
  media_too_large: { status: 413, message: "The file is too large. Limits: images 5 MB, audio 20 MB, PDF 10 MB." },
  rate_limited: { status: 429, message: "Too many media requests in a short time. Try again in a minute." },
  not_configured: { status: 409, message: "No AI provider is set up for this workspace. An owner or admin can add one in Settings, AI." },
  capability_not_configured: { status: 409, message: "No AI provider with this capability is set up. An owner or admin can add a provider whose models support it in Settings, AI (see Capabilities there)." },
  budget_exceeded: { status: 409, message: "The monthly AI budget is used up. An owner or admin can raise it in Settings, AI." },
  unsupported_capability: { status: 422, message: "The selected AI model does not support this kind of file." },
  rate_limit: { status: 429, message: "The AI provider is busy. Try again in a moment." },
  auth: { status: 502, message: "The AI provider key was rejected. An owner or admin should check it in Settings, AI." },
  key_unavailable: { status: 502, message: "The AI provider key cannot be read. An owner or admin should check it in Settings, AI." },
  timeout: { status: 502, message: "The AI provider took too long to answer. Try again." },
  invalid_request: { status: 502, message: "The AI provider could not process this file." },
  provider_error: { status: 502, message: "The AI provider failed. Try again." },
  template_invalid: { status: 502, message: "The request could not be built." },
};
