import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { sql } from "drizzle-orm";
import type { z } from "zod";
import { ATTACHMENT_LIMITS, checkAttachment, type AttachmentErrorCode, type AttachmentKind } from "@crm/ai";
import { AttachmentAskBody, AttachmentTranscribeBody, UploadAttachmentBody, type MediaResult } from "@crm/contracts";
import { attachmentKey, type BlobStore } from "@crm/core";
import { can } from "@crm/core/permissions";
import { withContext, type Db } from "@crm/db";
import { writeAudit } from "../audit.ts";
import { MEDIA_FAILURES, type MediaOutcome, type MediaService } from "../ai/media.ts";
import { deleteAttachmentBlobs } from "../inbox/attachments.ts";
import { pgCode } from "../routes/pipelines.ts";
import { WindowCounter } from "../throttle.ts";
import { actor, body, fail, forbidden, isUuid, wctx, type ErrStatus, type SC, type ScopedEnv } from "../routes/scope.ts";
import { ATT_COLS, disposition, INLINE, loadAttachment, readAttachmentFile, rowsOf, toDto } from "./service.ts";

export type AttachmentRouteDeps = {
  /** Absent = no storage configured: metadata is shown, uploads answer `storage_not_configured`, nothing crashes. */
  store?: BlobStore;
  media?: MediaService;
  limits?: Partial<Record<AttachmentKind, number>>;
  uploadsPerUser?: number;
  windowMs?: number;
  /** Called after a person re-queues a failed download: wakes the download worker. Assigned by server.ts once the worker exists. */
  kick?: () => void;
};

export const effectiveLimits = (o?: Partial<Record<AttachmentKind, number>>): Record<AttachmentKind, number> => ({ ...ATTACHMENT_LIMITS, ...o });

const UPLOAD_FAILURES: Record<AttachmentErrorCode, { status: ErrStatus; message: string }> = {
  empty_media: { status: 422, message: "The file is empty." },
  unsupported_media: { status: 422, message: "This file type is not supported. Images: png, jpeg, webp, gif. Audio: mp3, wav, m4a, ogg, webm. Video: mp4, mov, webm. Documents: pdf, docx, xlsx, pptx, txt, csv." },
  mime_mismatch: { status: 422, message: "The file does not match its declared type." },
  media_too_large: { status: 413, message: "The file is too large for its type." },
  executable_content: { status: 422, message: "Executable files and scripts cannot be attached." },
};
const NOT_CONFIGURED = "File storage is not set up on this server, so attachments cannot be kept. An administrator needs to configure it (see docs/deploy/free-tier.md).";

/**
 * Inbox attachments API. Everything is workspace scoped twice: an explicit `workspace_id = $ws` on every query and forced RLS under the caller's role. A file is only ever read through the store with a key derived from
 * (workspace id, attachment id) of a row the caller has just been shown, so a guessed key or id from another workspace finds nothing. Permissions: conversation.view reads (viewers included), conversation.reply uploads
 * and re-queues, ai.use runs AI on a file, delete needs owner/admin or the uploading agent (enforced by a database trigger, not only here). The bytes never go into PostgreSQL or any log.
 */
