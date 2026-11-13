import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { parseMetaWebhook, verifyMetaSignature } from "@crm/integrations";
import type { Db } from "@crm/db";
import { WindowCounter } from "../throttle.ts";

export const MAX_WEBHOOK_BYTES = 1024 * 1024;
const PLATFORMS = ["messenger", "instagram"] as const;
type Platform = (typeof PLATFORMS)[number];
// Meta names the object "page" for Messenger. The expected object is derived from the callback path, never from the payload.
const OBJECT_OF: Record<Platform, string> = { messenger: "page", instagram: "instagram" };

export type IngressConfig = {
  /** Current app secret first, previous one second while rotating. */
  appSecrets: string[];
  verifyToken: string;
  /** Pool connected as crm_ingest (INSERT-only on webhook_events). */
  ingestDb: Db;
  limits?: { perKeyPerWindow: number; failedPerKeyPerWindow: number; rejectedRowsPerWindow: number; windowMs: number };
  now?: () => number;
};

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const safeEq = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

/** Reads the body up to max bytes. Returns null as soon as the limit is exceeded (the rest is never read). */
async function readLimited(req: Request, max: number): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Meta webhook ingress. One callback path per platform (/webhooks/meta/messenger and /webhooks/meta/instagram). ASSUMPTION, UNVERIFIED (C8): that Meta allows one callback URL per object type.
 * The request does no Graph API call and no processing: verify, store durably, answer 200. The worker routes and processes (see process.ts).
 */
export function metaWebhookRoutes(cfg: IngressConfig) {
  const app = new Hono();
  const lim = cfg.limits ?? { perKeyPerWindow: 600, failedPerKeyPerWindow: 20, rejectedRowsPerWindow: 200, windowMs: 60_000 };
  const all = new WindowCounter(lim.perKeyPerWindow, lim.windowMs, cfg.now);
  const failed = new WindowCounter(lim.failedPerKeyPerWindow, lim.windowMs, cfg.now);
  const rejectedRows = new WindowCounter(lim.rejectedRowsPerWindow, lim.windowMs, cfg.now);

  // The tunnel / proxy address is not trusted (X-Forwarded-For is attacker controlled): the key is the TCP peer. Behind a tunnel all traffic shares one key, which is deliberately the stricter outcome.
  const keyOf = (c: Parameters<typeof getConnInfo>[0]) => {
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  };

  app.get("/:platform", (c) => {
    const platform = c.req.param("platform");
    if (!PLATFORMS.includes(platform as Platform) || !cfg.verifyToken) return c.text("forbidden", 403);
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token") ?? "";
    const challenge = c.req.query("hub.challenge") ?? "";
    if (mode !== "subscribe" || !safeEq(token, cfg.verifyToken) || !/^[0-9A-Za-z_-]{1,200}$/.test(challenge)) return c.text("forbidden", 403);
    return c.text(challenge, 200);
  });

  app.post("/:platform", async (c) => {
    const platform = c.req.param("platform") as Platform;
    if (!PLATFORMS.includes(platform)) return c.text("not found", 404);
    const key = keyOf(c);
    if (!all.allow(key)) return c.text("rate limited", 429, { "retry-after": "60" });

    const raw = await readLimited(c.req.raw, MAX_WEBHOOK_BYTES);
    if (!raw) return c.text("payload too large", 413);

    const ok = verifyMetaSignature(raw, c.req.header("x-hub-signature-256"), cfg.appSecrets);
    if (!ok) {
      if (!failed.allow(key)) return c.text("rate limited", 429, { "retry-after": "60" });
      // Audit row without the body. A global cap bounds how many rows an unauthenticated caller can make us write.
      if (rejectedRows.allow("global")) {
        await cfg.ingestDb.$client.query(
          "INSERT INTO webhook_events (platform, signature_valid, raw_body, body_sha256, body_size, account_ref, status) VALUES ($1, false, NULL, NULL, $2, NULL, 'rejected')",
          [platform, raw.length],
        );
      }
      return c.text("forbidden", 403);
    }

    const parsed = parseMetaWebhook(raw);
    // Signed but unusable (not JSON, wrong object, no entries): acknowledge so Meta does not retry forever, store nothing.
    if (!parsed.ok || parsed.platform !== platform || parsed.entries.length === 0) return c.text("EVENT_RECEIVED", 200);

    // One stored row per account entry, so routing is per account. A single-entry body is stored byte for byte; a batch is split into per-entry bodies (the signature was verified over the original).
    const rows: { body: Buffer; account: string }[] = [];
    const seen = new Set<string>();
    for (const e of parsed.entries) {
      const body = parsed.entries.length === 1 ? raw : Buffer.from(JSON.stringify({ object: OBJECT_OF[platform], entry: [e.raw] }));
      const digest = `${e.accountId}:${sha(body).toString("hex")}`;
      if (seen.has(digest)) continue; // identical entry repeated inside one batch
      seen.add(digest);
      rows.push({ body, account: e.accountId });
    }
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      values.push(platform, r.body, sha(r.body), r.body.length, r.account);
      const o = i * 5;
      return `($${o + 1}, true, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, 'received')`;
    });
    // One statement: the whole batch is stored or none of it (Meta retries on 5xx; processing is idempotent by message id).
    await cfg.ingestDb.$client.query(`INSERT INTO webhook_events (platform, signature_valid, raw_body, body_sha256, body_size, account_ref, status) VALUES ${tuples.join(",")}`, values);
    return c.text("EVENT_RECEIVED", 200);
  });

  return app;
}
