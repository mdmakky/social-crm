import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { attachmentKey, FsBlobStore } from "@crm/core";
import { createDb, type Db } from "@crm/db";
import { buildWhatsAppBody, buildWhatsAppChange, createMockGraph, createSecretBox, GraphError, mockSecret, signMetaBody } from "@crm/integrations";
import type { SafeFetchDeps } from "@crm/knowledge";
import { createAttachmentRunner, processAttachmentDownloads, reconcileAttachments, sanitizeFilename, type AttachmentWorkerDeps } from "../src/inbox/attachments.ts";
import type { MetaConnectDeps } from "../src/inbox/meta-connect.ts";
import { processWebhookEvent } from "../src/inbox/process.ts";
import { metaWebhookRoutes } from "../src/inbox/webhook.ts";
import { bootstrap, type Harness, type TestUser } from "./harness.ts";

// Inbound media: webhook -> pending metadata -> download worker. Every network call is a FAKE fetch / resolver; real Meta and real CDN behaviour is UNVERIFIED.
const DB = process.env.CRM_DB_NAME ?? "crm";
const box = createSecretBox({ k1: Buffer.alloc(32, 7).toString("base64") }, "k1");
const TOKEN = "WA-TOKEN-must-never-leak-into-rows";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6]);
const EXE = Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);
let h: Harness, workerDb: Db, ingestDb: Db, hook: Hono, graph: ReturnType<typeof createMockGraph>, store: FsBlobStore, dir: string;
let owner: TestUser;
let ws: string;
const accounts: string[] = [];
const digits = () => `8${Math.floor(Math.random() * 1e13).toString().padStart(13, "0")}`;
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const RUN = Math.random().toString(36).slice(2, 8);
const wamid = () => `wamid.${RUN}.${digits()}`;
const PUBLIC = async () => ["93.184.216.34"];

async function account(platform: "whatsapp" | "messenger") {
  const ext = digits();
  const [a] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,$2,$3,'connected','x') RETURNING id", [ws, platform, ext]);
  accounts.push(a.id);
  const s = box.seal(TOKEN, `${ws}:${a.id}`);
  await q("INSERT INTO integration_secrets (workspace_id, integration_account_id, version, ciphertext, nonce, key_id) VALUES ($1,$2,1,$3,$4,$5)", [ws, a.id, s.ciphertext, s.nonce, s.keyId]);
  return { id: a.id as string, ext };
}
const post = (payload: unknown, path: string) => {
  const raw = Buffer.from(JSON.stringify(payload));
  return hook.request(`/webhooks/meta/${path}`, { method: "POST", body: new Uint8Array(raw), headers: { "content-type": "application/json", "x-hub-signature-256": signMetaBody(raw, mockSecret) } });
};
const drain = async (ref: string) => {
  for (let i = 0; i < 50; i++) {
    const todo = await q("SELECT id FROM webhook_events WHERE account_ref = $1 AND status IN ('received','failed') ORDER BY received_at", [ref]);
    if (!todo.length) return;
    for (const e of todo) await processWebhookEvent(workerDb, e.id);
    if (i > 0) await new Promise((r) => setTimeout(r, 50));
  }
};
const waMedia = async (phone: string, from: string, media: Record<string, unknown>, id = wamid()) => {
  await post(buildWhatsAppBody(digits(), [buildWhatsAppChange({ phoneNumberId: phone, messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), ...media }] })]), "whatsapp");
  return id;
};
const rowsOf = (mid: string) => q("SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.external_id = $1 ORDER BY a.created_at", [mid]);

