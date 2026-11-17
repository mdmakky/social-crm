import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq, sql } from "drizzle-orm";
import { ConnectMetaBody, MESSENGER_WEBHOOK_FIELDS, MetaCallbackQuery, type ConnectMetaResult, type IntegrationAccountDto } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { schema, withContext, type Db, type Tx } from "@crm/db";
import { GraphError, type GraphPage, type MetaGraph, type SecretBox, type TelegramClient } from "@crm/integrations";
import { writeAudit } from "../audit.ts";
import { actor, body, fail, wctx, type SC, type ScopedEnv } from "../routes/scope.ts";
import type { Vars } from "../routes/workspaces.ts";

/** Messenger subscription fields (docs/integrations/meta-api-verification-2026-11.md C4). Instagram fields cannot be set through the API (docs): the app dashboard does it. */
export const MESSENGER_FIELDS: string[] = [...MESSENGER_WEBHOOK_FIELDS];
/** Task a person needs on the Page to send as the Page (Meta Pages API overview, "MESSAGING: Send messages as the Page"). Receiving is not documented as a task: UNVERIFIED. */
export const REQUIRED_PAGE_TASK = "MESSAGING";
export const STATE_TTL_MS = 10 * 60_000;
const NONCE_COOKIE = "crm_meta_nonce";
const PENDING_COOKIE = "crm_meta_pending";

/** Instagram API with Unified Login (no Facebook Page). Present only when the Instagram-compatible Facebook Login for Business configuration id is set. Uses the same Meta app and Graph client; only the token type differs. */
export type InstagramUnifiedDeps = { configId: string; redirectUri: string };

export type MetaConnectDeps = {
  /** Direct Instagram connection (Unified Login). */
  igUnified?: InstagramUnifiedDeps;
  graph: MetaGraph;
  /** Telegram Bot API client (the mock client under META_MOCK). Absent: the Telegram routes answer 503. */
  telegram?: TelegramClient;
  /** Public https base of this API, where Telegram posts (webhook URL = base + /webhooks/telegram/<path id>). */
  publicBaseUrl?: string;
  box: SecretBox;
  /** Pool connected as crm_worker. The application role cannot create accounts or read secrets (migration 0018); this process sets the workspace context itself, after the user's role check. */
  workerDb: Db;
  appId: string;
  configId: string;
  graphVersion: string;
  redirectUri: string;
  webOrigin: string;
  /** HMAC key for the OAuth state (derived from the app secret). */
  stateKey: Buffer;
  /** Key for the pseudonymous Meta-user hash stored on accounts (derived from the secrets key; rotating that key needs a re-hash, listed as a release gate). */
  userHashKey: Buffer;
  /** True when the Graph port is the in-memory mock. Reported to the UI. */
  mock: boolean;
  secureCookies: boolean;
  now?: () => number;
};

type Pending = { userId: string; workspaceId: string; pages: GraphPage[]; metaUserHash: string | null; expiresAt: number };
export const hashMetaUser = (key: Buffer, metaUserId: string) => createHmac("sha256", key).update(metaUserId).digest("hex");
const eligibility = (p: GraphPage): { eligible: boolean; reason: string | null } =>
  p.tasks === null || p.tasks.includes(REQUIRED_PAGE_TASK) ? { eligible: true, reason: null } : { eligible: false, reason: "Your role on this Page cannot send messages as the Page. Ask a Page admin for messaging access." };
export const b64u = (b: Buffer) => b.toString("base64url");
export const sign = (key: Buffer, payload: string) => b64u(createHmac("sha256", key).update(payload).digest());
export const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** One-shot discovery result held in memory for 10 minutes, keyed by a random cookie value. shortcut: single API instance, move to the database before running several. */
class PendingStore {
  private m = new Map<string, Pending>();
  put(p: Pending): string {
    for (const [k, v] of this.m) if (v.expiresAt <= Date.now()) this.m.delete(k);
    const id = b64u(randomBytes(32));
    this.m.set(id, p);
    return id;
  }
  get(id: string | undefined, userId: string, workspaceId: string, now: number): Pending | null {
    const p = id ? this.m.get(id) : undefined;
    if (!p || p.expiresAt <= now || p.userId !== userId || p.workspaceId !== workspaceId) return null;
    return p;
  }
  drop(id: string | undefined) {
    if (id) this.m.delete(id);
  }
}

