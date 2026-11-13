import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { sql } from "drizzle-orm";
import { withContext, type Db } from "@crm/db";
import { WindowCounter } from "../throttle.ts";
import { hashMetaUser } from "./meta-connect.ts";
import { readLimited } from "./webhook.ts";

const MAX_FORM_BYTES = 16 * 1024;
const b64u = (b: Buffer) => b.toString("base64url");
const B64U = /^[A-Za-z0-9_-]+$/;

/**
 * Parses a Meta `signed_request` ("<base64url signature>.<base64url payload>"). Layout and algorithm from Meta's data-deletion callback page (PHP sample):
 * HMAC-SHA256 over the encoded payload string, keyed with the app secret, payload JSON with `algorithm` "HMAC-SHA256" and `user_id`.
 * Every secret is tried without early exit. Returns null for anything malformed or unsigned; never throws.
 */
export function parseSignedRequest(signedRequest: string, secrets: string[]): { userId: string } | null {
  const dot = signedRequest.indexOf(".");
  if (dot < 1 || signedRequest.length > MAX_FORM_BYTES) return null;
  const sigPart = signedRequest.slice(0, dot);
  const payload = signedRequest.slice(dot + 1);
  if (!B64U.test(sigPart) || !B64U.test(payload)) return null;
  const sig = Buffer.from(sigPart, "base64url");
  let ok = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = createHmac("sha256", secret).update(payload).digest();
    if (expected.length === sig.length && timingSafeEqual(expected, sig)) ok = true;
  }
  if (!ok) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (data.algorithm !== "HMAC-SHA256" || typeof data.user_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(data.user_id)) return null;
    return { userId: data.user_id };
  } catch {
    return null;
  }
}

export type UserCallbackConfig = {
  /** Current app secret first, previous one second while rotating. */
  appSecrets: string[];
  workerDb: Db;
  userHashKey: Buffer;
  /** HMAC key for the stateless deletion confirmation codes. */
  statusKey: Buffer;
  /** Public https base of this API (the tunnel or the host). Without it the data-deletion callback answers 503, as Meta needs a status URL. */
  publicBaseUrl?: string;
  now?: () => number;
  limitPerWindow?: number;
};

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;

/** Removes every connection that Meta user authorised. "deauthorized": tokens are dead, accounts need re-auth. "deleted": accounts are disabled and the link to the Meta user is erased. Returns the number of accounts touched. */
async function revokeConnections(cfg: UserCallbackConfig, metaUserId: string, mode: "deauthorized" | "deleted"): Promise<number> {
  const hash = hashMetaUser(cfg.userHashKey, metaUserId);
  // The worker role may read accounts across workspaces (routing needs it) but may only write inside one workspace context at a time.
  const found = rowsOf(await cfg.workerDb.execute(sql`SELECT id, workspace_id, status FROM integration_accounts WHERE connected_meta_user_hash = ${hash} ${mode === "deauthorized" ? sql`AND status = 'connected'` : sql``}`));
  for (const a of found) {
    await withContext(cfg.workerDb, { workspaceId: a.workspace_id as string }, async (tx) => {
      await tx.execute(sql`DELETE FROM integration_secrets WHERE integration_account_id = ${a.id as string} AND workspace_id = ${a.workspace_id as string}`);
      if (mode === "deauthorized") {
        await tx.execute(sql`UPDATE integration_accounts SET status = 'reauth_required', version = version + 1, updated_at = now() WHERE id = ${a.id as string} AND workspace_id = ${a.workspace_id as string}`);
      } else {
        await tx.execute(sql`UPDATE integration_accounts SET status = 'disabled', connected_meta_user_hash = NULL, version = version + 1, updated_at = now() WHERE id = ${a.id as string} AND workspace_id = ${a.workspace_id as string}`);
      }
      await tx.execute(sql`INSERT INTO integration_events (workspace_id, integration_account_id, kind, actor_user_id, data) VALUES (${a.workspace_id as string}, ${a.id as string}, 'status_changed', NULL, ${JSON.stringify({ reason: mode === "deleted" ? "meta_data_deletion" : "meta_deauthorized" })}::jsonb)`);
    });
  }
  return found.length;
}

/**
 * Meta app-level callbacks for the person who authorised the app (not for end customers). Mounted at /meta/callbacks:
 *  POST /deauthorize, POST /data-deletion, GET /data-deletion/status?code=
 * The request body format and signature are documented for data deletion; the deauthorize body format is NOT documented on the pages found
 * (assumed to be the same signed_request): UNVERIFIED until a real removal is observed.
 * Unknown or unmatched users get the same answer as matched ones, so the endpoints reveal nothing about who is connected.
 */
export function metaUserCallbackRoutes(cfg: UserCallbackConfig) {
  const app = new Hono();
  const now = () => (cfg.now ?? Date.now)();
  const limiter = new WindowCounter(cfg.limitPerWindow ?? 60, 60_000, cfg.now);
  const keyOf = (c: Parameters<typeof getConnInfo>[0]) => {
    try { return getConnInfo(c).remote.address ?? "unknown"; } catch { return "unknown"; }
  };
  const bad = (c: Context) => c.json({ error: "invalid_signed_request" }, 400);

  async function signedUser(c: Context): Promise<{ userId: string } | "rate" | null> {
    if (!limiter.allow(keyOf(c))) return "rate";
    const raw = await readLimited(c.req.raw, MAX_FORM_BYTES);
    if (!raw) return null;
    const sr = new URLSearchParams(raw.toString("utf8")).get("signed_request");
    return sr ? parseSignedRequest(sr, cfg.appSecrets) : null;
  }

  app.post("/deauthorize", async (c) => {
    const u = await signedUser(c);
    if (u === "rate") return c.json({ error: "rate_limited" }, 429);
    if (!u) return bad(c);
    await revokeConnections(cfg, u.userId, "deauthorized");
    return c.json({ ok: true });
  });

  app.post("/data-deletion", async (c) => {
    if (!cfg.publicBaseUrl) return c.json({ error: "not_configured" }, 503);
    const u = await signedUser(c);
    if (u === "rate") return c.json({ error: "rate_limited" }, 429);
    if (!u) return bad(c);
    const n = await revokeConnections(cfg, u.userId, "deleted");
    const payload = b64u(Buffer.from(JSON.stringify({ t: now(), n })));
    const code = `${payload}.${b64u(createHmac("sha256", cfg.statusKey).update(payload).digest())}`;
    return c.json({ url: `${cfg.publicBaseUrl.replace(/\/$/, "")}/meta/callbacks/data-deletion/status?code=${encodeURIComponent(code)}`, confirmation_code: code });
  });

  // Human-readable status (Meta requires the link to explain the request status). The code is self-describing and signed: no table, nothing about the user.
  app.get("/data-deletion/status", (c) => {
    const [payload = "", sig = ""] = (c.req.query("code") ?? "").split(".");
    const expected = b64u(createHmac("sha256", cfg.statusKey).update(payload).digest());
    if (!payload || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return c.text("Unknown confirmation code.", 404);
    try {
      const d = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { t: number; n: number };
      return c.text(`Data deletion request received on ${new Date(d.t).toISOString()}. ${d.n} connected account(s) were disconnected, and the stored access tokens and the link to your Meta user ID were deleted. Customer conversations on a Page are not linked to your Meta user ID.`);
    } catch {
      return c.text("Unknown confirmation code.", 404);
    }
  });

  return app;
}
