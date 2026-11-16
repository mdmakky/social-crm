import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { checkAttachment, ATTACHMENT_LIMITS, type AttachmentKind } from "@crm/ai";
import { attachmentKey, type BlobStore } from "@crm/core";
import { withContext, type Db, type Tx } from "@crm/db";
import { GraphError, type MetaAttachment, type MetaGraph } from "@crm/integrations";
import { fetchPublicBytes, KnowledgeError, type SafeFetchDeps } from "@crm/knowledge";
import { loadToken, type MetaConnectDeps } from "./meta-connect.ts";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;

/** Channel attachment type -> our kind. Anything else (location, fallback, share, template, unsupported) has no downloadable file and stays in messages.attachments only. */
const KIND: Record<string, AttachmentKind> = { image: "image", sticker: "image", audio: "audio", video: "video", file: "document", document: "document" };

/** Display name only (never a path part): no separators, control characters or leading dots, at most 200 characters. */
export function sanitizeFilename(v: string | undefined | null): string | null {
  if (!v) return null;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const s = v.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "_").replace(/^\.+/, "").trim().slice(0, 200);
  return s === "" ? null : s;
}

/**
 * Inbound media metadata, written in the webhook transaction right after the message row. Only metadata: no network here. WhatsApp keeps the media id (the file is fetched later with the account token);
 * Messenger / Instagram keep the CDN url (a short-lived link; never readable by the application role). Idempotent per (message, provider media id); Messenger / Instagram use the position as id.
 * messages.attachments stays as it was; the attachments table links to the message by id.
 */
export async function recordInboundAttachments(tx: Tx, a: { workspaceId: string; conversationId: string; messageId: string; attachments: MetaAttachment[] }): Promise<void> {
  for (const [i, att] of a.attachments.entries()) {
    const kind = KIND[att.type];
    if (!kind || (!att.mediaId && !att.url)) continue;
    await tx.execute(sql`
      INSERT INTO attachments (workspace_id, conversation_id, message_id, direction, source, kind, status, declared_mime, original_filename, provider_media_id, provider_url)
      VALUES (${a.workspaceId}, ${a.conversationId}, ${a.messageId}, 'inbound', 'channel_download', ${kind}, 'pending', ${att.mime ?? null}, ${sanitizeFilename(att.name)}, ${att.mediaId ?? `idx:${i}`}, ${att.url})
      ON CONFLICT (workspace_id, message_id, provider_media_id) WHERE provider_media_id IS NOT NULL DO NOTHING`);
  }
}

/**
 * MOCK ONLY (META_MOCK=1): a network that answers every channel download with a valid 1x1 PNG, and a 404 for a media id ending in FAILME. Lets the mock inbox show a real preview offline.
 * It never touches a network, and it is labelled mock: it proves our pipeline, nothing about Meta's CDN.
 */
export const MOCK_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
export const mockMediaNet = (): SafeFetchDeps => ({
  resolve: async () => ["93.184.216.34"],
  fetch: async (url) => (url.pathname.endsWith("FAILME") ? new Response(null, { status: 404 }) : new Response(MOCK_PNG, { headers: { "content-type": "image/png" } })),
});

/** Hosts a channel download may come from (suffix match). UNVERIFIED: Meta documents no fixed list; a wrong guess fails closed (`url_blocked`). Override with ATTACHMENT_ALLOWED_HOSTS. */
export const DEFAULT_MEDIA_HOSTS = ["fbcdn.net", "fbsbx.com", "cdninstagram.com", "whatsapp.net", "facebook.com", "instagram.com"];
export const hostAllowed = (suffixes: string[]) => (host: string) => suffixes.some((s) => host === s || host.endsWith(`.${s}`));

export type AttachmentWorkerDeps = {
  workerDb: Db;
  /** Without a store nothing is downloaded and rows stay `pending`. */
  store: BlobStore | undefined;
  graph: MetaGraph;
  meta: Pick<MetaConnectDeps, "box" | "workerDb">;
  /** Injected in tests so no download touches the network. */
  net?: SafeFetchDeps;
  limits?: Partial<Record<AttachmentKind, number>>;
  allowedHosts?: string[];
  maxAttempts?: number;
  /** Seconds to wait before attempt n+1 (n starts at 1). */
  backoffSec?: (attempt: number) => number;
};
export type DownloadOutcome = { ready: number; failed: number; retry: number; skipped: number };

