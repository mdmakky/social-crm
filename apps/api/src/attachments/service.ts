import { sql } from "drizzle-orm";
import { attachmentKey, type BlobStore } from "@crm/core";
import type { AttachmentDto } from "@crm/contracts";
import type { Tx } from "@crm/db";

type Row = Record<string, unknown>;
export const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;
const iso = (v: unknown) => new Date(v as string | Date).toISOString();

/** Columns the application role may read (never provider_url: a short-lived channel link). */
export const ATT_COLS = sql`a.id, a.conversation_id, a.message_id, a.direction, a.source, a.kind, a.status, a.mime, a.original_filename, a.size_bytes, a.error_code, a.created_at, a.created_by`;

export const toDto = (r: Row): AttachmentDto => ({
  id: r.id as string, conversationId: r.conversation_id as string, messageId: (r.message_id as string | null) ?? null,
  direction: r.direction as AttachmentDto["direction"], source: r.source as AttachmentDto["source"], kind: r.kind as AttachmentDto["kind"], status: r.status as AttachmentDto["status"],
  mime: (r.mime as string | null) ?? null, filename: (r.original_filename as string | null) ?? null, sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
  errorCode: (r.error_code as string | null) ?? null, createdAt: iso(r.created_at), createdBy: (r.created_by as string | null) ?? null,
});

/** One live attachment of this workspace (optionally pinned to a conversation). Deleted rows are invisible. RLS applies on top of the explicit workspace filter. */
export async function loadAttachment(tx: Tx, workspaceId: string, id: string, conversationId?: string) {
  const r = rowsOf(await tx.execute(sql`SELECT ${ATT_COLS} FROM attachments a WHERE a.workspace_id = ${workspaceId} AND a.id = ${id} AND a.status <> 'deleted' ${conversationId ? sql`AND a.conversation_id = ${conversationId}` : sql``}`))[0];
  return r ? toDto(r) : null;
}

/** Reads the stored bytes through the store. `missing` when the row is not ready or the blob is gone. The key is derived from ids, never from the row's text. */
export async function readAttachmentFile(store: BlobStore, workspaceId: string, a: Pick<AttachmentDto, "id" | "status" | "mime">): Promise<{ mime: string; bytes: Uint8Array } | "missing"> {
  if (a.status !== "ready" || !a.mime) return "missing";
  const got = await store.get(attachmentKey(workspaceId, a.id));
  return got ? { mime: a.mime, bytes: got.bytes } : "missing";
}

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/webm": "webm",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "text/plain": "txt", "text/csv": "csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};
export const extOf = (mime: string | null): string | null => (mime && EXT[mime]) || null;

/** Types a browser may render inline. Everything else (pdf, office files, text, csv) is a download: Chrome's PDF viewer may refuse a response under `sandbox` CSP and that was not verified, so PDFs are downloaded. SVG and HTML are never accepted as attachments at all. */
export const INLINE = (mime: string) => /^(image\/(png|jpeg|gif|webp)|audio\/(mpeg|wav|mp4|ogg|webm)|video\/(mp4|quicktime|webm))$/.test(mime);

/** Content-Disposition with a safe name: ASCII fallback plus RFC 5987 form, no quotes, backslashes, control characters or path parts. */
export function disposition(inline: boolean, filename: string | null, id: string, mime: string | null): string {
  const base = (filename ?? `attachment-${id.slice(0, 8)}${extOf(mime) ? `.${extOf(mime)}` : ""}`).replace(/[\r\n"\\/]/g, "_");
  const ascii = base.replace(/[^\x20-\x7e]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
