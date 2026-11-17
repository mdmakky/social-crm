import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { ConnectTelegramBody, type ConnectTelegramResult, type TelegramHealth } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { schema, withContext, type Db } from "@crm/db";
import { hashTelegramSecret, TELEGRAM_ALLOWED_UPDATES, TelegramError, type TelegramBot } from "@crm/integrations";
import { writeAudit } from "../audit.ts";
import { actor, body, fail, isUuid, wctx, type SC, type ScopedEnv } from "../routes/scope.ts";
import { WindowCounter } from "../throttle.ts";
import { AccountElsewhere, dto, eventSql, loadToken, upsertAccount, type MetaConnectDeps } from "./meta-connect.ts";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;
/** Telegram's own bounds for max_connections are 1-100 (Bot API setWebhook); a support inbox needs few. */
export const TELEGRAM_MAX_CONNECTIONS = 3;
export const telegramWebhookUrl = (base: string, pathId: string) => `${base.replace(/\/+$/, "")}/webhooks/telegram/${pathId}`;
export type TelegramLimits = { connectsPerUser: number; windowMs: number };

/**
 * Telegram support-inbox channel, manual bot token (MOCK ONLY so far: no request has ever reached Telegram, see docs/integrations/telegram.md).
 * The owner pastes the BotFather token; we check it with getMe (the bot id comes from there), store it sealed, and point the bot's webhook at /webhooks/telegram/<random path id> with a fresh random secret_token.
 * Order: DB first (worker transaction, no network inside), then setWebhook. A failed setWebhook keeps the connection and says so; connecting again retries it (and rotates path id and secret).
 */