const defaultBackoff = (n: number) => Math.min(3600, 30 * 4 ** (n - 1));
const failureOf = (e: unknown): { code: string; retry: boolean } => {
  if (e instanceof GraphError) {
    if (e.status === 404) return { code: "media_expired", retry: false };
    if (e.kind === "auth") return { code: "provider_auth", retry: false };
    if (e.kind === "permission") return { code: "provider_denied", retry: false };
    return { code: "download_failed", retry: true }; // throttling, 5xx, network
  }
  if (e instanceof KnowledgeError) {
    if (e.code === "url_blocked" || e.code === "url_invalid") return { code: "url_blocked", retry: false };
    if (e.code === "too_large") return { code: "too_large", retry: false };
    if (e.code === "too_many_redirects") return { code: "download_failed", retry: false };
    if (e.code === "fetch_status") {
      const s = Number(/status (\d{3})/.exec(e.message)?.[1]);
      if (s === 404 || s === 410) return { code: "media_expired", retry: false };
      if (s === 429 || s >= 500) return { code: "download_failed", retry: true };
      return { code: "provider_denied", retry: false };
    }
    return { code: "download_failed", retry: true }; // fetch_failed, fetch_timeout
  }
  return { code: "download_failed", retry: true };
};
const VALIDATION: Record<string, string> = { media_too_large: "too_large", unsupported_media: "unsupported_media", empty_media: "empty_media", executable_content: "executable_content", mime_mismatch: "unsupported_media" };

/**
 * Downloads one pending inbound attachment. Three phases so that no network call ever runs inside a database transaction:
 *  1. claim (worker role): attempts + 1 and a 5 minute lease on next_attempt_at, so two workers never fetch the same row; read the account and the sealed token.
 *  2. fetch (no transaction): WhatsApp = Graph media lookup, then the returned url with the Bearer token; Messenger / Instagram = the CDN url. SSRF-safe, host allowlist, byte cap by kind, magic-byte validation, blob write.
 *  3. record (worker role): ready, failed (a clear error_code) or, for a transient problem, pending again with backoff until maxAttempts.
 * Never logs the url, the token, the filename or any bytes.
 */
async function downloadOne(d: AttachmentWorkerDeps, workspaceId: string, id: string): Promise<keyof DownloadOutcome> {
  const store = d.store!;
  const max = d.maxAttempts ?? 5;
  const claim = await withContext(d.workerDb, { workspaceId }, async (tx) => {
    const r = rowsOf(
      await tx.execute(sql`
        UPDATE attachments SET attempts = attempts + 1, next_attempt_at = now() + interval '5 minutes', updated_at = now()
        WHERE workspace_id = ${workspaceId} AND id = ${id} AND status = 'pending' AND source = 'channel_download' AND coalesce(next_attempt_at, now()) <= now()
        RETURNING kind, declared_mime, provider_media_id, provider_url, attempts, message_id`),
    )[0];
    if (!r) return null;
    const acc = rowsOf(
      await tx.execute(sql`SELECT m.integration_account_id AS account_id, a.platform FROM messages m JOIN integration_accounts a ON a.workspace_id = m.workspace_id AND a.id = m.integration_account_id WHERE m.workspace_id = ${workspaceId} AND m.id = ${r.message_id as string}`),
    )[0];
    const token = acc && acc.platform === "whatsapp" ? await loadToken(tx, d.meta as MetaConnectDeps, workspaceId, acc.account_id as string) : null;
    return { kind: r.kind as AttachmentKind, declared: (r.declared_mime as string | null) ?? "", mediaId: r.provider_media_id as string, url: (r.provider_url as string | null) ?? null, attempts: Number(r.attempts), platform: (acc?.platform as string | undefined) ?? null, token };
  });
  if (!claim) return "skipped";

  const settle = (fn: (tx: Tx) => Promise<unknown>) => withContext(d.workerDb, { workspaceId }, fn);
  const fail = async (code: string, retry: boolean): Promise<keyof DownloadOutcome> => {
    const again = retry && claim.attempts < max;
    await settle((tx) =>
      again
        ? tx.execute(sql`UPDATE attachments SET error_code = ${code}, next_attempt_at = now() + make_interval(secs => ${(d.backoffSec ?? defaultBackoff)(claim.attempts)}), updated_at = now() WHERE workspace_id = ${workspaceId} AND id = ${id} AND status = 'pending'`)
        : tx.execute(sql`UPDATE attachments SET status = 'failed', error_code = ${retry ? "download_failed" : code}, next_attempt_at = NULL, updated_at = now() WHERE workspace_id = ${workspaceId} AND id = ${id} AND status = 'pending'`),
    );
    return again ? "retry" : "failed";
  };

  let bytes: Uint8Array;
  let declared = claim.declared;
  try {
    const cap = { ...ATTACHMENT_LIMITS, ...d.limits }[claim.kind];
    const allowHost = hostAllowed(d.allowedHosts ?? DEFAULT_MEDIA_HOSTS);
    if (claim.platform === "whatsapp") {
      if (!claim.token) return await fail("token_unavailable", false);
      const info = await d.graph.getWhatsAppMedia(claim.mediaId, claim.token);
      declared = info.mime ?? declared;
      if (info.size !== null && info.size > cap) return await fail("too_large", false);
      bytes = (await fetchPublicBytes(info.url, { maxBytes: cap, headers: { authorization: `Bearer ${claim.token}` }, allowHost }, d.net)).bytes;
    } else {
      if (!claim.url) return await fail("url_missing", false);
      bytes = (await fetchPublicBytes(claim.url, { maxBytes: cap, allowHost }, d.net)).bytes;
    }
  } catch (e) {
    const f = failureOf(e);
    return fail(f.code, f.retry);
  }
  const check = checkAttachment(declared, bytes, { limits: d.limits });
  if (!check.ok) return fail(VALIDATION[check.code] ?? "unsupported_media", false);

  const key = attachmentKey(workspaceId, id);
  try {
    await store.put(key, bytes, { contentType: check.mime });
  } catch {
    return fail("storage_error", true);
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  const done = await settle(async (tx) =>
    rowsOf(await tx.execute(sql`
      UPDATE attachments SET status = 'ready', kind = ${check.kind}, mime = ${check.mime}, size_bytes = ${bytes.byteLength}, sha256 = ${sha}, storage_key = ${key}, error_code = NULL, next_attempt_at = NULL, updated_at = now()
      WHERE workspace_id = ${workspaceId} AND id = ${id} AND status = 'pending' RETURNING id`)).length,
  );
  if (done === 0) { await store.delete(key).catch(() => undefined); return "skipped"; } // deleted while it was being fetched: leave no blob behind
  return "ready";
}

/** Downloads up to `limit` due attachments (oldest first). Safe to run from several workers: the claim is exclusive. Returns zeros when no store is configured. */
export async function processAttachmentDownloads(d: AttachmentWorkerDeps, limit = 20): Promise<DownloadOutcome> {
  const out: DownloadOutcome = { ready: 0, failed: 0, retry: 0, skipped: 0 };
  if (!d.store) return out;
  const due = rowsOf(await d.workerDb.execute(sql`SELECT workspace_id, id FROM attachments_due(${limit})`));
  for (const r of due) {
    try { out[await downloadOne(d, r.workspace_id as string, r.id as string)] += 1; } catch { out.skipped += 1; } // a database error leaves the lease in place: the row is retried after it expires
  }
  return out;
}

/** Single-flight runner: a request for a run while one is going sets `again`. Used by the inbox worker's enrich hook and by the retry route. */
export function createAttachmentRunner(d: AttachmentWorkerDeps, onError?: (e: unknown) => void) {
  let running: Promise<void> | null = null;
  let again = false;
  const run = (): Promise<void> => {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        for (;;) {
          again = false;
          const r = await processAttachmentDownloads(d);
          if (r.ready + r.failed + r.retry === 0 && !again) break; // drained (rows waiting for a retry time are not due)
        }
      } catch (e) {
        onError?.(e);
      } finally {
        running = null;
      }
    })();
    return running;
  };
  return { run };
}

