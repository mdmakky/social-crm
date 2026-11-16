import { AiError, type AiProvider, type Capability, type MediaInput, type MediaKind, type TokenUsage } from "./types.ts";

/** Hard caps per media kind, in bytes. Mirrored in @crm/contracts (a test keeps them equal). */
export const MEDIA_LIMITS = { image: 5 * 1024 * 1024, audio: 20 * 1024 * 1024, document: 10 * 1024 * 1024 } as const;

export type Sig = { kind: MediaKind; mime: string; aliases: string[]; test: (b: Uint8Array) => boolean };
export const at = (b: Uint8Array, off: number, s: string) => [...s].every((c, i) => b[off + i] === c.charCodeAt(0));
export const SIGS: Sig[] = [
  { kind: "image", mime: "image/png", aliases: ["image/png"], test: (b) => b[0] === 0x89 && at(b, 1, "PNG\r\n") },
  { kind: "image", mime: "image/jpeg", aliases: ["image/jpeg", "image/jpg"], test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: "image", mime: "image/gif", aliases: ["image/gif"], test: (b) => at(b, 0, "GIF87a") || at(b, 0, "GIF89a") },
  { kind: "image", mime: "image/webp", aliases: ["image/webp"], test: (b) => at(b, 0, "RIFF") && at(b, 8, "WEBP") },
  { kind: "document", mime: "application/pdf", aliases: ["application/pdf"], test: (b) => at(b, 0, "%PDF-") },
  { kind: "audio", mime: "audio/wav", aliases: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"], test: (b) => at(b, 0, "RIFF") && at(b, 8, "WAVE") },
  { kind: "audio", mime: "audio/ogg", aliases: ["audio/ogg", "application/ogg"], test: (b) => at(b, 0, "OggS") },
  { kind: "audio", mime: "audio/webm", aliases: ["audio/webm"], test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { kind: "audio", mime: "audio/mp4", aliases: ["audio/mp4", "audio/x-m4a", "audio/m4a"], test: (b) => at(b, 4, "ftyp") },
  { kind: "audio", mime: "audio/mpeg", aliases: ["audio/mpeg", "audio/mp3"], test: (b) => at(b, 0, "ID3") || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) },
];

export type MediaErrorCode = "empty_media" | "unsupported_media" | "mime_mismatch" | "media_too_large";
export type MediaCheck = { ok: true; media: MediaInput } | { ok: false; code: MediaErrorCode };

/** Allowlist + size cap + magic-byte check. Magic bytes decide what a file is; a spoofed declared mime is `mime_mismatch`. */
export function checkMedia(declaredMime: string, bytes: Uint8Array, allow: readonly MediaKind[]): MediaCheck {
  if (bytes.byteLength === 0) return { ok: false, code: "empty_media" };
  const declared = declaredMime.split(";")[0]!.trim().toLowerCase();
  const sig = SIGS.find((x) => x.test(bytes));
  if (!sig || !allow.includes(sig.kind)) return { ok: false, code: "unsupported_media" };
  if (!sig.aliases.includes(declared)) return { ok: false, code: SIGS.some((x) => x.aliases.includes(declared)) ? "mime_mismatch" : "unsupported_media" };
  if (bytes.byteLength > MEDIA_LIMITS[sig.kind]) return { ok: false, code: "media_too_large" };
  return { ok: true, media: { kind: sig.kind, mime: sig.mime, bytes } };
}

/**
 * Documented ESTIMATES, used only when a provider reports no token usage. UNVERIFIED rules of thumb, not vendor figures:
 * image about 1 token per 750 bytes within 85..1600; PDF about 1 token per 32 bytes (a ~50 KB page is ~1500 tokens); audio about 128 kbit/s.
 */
export function estimateMediaTokens(kind: MediaKind, bytes: number): number {
  if (kind === "image") return Math.min(1600, Math.max(85, Math.ceil(bytes / 750)));
  if (kind === "document") return Math.max(1, Math.ceil(bytes / 32));
  return 0;
}
export const estimateAudioSeconds = (bytes: number): number => Math.max(1, Math.ceil(bytes / 16_000));

/** Runs one capability on a provider; a missing method, or a media kind that capability does not take, is `unsupported_capability`. */
export async function invokeMedia(p: AiProvider, via: Capability, a: { apiKey: string; model: string; media: MediaInput; prompt: string; maxOutputTokens: number; language?: string }): Promise<{ text: string; usage: TokenUsage; durationSec?: number; routedModel?: string }> {
  const { apiKey, model, media, prompt, maxOutputTokens } = a;
  if (via === "transcription") {
    if (!p.transcribe || media.kind !== "audio") throw new AiError("unsupported_capability");
    return p.transcribe({ apiKey, model, media, ...(a.language ? { language: a.language } : {}) });
  }
  const fn = via === "vision" ? p.vision : via === "document" ? p.document : undefined;
  if (!fn || (via === "vision" && media.kind !== "image") || (via === "document" && media.kind === "audio")) throw new AiError("unsupported_capability");
  return fn.call(p, { apiKey, model, media, prompt, maxOutputTokens });
}