export function telegramConnect(db: Db, deps?: MetaConnectDeps, limits?: Partial<TelegramLimits>) {
  const r = new Hono<ScopedEnv>();
  const lim = { connectsPerUser: 10, windowMs: 10 * 60_000, ...limits };
  const connects = new WindowCounter(lim.connectsPerUser, lim.windowMs);
  const manage = (c: SC) => can(c.get("role"), "integration.manage", {});
  const forbidden = (c: SC) => fail(c, 403, "forbidden", "You don't have permission to do that.");
  const notConfigured = (c: SC) => fail(c, 503, "integration_not_configured", "Telegram is not set up on this server.");

  r.post("/integrations/telegram/connect", async (c) => {
    if (!manage(c)) return forbidden(c);
    const tg = deps?.telegram;
    if (!deps || !tg) return notConfigured(c);
    if (!connects.allow(`${c.get("workspaceId")}:${c.get("userId")}`)) { c.header("Retry-After", String(Math.ceil(lim.windowMs / 1000))); return fail(c, 429, "rate_limited", "Too many attempts. Try again in a few minutes."); }
    const parsed = await body(c, ConnectTelegramBody);
    if (!parsed.ok) return parsed.res;
    const botToken = parsed.data.botToken;
    const workspaceId = c.get("workspaceId");
    const userId = c.get("userId");
    // Telegram only delivers to HTTPS (Bot API setWebhook). Outside the mock, a base address that is not https is refused before anything is stored.
    const base = deps.publicBaseUrl;
    if (!base || (!deps.mock && !base.startsWith("https://"))) return fail(c, 422, "public_url_required", "This server has no public https address, so Telegram cannot reach it. Set the public address first.");

    let bot: TelegramBot;
    try {
      bot = await tg.getMe(botToken);
    } catch (e) {
      if (e instanceof TelegramError && e.kind === "auth") return fail(c, 422, "token_invalid", "Telegram rejected this token. Copy it again from BotFather.");
      return fail(c, 502, "telegram_unavailable", "Telegram could not be reached. Try again later.");
    }

    // Plain random values: the path id locates the account, the secret proves the caller is Telegram. Only the hash of the secret is stored.
    const pathId = randomBytes(24).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    let made: { id: string; reconnected: boolean };
    let replayed = 0;
    try {
      made = await withContext(deps.workerDb, wctx(c), async (tx) => {
        const m = await upsertAccount(tx, deps, { workspaceId, userId, platform: "telegram", externalId: bot.id, displayName: bot.username ? `@${bot.username}` : bot.firstName || `Bot ${bot.id}`, token: botToken, expiresAt: null, metaUserHash: null, tasksUnverified: false });
        await tx.execute(sql`
          INSERT INTO telegram_accounts (workspace_id, integration_account_id, bot_id, bot_username, webhook_path_id, secret_hash)
          VALUES (${workspaceId}, ${m.id}, ${bot.id}, ${bot.username}, ${pathId}, ${hashTelegramSecret(secret)})
          ON CONFLICT (integration_account_id) DO UPDATE SET bot_username = EXCLUDED.bot_username, webhook_path_id = EXCLUDED.webhook_path_id, secret_hash = EXCLUDED.secret_hash, updated_at = now()`);
        replayed = rowsOf(await tx.execute(sql`UPDATE webhook_events SET status = 'received', attempts = 0, last_error = NULL WHERE platform = 'telegram' AND account_ref = ${bot.id} AND status = 'orphan' AND last_error IN ('unknown_account','account_disabled') AND raw_body IS NOT NULL RETURNING id`)).length;
        return m;
      });
    } catch (e) {
      if (e instanceof AccountElsewhere) return fail(c, 409, "account_unavailable", "This bot is already connected to another workspace. Disconnect it there first, or contact support to release it.");
      throw e;
    }

    let webhook: ConnectTelegramResult["webhook"] = "failed";
    try {
      await tg.setWebhook(botToken, { url: telegramWebhookUrl(base, pathId), secretToken: secret, maxConnections: TELEGRAM_MAX_CONNECTIONS, allowedUpdates: TELEGRAM_ALLOWED_UPDATES, dropPendingUpdates: false });
      webhook = "set";
    } catch { /* kept: the account shows a failed webhook and connecting again retries */ }
    await withContext(deps.workerDb, wctx(c), (tx) => eventSql(tx, workspaceId, made.id, "status_changed", userId, { webhook, method: "telegram_bot_token", replayedEvents: replayed }));
    await withContext(db, wctx(c), (tx) => writeAudit(tx, { ...actor(c), workspaceId, action: "integration.telegram.connected", entityType: "integration_account", entityId: made.id, summary: { platform: "telegram", externalAccountId: bot.id, reconnected: made.reconnected, webhook } }));
    const [row] = await withContext(db, wctx(c), (tx) => tx.select().from(schema.integrationAccounts).where(and(eq(schema.integrationAccounts.workspaceId, workspaceId), eq(schema.integrationAccounts.id, made.id))));
    const out: ConnectTelegramResult = { account: dto(row!), botUsername: bot.username, webhook, reconnected: made.reconnected, replayedEvents: replayed };
    return c.json(out);
  });

  /** getWebhookInfo for the health line. Read only; the message Telegram reports is shortened and shown as is (it describes our server's answer, never a customer message). */
  r.get("/integrations/telegram/accounts/:accountId/health", async (c) => {
    if (!manage(c)) return forbidden(c);
    const tg = deps?.telegram;
    if (!deps || !tg) return notConfigured(c);
    const id = c.req.param("accountId") ?? "";
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const [a] = await withContext(db, wctx(c), (tx) => tx.select().from(schema.integrationAccounts).where(and(eq(schema.integrationAccounts.workspaceId, c.get("workspaceId")), eq(schema.integrationAccounts.id, id), eq(schema.integrationAccounts.platform, "telegram"))));
    if (!a || a.status === "disabled") return fail(c, 404, "not_found");
    const token = await withContext(deps.workerDb, wctx(c), (tx) => loadToken(tx, deps, a.workspaceId, a.id));
    if (!token) return fail(c, 409, "token_unavailable", "The bot token can't be used. Connect the bot again.");
    try {
      const i = await tg.getWebhookInfo(token);
      const out: TelegramHealth = { webhookSet: i.url !== "", pendingUpdateCount: i.pendingUpdateCount, lastErrorAt: i.lastErrorAt?.toISOString() ?? null, lastErrorMessage: i.lastErrorMessage };
      return c.json(out);
    } catch (e) {
      if (e instanceof TelegramError && e.kind === "auth") return fail(c, 422, "token_invalid", "Telegram no longer accepts this bot token. Connect the bot again with a new one.");
      return fail(c, 502, "telegram_unavailable", "Telegram could not be reached. Try again later.");
    }
  });

  return r;
}