export class AccountElsewhere extends Error {}
type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;

export const dto = (a: typeof schema.integrationAccounts.$inferSelect): IntegrationAccountDto => ({
  id: a.id, platform: a.platform as IntegrationAccountDto["platform"], externalAccountId: a.externalAccountId, displayName: a.displayName, status: a.status as IntegrationAccountDto["status"], authMethod: a.authMethod as IntegrationAccountDto["authMethod"],
  tokenExpiresAt: a.tokenExpiresAt?.toISOString() ?? null, lastTokenCheckAt: a.lastTokenCheckAt?.toISOString() ?? null, connectedAt: a.connectedAt.toISOString(),
});

/** Creates or reconnects one account and stores a new encrypted token version (older versions are deleted). Runs inside a worker transaction with the workspace context set. */
export async function upsertAccount(tx: Tx, deps: MetaConnectDeps, a: { workspaceId: string; userId: string; platform: "messenger" | "instagram" | "whatsapp" | "telegram"; externalId: string; displayName: string; token: string; expiresAt: Date | null; metaUserHash: string | null; tasksUnverified: boolean; authMethod?: "facebook" | "unified" }) {
  const authMethod = a.authMethod ?? "facebook";
  const found = async () => rowsOf(await tx.execute(sql`SELECT id, workspace_id FROM integration_accounts WHERE platform = ${a.platform} AND external_account_id = ${a.externalId}`))[0];
  let row = await found();
  let reconnected = true;
  if (!row) {
    // ON CONFLICT instead of catching 23505: a caught error would abort this transaction.
    const ins = rowsOf(await tx.execute(sql`
      INSERT INTO integration_accounts (workspace_id, platform, external_account_id, display_name, token_expires_at, connected_by, connected_meta_user_hash, auth_method)
      VALUES (${a.workspaceId}, ${a.platform}, ${a.externalId}, ${a.displayName}, ${a.expiresAt}, ${a.userId}, ${a.metaUserHash}, ${authMethod})
      ON CONFLICT (platform, external_account_id) DO NOTHING RETURNING id, workspace_id`))[0];
    if (ins) { row = ins; reconnected = false; } else row = await found();
  }
  if (!row || row.workspace_id !== a.workspaceId) throw new AccountElsewhere();
  const id = row.id as string;
  if (reconnected) {
    await tx.execute(sql`UPDATE integration_accounts SET status = 'connected', display_name = ${a.displayName}, token_expires_at = ${a.expiresAt}, connected_by = ${a.userId}, connected_meta_user_hash = ${a.metaUserHash}, auth_method = ${authMethod}, connected_at = now(), version = version + 1, updated_at = now() WHERE id = ${id} AND workspace_id = ${a.workspaceId}`);
  }
  const next = Number(rowsOf(await tx.execute(sql`SELECT coalesce(max(version), 0) + 1 AS v FROM integration_secrets WHERE integration_account_id = ${id}`))[0]!.v);
  const sealed = deps.box.seal(a.token, `${a.workspaceId}:${id}`);
  await tx.execute(sql`INSERT INTO integration_secrets (workspace_id, integration_account_id, version, ciphertext, nonce, key_id) VALUES (${a.workspaceId}, ${id}, ${next}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.keyId})`);
  await tx.execute(sql`DELETE FROM integration_secrets WHERE integration_account_id = ${id} AND version < ${next}`);
  await tx.execute(sql`INSERT INTO integration_events (workspace_id, integration_account_id, kind, actor_user_id, data) VALUES (${a.workspaceId}, ${id}, ${reconnected ? "reconnected" : "connected"}, ${a.userId}, ${JSON.stringify({ platform: a.platform, authMethod, externalAccountId: a.externalId, ...(a.tasksUnverified ? { tasksUnverified: true } : {}) })}::jsonb)`);
  return { id, reconnected };
}