/**
 * Consistency check for one workspace: a `ready` row whose blob is gone becomes `missing`. With a store that can list keys (the local one), also returns blob keys that have no live row (never deleted here: a person decides).
 */
export async function reconcileAttachments(workerDb: Db, store: BlobStore, workspaceId: string): Promise<{ markedMissing: number; orphanKeys: string[] }> {
  const ready = await withContext(workerDb, { workspaceId }, async (tx) => rowsOf(await tx.execute(sql`SELECT id, storage_key FROM attachments WHERE workspace_id = ${workspaceId} AND status = 'ready' LIMIT 1000`)));
  const gone: string[] = [];
  for (const r of ready) if (!(await store.head(r.storage_key as string))) gone.push(r.id as string);
  if (gone.length) await withContext(workerDb, { workspaceId }, (tx) => tx.execute(sql`UPDATE attachments SET status = 'missing', error_code = 'blob_missing', updated_at = now() WHERE workspace_id = ${workspaceId} AND status = 'ready' AND id IN (${sql.join(gone.map((g) => sql`${g}::uuid`), sql`, `)})`));
  let orphanKeys: string[] = [];
  if (store.list) {
    const live = new Set((await withContext(workerDb, { workspaceId }, async (tx) => rowsOf(await tx.execute(sql`SELECT storage_key FROM attachments WHERE workspace_id = ${workspaceId} AND status IN ('ready','missing','pending')`)))).map((r) => r.storage_key as string));
    orphanKeys = (await store.list(`workspaces/${workspaceId}/attachments`)).filter((k) => !live.has(k));
  }
  return { markedMissing: gone.length, orphanKeys };
}

/** Deletes the blobs of attachments whose rows were just soft-deleted. Idempotent; a failure is swallowed (the row is already deleted, reconcile reports the orphan). */
export async function deleteAttachmentBlobs(store: BlobStore | undefined, workspaceId: string, ids: string[]): Promise<void> {
  if (!store) return;
  for (const id of ids) await store.delete(attachmentKey(workspaceId, id)).catch(() => undefined);
}
