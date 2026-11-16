import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { AddAttachmentToKnowledgeBody, CreateKnowledgeFileBody, CreateKnowledgeTextBody, CreateKnowledgeUrlBody, KnowledgeSearchQuery, type KnowledgeSourceDto, type KnowledgeSourceList } from "@crm/contracts";
import { attachmentKey, type BlobStore } from "@crm/core";
import { can } from "@crm/core/permissions";
import { schema, user, withContext, type Db, type Tx } from "@crm/db";
import { extractFile, fetchPublicPage, htmlToText, KB_LIMITS, KnowledgeError, prepareSource, type Chunk, type SafeFetchDeps } from "@crm/knowledge";
import { writeAudit } from "../audit.ts";
import { actor, body, fail, forbidden, isUuid, query, wctx, type ErrStatus, type SC, type ScopedEnv } from "../routes/scope.ts";
import { WindowCounter } from "../throttle.ts";
import type { MediaService } from "../ai/media.ts";
import { extOf, loadAttachment } from "../attachments/service.ts";
import { isMediaFile, mediaExtractors } from "./media-extractors.ts";
import { searchKnowledge } from "./search.ts";

export type KnowledgeDeps = {
  /** Injected in tests so URL ingestion never touches the network. */
  net?: SafeFetchDeps;
  /** AI media service: when present, PDF, image (OCR) and audio files are accepted and processed through it. Absent => those types stay `unsupported_type`. */
  media?: MediaService;
  /** Blob store of the Inbox attachments. `from-attachment` reads a file through it (no copy is made); absent => `storage_not_configured`. */
  blobs?: BlobStore;
  limits?: { ingestPerUser?: number; urlPerUser?: number; searchPerUser?: number; windowMs?: number };
};

// Base64 of a 2 MB file is 2.8 MB; JSON escaping of a text body can add up to 6x in the worst case, so the cap is on the stream, before any parsing.
// Media files (audio up to 20 MB) are 27 MB as base64; the 2 MB rule for text formats is enforced after decoding.
const FILE_BODY_MAX = 28 * 1024 * 1024;
const TEXT_BODY_MAX = 6 * 1024 * 1024;
const URL_BODY_MAX = 16 * 1024;
const INSERT_BATCH = 200;

const STATUS_OF: Partial<Record<string, ErrStatus>> = { too_large: 413, capability_not_configured: 409, budget_exceeded: 409, rate_limited: 429, ai_unavailable: 502 };
const toDto = (r: Omit<typeof schema.knowledgeSources.$inferSelect, "body">, createdByName: string | null): KnowledgeSourceDto => ({
  id: r.id, type: r.type as KnowledgeSourceDto["type"], title: r.title, sourceRef: r.sourceRef, status: r.status as KnowledgeSourceDto["status"], error: r.error,
  charCount: r.charCount, chunkCount: r.chunkCount, createdBy: r.createdBy, createdByName, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
});
/** Everything except `body`, which can be a megabyte per row and is only read when a source is re-indexed. */
const COLS = {
  id: schema.knowledgeSources.id, workspaceId: schema.knowledgeSources.workspaceId, type: schema.knowledgeSources.type, title: schema.knowledgeSources.title, sourceRef: schema.knowledgeSources.sourceRef,
  status: schema.knowledgeSources.status, error: schema.knowledgeSources.error, charCount: schema.knowledgeSources.charCount, chunkCount: schema.knowledgeSources.chunkCount,
  createdBy: schema.knowledgeSources.createdBy, createdAt: schema.knowledgeSources.createdAt, updatedAt: schema.knowledgeSources.updatedAt, deletedAt: schema.knowledgeSources.deletedAt, name: user.name,
};

/** Rolls the transaction back with a ready-made error response. */
class Reject extends Error { constructor(readonly code: string, readonly status: ErrStatus, readonly msg: string) { super(code); } }

/**
 * Knowledge base (AI Studio, slice 1): sources a workspace teaches its assistant, and search over them. Permissions: ai.configure (owner, admin) manages,
 * workspace.view (every member, viewers included) lists and searches. Ingestion runs inside the request: a URL is fetched BEFORE any transaction opens
 * (no network while a database transaction is held), then the source and its chunks are written in one transaction with the audit entry.
 * Document text is never logged and never put in an audit entry or an error. Rate limits are in-process (single API instance, like the other limiters).
 */