export const eventSql = (tx: Tx, workspaceId: string, accountId: string, kind: string, actorUserId: string | null, data: Record<string, unknown>) =>
  tx.execute(sql`INSERT INTO integration_events (workspace_id, integration_account_id, kind, actor_user_id, data) VALUES (${workspaceId}, ${accountId}, ${kind}, ${actorUserId}, ${JSON.stringify(data)}::jsonb)`);

export async function loadToken(tx: Tx, deps: MetaConnectDeps, workspaceId: string, accountId: string): Promise<string | null> {
  const s = rowsOf(await tx.execute(sql`SELECT ciphertext, nonce, key_id FROM integration_secrets WHERE integration_account_id = ${accountId} AND workspace_id = ${workspaceId} ORDER BY version DESC LIMIT 1`))[0];
  if (!s) return null;
  try {
    return deps.box.open({ ciphertext: s.ciphertext as Buffer, nonce: s.nonce as Buffer, keyId: s.key_id as string }, `${workspaceId}:${accountId}`);
  } catch {
    return null; // wrong key or tampered row: treated as "no usable token"
  }
}

type SubState = "subscribed" | "failed" | "dashboard_required";
const subscribe = async (deps: MetaConnectDeps, platform: string, externalId: string, token: string): Promise<{ state: SubState; code: number | null }> => {
  if (platform === "instagram") return { state: "dashboard_required", code: null };
  try {
    return { state: (await deps.graph.subscribePage(externalId, token, MESSENGER_FIELDS)) ? "subscribed" : "failed", code: null };
  } catch (e) {
    return { state: "failed", code: e instanceof GraphError ? e.code : null };
  }
};

/** Webhook subscription of one Instagram account connected through Unified Login: POST /{ig-id}/subscribed_apps with the system-user token (docs 2026-11-14). Fuller set first, then `messages` alone. */
export const IG_UNIFIED_FIELDS = ["messages", "messaging_seen"];
export async function subscribeInstagramAccount(deps: MetaConnectDeps, igId: string, token: string): Promise<{ state: SubState; code: number | null }> {
  let code: number | null = null;
  for (const fields of [IG_UNIFIED_FIELDS, ["messages"]]) {
    try {
      if (await deps.graph.subscribePage(igId, token, fields)) return { state: "subscribed", code: null };
    } catch (e) {
      code = e instanceof GraphError ? e.code : null;
    }
  }
  return { state: "failed", code };
}

/** WhatsApp: the app is subscribed to the WABA (not to a number), so the WABA id comes from the side table (read it inside a transaction, call this after the transaction has closed). */
export const wabaOf = async (tx: Tx, workspaceId: string, accountId: string) =>
  rowsOf(await tx.execute(sql`SELECT waba_id FROM whatsapp_accounts WHERE integration_account_id = ${accountId} AND workspace_id = ${workspaceId}`))[0]?.waba_id as string | undefined;
export async function subscribeWhatsAppAccount(deps: MetaConnectDeps, waba: string | undefined, token: string): Promise<{ state: SubState; code: number | null }> {
  if (!waba) return { state: "failed", code: null };
  try {
    return { state: (await deps.graph.subscribeWaba(waba, token)) ? "subscribed" : "failed", code: null };
  } catch (e) {
    return { state: "failed", code: e instanceof GraphError ? e.code : null };
  }
}

/** Newest secret version of an account: lets a slow Graph answer detect that the account was reconnected or disconnected meanwhile. */
const secretVersion = async (tx: Tx, workspaceId: string, accountId: string) =>
  rowsOf(await tx.execute(sql`SELECT max(version) AS v FROM integration_secrets WHERE integration_account_id = ${accountId} AND workspace_id = ${workspaceId}`))[0]?.v as number | null | undefined ?? null;

/**
 * Daily-ish token health: debug_token, then record the result. Invalid token (Graph error 190 family) moves the account to reauth_required. Returns false when Graph was unreachable (state unchanged).
 * No transaction (and no row lock) is open during the Graph call. The result is applied only if the account still holds the same secret version: a reconnect or disconnect that happened meanwhile wins and the stale answer is dropped.
 */
