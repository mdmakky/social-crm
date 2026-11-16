import { at, SIGS, type MediaErrorCode } from "./media.ts";

// Inbox attachments: wider file sniffing (video, office documents, text) on top of the AI media signatures in media.ts. Same rule: the BYTES decide what a file is.

export type AttachmentKind = "image" | "audio" | "video" | "document";
/** Default size caps per attachment kind. The API lets an env var change them. WhatsApp's own limits are UNVERIFIED here. */
export const ATTACHMENT_LIMITS: Record<AttachmentKind, number> = { image: 5 * 1024 * 1024, audio: 20 * 1024 * 1024, video: 25 * 1024 * 1024, document: 10 * 1024 * 1024 };
export type AttachmentErrorCode = MediaErrorCode | "executable_content";
export type AttachmentCheck = { ok: true; kind: AttachmentKind; mime: string } | { ok: false; code: AttachmentErrorCode };

const OFFICE = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;
/** Accepted spellings of the declared type, per detected mime (image/audio/pdf aliases come from SIGS). */
const ALIASES: Record<string, string[]> = {
  "video/mp4": ["video/mp4", "video/x-m4v", "video/3gpp"], "video/quicktime": ["video/quicktime"], "video/webm": ["video/webm"],
  [OFFICE.docx]: [OFFICE.docx], [OFFICE.xlsx]: [OFFICE.xlsx], [OFFICE.pptx]: [OFFICE.pptx],
  "text/plain": ["text/plain"], "text/csv": ["text/csv", "application/csv", "application/vnd.ms-excel"],
};
const ascii = (b: Uint8Array, off: number, n: number) => String.fromCharCode(...b.subarray(off, off + n));

function sniff(bytes: Uint8Array, declared: string): { kind: AttachmentKind; mime: string } | null {
  if (at(bytes, 4, "ftyp")) { // ISO base media: the major brand tells audio (M4A) from QuickTime and mp4
    const brand = ascii(bytes, 8, 4);
    if (brand === "M4A " || brand === "M4B ") return { kind: "audio", mime: "audio/mp4" };
    return { kind: "video", mime: brand === "qt  " ? "video/quicktime" : "video/mp4" };
  }
  // EBML is one container for audio and video: a video claim wins only when the sender says video.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return declared.startsWith("video/") ? { kind: "video", mime: "video/webm" } : { kind: "audio", mime: "audio/webm" };
  const known = SIGS.find((x) => x.test(bytes));
  if (known) return { kind: known.kind, mime: known.mime };
  if (at(bytes, 0, "PK\u0003\u0004")) { // zip container: only the three Office formats, recognised by their well-known part names
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (b.includes("[Content_Types].xml")) {
      if (b.includes("word/document.xml")) return { kind: "document", mime: OFFICE.docx };
      if (b.includes("xl/workbook.xml")) return { kind: "document", mime: OFFICE.xlsx };
      if (b.includes("ppt/presentation.xml")) return { kind: "document", mime: OFFICE.pptx };
    }
  }
  return null;
}

/** Plain text (txt, csv) has no magic number: require valid UTF-8 without NUL bytes, and refuse scripts and markup. */
function sniffText(bytes: Uint8Array, declared: string): { kind: "document"; mime: string } | "executable" | null {
  if (bytes.subarray(0, 8192).includes(0) || at(bytes, 0, "PK\u0003\u0004")) return null; // a zip that is not an Office file is not text
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
  if (/^\s*(#!|<\?php|<script|<!doctype html|<html)/i.test(text.slice(0, 64))) return "executable";
  return { kind: "document", mime: ALIASES["text/csv"]!.includes(declared) ? "text/csv" : "text/plain" };
}

const isExecutable = (b: Uint8Array) =>
  (b[0] === 0x4d && b[1] === 0x5a) || at(b, 0, "\u007fELF") || at(b, 0, "#!") || (b[0] === 0xcf && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe) || (b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe);

/**
 * Validates a file by its bytes. `strict` (user uploads) also requires the declared type to agree with the detection; inbound files from a channel are classified by
 * bytes alone (the sender's label is kept only as `declared_mime`). Unknown, spoofed and executable content is refused. Size caps per kind (`limits` overrides).
 */
export function checkAttachment(declaredMime: string, bytes: Uint8Array, o: { strict?: boolean; limits?: Partial<Record<AttachmentKind, number>> } = {}): AttachmentCheck {
  if (bytes.byteLength === 0) return { ok: false, code: "empty_media" };
  const declared = declaredMime.split(";")[0]!.trim().toLowerCase();
  if (isExecutable(bytes)) return { ok: false, code: "executable_content" };
  let hit = sniff(bytes, declared);
  if (!hit) {
    const t = sniffText(bytes, declared);
    if (t === "executable") return { ok: false, code: "executable_content" };
    hit = t;
  }
  if (!hit) return { ok: false, code: "unsupported_media" };
  if (o.strict) {
    const agrees = (ALIASES[hit.mime] ?? []).includes(declared) || SIGS.some((x) => x.mime === hit!.mime && x.aliases.includes(declared));
    if (!agrees) return { ok: false, code: declared.includes("/") && declared !== "application/octet-stream" ? "mime_mismatch" : "unsupported_media" };
  }
  if (bytes.byteLength > { ...ATTACHMENT_LIMITS, ...o.limits }[hit.kind]) return { ok: false, code: "media_too_large" };
  return { ok: true, kind: hit.kind, mime: hit.mime };
}