export function knowledgeRoutes(db: Db, deps: KnowledgeDeps = {}) {
  const r = new Hono<ScopedEnv>();
  const lim = { ingestPerUser: 30, urlPerUser: 15, searchPerUser: 300, windowMs: 10 * 60_000, ...deps.limits };
  const ingests = new WindowCounter(lim.ingestPerUser, lim.windowMs);
  const urls = new WindowCounter(lim.urlPerUser, lim.windowMs);
  const searches = new WindowCounter(lim.searchPerUser, lim.windowMs);
  const limited = (c: SC) => { c.header("Retry-After", String(Math.ceil(lim.windowMs / 1000))); return fail(c, 429, "rate_limited", "Too many requests in a short time. Try again in a few minutes."); };
  const manage = (c: SC) => can(c.get("role"), "ai.configure", {});
  const kfail = (c: SC, e: KnowledgeError) => fail(c, STATUS_OF[e.code] ?? 422, e.code, e.message);

  /** Writes a source's chunks in one transaction. `existingId` re-indexes in place. Throws Reject when a limit is hit. */
  async function store(tx: Tx, c: SC, a: { existingId?: string; type: "text" | "url" | "file"; title: string; sourceRef: string | null; text: string; keepBody: boolean; chunks: Chunk[]; action: string }) {
    const { workspaceId, userId } = wctx(c);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"kb:" + workspaceId}, 0))`); // serialises limit checks per workspace
    const [usage] = (await tx.execute(sql`SELECT count(*)::int AS n, coalesce(sum(char_count),0)::bigint AS chars FROM knowledge_sources WHERE workspace_id = ${workspaceId}::uuid AND deleted_at IS NULL AND id IS DISTINCT FROM ${a.existingId ?? null}::uuid`)).rows as { n: number; chars: string }[];
    if (!a.existingId && usage!.n >= KB_LIMITS.maxSources) throw new Reject("source_limit", 409, `A workspace can hold ${KB_LIMITS.maxSources} sources. Delete one first.`);
    if (Number(usage!.chars) + a.text.length > KB_LIMITS.maxCharsPerWorkspace) throw new Reject("storage_limit", 409, "This workspace has reached its knowledge storage limit. Delete a source first.");
    let id = a.existingId;
    if (id) {
      await tx.delete(schema.knowledgeChunks).where(and(eq(schema.knowledgeChunks.workspaceId, workspaceId), eq(schema.knowledgeChunks.sourceId, id)));
      await tx.update(schema.knowledgeSources).set({ status: "ready", error: null, body: a.keepBody ? a.text : null, charCount: a.text.length, chunkCount: a.chunks.length, updatedAt: new Date() }).where(and(eq(schema.knowledgeSources.workspaceId, workspaceId), eq(schema.knowledgeSources.id, id)));
    } else {
      const [row] = await tx.insert(schema.knowledgeSources).values({ workspaceId, type: a.type, title: a.title, sourceRef: a.sourceRef, status: "ready", body: a.keepBody ? a.text : null, charCount: a.text.length, chunkCount: a.chunks.length, createdBy: userId }).returning({ id: schema.knowledgeSources.id });
      id = row!.id;
    }
    for (let i = 0; i < a.chunks.length; i += INSERT_BATCH)
      await tx.insert(schema.knowledgeChunks).values(a.chunks.slice(i, i + INSERT_BATCH).map((k) => ({ workspaceId, sourceId: id!, position: k.position, content: k.content, tokenEstimate: k.tokenEstimate })));
    await writeAudit(tx, { ...actor(c), workspaceId, action: a.action, entityType: "knowledge_source", entityId: id, summary: { type: a.type, title: a.title, chars: a.text.length, chunks: a.chunks.length } });
    return id!;
  }

  async function dto(tx: Tx, workspaceId: string, id: string): Promise<KnowledgeSourceDto | null> {
    const [row] = await tx.select(COLS).from(schema.knowledgeSources).leftJoin(user, eq(user.id, schema.knowledgeSources.createdBy)).where(and(eq(schema.knowledgeSources.workspaceId, workspaceId), eq(schema.knowledgeSources.id, id), isNull(schema.knowledgeSources.deletedAt)));
    return row ? toDto(row, row.name) : null;
  }

  /** Runs `fn` in a transaction; a Reject becomes its error response. */
  const guarded = async (c: SC, fn: (tx: Tx) => Promise<Response>) => {
    try { return await withContext(db, wctx(c), fn); } catch (e) {
      if (e instanceof Reject) return fail(c, e.status, e.code, e.msg);
      throw e;
    }
  };
  const created = async (c: SC, a: Omit<Parameters<typeof store>[2], "action">) =>
    guarded(c, async (tx) => { const id = await store(tx, c, { ...a, action: "knowledge.source.created" }); return c.json((await dto(tx, wctx(c).workspaceId, id))!, 201); });

  /** A source row for an upload that could not be processed: status failed, the failure code, no text and no passages. */
  async function recordFailed(c: SC, title: string, sourceRef: string, error: string) {
    const { workspaceId, userId } = wctx(c);
    await withContext(db, wctx(c), async (tx) => {
      const [row] = await tx.insert(schema.knowledgeSources).values({ workspaceId, type: "file", title, sourceRef, status: "failed", error, createdBy: userId }).returning({ id: schema.knowledgeSources.id });
      await writeAudit(tx, { ...actor(c), workspaceId, action: "knowledge.source.failed", entityType: "knowledge_source", entityId: row!.id, summary: { type: "file", title, error } });
    });
  }

  r.get("/knowledge/sources", async (c) => {
    if (!can(c.get("role"), "workspace.view", {})) return forbidden(c);
    const { workspaceId } = wctx(c);
    const out = await withContext(db, wctx(c), async (tx) => {
      const rows = await tx.select(COLS).from(schema.knowledgeSources).leftJoin(user, eq(user.id, schema.knowledgeSources.createdBy)).where(and(eq(schema.knowledgeSources.workspaceId, workspaceId), isNull(schema.knowledgeSources.deletedAt))).orderBy(desc(schema.knowledgeSources.id));
      const items = rows.map((x) => toDto(x, x.name));
      return { items, usage: { sources: items.length, maxSources: KB_LIMITS.maxSources, chars: items.reduce((n, s) => n + s.charCount, 0), maxChars: KB_LIMITS.maxCharsPerWorkspace } } satisfies KnowledgeSourceList;
    });
    return c.json(out);
  });

  r.get("/knowledge/sources/:sourceId", async (c) => {
    if (!can(c.get("role"), "workspace.view", {})) return forbidden(c);
    const id = c.req.param("sourceId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const out = await withContext(db, wctx(c), (tx) => dto(tx, wctx(c).workspaceId, id));
    return out ? c.json(out) : fail(c, 404, "not_found");
  });

  r.post("/knowledge/sources/text", bodyLimit({ maxSize: TEXT_BODY_MAX, onError: (c) => fail(c as SC, 413, "too_large", "The request is too large.") }), async (c) => {
    if (!manage(c)) return forbidden(c);
    if (!ingests.allow(`${wctx(c).workspaceId}:${wctx(c).userId}`)) return limited(c);
    const b = await body(c, CreateKnowledgeTextBody);
    if (!b.ok) return b.res;
    try {
      const { text, chunks } = prepareSource(b.data.text);
      return await created(c, { type: "text", title: b.data.title, sourceRef: null, text, keepBody: true, chunks });
    } catch (e) { if (e instanceof KnowledgeError) return kfail(c, e); throw e; }
  });

  r.post("/knowledge/sources/file", bodyLimit({ maxSize: FILE_BODY_MAX, onError: (c) => fail(c as SC, 413, "too_large", "The file is too large.") }), async (c) => {
    if (!manage(c)) return forbidden(c);
    if (!ingests.allow(`${wctx(c).workspaceId}:${wctx(c).userId}`)) return limited(c);
    const b = await body(c, CreateKnowledgeFileBody);
    if (!b.ok) return b.res;
    try {
      const bytes = b.data.contentBase64 !== undefined ? Buffer.from(b.data.contentBase64, "base64") : Buffer.from(b.data.content ?? "", "utf8");
      const viaMedia = !!deps.media && isMediaFile(b.data.filename);
      // The provider call happens here, before any transaction opens. A media failure still leaves a visible failed source (code only) so the person can see what went wrong.
      try {
        const ex = await extractFile({ filename: b.data.filename, bytes }, viaMedia ? mediaExtractors(deps.media!, wctx(c)) : undefined);
        const { text, chunks } = prepareSource(ex.text);
        return await created(c, { type: "file", title: b.data.title ?? b.data.filename, sourceRef: b.data.filename, text, keepBody: true, chunks });
      } catch (e) {
        if (viaMedia && e instanceof KnowledgeError && e.code !== "rate_limited") await recordFailed(c, b.data.title ?? b.data.filename, b.data.filename, e.code);
        throw e;
      }
    } catch (e) { if (e instanceof KnowledgeError) return kfail(c, e); throw e; }
  });

  /**
   * Adds an Inbox attachment to the knowledge base. The source REFERENCES the file (source_ref = "attachment:<id>"): the bytes are read through the store for extraction only and are not copied;
   * what is kept is the extracted text and its passages, like any file source. Deleting the attachment removes the source (database trigger). Text, csv and pdf, image (OCR) and audio (transcription,
   * through the AI media service) are supported; office documents and video answer `unsupported_type` (no extractor yet).
   */
  r.post("/knowledge/sources/from-attachment", bodyLimit({ maxSize: URL_BODY_MAX, onError: (c) => fail(c as SC, 413, "too_large", "The request is too large.") }), async (c) => {
    if (!manage(c)) return forbidden(c);
    if (!ingests.allow(`${wctx(c).workspaceId}:${wctx(c).userId}`)) return limited(c);
    const b = await body(c, AddAttachmentToKnowledgeBody);
    if (!b.ok) return b.res;
    if (!deps.blobs) return fail(c, 503, "storage_not_configured", "File storage is not set up on this server.");
    const { workspaceId } = wctx(c);
    const found = await withContext(db, wctx(c), async (tx) => {
      const a = await loadAttachment(tx, workspaceId, b.data.attachmentId);
      const dup = a ? (await tx.execute(sql`SELECT 1 FROM knowledge_sources WHERE workspace_id = ${workspaceId} AND source_ref = ${`attachment:${a.id}`} AND deleted_at IS NULL AND status <> 'failed'`)).rows.length > 0 : false;
      return { a, dup };
    });
    if (!found.a) return fail(c, 404, "not_found");
    if (found.dup) return fail(c, 409, "already_in_knowledge", "This file is already in the knowledge base.");
    const att = found.a;
    if (att.status !== "ready" || !att.mime) return fail(c, 409, "attachment_not_ready", "The file is not available yet.");
    const blob = await deps.blobs.get(attachmentKey(workspaceId, att.id));
    if (!blob) return fail(c, 409, "file_missing", "The stored file could not be found.");
    const ref = `attachment:${att.id}`;
    const title = b.data.title ?? att.filename ?? "Attachment";
    try {
      const ext = extOf(att.mime);
      if (!ext) throw new KnowledgeError("unsupported_type", "This type of file cannot be added to the knowledge base yet. Use an image, PDF, audio, text or csv file.");
      const viaMedia = !!deps.media && isMediaFile(`x.${ext}`);
      try {
        const ex = await extractFile({ filename: `attachment.${ext}`, bytes: blob.bytes }, viaMedia ? mediaExtractors(deps.media!, wctx(c)) : undefined);
        const { text, chunks } = prepareSource(ex.text);
        return await created(c, { type: "file", title, sourceRef: ref, text, keepBody: true, chunks });
      } catch (e) {
        if (viaMedia && e instanceof KnowledgeError && e.code !== "rate_limited") await recordFailed(c, title, ref, e.code);
        throw e;
      }
    } catch (e) { if (e instanceof KnowledgeError) return kfail(c, e); throw e; }
  });

  /** Fetches (no transaction open) and turns a page into source text. */
  const fromUrl = async (rawUrl: string) => {
    const page = await fetchPublicPage(rawUrl, deps.net);
    const html = page.contentType === "text/html" ? htmlToText(page.text) : { title: null, text: page.text };
    return { ...prepareSource(html.text), title: html.title, finalUrl: page.finalUrl };
  };

  r.post("/knowledge/sources/url", bodyLimit({ maxSize: URL_BODY_MAX, onError: (c) => fail(c as SC, 413, "too_large", "The request is too large.") }), async (c) => {
    if (!manage(c)) return forbidden(c);
    if (!urls.allow(`${wctx(c).workspaceId}:${wctx(c).userId}`)) return limited(c);
    const b = await body(c, CreateKnowledgeUrlBody);
    if (!b.ok) return b.res;
    try {
      const got = await fromUrl(b.data.url);
      const host = new URL(got.finalUrl).hostname;
      return await created(c, { type: "url", title: (b.data.title ?? got.title ?? host).slice(0, 200), sourceRef: got.finalUrl.slice(0, 2048), text: got.text, keepBody: false, chunks: got.chunks });
    } catch (e) { if (e instanceof KnowledgeError) return kfail(c, e); throw e; }
  });

  r.post("/knowledge/sources/:sourceId/reindex", async (c) => {
    if (!manage(c)) return forbidden(c);
    const id = c.req.param("sourceId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const key = `${wctx(c).workspaceId}:${wctx(c).userId}`;
    if (!ingests.allow(key)) return limited(c);
    const { workspaceId } = wctx(c);
    const src = await withContext(db, wctx(c), async (tx) => (await tx.select({ type: schema.knowledgeSources.type, title: schema.knowledgeSources.title, sourceRef: schema.knowledgeSources.sourceRef, body: schema.knowledgeSources.body }).from(schema.knowledgeSources).where(and(eq(schema.knowledgeSources.workspaceId, workspaceId), eq(schema.knowledgeSources.id, id), isNull(schema.knowledgeSources.deletedAt))))[0]);
    if (!src) return fail(c, 404, "not_found");
    let prepared: { text: string; chunks: Chunk[] };
    try {
      if (src.type === "url") {
        if (!urls.allow(key)) return limited(c);
        prepared = await fromUrl(src.sourceRef!); // network first, no transaction open
      } else prepared = prepareSource(src.body ?? "");
    } catch (e) {
      if (!(e instanceof KnowledgeError)) throw e;
      // Keep the chunks of the last good index searchable; record why the refresh failed (a code, never content).
      await withContext(db, wctx(c), async (tx) => {
        await tx.update(schema.knowledgeSources).set({ status: "failed", error: e.code, updatedAt: new Date() }).where(and(eq(schema.knowledgeSources.workspaceId, workspaceId), eq(schema.knowledgeSources.id, id), isNull(schema.knowledgeSources.deletedAt)));
        await writeAudit(tx, { ...actor(c), workspaceId, action: "knowledge.source.reindex_failed", entityType: "knowledge_source", entityId: id, summary: { error: e.code } });
      });
      return kfail(c, e);
    }
    return guarded(c, async (tx) => {
      const [live] = await tx.select({ id: schema.knowledgeSources.id }).from(schema.knowledgeSources).where(and(eq(schema.knowledgeSources.workspaceId, workspaceId), eq(schema.knowledgeSources.id, id), isNull(schema.knowledgeSources.deletedAt))).for("update");
      if (!live) return fail(c, 404, "not_found"); // deleted while the page was being fetched
      await store(tx, c, { existingId: id, type: src.type as "text" | "url" | "file", title: src.title, sourceRef: src.sourceRef, text: prepared.text, keepBody: src.type !== "url", chunks: prepared.chunks, action: "knowledge.source.reindexed" });
      return c.json((await dto(tx, workspaceId, id))!);
    });
  });

  r.delete("/knowledge/sources/:sourceId", async (c) => {
    if (!manage(c)) return forbidden(c);
    const id = c.req.param("sourceId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const [row] = await tx.update(schema.knowledgeSources).set({ deletedAt: new Date(), body: null, updatedAt: new Date() }).where(and(eq(schema.knowledgeSources.workspaceId, workspaceId), eq(schema.knowledgeSources.id, id), isNull(schema.knowledgeSources.deletedAt))).returning({ title: schema.knowledgeSources.title, type: schema.knowledgeSources.type });
      if (!row) return fail(c, 404, "not_found");
      await tx.delete(schema.knowledgeChunks).where(and(eq(schema.knowledgeChunks.workspaceId, workspaceId), eq(schema.knowledgeChunks.sourceId, id)));
      await writeAudit(tx, { ...actor(c), workspaceId, action: "knowledge.source.deleted", entityType: "knowledge_source", entityId: id, summary: { type: row.type, title: row.title } });
      return c.body(null, 204);
    });
  });

  r.get("/knowledge/search", async (c) => {
    if (!can(c.get("role"), "workspace.view", {})) return forbidden(c);
    if (!searches.allow(`${wctx(c).workspaceId}:${wctx(c).userId}`)) return limited(c);
    const q = query(c, KnowledgeSearchQuery);
    if (!q.ok) return q.res;
    const items = await searchKnowledge(db, wctx(c), q.data.q, { limit: q.data.limit });
    return c.json({ items });
  });

  return r;
}