export async function checkAccountToken(deps: MetaConnectDeps, workspaceId: string, accountId: string, actorUserId: string | null): Promise<boolean> {
  const ctx = { workspaceId, userId: actorUserId ?? undefined };
  const { token, version } = await withContext(deps.workerDb, ctx, async (tx) => ({ token: await loadToken(tx, deps, workspaceId, accountId), version: await secretVersion(tx, workspaceId, accountId) }));
  let valid = false;
  let expiresAt: Date | null = null;
  let code: number | null = null;
  if (token) {
    try {
      const info = await deps.graph.debugToken(token);
      valid = info.isValid;
      expiresAt = info.expiresAt;
      code = info.errorCode;
    } catch (e) {
      if (!(e instanceof GraphError) || e.kind !== "auth") return false; // throttle / network / other: try again later, change nothing
      code = e.code;
    }
  }
  return withContext(deps.workerDb, ctx, async (tx) => {
    await tx.execute(sql`SELECT 1 FROM integration_accounts WHERE id = ${accountId} AND workspace_id = ${workspaceId} FOR UPDATE`); // serialises with connect and disconnect, DB work only
    if ((await secretVersion(tx, workspaceId, accountId)) !== version) return true; // reconnected or disconnected while Meta answered: drop the stale result
    await tx.execute(sql`UPDATE integration_accounts SET last_token_check_at = now(), token_expires_at = ${expiresAt}, ${valid ? sql`status = status` : sql`status = CASE WHEN status = 'connected' THEN 'reauth_required' ELSE status END`}, version = version + 1, updated_at = now() WHERE id = ${accountId} AND workspace_id = ${workspaceId}`);
    await eventSql(tx, workspaceId, accountId, valid ? "token_checked" : "status_changed", actorUserId, valid ? { valid: true } : { reason: token ? "token_invalid" : "token_missing", code });
    return true;
  });
}

/** Background job: check every connected account whose last check is older than maxAgeHours. */
export async function runTokenChecks(deps: MetaConnectDeps, maxAgeHours = 24): Promise<number> {
  const due = rowsOf(await deps.workerDb.execute(sql`SELECT id, workspace_id FROM integration_accounts WHERE status = 'connected' AND platform IN ('messenger','instagram','whatsapp') AND (last_token_check_at IS NULL OR last_token_check_at < now() - make_interval(hours => ${maxAgeHours})) LIMIT 100`));
  let n = 0;
  for (const r of due) if (await checkAccountToken(deps, r.workspace_id as string, r.id as string, null).catch(() => false)) n++;
  return n;
}

