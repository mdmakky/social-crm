import { KnowledgeError, type Extractor, type KnowledgeErrorCode } from "@crm/knowledge";
import { MEDIA_FAILURES, type MediaFailure, type MediaService } from "../ai/media.ts";

/** Extension -> the mime the upload claims. The media service checks the real bytes against it (magic bytes), so a renamed file is refused. */
const TYPES: Record<string, { mime: string; audio: boolean }> = {
  ".pdf": { mime: "application/pdf", audio: false }, ".png": { mime: "image/png", audio: false }, ".jpg": { mime: "image/jpeg", audio: false }, ".jpeg": { mime: "image/jpeg", audio: false },
  ".webp": { mime: "image/webp", audio: false }, ".gif": { mime: "image/gif", audio: false },
  ".mp3": { mime: "audio/mpeg", audio: true }, ".wav": { mime: "audio/wav", audio: true }, ".m4a": { mime: "audio/mp4", audio: true }, ".ogg": { mime: "audio/ogg", audio: true }, ".webm": { mime: "audio/webm", audio: true },
};
export const isMediaFile = (filename: string): boolean => Object.hasOwn(TYPES, /\.[^./\\]+$/.exec(filename.toLowerCase())?.[0] ?? "");

/** Failure of the media service -> stable knowledge error code (stored on a failed source) with the user-facing message. */
const CODE: Partial<Record<MediaFailure, KnowledgeErrorCode>> = {
  empty_media: "empty_content", media_too_large: "too_large", unsupported_media: "unsupported_media", mime_mismatch: "unsupported_media",
  not_configured: "capability_not_configured", capability_not_configured: "capability_not_configured", unsupported_capability: "capability_not_configured",
  budget_exceeded: "budget_exceeded", rate_limited: "rate_limited",
};

/** Registers PDF, image (OCR) and audio (transcription) extractors that run through the AI media service (and so through runAi: budget, run log). */
export function mediaExtractors(media: MediaService, who: { workspaceId: string; userId: string }): Record<string, Extractor> {
  return Object.fromEntries(Object.entries(TYPES).map(([ext, t]) => [ext, async (f) => {
    const out = t.audio ? await media.transcribeAudio(who, { mime: t.mime, bytes: f.bytes }) : await media.extractDocumentText(who, { mime: t.mime, bytes: f.bytes });
    if (out.ok) return { text: out.text };
    throw new KnowledgeError(CODE[out.code] ?? "ai_unavailable", MEDIA_FAILURES[out.code].message);
  }]));
}
