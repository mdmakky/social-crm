import { ATTACHMENT_LIMITS, type AttachmentDto, type AttachmentKind } from "@crm/contracts";

/** Extension -> kind, for the client-side pre-check only. The server decides what a file really is from its bytes. */
export const EXT_KIND: Record<string, AttachmentKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  mp3: "audio", wav: "audio", m4a: "audio", ogg: "audio",
  webm: "video", mp4: "video", mov: "video",
  pdf: "document", docx: "document", xlsx: "document", pptx: "document", txt: "document", csv: "document",
};
export const extOf = (name: string) => /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";

export function formatBytes(n: number | null): string {
  if (n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Why a file cannot be attached, or null. `limits` come from the server (an administrator can change them). */
export function checkPick(file: { name: string; size: number }, limits: Record<AttachmentKind, number> = ATTACHMENT_LIMITS): string | null {
  const kind = EXT_KIND[extOf(file.name)];
  if (!kind) return "This file type is not supported. Use an image, audio, video, PDF, Word, Excel, PowerPoint, text or CSV file.";
  if (file.size === 0) return "The file is empty.";
  if (file.size > limits[kind]) return `The file is too large. The limit for ${kind === "document" ? "documents" : `${kind} files`} is ${formatBytes(limits[kind])}.`;
  return null;
}

/** Plain-language reason for a failed download, from the stored error code. */
export function downloadFailureText(code: string | null): string {
  switch (code) {
    case "media_expired": return "The channel no longer has this file (it may have expired).";
    case "too_large": return "The file is larger than the size limit.";
    case "unsupported_media": return "This type of file is not supported.";
    case "executable_content": return "This file was blocked because it is an executable or script.";
    case "empty_media": return "The file is empty.";
    case "url_blocked": return "The file's address was not allowed.";
    case "provider_auth": case "token_unavailable": return "The channel connection can't be used. Reconnect it in Settings > Integrations.";
    case "provider_denied": return "The channel refused to give us this file.";
    case "storage_error": return "The file could not be saved to storage.";
    case "blob_missing": return "The file is no longer in storage.";
    default: return "The download did not work.";
  }
}

/** The text shown for a failed upload, from the API code (the API message is already plain language; this adds the generic cases). */
export const uploadFailureText = (code: string, message: string | undefined): string =>
  code === "storage_not_configured" ? "File storage is not set up on this server." : code === "rate_limited" ? "Too many uploads. Wait a minute and try again." : message && code !== "internal_error" ? message : "The upload did not work. Try again.";

export const contentUrl = (a: Pick<AttachmentDto, "id" | "conversationId">, workspaceId: string, download = false) =>
  `/v1/workspaces/${workspaceId}/conversations/${a.conversationId}/attachments/${a.id}/content${download ? "?download=1" : ""}`;