function scopedRoutes(db: Db, deps: MetaConnectDeps | undefined, pending: PendingStore) {
  const r = new Hono<ScopedEnv>();
  const now = () => (deps?.now ?? Date.now)();
  const may = (c: SC, a: "integration.view" | "integration.manage") => can(c.get("role"), a, {});
  const forbidden = (c: SC) => fail(c, 403, "forbidden", "You don't have permission to do that.");
  const notConfigured = (c: SC) => fail(c, 503, "integration_not_configured", "Meta is not configured on this server.");
  const elsewhere = (c: SC) => fail(c, 409, "account_unavailable", "This account can't be connected to this workspace.");
  const cookieOpts = (d: MetaConnectDeps) => ({ httpOnly: true, sameSite: "Lax" as const, path: "/v1", maxAge: STATE_TTL_MS / 1000, secure: d.secureCookies });

  const accountsOf = (tx: Tx, workspaceId: string) => tx.select().from(schema.integrationAccounts).where(eq(schema.integrationAccounts.workspaceId, workspaceId));
  const ownAccount = async (c: SC, id: string) => {
    const [a] = await withContext(db, wctx(c), (tx) => tx.select().from(schema.integrationAccounts).where(and(eq(schema.integrationAccounts.workspaceId, c.get("workspaceId")), eq(schema.integrationAccounts.id, id))));
    return a ?? null;
  };
  const auditIt = (c: SC, action: string, entityId: string, summary: Record<string, unknown>) =>
    withContext(db, wctx(c), (tx) => writeAudit(tx, { ...actor(c), workspaceId: c.get("workspaceId"), action, entityType: "integration_account", entityId, summary }));

  r.get("/integrations/meta", async (c) => {
    if (!may(c, "integration.view")) return forbidden(c);
    const rows = await withContext(db, wctx(c), (tx) => accountsOf(tx, c.get("workspaceId")));
    return c.json({ configured: !!deps, mock: deps?.mock ?? false, instagramUnifiedConfigured: !!deps?.igUnified, accounts: rows.map(dto) });
  });

  r.post("/integrations/meta/connect/start", async (c) => {
    if (!may(c, "integration.manage")) return forbidden(c);
    if (!deps) return notConfigured(c);
    const nonce = b64u(randomBytes(24));
    const payload = b64u(Buffer.from(JSON.stringify({ w: c.get("workspaceId"), u: c.get("userId"), n: nonce, e: now() + STATE_TTL_MS })));
    setCookie(c, NONCE_COOKIE, nonce, cookieOpts(deps));
    const state = `${payload}.${sign(deps.stateKey, payload)}`;
    if (deps.mock) {
      // MOCK MODE: skip Meta entirely and go straight to our own callback with the mock's valid code. Never reaches facebook.com.
      const back = new URL(deps.redirectUri);
      back.searchParams.set("code", "good-code");
      back.searchParams.set("state", state);
      return c.json({ authUrl: back.toString() });
    }
    const url = new URL(`https://www.facebook.com/${deps.graphVersion}/dialog/oauth`);
    // Facebook Login for Business: config_id replaces scope (docs). Default response_type is code, which yields a user token (not a system-user token).
    for (const [k, v] of Object.entries({ client_id: deps.appId, redirect_uri: deps.redirectUri, state, config_id: deps.configId, response_type: "code" })) url.searchParams.set(k, v);
    return c.json({ authUrl: url.toString() });
  });

  r.get("/integrations/meta/pending", async (c) => {
    if (!may(c, "integration.manage")) return forbidden(c);
    if (!deps) return notConfigured(c);
    const p = pending.get(getCookie(c, PENDING_COOKIE), c.get("userId"), c.get("workspaceId"), now());
    if (!p) return fail(c, 404, "no_pending_selection", "The Meta login expired. Connect again.");
    const mine = new Set((await withContext(db, wctx(c), (tx) => accountsOf(tx, c.get("workspaceId")))).filter((a) => a.status !== "disabled").map((a) => `${a.platform}:${a.externalAccountId}`));
    return c.json({ pages: p.pages.map((g) => ({ pageId: g.id, name: g.name, instagramAccountId: g.instagramAccountId, instagram: g.instagram ?? null, instagramConnected: !!g.instagramAccountId && mine.has(`instagram:${g.instagramAccountId}`), connected: mine.has(`messenger:${g.id}`), eligible: eligibility(g).eligible, ineligibleReason: eligibility(g).reason })), expiresAt: new Date(p.expiresAt).toISOString() });
  });

  r.post("/integrations/meta/connect", async (c) => {
    if (!may(c, "integration.manage")) return forbidden(c);
    if (!deps) return notConfigured(c);
    const parsed = await body(c, ConnectMetaBody);
    if (!parsed.ok) return parsed.res;
    const cookie = getCookie(c, PENDING_COOKIE);
    const p = pending.get(cookie, c.get("userId"), c.get("workspaceId"), now());
    const page = p?.pages.find((g) => g.id === parsed.data.pageId);
    if (!p || !page) return fail(c, 404, "no_pending_selection", "The Meta login expired. Connect again.");
    if (!eligibility(page).eligible) return fail(c, 422, "page_task_missing", eligibility(page).reason ?? undefined);
    const withIg = parsed.data.connectInstagram && !!page.instagramAccountId;
    const targets: { platform: "messenger" | "instagram"; externalId: string; name: string }[] = [{ platform: "messenger", externalId: page.id, name: page.name }];
    if (withIg) targets.push({ platform: "instagram", externalId: page.instagramAccountId!, name: page.instagram?.username ? `@${page.instagram.username}` : `${page.name} (Instagram)` });
    let made: { id: string; reconnected: boolean; platform: "messenger" | "instagram"; externalId: string }[];
    try {
      made = await withContext(deps.workerDb, wctx(c), async (tx) => {
        const out = [];
        for (const t of targets) out.push({ ...(await upsertAccount(tx, deps, { workspaceId: c.get("workspaceId"), userId: c.get("userId"), platform: t.platform, externalId: t.externalId, displayName: t.name, token: page.accessToken, expiresAt: null, metaUserHash: p.metaUserHash, tasksUnverified: page.tasks === null })), platform: t.platform, externalId: t.externalId });
        return out;
      });
    } catch (e) {
      if (e instanceof AccountElsewhere) return elsewhere(c);
      throw e;
    }
    // The Page token is single-use here: drop this page from the in-memory selection.
    p.pages = p.pages.filter((g) => g.id !== page.id);
    if (p.pages.length === 0) { pending.drop(cookie); deleteCookie(c, PENDING_COOKIE, { path: "/v1" }); }

    const accounts: ConnectMetaResult["accounts"] = [];
    for (const m of made) {
      const sub = await subscribe(deps, m.platform, m.externalId, page.accessToken);
      await withContext(deps.workerDb, wctx(c), (tx) => eventSql(tx, c.get("workspaceId"), m.id, "status_changed", c.get("userId"), { subscription: sub.state, fields: m.platform === "messenger" ? MESSENGER_FIELDS : [], code: sub.code }));
      await auditIt(c, m.reconnected ? "integration.meta.reconnected" : "integration.meta.connected", m.id, { platform: m.platform, externalAccountId: m.externalId, subscription: sub.state });
      const [row] = await withContext(db, wctx(c), (tx) => tx.select().from(schema.integrationAccounts).where(and(eq(schema.integrationAccounts.workspaceId, c.get("workspaceId")), eq(schema.integrationAccounts.id, m.id))));
      accounts.push({ account: dto(row!), subscription: sub.state, reconnected: m.reconnected });
    }
    return c.json({ accounts });
  });

  r.post("/integrations/meta/accounts/:accountId/disconnect", async (c) => {
    if (!may(c, "integration.manage")) return forbidden(c);
    if (!deps) return notConfigured(c);
    const a = await ownAccount(c, c.req.param("accountId") ?? "");
    if (!a) return fail(c, 404, "not_found");
    // Messenger: unsubscribe the Page before the transaction (best effort: the account is disabled either way), so no row lock is held while Meta answers.
    // WhatsApp: the app is subscribed per WABA, and another workspace may hold a number of the same WABA (invisible to us under RLS), so the subscription is never removed here: events for a disabled number become orphans.
    if (a.platform === "messenger") {
      const token = await withContext(deps.workerDb, wctx(c), (tx) => loadToken(tx, deps, a.workspaceId, a.id));
      if (token) await deps.graph.unsubscribePage(a.externalAccountId, token).catch(() => false);
    }
    // Telegram: remove the webhook first, best effort (the bot token is dropped below either way). No transaction is open while Telegram answers.
    if (a.platform === "telegram" && deps.telegram) {
      const token = await withContext(deps.workerDb, wctx(c), (tx) => loadToken(tx, deps, a.workspaceId, a.id));
      if (token) await deps.telegram.deleteWebhook(token).catch(() => undefined);
    }
    await withContext(deps.workerDb, wctx(c), async (tx) => {
      await tx.execute(sql`SELECT 1 FROM integration_accounts WHERE id = ${a.id} AND workspace_id = ${a.workspaceId} FOR UPDATE`); // a reconnect racing this disconnect waits here, so it cannot leave a disabled row holding a fresh token
      await tx.execute(sql`DELETE FROM integration_secrets WHERE integration_account_id = ${a.id} AND workspace_id = ${a.workspaceId}`);
      await tx.execute(sql`UPDATE integration_accounts SET status = 'disabled', version = version + 1, updated_at = now() WHERE id = ${a.id} AND workspace_id = ${a.workspaceId}`);
      await eventSql(tx, a.workspaceId, a.id, "disconnected", c.get("userId"), { platform: a.platform });
    });
    await auditIt(c, a.platform === "telegram" ? "integration.telegram.disconnected" : "integration.meta.disconnected", a.id, { platform: a.platform, externalAccountId: a.externalAccountId });
    return c.json({ ok: true as const });
  });

  r.post("/integrations/meta/accounts/:accountId/check-token", async (c) => {
    if (!may(c, "integration.manage")) return forbidden(c);
    if (!deps) return notConfigured(c);
    const a = await ownAccount(c, c.req.param("accountId") ?? "");
    if (!a) return fail(c, 404, "not_found");
    if (a.platform === "telegram") return fail(c, 422, "unsupported_channel", "Use the connection check for Telegram bots.");
    if (!(await checkAccountToken(deps, a.workspaceId, a.id, c.get("userId")))) return fail(c, 502, "meta_unavailable", "Meta could not be reached. Try again later.");
    return c.json(dto((await ownAccount(c, a.id))!));
  });

  /** Plain-language history of one account (decisions D-D: no tokens, no raw payloads; only what the event kinds mean). */
  r.get("/integrations/meta/accounts/:accountId/events", async (c) => {
    if (!may(c, "integration.manage")) return forbidden(c);
    const a = await ownAccount(c, c.req.param("accountId") ?? "");
    if (!a) return fail(c, 404, "not_found");
    const rows = await withContext(db, wctx(c), (tx) => tx.select().from(schema.integrationEvents).where(and(eq(schema.integrationEvents.workspaceId, a.workspaceId), eq(schema.integrationEvents.integrationAccountId, a.id))).orderBy(sql`${schema.integrationEvents.createdAt} DESC, ${schema.integrationEvents.id} DESC`).limit(10));
    const text = (kind: string, d: Record<string, unknown>): string => {
      if (kind === "connected") return "Connected";
      if (kind === "reconnected") return "Reconnected";
      if (kind === "disconnected") return "Disconnected";
      if (kind === "token_checked") return "Token checked: valid";
      if (kind === "status_changed") {
        if (d.webhook === "set") return "Telegram webhook set";
        if (d.webhook === "failed") return "Telegram webhook was not accepted";
        if (d.subscription === "subscribed") return "Webhook subscribed";
        if (d.subscription === "failed") return "Webhook subscription failed";
        if (d.subscription === "dashboard_required") return "Webhook fields must be enabled in the Meta dashboard";
        if (d.reason === "token_invalid" || d.reason === "token_missing") return "Token no longer valid: reconnect needed";
        if (d.reason === "meta_deauthorized") return "Meta authorisation removed: reconnect needed";
        if (d.reason === "meta_data_deletion") return "Disconnected after a Meta data deletion request";
        return "Status changed";
      }
      return kind;
    };
    return c.json({ items: rows.map((e) => ({ id: e.id, kind: e.kind, summary: text(e.kind, (e.data ?? {}) as Record<string, unknown>), createdAt: e.createdAt.toISOString() })) });
  });

  r.post("/integrations/meta/accounts/:accountId/resubscribe", async (c) => {
    if (!may(c, "integration.manage")) return forbidden(c);
    if (!deps) return notConfigured(c);
    const a = await ownAccount(c, c.req.param("accountId") ?? "");
    if (!a || a.status === "disabled") return fail(c, 404, "not_found");
    if (a.platform === "telegram") return fail(c, 422, "unsupported_channel", "Connect the bot again to reset its webhook.");
    const { token, waba } = await withContext(deps.workerDb, wctx(c), async (tx) => ({ token: await loadToken(tx, deps, a.workspaceId, a.id), waba: a.platform === "whatsapp" ? await wabaOf(tx, a.workspaceId, a.id) : undefined }));
    const sub = !token ? { state: "failed" as SubState, code: null } : a.platform === "whatsapp" ? await subscribeWhatsAppAccount(deps, waba, token) : a.authMethod === "unified" ? await subscribeInstagramAccount(deps, a.externalAccountId, token) : await subscribe(deps, a.platform, a.externalAccountId, token); // Graph call: no transaction open
    await withContext(deps.workerDb, wctx(c), async (tx) => {
      const live = rowsOf(await tx.execute(sql`SELECT 1 FROM integration_accounts WHERE id = ${a.id} AND workspace_id = ${a.workspaceId} AND status <> 'disabled'`)).length > 0;
      if (live) await eventSql(tx, a.workspaceId, a.id, "status_changed", c.get("userId"), { subscription: sub.state, code: sub.code }); // an account disconnected meanwhile gets no "subscribed" entry after "Disconnected"
    });
    return c.json({ subscription: sub.state });
  });

  return r;
}