type Call = { url: string; headers: Record<string, string> };
/** Fake network: answers by url from a table of Responses (or a function), and records calls. */
function net(answer: (url: URL, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const deps: SafeFetchDeps = { resolve: PUBLIC, fetch: async (url, init) => { calls.push({ url: url.toString(), headers: init.headers }); return answer(url, calls.length); } };
  return { deps, calls };
}
const bytesRes = (b: Uint8Array, status = 200, headers: Record<string, string> = {}) => new Response(b as unknown as BodyInit, { status, headers });
const worker = (n: SafeFetchDeps, over: Partial<AttachmentWorkerDeps> = {}): AttachmentWorkerDeps => ({ workerDb, store, graph, meta: { box, workerDb }, net: n, backoffSec: () => 0, ...over });
/** Runs only this test's rows: other test files may have due rows too, so look at ours afterwards. */
const mine = (mid: string) => rowsOf(mid).then((r) => r[0]!);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "att-in-"));
  store = new FsBlobStore(dir);
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  ingestDb = createDb(`postgres://crm_ingest:ingest_dev@127.0.0.1:5436/${DB}`);
  hook = new Hono().route("/webhooks/meta", metaWebhookRoutes({ appSecrets: [mockSecret], verifyToken: "v", ingestDb }));
  graph = createMockGraph({ pages: [] });
  const deps: MetaConnectDeps = {
    graph, box, workerDb, appId: "123456", configId: "654321", graphVersion: "v25.0", redirectUri: "http://localhost:3000/v1/integrations/meta/callback", webOrigin: "http://localhost:3000",
    stateKey: createHmac("sha256", "k").update("s").digest(), userHashKey: createHmac("sha256", "k").update("u").digest(), mock: true, secureCookies: false,
  };
  h = await bootstrap(undefined, deps);
  owner = await h.newUser("attowner");
  ws = await h.workspace(owner, "Att inbound");
});
afterAll(async () => {
  if (accounts.length) await q("UPDATE integration_accounts SET last_token_check_at = now(), status = 'disabled' WHERE id = ANY($1::uuid[])", [accounts]);
  await workerDb.$client.end();
  await ingestDb.$client.end();
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("recording metadata from the webhook", () => {
  it("WhatsApp image + document: one pending row each, caption stays the message text, messages.attachments untouched, no network, filename sanitised", async () => {
    const a = await account("whatsapp");
    const from = digits();
    const before = graph.calls.length;
    const mid = await waMedia(a.ext, from, { type: "image", image: { id: "MEDIA1", mime_type: "image/jpeg", caption: "my receipt" } });
    const mid2 = await waMedia(a.ext, from, { type: "document", document: { id: "MEDIA2", mime_type: "application/pdf", filename: "../../etc/pass\u0000wd.pdf" } });
    await drain(a.ext);
    const [img] = await rowsOf(mid);
    expect(img).toMatchObject({ status: "pending", direction: "inbound", source: "channel_download", kind: "image", provider_media_id: "MEDIA1", declared_mime: "image/jpeg", provider_url: null });
    const [doc] = await rowsOf(mid2);
    expect(doc).toMatchObject({ kind: "document", provider_media_id: "MEDIA2" });
    expect(doc.original_filename).not.toMatch(/[\\/]/);
    expect(doc.original_filename).toBe("_.._etc_passwd.pdf"); // separators replaced, NUL dropped by the parser (it would break the jsonb insert)
    const [m] = await q("SELECT body, attachments FROM messages WHERE external_id = $1", [mid]);
    expect(m.body).toBe("my receipt");
    expect(m.attachments).toEqual([{ type: "image", url: null, mediaId: "MEDIA1", mime: "image/jpeg" }]);
    expect(graph.calls.length).toBe(before); // recording made no Graph call
  });

  it("Messenger image keeps the CDN url as pending; a media-only message still exists; a redelivered event adds no second row", async () => {
    const a = await account("messenger");
    const user = digits();
    const mid = `m.${RUN}.${digits()}`;
    const body = { object: "page", entry: [{ id: a.ext, time: Date.now(), messaging: [{ sender: { id: user }, recipient: { id: a.ext }, timestamp: Date.now(), message: { mid, attachments: [{ type: "image", payload: { url: "https://scontent.xx.fbcdn.net/v/abc.jpg" } }, { type: "location", payload: { coordinates: { lat: 1, long: 2 } } }] } }] }] };
    await post(body, "messenger");
    await post(body, "messenger");
    await drain(a.ext);
    const rows = await rowsOf(mid);
    expect(rows).toHaveLength(1); // the location has no file
    expect(rows[0]).toMatchObject({ status: "pending", kind: "image", provider_media_id: "idx:0", provider_url: "https://scontent.xx.fbcdn.net/v/abc.jpg" });
    expect(await q("SELECT 1 FROM messages WHERE external_id = $1", [mid])).toHaveLength(1);
  });

  it("sanitizeFilename never yields a path", () => {
    expect(sanitizeFilename("a/b\\c.png")).toBe("a_b_c.png");
    expect(sanitizeFilename("..hidden")).toBe("hidden");
    expect(sanitizeFilename("   ")).toBeNull();
    expect(sanitizeFilename("x".repeat(500))).toHaveLength(200);
  });
});

describe("download worker", () => {
  it("WhatsApp: media lookup, then the url with the Bearer token, validated by bytes, stored, ready; idempotent on a second run", async () => {
    const a = await account("whatsapp");
    const mid = await waMedia(a.ext, digits(), { type: "image", image: { id: "OKMEDIA", mime_type: "image/png" } });
    await drain(a.ext);
    const n = net(() => bytesRes(PNG, 200, { "content-type": "image/png" }));
    const out = await processAttachmentDownloads(worker(n.deps));
    expect(out.ready).toBeGreaterThanOrEqual(1);
    const r = await mine(mid);
    expect(r).toMatchObject({ status: "ready", kind: "image", mime: "image/png", size_bytes: String(PNG.length), error_code: null });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.storage_key).toBe(attachmentKey(ws, r.id));
    expect(new Uint8Array((await store.get(r.storage_key))!.bytes)).toEqual(PNG);
    const call = n.calls.find((c) => c.url.includes("OKMEDIA"))!;
    expect(call.url).toBe("https://lookaside.fbsbx.com/mock/OKMEDIA");
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    const again = await processAttachmentDownloads(worker(n.deps));
    expect(again.ready).toBe(0);
    expect((await mine(mid)).updated_at).toEqual(r.updated_at);
  });

  it("Messenger: fetches the CDN url without any token", async () => {
    const a = await account("messenger");
    const mid = `m.${RUN}.${digits()}`;
    await post({ object: "page", entry: [{ id: a.ext, time: Date.now(), messaging: [{ sender: { id: digits() }, recipient: { id: a.ext }, timestamp: Date.now(), message: { mid, attachments: [{ type: "image", payload: { url: "https://scontent.xx.fbcdn.net/v/ok.png" } }] } }] }] }, "messenger");
    await drain(a.ext);
    const n = net(() => bytesRes(PNG));
    await processAttachmentDownloads(worker(n.deps));
    expect((await mine(mid)).status).toBe("ready");
    expect(n.calls.find((c) => c.url.includes("ok.png"))!.headers.authorization).toBeUndefined();
  });

  it("a transient failure retries with backoff, then becomes ready; permanent errors fail with a clear code; attempts are bounded", async () => {
    const a = await account("whatsapp");
    const from = digits();
    const mid = await waMedia(a.ext, from, { type: "image", image: { id: "FLAKY", mime_type: "image/png" } });
    await drain(a.ext);
    let hits = 0;
    const flaky = net(() => (++hits === 1 ? bytesRes(new Uint8Array(), 503) : bytesRes(PNG)));
    await processAttachmentDownloads(worker(flaky.deps, { backoffSec: () => 3600 }));
    let r = await mine(mid);
    expect(r).toMatchObject({ status: "pending", attempts: 1, error_code: "download_failed" });
    expect(new Date(r.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 3_000_000); // waits: not due now
    expect((await processAttachmentDownloads(worker(flaky.deps))).ready).toBe(0);
    expect(hits).toBe(1);
    await q("UPDATE attachments SET next_attempt_at = now() WHERE id = $1", [r.id]);
    await processAttachmentDownloads(worker(flaky.deps));
    r = await mine(mid);
    expect(r).toMatchObject({ status: "ready", attempts: 2, error_code: null });

    const gone = await waMedia(a.ext, from, { type: "image", image: { id: "GONE" } });
    const always500 = await waMedia(a.ext, from, { type: "image", image: { id: "DOWN" } });
    await drain(a.ext);
    graph.state.waMedia = new Map([["GONE", new GraphError(100, 404, "other")]]);
    const nn = net(() => bytesRes(new Uint8Array(), 500));
    for (let i = 0; i < 5; i++) {
      await processAttachmentDownloads(worker(nn.deps, { maxAttempts: 3 }));
      await q("UPDATE attachments SET next_attempt_at = now() WHERE status = 'pending' AND provider_media_id IN ('GONE','DOWN')");
    }
    expect(await mine(gone)).toMatchObject({ status: "failed", error_code: "media_expired" });
    expect(await mine(always500)).toMatchObject({ status: "failed", error_code: "download_failed", attempts: 3 });
    graph.state.waMedia = undefined;
  });

  it("refuses wrong content: executable, unknown bytes, oversize; nothing is stored for them", async () => {
    const a = await account("whatsapp");
    const from = digits();
    const exe = await waMedia(a.ext, from, { type: "image", image: { id: "EXE", mime_type: "image/png" } });
    const junk = await waMedia(a.ext, from, { type: "document", document: { id: "JUNK", mime_type: "application/pdf" } });
    const big = await waMedia(a.ext, from, { type: "image", image: { id: "BIG", mime_type: "image/png" } });
    await drain(a.ext);
    const n = net((url) => (url.pathname.endsWith("EXE") ? bytesRes(EXE) : url.pathname.endsWith("JUNK") ? bytesRes(Uint8Array.from([0, 1, 2, 3, 0])) : bytesRes(new Uint8Array(200).fill(0x41), 200, { "content-length": "200" })));
    await processAttachmentDownloads(worker(n.deps, { limits: { image: 100 } }));
    expect(await mine(exe)).toMatchObject({ status: "failed", error_code: "executable_content", storage_key: null });
    expect(await mine(junk)).toMatchObject({ status: "failed", error_code: "unsupported_media" });
    expect(await mine(big)).toMatchObject({ status: "failed", error_code: "too_large" });
    expect(await store.list!(`workspaces/${ws}/attachments`)).not.toContain(attachmentKey(ws, (await mine(exe)).id));
  });

  it("SSRF: private addresses, a non-allowlisted host and a redirect into the private network are refused; a token never follows a redirect to another origin", async () => {
    const a = await account("messenger");
    const mk = async (url: string) => {
      const mid = `m.${RUN}.${digits()}`;
      await post({ object: "page", entry: [{ id: a.ext, time: Date.now(), messaging: [{ sender: { id: digits() }, recipient: { id: a.ext }, timestamp: Date.now(), message: { mid, attachments: [{ type: "image", payload: { url } }] } }] }] }, "messenger");
      return mid;
    };
    const priv = await mk("https://private.fbcdn.net/a.jpg");
    const off = await mk("https://evil.example/a.jpg");
    const redir = await mk("https://scontent.fbcdn.net/redir.jpg");
    await drain(a.ext);
    const n = net((url) => (url.pathname === "/redir.jpg" ? new Response(null, { status: 302, headers: { location: "https://metadata.fbcdn.net/latest/meta-data" } }) : bytesRes(PNG)));
    n.deps.resolve = async (host) => (host === "private.fbcdn.net" ? ["10.0.0.5"] : host === "metadata.fbcdn.net" ? ["169.254.169.254"] : ["93.184.216.34"]);
    await processAttachmentDownloads(worker(n.deps));
    expect(await mine(priv)).toMatchObject({ status: "failed", error_code: "url_blocked" });
    expect(await mine(off)).toMatchObject({ status: "failed", error_code: "url_blocked" });
    expect(await mine(redir)).toMatchObject({ status: "failed", error_code: "url_blocked" });
    const urls = n.calls.map((c) => c.url);
    expect(urls.some((u) => u.includes("evil.example") || u.includes("private.fbcdn") || u.includes("metadata.fbcdn"))).toBe(false); // none of the refused hosts was ever contacted
    expect(urls).toContain("https://scontent.fbcdn.net/redir.jpg");
  });

  it("WhatsApp: the Authorization header is dropped when the download redirects to another origin", async () => {
    const a = await account("whatsapp");
    const mid = await waMedia(a.ext, digits(), { type: "image", image: { id: "REDIR", mime_type: "image/png" } });
    await drain(a.ext);
    const n = net((url) => (url.host === "lookaside.fbsbx.com" ? new Response(null, { status: 302, headers: { location: "https://scontent.xx.fbcdn.net/x.png" } }) : bytesRes(PNG)));
    await processAttachmentDownloads(worker(n.deps));
    expect((await mine(mid)).status).toBe("ready");
    const [first, second] = n.calls.filter((c) => c.url.includes("fbsbx") || c.url.includes("x.png"));
    expect(first!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(second!.headers.authorization).toBeUndefined();
  });

  it("with no storage configured nothing is downloaded and rows stay pending", async () => {
    const a = await account("whatsapp");
    const mid = await waMedia(a.ext, digits(), { type: "audio", audio: { id: "NOSTORE", mime_type: "audio/ogg" } });
    await drain(a.ext);
    const n = net(() => bytesRes(PNG));
    expect(await processAttachmentDownloads(worker(n.deps, { store: undefined }))).toEqual({ ready: 0, failed: 0, retry: 0, skipped: 0 });
    expect(n.calls).toHaveLength(0);
    expect((await mine(mid)).status).toBe("pending");
  });

  it("two workers never fetch the same row", async () => {
    const a = await account("whatsapp");
    const mid = await waMedia(a.ext, digits(), { type: "image", image: { id: "RACE", mime_type: "image/png" } });
    await drain(a.ext);
    const n = net(async () => { await new Promise((r) => setTimeout(r, 80)); return bytesRes(PNG); });
    await Promise.all([processAttachmentDownloads(worker(n.deps)), processAttachmentDownloads(worker(n.deps))]);
    expect((await mine(mid)).status).toBe("ready");
    expect(n.calls.filter((c) => c.url.includes("RACE"))).toHaveLength(1);
    await createAttachmentRunner(worker(n.deps)).run(); // the single-flight runner drains without error and finds nothing due for this row
  });
});

describe("reconcile", () => {
  async function readyRow(id: string) {
    const a = await account("whatsapp");
    const mid = await waMedia(a.ext, digits(), { type: "image", image: { id, mime_type: "image/png" } });
    await drain(a.ext);
    await processAttachmentDownloads(worker(net(() => bytesRes(PNG)).deps));
    const r = await mine(mid);
    expect(r.status).toBe("ready");
    return { mid, r };
  }
  it("two strikes before a row is flipped to missing; local orphan blobs are reported, never deleted; a returning blob recovers the row", async () => {
    const { mid, r } = await readyRow("RECON");
    await store.delete(r.storage_key);
    const orphan = attachmentKey(ws, crypto.randomUUID());
    await store.put(orphan, PNG, { contentType: "image/png" });
    const first = await reconcileAttachments(workerDb, store, ws);
    expect(first).toMatchObject({ aborted: false, markedMissing: 0 });
    expect(first.suspected).toBeGreaterThanOrEqual(1);
    expect(await mine(mid)).toMatchObject({ status: "ready", error_code: "blob_check_1" }); // one strike: still ready
    const second = await reconcileAttachments(workerDb, store, ws);
    expect(second.markedMissing).toBeGreaterThanOrEqual(1);
    expect(second.orphanKeys).toContain(orphan);
    expect(await store.head(orphan)).not.toBeNull();
    expect(await mine(mid)).toMatchObject({ status: "missing", error_code: "blob_missing" });
    await store.put(r.storage_key, PNG, { contentType: "image/png" }); // the blob comes back
    expect((await reconcileAttachments(workerDb, store, ws)).recovered).toBeGreaterThanOrEqual(1);
    expect(await mine(mid)).toMatchObject({ status: "ready", error_code: null });
  });

  it("a failing storage probe aborts the whole run and changes no row; a blob that is back before the second strike clears the marker", async () => {
    const { mid, r } = await readyRow("PROBE");
    await store.delete(r.storage_key);
    const broken = { put: async () => { throw new Error("wrong bucket"); }, head: async () => null, delete: async () => undefined, get: async () => null, getStream: async () => null } as unknown as FsBlobStore;
    expect(await reconcileAttachments(workerDb, broken, ws)).toMatchObject({ aborted: true, markedMissing: 0, suspected: 0 });
    expect(await mine(mid)).toMatchObject({ status: "ready", error_code: null });
    await reconcileAttachments(workerDb, store, ws); // strike one
    await store.put(r.storage_key, PNG, { contentType: "image/png" });
    await reconcileAttachments(workerDb, store, ws);
    expect(await mine(mid)).toMatchObject({ status: "ready", error_code: null });
  });
});

describe("retry of a stored file", () => {
  /** Test only: the state a person's retry of a missing file produces (the superuser skips the status graph). */
  const requeue = async (id: string, attempts: number) => {
    await q("SET session_replication_role = replica");
    await q("UPDATE attachments SET status = 'pending', error_code = NULL, attempts = $2, next_attempt_at = NULL WHERE id = $1", [id, attempts]);
    await q("SET session_replication_role = DEFAULT");
  };
  it("different bytes never overwrite the blob (failed, content_changed); exhausted attempts are never claimed; the same bytes restore the blob", async () => {
    const a = await account("whatsapp");
    const mid = await waMedia(a.ext, digits(), { type: "image", image: { id: "CHG", mime_type: "image/png" } });
    await drain(a.ext);
    await processAttachmentDownloads(worker(net(() => bytesRes(PNG)).deps));
    const r = await mine(mid);
    await requeue(r.id, 0);
    const other = Buffer.concat([Buffer.from(PNG), Buffer.from([9, 9])]);
    await processAttachmentDownloads(worker(net(() => bytesRes(other)).deps));
    expect(await mine(mid)).toMatchObject({ status: "failed", error_code: "content_changed", sha256: r.sha256 });
    expect(Buffer.from((await store.get(r.storage_key))!.bytes).equals(Buffer.from(PNG))).toBe(true); // blob untouched
    await requeue(r.id, 5);
    const spy = net(() => bytesRes(PNG));
    await processAttachmentDownloads(worker(spy.deps, { maxAttempts: 5 }));
    expect(spy.calls.filter((c) => c.url.includes("CHG"))).toHaveLength(0);
    await requeue(r.id, 0);
    await store.delete(r.storage_key);
    await processAttachmentDownloads(worker(net(() => bytesRes(PNG)).deps));
    expect(await mine(mid)).toMatchObject({ status: "ready", sha256: r.sha256 });
    expect(await store.head(r.storage_key)).not.toBeNull();
  });
});
