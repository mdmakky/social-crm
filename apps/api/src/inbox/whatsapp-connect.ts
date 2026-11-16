import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { ConnectWhatsAppBody, WhatsAppLookupBody, type ConnectWhatsAppResult, type WhatsAppLookupResult } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { schema, withContext, type Db } from "@crm/db";
import { GraphError, type WhatsAppNumber } from "@crm/integrations";
import { writeAudit } from "../audit.ts";
import { actor, body, fail, wctx, type SC, type ScopedEnv } from "../routes/scope.ts";
import { WindowCounter } from "../throttle.ts";
import { AccountElsewhere, dto, eventSql, upsertAccount, type MetaConnectDeps } from "./meta-connect.ts";

/** Scope that lets the token read the WABA and subscribe the app to it. Sending needs `whatsapp_business_messaging` too: recorded on the connect event, required by slice 3, not by this slice. */
export const WA_REQUIRED_SCOPE = "whatsapp_business_management";
export const WA_MESSAGING_SCOPE = "whatsapp_business_messaging";

class WabaMismatch extends Error {}
/** Each call spends a Meta request carrying a pasted token, so an owner (or a stolen session) cannot use these routes to probe tokens or WABA ids in bulk. Per workspace and user, in process (same shortcut as imports: move to a shared store before running more than one API instance). */
export type WhatsAppLimits = { lookupsPerUser: number; connectsPerUser: number; windowMs: number };
const DEFAULT_LIMITS: WhatsAppLimits = { lookupsPerUser: 30, connectsPerUser: 10, windowMs: 10 * 60_000 };
type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;

/** Reads the numbers of one WABA with the supplied token. Throws a response-ready tuple instead of leaking Graph details. */
async function numbersOf(deps: MetaConnectDeps, token: string, wabaId: string): Promise<{ ok: true; numbers: WhatsAppNumber[] } | { ok: false; status: 422 | 502; code: string; message: string }> {
  try {
    return { ok: true, numbers: await deps.graph.listWhatsAppNumbers(token, wabaId) };
  } catch (e) {
    if (e instanceof GraphError && e.kind === "auth") return { ok: false, status: 422, code: "token_invalid", message: "Meta rejected this token. Check that it is a current system user token for this app." };
    if (e instanceof GraphError && e.kind !== "throttle" && e.status !== 0 && e.status < 500) return { ok: false, status: 422, code: "waba_not_accessible", message: "This token cannot read that WhatsApp Business Account. Check the account ID and that the system user has been given access to the account." };
    return { ok: false, status: 502, code: "meta_unavailable", message: "Meta could not be reached. Try again later." };
  }
}

/**
 * WhatsApp Cloud API, manual connection with a system user token (slice 2). No OAuth round trip: the owner pastes the WABA id and the token, we read the numbers of the account,
 * the owner picks one, and we store it with the token sealed (same SecretBox, same rows as Messenger and Instagram), then subscribe the app to the WABA.
 * Facts and unknowns: docs/integrations/whatsapp-cloud-api.md. Check-token, disconnect and re-subscribe are the generic account routes in meta-connect.ts.
 */