/** Browser redirect target after the Meta dialog (not workspace scoped: the workspace is inside the signed state). Always answers with a 302 to the web app, never with details. */
function callbackRoutes(db: Db, deps: MetaConnectDeps | undefined, pending: PendingStore) {
  const r = new Hono<{ Variables: Vars }>();
  r.get("/integrations/meta/callback", async (c) => {
    if (!deps) return c.redirect("/?meta=not_configured", 302);
    const home = (ws: string | null, result: string) => c.redirect(`${deps.webOrigin}${ws ? `/w/${ws}/settings/integrations` : "/"}?meta=${result}`, 302);
    const q = MetaCallbackQuery.safeParse(c.req.query());
    const nonceCookie = getCookie(c, NONCE_COOKIE) ?? "";
    deleteCookie(c, NONCE_COOKIE, { path: "/v1" }); // the state is single use whatever happens next
    // 1. State: signed by us, not expired, issued to this very user, and bound to this browser by the nonce cookie (CSRF / login-CSRF defence).
    let st: { w: string; u: string; n: string; e: number; m?: string } | null = null;
    const [payload = "", sig = ""] = (q.success ? q.data.state ?? "" : "").split(".");
    if (payload && safeEq(sig, sign(deps.stateKey, payload))) {
      try { st = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { st = null; }
    }
    const now = (deps.now ?? Date.now)();
    if (!st || st.m !== undefined || typeof st.w !== "string" || typeof st.n !== "string" || st.e < now || st.u !== c.get("userId") || !safeEq(nonceCookie, st.n)) return home(null, "invalid_state");
    // 2. The user must still be an owner/admin of that workspace.
    const [m] = await withContext(db, { userId: st.u, workspaceId: st.w }, (tx) => tx.select({ role: schema.memberships.role }).from(schema.memberships).where(and(eq(schema.memberships.workspaceId, st!.w), eq(schema.memberships.userId, st!.u), eq(schema.memberships.status, "active")))).catch(() => []);
    if (!m || !can(m.role, "integration.manage", {})) return home(null, "forbidden");
    if (!q.success || q.data.error) return home(st.w, "denied");
    if (!q.data.code) return home(st.w, "error");
    // 3. Code -> long-lived user token -> Pages (each with its own Page token). The user token is not stored; only Page tokens are, after the user picks one.
    try {
      const short = await deps.graph.exchangeCode(q.data.code, deps.redirectUri);
      const long = await deps.graph.exchangeLongLived(short.accessToken);
      const pages = await deps.graph.listPages(long.accessToken);
      // Username and picture of each linked Instagram account for the picker. Best effort and sequential (a few Pages at most): a failure just leaves the plain id.
      for (const pg of pages) if (pg.instagramAccountId) pg.instagram = await deps.graph.getInstagramAccount(pg.instagramAccountId, pg.accessToken);
      // Non-fatal: without it the deauthorization callback cannot find this person's connections (recorded as null).
      const metaUserId = await deps.graph.getUserId(long.accessToken).catch(() => null);
      const id = pending.put({ userId: st.u, workspaceId: st.w, pages, metaUserHash: metaUserId ? hashMetaUser(deps.userHashKey, metaUserId) : null, expiresAt: now + STATE_TTL_MS });
      setCookie(c, PENDING_COOKIE, id, { httpOnly: true, sameSite: "Lax", path: "/v1", maxAge: STATE_TTL_MS / 1000, secure: deps.secureCookies });
      return home(st.w, pages.length ? "select" : "no_pages");
    } catch {
      return home(st.w, "error");
    }
  });
  return r;
}

/** Scoped (per workspace) and callback routes share one in-memory pending-selection store. */
export function metaConnect(db: Db, deps?: MetaConnectDeps) {
  const pending = new PendingStore();
  return { scoped: scopedRoutes(db, deps, pending), callback: callbackRoutes(db, deps, pending) };
}