export function attachmentRoutes(db: Db, deps: AttachmentRouteDeps = {}) {
  const r = new Hono<ScopedEnv>();
  const limits = effectiveLimits(deps.limits);
  const uploads = new WindowCounter(deps.uploadsPerUser ?? 60, deps.windowMs ?? 10 * 60_000);
  const view = (c: SC) => can(c.get("role"), "conversation.view", {});
  const reply = (c: SC) => can(c.get("role"), "conversation.reply", {});
  const ids = (c: SC) => ({ conversationId: c.req.param("conversationId"), attachmentId: c.req.param("attachmentId") });

  r.get("/conversations/:conversationId/attachments", async (c) => {
    if (!view(c)) return forbidden(c);
    const { conversationId } = ids(c);
    if (!isUuid(conversationId)) return fail(c, 404, "not_found");
    const ws = c.get("workspaceId");
    return withContext(db, wctx(c), async (tx) => {
      if (!rowsOf(await tx.execute(sql`SELECT 1 FROM conversations WHERE workspace_id = ${ws} AND id = ${conversationId}`)).length) return fail(c, 404, "not_found");
      const rows = rowsOf(await tx.execute(sql`SELECT ${ATT_COLS} FROM attachments a WHERE a.workspace_id = ${ws} AND a.conversation_id = ${conversationId} AND a.status <> 'deleted' ORDER BY a.created_at, a.id LIMIT 500`));
      return c.json({ items: rows.map(toDto), storageConfigured: !!deps.store, limits });
    });
  });

  r.post("/conversations/:conversationId/attachments", bodyLimit({ maxSize: 36 * 1024 * 1024, onError: (c) => fail(c as SC, 413, "media_too_large", "The file is too large.") }), async (c) => {
    if (!reply(c)) return forbidden(c);
    const { conversationId } = ids(c);
    if (!isUuid(conversationId)) return fail(c, 404, "not_found");
    if (!deps.store) return fail(c, 503, "storage_not_configured", NOT_CONFIGURED);
    const { workspaceId: ws, userId } = wctx(c);
    if (!uploads.allow(`${ws}:${userId}`)) { c.header("Retry-After", "60"); return fail(c, 429, "rate_limited", "Too many uploads in a short time. Try again in a minute."); }
    const b = await body(c, UploadAttachmentBody);
    if (!b.ok) return b.res;
    const bytes = new Uint8Array(Buffer.from(b.data.contentBase64, "base64"));
    const chk = checkAttachment(b.data.mime, bytes, { strict: true, limits });
    if (!chk.ok) { const f = UPLOAD_FAILURES[chk.code]; return fail(c, f.status, chk.code, f.message); }
    const known = await withContext(db, wctx(c), async (tx) => rowsOf(await tx.execute(sql`SELECT 1 FROM conversations WHERE workspace_id = ${ws} AND id = ${conversationId}`)).length > 0);
    if (!known) return fail(c, 404, "not_found");
    const id = crypto.randomUUID();
    const key = attachmentKey(ws, id);
    try { await deps.store.put(key, bytes, { contentType: chk.mime }); } catch { return fail(c, 502, "storage_error", "The file could not be saved. Try again."); }
    try {
      const filename = b.data.filename.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "_").replace(/^\.+/, "").trim().slice(0, 200) || null; // eslint-disable-line no-control-regex
      const sha = createHash("sha256").update(bytes).digest("hex");
      const dto = await withContext(db, wctx(c), async (tx) => {
        const row = rowsOf(await tx.execute(sql`
          INSERT INTO attachments (id, workspace_id, conversation_id, direction, source, kind, status, mime, declared_mime, original_filename, size_bytes, sha256, storage_key, created_by)
          VALUES (${id}, ${ws}, ${conversationId}, 'outbound', 'user_upload', ${chk.kind}, 'ready', ${chk.mime}, ${b.data.mime.slice(0, 127)}, ${filename}, ${bytes.byteLength}, ${sha}, ${key}, ${userId})
          RETURNING id, conversation_id, message_id, direction, source, kind, status, mime, original_filename, size_bytes, error_code, created_at, created_by`))[0]!;
        await writeAudit(tx, { ...actor(c), workspaceId: ws, action: "attachment.uploaded", entityType: "attachment", entityId: id, summary: { conversationId, kind: chk.kind, mime: chk.mime, size: bytes.byteLength } });
        return toDto(row);
      });
      return c.json(dto, 201);
    } catch (e) {
      await deps.store.delete(key).catch(() => undefined); // no orphan blob when the row could not be written
      if (pgCode(e) === "42501") return forbidden(c);
      throw e;
    }
  });

  r.get("/conversations/:conversationId/attachments/:attachmentId", async (c) => {
    if (!view(c)) return forbidden(c);
    const { conversationId, attachmentId } = ids(c);
    if (!isUuid(conversationId) || !isUuid(attachmentId)) return fail(c, 404, "not_found");
    const a = await withContext(db, wctx(c), (tx) => loadAttachment(tx, c.get("workspaceId"), attachmentId, conversationId));
    return a ? c.json(a) : fail(c, 404, "not_found");
  });

  r.get("/conversations/:conversationId/attachments/:attachmentId/content", async (c) => {
    if (!view(c)) return forbidden(c);
    const { conversationId, attachmentId } = ids(c);
    if (!isUuid(conversationId) || !isUuid(attachmentId)) return fail(c, 404, "not_found");
    if (!deps.store) return fail(c, 503, "storage_not_configured", NOT_CONFIGURED);
    const ws = c.get("workspaceId");
    // The access check comes first and is the only thing that decides the key: auth, then RLS + explicit workspace and conversation, then the store.
    const a = await withContext(db, wctx(c), (tx) => loadAttachment(tx, ws, attachmentId, conversationId));
    if (!a) return fail(c, 404, "not_found");
    if (a.status !== "ready" || !a.mime) return fail(c, 409, a.status === "missing" ? "file_missing" : "not_ready", a.status === "pending" ? "The file is still being downloaded." : "The file is not available.");
    const blob = await deps.store.getStream(attachmentKey(ws, a.id));
    if (!blob) return fail(c, 409, "file_missing", "The stored file could not be found.");
    return c.body(blob.stream, 200, {
      "content-type": a.mime, // the DETECTED type, never the sender's label
      "content-length": String(a.sizeBytes ?? blob.size),
      "content-disposition": disposition(INLINE(a.mime), a.filename, a.id, a.mime),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    });
  });

  r.delete("/conversations/:conversationId/attachments/:attachmentId", async (c) => {
    if (!reply(c)) return forbidden(c);
    const { conversationId, attachmentId } = ids(c);
    if (!isUuid(conversationId) || !isUuid(attachmentId)) return fail(c, 404, "not_found");
    const ws = c.get("workspaceId");
    try {
      const out = await withContext(db, wctx(c), async (tx) => {
        const upd = rowsOf(await tx.execute(sql`UPDATE attachments SET status = 'deleted', deleted_at = now(), updated_at = now() WHERE workspace_id = ${ws} AND conversation_id = ${conversationId} AND id = ${attachmentId} AND status <> 'deleted' RETURNING kind`));
        if (upd.length) {
          await writeAudit(tx, { ...actor(c), workspaceId: ws, action: "attachment.deleted", entityType: "attachment", entityId: attachmentId, summary: { conversationId, kind: upd[0]!.kind } });
          return "deleted" as const;
        }
        // idempotent: an already deleted row of this conversation answers 204 again; anything else does not exist for this caller
        return rowsOf(await tx.execute(sql`SELECT 1 FROM attachments WHERE workspace_id = ${ws} AND conversation_id = ${conversationId} AND id = ${attachmentId}`)).length ? ("again" as const) : ("none" as const);
      });
      if (out === "none") return fail(c, 404, "not_found");
      await deleteAttachmentBlobs(deps.store, ws, [attachmentId]); // after commit; also on a repeat, so a failed first attempt is completed
      return c.body(null, 204);
    } catch (e) {
      // the guard trigger: only an owner, an admin or the uploader may delete
      if (pgCode(e) === "P0001") return forbidden(c);
      throw e;
    }
  });

  r.post("/conversations/:conversationId/attachments/:attachmentId/retry", async (c) => {
    if (!reply(c)) return forbidden(c);
    const { conversationId, attachmentId } = ids(c);
    if (!isUuid(conversationId) || !isUuid(attachmentId)) return fail(c, 404, "not_found");
    const ws = c.get("workspaceId");
    const out = await withContext(db, wctx(c), async (tx) => {
      const cur = await loadAttachment(tx, ws, attachmentId, conversationId);
      if (!cur) return "none" as const;
      if (cur.direction !== "inbound" || (cur.status !== "failed" && cur.status !== "missing")) return "conflict" as const;
      await tx.execute(sql`UPDATE attachments SET status = 'pending', error_code = NULL, attempts = 0, next_attempt_at = NULL, updated_at = now() WHERE workspace_id = ${ws} AND id = ${attachmentId} AND status IN ('failed','missing') AND direction = 'inbound'`);
      await writeAudit(tx, { ...actor(c), workspaceId: ws, action: "attachment.retry_requested", entityType: "attachment", entityId: attachmentId, summary: { conversationId } });
      return (await loadAttachment(tx, ws, attachmentId, conversationId))!;
    });
    if (out === "none") return fail(c, 404, "not_found");
    if (out === "conflict") return fail(c, 409, "not_retryable", "Only a received file that failed to download can be retried.");
    deps.kick?.();
    return c.json(out);
  });

  // ---- AI on one attachment: only when a person asks. Same service as /ai/media/*, so budget hard stop, run log (no bodies) and capability gating are unchanged. ----
  const respond = (c: SC, out: MediaOutcome) => {
    if (out.ok) return c.json({ text: out.text, provider: out.provider, model: out.model, mock: out.mock, runId: out.runId, usage: out.usage } satisfies MediaResult);
    const f = MEDIA_FAILURES[out.code];
    if (out.code === "rate_limited") c.header("Retry-After", "60");
    return fail(c, f.status, out.code === "not_configured" ? "capability_not_configured" : out.code, f.message);
  };
  const aiRoute = <S extends z.ZodType | null>(path: string, kinds: AttachmentKind[], schema: S, run: (ms: MediaService, who: { workspaceId: string; userId: string }, f: { mime: string; bytes: Uint8Array }, b: Record<string, unknown>) => Promise<MediaOutcome>) =>
    r.post(`/conversations/:conversationId/attachments/:attachmentId/ai/${path}`, async (c) => {
      if (!can(c.get("role"), "ai.use", {})) return forbidden(c);
      const { conversationId, attachmentId } = ids(c);
      if (!isUuid(conversationId) || !isUuid(attachmentId)) return fail(c, 404, "not_found");
      if (!deps.media) return fail(c, 503, "ai_not_configured", "AI is not configured on this server.");
      if (!deps.store) return fail(c, 503, "storage_not_configured", NOT_CONFIGURED);
      const ws = c.get("workspaceId");
      let extra: Record<string, unknown> = {};
      if (schema) {
        const b = await body(c, schema as z.ZodType);
        if (!b.ok) return b.res;
        extra = b.data as Record<string, unknown>;
      }
      const a = await withContext(db, wctx(c), (tx) => loadAttachment(tx, ws, attachmentId, conversationId));
      if (!a) return fail(c, 404, "not_found");
      if (!kinds.includes(a.kind)) return fail(c, 422, "unsupported_kind", `This action does not apply to ${a.kind} files.`);
      const file = await readAttachmentFile(deps.store, ws, a);
      if (file === "missing") return fail(c, 409, a.status === "ready" ? "file_missing" : "not_ready", "The file is not available.");
      return respond(c, await run(deps.media, wctx(c), file, extra)); // the provider call: no database transaction is open here
    });
  aiRoute("describe", ["image"], null, (ms, who, f) => ms.describeImage(who, f));
  aiRoute("ask", ["image"], AttachmentAskBody, (ms, who, f, b) => ms.askAboutImage(who, f, b.question as string));
  aiRoute("extract", ["image", "document"], null, (ms, who, f) => ms.extractDocumentText(who, f));
  aiRoute("transcribe", ["audio"], AttachmentTranscribeBody, (ms, who, f, b) => ms.transcribeAudio(who, f, b.language as string | undefined));

  return r;
}
