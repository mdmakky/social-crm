import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { can } from "@crm/core/permissions";
import { schema, withContext, type Db } from "@crm/db";
import { writeAudit } from "../audit.ts";
import { fail, type ScopedEnv } from "../routes/scope.ts";
import type { Vars } from "../routes/workspaces.ts";
import { AccountElsewhere, b64u, eventSql, safeEq, sign, STATE_TTL_MS, subscribeInstagramAccount, upsertAccount, type MetaConnectDeps } from "./meta-connect.ts";

const NONCE_COOKIE = "crm_ig_nonce";
const MAX_ACCOUNTS = 10;
const Callback = z.object({ code: z.string().min(1).max(2000).optional(), state: z.string().max(2000).optional(), error: z.string().max(100).optional() });

/**
 * Connect Instagram accounts WITHOUT a Facebook Page: Instagram API with Unified Login (Facebook Login for Business with an Instagram-only configuration). Facts and unknowns: docs/integrations/instagram-messaging.md, Method C.
 * Flow: signed state -> facebook.com dialog (config_id) -> our callback -> code exchanged on the server for a system-user token -> me/assigned_instagram_accounts -> each shared account is stored with the token sealed,
 * and subscribed. The browser only ever sees a short result word in the redirect.
 */
export function instagramUnified(db: Db, deps?: MetaConnectDeps) {
  const now = () => (deps?.now ?? Date.now)();

  const scoped = new Hono<ScopedEnv>();
  scoped.post("/integrations/instagram/connect/start", async (c) => {
    if (!can(c.get("role"), "integration.manage", {})) return fail(c, 403, "forbidden", "You don't have permission to do that.");
    if (!deps?.igUnified) return fail(c, 503, "integration_not_configured", "Direct Instagram connection is not configured on this server.");
    const nonce = b64u(randomBytes(24));
    const payload = b64u(Buffer.from(JSON.stringify({ w: c.get("workspaceId"), u: c.get("userId"), n: nonce, e: now() + STATE_TTL_MS, m: "ig" })));
    setCookie(c, NONCE_COOKIE, nonce, { httpOnly: true, sameSite: "Lax", path: "/v1", maxAge: STATE_TTL_MS / 1000, secure: deps.secureCookies });
    const state = `${payload}.${sign(deps.stateKey, payload)}`;
    if (deps.mock) {
      // MOCK MODE: straight to our own callback with the mock's valid code. Never reaches facebook.com.
      const back = new URL(deps.igUnified.redirectUri);
      back.searchParams.set("code", "good-code");
      back.searchParams.set("state", state);
      return c.json({ authUrl: back.toString() });
    }
    const url = new URL(`https://www.facebook.com/${deps.graphVersion}/dialog/oauth`);
    // Same parameters as the Login URL the Meta dashboard generates for this configuration (checked against the dashboard on 2026-11-14), minus `display=popup` because this is a full-page redirect.
    // prompt=login shows both the Facebook and the Instagram sign-in options (Unified Login get-started page).
    for (const [k, v] of Object.entries({ client_id: deps.appId, config_id: deps.igUnified.configId, redirect_uri: deps.igUnified.redirectUri, response_type: "code", override_default_response_type: "true", state, prompt: "login" })) url.searchParams.set(k, v);
    return c.json({ authUrl: url.toString() });
  });

  const callback = new Hono<{ Variables: Vars }>();
  callback.get("/integrations/instagram/callback", async (c) => {
    if (!deps?.igUnified) return c.redirect("/?meta=not_configured", 302);
    const cfg = deps.igUnified;
    const home = (ws: string | null, result: string) => c.redirect(`${deps.webOrigin}${ws ? `/w/${ws}/settings/integrations` : "/"}?meta=${result}&channel=instagram`, 302);
    const q = Callback.safeParse(c.req.query());
    const nonceCookie = getCookie(c, NONCE_COOKIE) ?? "";
    deleteCookie(c, NONCE_COOKIE, { path: "/v1" }); // single use whatever happens next
    // 1. State: signed by us, unexpired, issued to this user for the Instagram flow, bound to this browser by the nonce cookie.
    let st: { w: string; u: string; n: string; e: number; m?: string } | null = null;
    const [payload = "", sig = ""] = (q.success ? q.data.state ?? "" : "").split(".");
    if (payload && safeEq(sig, sign(deps.stateKey, payload))) {
      try { st = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { st = null; }
    }
    if (!st || st.m !== "ig" || typeof st.w !== "string" || typeof st.n !== "string" || st.e < now() || st.u !== c.get("userId") || !safeEq(nonceCookie, st.n)) return home(null, "invalid_state");
    const { w: workspaceId, u: userId } = st;
    // 2. The user must still be an owner/admin of that workspace.
    const [m] = await withContext(db, { userId, workspaceId }, (tx) => tx.select({ role: schema.memberships.role }).from(schema.memberships).where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, userId), eq(schema.memberships.status, "active")))).catch(() => []);
    if (!m || !can(m.role, "integration.manage", {})) return home(null, "forbidden");
    if (!q.success || q.data.error) return home(workspaceId, "denied");
    const code = (q.data.code ?? "").replace(/#_$/, ""); // a trailing "#_" is not part of the code
    if (!code) return home(workspaceId, "error");
    // 3. code -> system-user token (no long-lived exchange: this token is not a user token) -> the accounts the person shared.
    let token: string, expiresAt: Date | null, shared: { id: string; username: string | null }[], truncated: boolean;
    try {
      const t = await deps.graph.exchangeCode(code, cfg.redirectUri);
      token = t.accessToken;
      // Expiry depends on the configuration (never, or a number of days). debug_token tells; failing to read it only means "unknown".
      expiresAt = await deps.graph.debugToken(token).then((i) => i.expiresAt).catch(() => null);
      const all = await deps.graph.listAssignedInstagramAccounts(token);
      truncated = all.length > MAX_ACCOUNTS; // more shared than we connect in one login: say so instead of silently dropping the rest
      shared = all.slice(0, MAX_ACCOUNTS);
    } catch {
      return home(workspaceId, "error");
    }
    if (shared.length === 0) return home(workspaceId, "ig_no_accounts");
    // 4. Store each shared account on its own (one that belongs to another workspace must not block the others), then subscribe it.
    let connected = 0, refused = 0, failed = 0, unsubscribed = 0;
    for (const a of shared) {
      let accountId: string, reconnected: boolean;
      try {
        ({ id: accountId, reconnected } = await withContext(deps.workerDb, { userId, workspaceId }, (tx) =>
          upsertAccount(tx, deps, { workspaceId, userId, platform: "instagram", externalId: a.id, displayName: a.username ? `@${a.username}` : "Instagram account", token, expiresAt, metaUserHash: null, tasksUnverified: false, authMethod: "unified" }),
        ));
      } catch (e) {
        if (e instanceof AccountElsewhere) refused++;
        else failed++; // this account is not connected; the others still are, and the result says so
        continue;
      }
      connected++;
      const sub = await subscribeInstagramAccount(deps, a.id, token);
      if (sub.state !== "subscribed") unsubscribed++;
      try {
        await withContext(deps.workerDb, { userId, workspaceId }, (tx) => eventSql(tx, workspaceId, accountId, "status_changed", userId, { subscription: sub.state, code: sub.code, method: "instagram_unified" }));
        await withContext(db, { userId, workspaceId }, (tx) => writeAudit(tx, { actorUserId: userId, requestId: c.get("requestId"), workspaceId, action: reconnected ? "integration.instagram_unified.reconnected" : "integration.instagram_unified.connected", entityType: "integration_account", entityId: accountId, summary: { externalAccountId: a.id, subscription: sub.state } }));
      } catch { /* the account is connected; a failed history or audit write must not turn that into an error page */ }
    }
    if (connected === 0) return home(workspaceId, failed === 0 && refused > 0 ? "account_unavailable" : "error");
    return home(workspaceId, refused > 0 || failed > 0 || truncated ? "ig_partial" : unsubscribed > 0 ? "ig_connected_unsubscribed" : "ig_connected");
  });

  return { scoped, callback };
}
