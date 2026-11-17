import { createHash } from "node:crypto";
import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { verifyTelegramSecret } from "@crm/integrations";
import type { Db } from "@crm/db";
import { WindowCounter } from "../throttle.ts";
import { MAX_WEBHOOK_BYTES, readLimited } from "./webhook.ts";

export type TelegramIngressConfig = {
  /** Pool connected as crm_ingest (INSERT-only on webhook_events, EXECUTE on telegram_ingest_lookup). */
  ingestDb: Db;
  /** Called after an update was stored. Must not throw. */
  onStored?: () => void;
  limits?: { perKeyPerWindow: number; failedPerKeyPerWindow: number; rejectedRowsPerWindow: number; windowMs: number };
  now?: () => number;
};

const PATH_ID = /^[A-Za-z0-9_-]{20,64}$/;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest();

/**
 * Telegram webhook ingress: POST /webhooks/telegram/:pathId (MOCK ONLY so far; UNVERIFIED against Telegram).
 * Two checks before anything is stored: the unguessable path id must name a connected bot, and the X-Telegram-Bot-Api-Secret-Token header must match that bot's secret (SHA-256 compared in constant time).
 * An unknown path id and a wrong or missing secret get the same 403, so the route cannot be used to find out which path ids exist. Like the Meta route it does no Telegram call and no processing:
 * verify, store, answer 200; the worker routes and processes (process.ts). An identical body (a retry of the same update) is stored once (unique index, ON CONFLICT DO NOTHING).
 */
export function telegramWebhookRoutes(cfg: TelegramIngressConfig) {
  const app = new Hono();
  const lim = cfg.limits ?? { perKeyPerWindow: 600, failedPerKeyPerWindow: 20, rejectedRowsPerWindow: 200, windowMs: 60_000 };
  const all = new WindowCounter(lim.perKeyPerWindow, lim.windowMs, cfg.now);
  const failed = new WindowCounter(lim.failedPerKeyPerWindow, lim.windowMs, cfg.now);
  const rejectedRows = new WindowCounter(lim.rejectedRowsPerWindow, lim.windowMs, cfg.now);
  const keyOf = (c: Parameters<typeof getConnInfo>[0]) => {
    try { return getConnInfo(c).remote.address ?? "unknown"; } catch { return "unknown"; }
  };

  app.post("/:pathId", async (c) => {
    const pathId = c.req.param("pathId");
    if (!PATH_ID.test(pathId)) return c.text("forbidden", 403);
    const key = keyOf(c);
    if (!all.allow(key)) return c.text("rate limited", 429, { "retry-after": "60" });
    const raw = await readLimited(c.req.raw, MAX_WEBHOOK_BYTES);
    if (!raw) return c.text("payload too large", 413);

    const found = (await cfg.ingestDb.$client.query("SELECT bot_id, secret_hash FROM telegram_ingest_lookup($1)", [pathId])).rows[0] as { bot_id: string; secret_hash: string } | undefined;
    const ok = verifyTelegramSecret(c.req.header("x-telegram-bot-api-secret-token"), found?.secret_hash ?? null);
    if (!ok || !found) {
      if (!failed.allow(key)) return c.text("rate limited", 429, { "retry-after": "60" });
      // Audit row without the body; a global cap bounds how many rows an unauthenticated caller can make us write.
      if (rejectedRows.allow("global")) {
        await cfg.ingestDb.$client.query("INSERT INTO webhook_events (platform, signature_valid, raw_body, body_sha256, body_size, account_ref, status) VALUES ('telegram', false, NULL, NULL, $1, NULL, 'rejected')", [raw.length]);
      }
      return c.text("forbidden", 403);
    }

    // Signed but unusable (not JSON, no update_id): acknowledge so Telegram does not keep retrying, store nothing.
    let update: unknown;
    try { update = JSON.parse(raw.toString("utf8")); } catch { return c.text("ok", 200); }
    if (typeof update !== "object" || update === null || typeof (update as { update_id?: unknown }).update_id !== "number") return c.text("ok", 200);

    await cfg.ingestDb.$client.query(
      "INSERT INTO webhook_events (platform, signature_valid, raw_body, body_sha256, body_size, account_ref, status) VALUES ('telegram', true, $1, $2, $3, $4, 'received') ON CONFLICT DO NOTHING",
      [raw, sha(raw), raw.length, found.bot_id],
    );
    try { cfg.onStored?.(); } catch { /* a worker signal must never fail the delivery */ }
    return c.text("ok", 200);
  });

  return app;
}
