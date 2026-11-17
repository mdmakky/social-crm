import { createHash } from "node:crypto";
import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { parseMailgunEvent, parseMailgunInbound, parseRecipient, tokenOfMessageId, TokenSeen, verifyMailgunSignature, type StoredEmailEvent } from "@crm/integrations";
import type { Db } from "@crm/db";
import { WindowCounter } from "../throttle.ts";
import { MAX_WEBHOOK_BYTES, readLimited } from "./webhook.ts";

export type EmailIngressConfig = {
  /** Webhook signing keys, current first. Mailgun: the account Webhook Signing Key, not the API key. */
  signingKeys: string[];
  /** Domain of the support addresses. The recipient must be exactly support+<token>@this; nothing else routes. */
  inboundDomain: string;
  onStored?: () => void;
  /** Pool connected as crm_ingest (INSERT-only on webhook_events). */
  ingestDb: Db;
  limits?: { perKeyPerWindow: number; failedPerKeyPerWindow: number; rejectedRowsPerWindow: number; perSenderPerHour: number; windowMs: number };
  maxSkewMs?: number;
  now?: () => number;
};

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

/**
 * Email ingress (provider: Mailgun format; MOCK-tested only, nothing has been received from a real Mailgun route). Same order as the Meta webhook: body cap, rate limit, signature FIRST, then store and answer.
 * The stored row is a small normalised JSON of the verified fields (plain text, headers, attachment names). Raw HTML and attachment bytes are never stored. account_ref is the token of the recipient address: the only routing input.
 * Nothing here calls the provider or the database role that processes events; the worker does that (process.ts).
 */
export function emailWebhookRoutes(cfg: EmailIngressConfig) {
  const app = new Hono();
  const lim = cfg.limits ?? { perKeyPerWindow: 600, failedPerKeyPerWindow: 20, rejectedRowsPerWindow: 200, perSenderPerHour: 30, windowMs: 60_000 };
  const now = cfg.now ?? Date.now;
  const all = new WindowCounter(lim.perKeyPerWindow, lim.windowMs, cfg.now);
  const failed = new WindowCounter(lim.failedPerKeyPerWindow, lim.windowMs, cfg.now);
  const rejectedRows = new WindowCounter(lim.rejectedRowsPerWindow, lim.windowMs, cfg.now);
  const perSender = new WindowCounter(lim.perSenderPerHour, 3_600_000, cfg.now);
  const seen = new TokenSeen();
  const keyOf = (c: Parameters<typeof getConnInfo>[0]) => {
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  };
  const reject = async (key: string, size: number) => {
    if (!failed.allow(key)) return new Response("rate limited", { status: 429, headers: { "retry-after": "60" } });
    if (rejectedRows.allow("global")) await cfg.ingestDb.$client.query("INSERT INTO webhook_events (platform, signature_valid, raw_body, body_sha256, body_size, account_ref, status) VALUES ('email', false, NULL, NULL, $1, NULL, 'rejected')", [size]);
    return new Response("forbidden", { status: 403 });
  };
  const store = async (accountRef: string | null, ev: StoredEmailEvent) => {
    const body = Buffer.from(JSON.stringify({ v: 1, ...ev }));
    await cfg.ingestDb.$client.query(
      "INSERT INTO webhook_events (platform, signature_valid, raw_body, body_sha256, body_size, account_ref, status) VALUES ('email', true, $1, $2, $3, $4, $5)",
      [body, sha(body), body.length, accountRef, accountRef ? "received" : "orphan"],
    );
    try { cfg.onStored?.(); } catch { /* a worker signal must never fail the delivery */ }
  };

  app.post("/inbound", async (c) => {
    const key = keyOf(c);
    if (!all.allow(key)) return c.text("rate limited", 429, { "retry-after": "60" });
    const raw = await readLimited(c.req.raw, MAX_WEBHOOK_BYTES);
    if (!raw) return c.text("payload too large", 413);

    let form: FormData;
    try {
      form = await new Request("http://local/", { method: "POST", headers: { "content-type": c.req.header("content-type") ?? "" }, body: new Uint8Array(raw) }).formData();
    } catch {
      return await reject(key, raw.length);
    }
    const fields: Record<string, string> = {};
    const files: { name: string; size: number }[] = [];
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") fields[k] = v.length > 1_000_000 ? v.slice(0, 1_000_000) : v;
      else files.push({ name: v.name, size: v.size });
    }
    const sig = verifyMailgunSignature({ timestamp: fields["timestamp"], token: fields["token"], signature: fields["signature"] }, cfg.signingKeys, now(), cfg.maxSkewMs);
    if (!sig.ok) return await reject(key, raw.length);
    if (seen.has(sig.token, now())) return c.text("duplicate", 200); // a replayed request: acknowledged, never stored twice

    const ev = parseMailgunInbound(fields, files);
    if (!ev) { seen.firstUse(sig.token, now()); return c.text("ok", 200); } // signed but unusable (no recipient): nothing to store
    // Flood guard per sender address. Over the limit the mail is acknowledged and dropped (a provider retry would only repeat it).
    if (ev.fromAddress && !perSender.allow(ev.fromAddress)) { seen.firstUse(sig.token, now()); return c.text("ok", 200); }
    const tag = parseRecipient(ev.recipient, cfg.inboundDomain);
    // No usable token (wrong domain, no +token): stored as an orphan with the same normalised body, never routed anywhere.
    await store(tag?.token ?? null, { ...ev, ...(tag?.convToken ? { convToken: tag.convToken } : {}) });
    seen.firstUse(sig.token, now());
    return c.text("ok", 200);
  });

  /** Bounce and complaint events (Mailgun event webhook, JSON). Shape UNVERIFIED (parseMailgunEvent). */
  app.post("/events", async (c) => {
    const key = keyOf(c);
    if (!all.allow(key)) return c.text("rate limited", 429, { "retry-after": "60" });
    const raw = await readLimited(c.req.raw, 64 * 1024);
    if (!raw) return c.text("payload too large", 413);
    let json: unknown = null;
    try { json = JSON.parse(raw.toString("utf8")); } catch { /* falls to reject */ }
    const p = parseMailgunEvent(json);
    if (!p) return await reject(key, raw.length);
    const sig = verifyMailgunSignature(p.signature, cfg.signingKeys, now(), cfg.maxSkewMs);
    if (!sig.ok) return await reject(key, raw.length);
    if (seen.has(sig.token, now())) return c.text("duplicate", 200);
    const token = p.event ? tokenOfMessageId(p.event.messageId) : null;
    if (p.event && token) await store(token, p.event);
    seen.firstUse(sig.token, now());
    return c.text("ok", 200);
  });

  return app;
}