export function whatsappConnect(db: Db, deps?: MetaConnectDeps, limits?: Partial<WhatsAppLimits>) {
  const r = new Hono<ScopedEnv>();
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const lookups = new WindowCounter(lim.lookupsPerUser, lim.windowMs);
  const connects = new WindowCounter(lim.connectsPerUser, lim.windowMs);
  const limited = (c: SC) => { c.header("Retry-After", String(Math.ceil(lim.windowMs / 1000))); return fail(c, 429, "rate_limited", "Too many attempts. Try again in a few minutes."); };
  const manage = (c: SC) => can(c.get("role"), "integration.manage", {});
  const forbidden = (c: SC) => fail(c, 403, "forbidden", "You don't have permission to do that.");
  const notConfigured = (c: SC) => fail(c, 503, "integration_not_configured", "Meta is not configured on this server.");

  r.post("/integrations/whatsapp/numbers", async (c) => {
    if (!manage(c)) return forbidden(c);
    if (!deps) return notConfigured(c);
    if (!lookups.allow(`${c.get("workspaceId")}:${c.get("userId")}`)) return limited(c);
    const parsed = await body(c, WhatsAppLookupBody);
    if (!parsed.ok) return parsed.res;
    const res = await numbersOf(deps, parsed.data.accessToken, parsed.data.wabaId);
    if (!res.ok) return fail(c, res.status, res.code, res.message);
    const mine = await withContext(db, wctx(c), (tx) => tx.select({ id: schema.integrationAccounts.externalAccountId }).from(schema.integrationAccounts).where(and(eq(schema.integrationAccounts.workspaceId, c.get("workspaceId")), eq(schema.integrationAccounts.platform, "whatsapp"), sql`${schema.integrationAccounts.status} <> 'disabled'`)));
    const have = new Set(mine.map((m) => m.id));
    // Advisory only (the worker role sees across workspaces, the app role does not): tells the owner up front which numbers /connect would refuse with 409. Says nothing about WHO holds the number. /connect stays authoritative.
    const taken = new Set<string>();
    if (res.numbers.length > 0) {
      const rows = await withContext(deps.workerDb, wctx(c), async (tx) => rowsOf(await tx.execute(sql`SELECT external_account_id FROM integration_accounts WHERE platform = 'whatsapp' AND workspace_id <> ${c.get("workspaceId")} AND external_account_id IN (${sql.join(res.numbers.map((n) => sql`${n.id}`), sql`, `)})`)));
      for (const r of rows) taken.add(r.external_account_id as string);
    }
    const out: WhatsAppLookupResult = { numbers: res.numbers.map((n) => ({ phoneNumberId: n.id, displayPhoneNumber: n.displayPhoneNumber, verifiedName: n.verifiedName, connected: have.has(n.id), unavailable: taken.has(n.id) })) };
    return c.json(out);
  });

  r.post("/integrations/whatsapp/connect", async (c) => {
    if (!manage(c)) return forbidden(c);
    if (!deps) return notConfigured(c);
    if (!connects.allow(`${c.get("workspaceId")}:${c.get("userId")}`)) return limited(c);
    const parsed = await body(c, ConnectWhatsAppBody);
    if (!parsed.ok) return parsed.res;
    const { wabaId, phoneNumberId, accessToken } = parsed.data;
    const workspaceId = c.get("workspaceId");
    const userId = c.get("userId");

    // 1. The token must be a live token of THIS app, and the chosen number must belong to the WABA the token can read (a number id alone proves nothing about who owns it).
    let info: Awaited<ReturnType<typeof deps.graph.debugToken>>;
    try {
      info = await deps.graph.debugToken(accessToken);
    } catch (e) {
      if (e instanceof GraphError && e.kind === "auth") return fail(c, 422, "token_invalid", "Meta rejected this token. Check that it is a current system user token for this app.");
      return fail(c, 502, "meta_unavailable", "Meta could not be reached. Try again later.");
    }
    if (!deps.mock && !info.appId) return fail(c, 422, "token_invalid", "Meta did not say which app this token belongs to. Generate the token for this app and try again."); // fail closed outside the mock: an unattributed token is not accepted
    if (info.appId && info.appId !== deps.appId) return fail(c, 422, "token_invalid", "This token was issued to a different Meta app. Generate it for this app.");
    if (!info.isValid) return fail(c, 422, "token_invalid", "Meta rejected this token. Check that it is a current system user token for this app.");
    if (info.scopes.length > 0 && !info.scopes.includes(WA_REQUIRED_SCOPE)) return fail(c, 422, "permission_missing", `The token lacks the ${WA_REQUIRED_SCOPE} permission. Create it again with that permission.`);
    const res = await numbersOf(deps, accessToken, wabaId);
    if (!res.ok) return fail(c, res.status, res.code, res.message);
    const number = res.numbers.find((n) => n.id === phoneNumberId);
    if (!number) return fail(c, 422, "number_not_found", "That phone number is not part of this WhatsApp Business Account.");

    // 2. Account row, sealed token and whatsapp_accounts side row in one worker transaction (the app role cannot create accounts or read secrets, migration 0018).
    let made: { id: string; reconnected: boolean };
    let replayed = 0;
    try {
      made = await withContext(deps.workerDb, wctx(c), async (tx) => {
        const m = await upsertAccount(tx, deps, { workspaceId, userId, platform: "whatsapp", externalId: number.id, displayName: number.verifiedName ?? number.displayPhoneNumber, token: accessToken, expiresAt: info.expiresAt, metaUserHash: null, tasksUnverified: false });
        const had = rowsOf(await tx.execute(sql`SELECT waba_id FROM whatsapp_accounts WHERE integration_account_id = ${m.id} AND workspace_id = ${workspaceId}`))[0]?.waba_id as string | undefined;
        if (had && had !== wabaId) throw new WabaMismatch(); // the account id of a connected number cannot change: disconnecting does not move it, so refuse instead of keeping a stale WABA
        await tx.execute(sql`
          INSERT INTO whatsapp_accounts (workspace_id, integration_account_id, waba_id, display_phone_number, mode)
          VALUES (${workspaceId}, ${m.id}, ${wabaId}, ${number.displayPhoneNumber}, 'cloud_api')
          ON CONFLICT (integration_account_id) DO UPDATE SET display_phone_number = EXCLUDED.display_phone_number, updated_at = now()`);
        // Events that arrived while this number was not connected were stored as orphans: queue them again (dedupe on message id makes a repeat harmless).
        replayed = rowsOf(await tx.execute(sql`UPDATE webhook_events SET status = 'received', attempts = 0, last_error = NULL WHERE platform = 'whatsapp' AND account_ref = ${number.id} AND status = 'orphan' AND last_error IN ('unknown_account','account_disabled') AND raw_body IS NOT NULL RETURNING id`)).length;
        return m;
      });
    } catch (e) {
      if (e instanceof WabaMismatch) return fail(c, 409, "waba_mismatch", "This number is already connected under a different WhatsApp Business Account ID. Use that ID, or ask support to release the number.");
      if (e instanceof AccountElsewhere) return fail(c, 409, "account_unavailable", "This number is already connected to another workspace. Disconnect it there first, or contact support to release it.");
      throw e;
    }

    // 3. Webhook subscription for the WABA. A failure does not undo the connection: the account shows "subscription failed" and can be re-subscribed.
    let subscription: ConnectWhatsAppResult["subscription"] = "failed";
    let code: number | null = null;
    try {
      subscription = (await deps.graph.subscribeWaba(wabaId, accessToken)) ? "subscribed" : "failed";
    } catch (e) {
      code = e instanceof GraphError ? e.code : null;
    }
    await withContext(deps.workerDb, wctx(c), (tx) => eventSql(tx, workspaceId, made.id, "status_changed", userId, { subscription, code, method: "whatsapp_manual", messagingScope: info.scopes.length === 0 ? "unknown" : info.scopes.includes(WA_MESSAGING_SCOPE), replayedEvents: replayed }));
    await withContext(db, wctx(c), (tx) => writeAudit(tx, { ...actor(c), workspaceId, action: made.reconnected ? "integration.whatsapp.reconnected" : "integration.whatsapp.connected", entityType: "integration_account", entityId: made.id, summary: { platform: "whatsapp", externalAccountId: number.id, subscription } }));
    const [row] = await withContext(db, wctx(c), (tx) => tx.select().from(schema.integrationAccounts).where(and(eq(schema.integrationAccounts.workspaceId, workspaceId), eq(schema.integrationAccounts.id, made.id))));
    const out: ConnectWhatsAppResult = { account: dto(row!), subscription, reconnected: made.reconnected, replayedEvents: replayed };
    return c.json(out);
  });

  return r;
}
