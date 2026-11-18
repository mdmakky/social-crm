import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { sql } from "drizzle-orm";
import { WEB_CHAT_LIMITS, WidgetContactBody, WidgetSendBody, type WidgetMessage, type WidgetPublicConfig } from "@crm/contracts";
import { withContext, type Db, type Tx } from "@crm/db";
import { hasNul } from "../routes/scope.ts";
import { saveExtracted } from "../inbox/extract.ts";
import { WindowCounter } from "../throttle.ts";
import { randomDigits } from "./admin.ts";
import { verifyPreview } from "./preview.ts";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type WidgetLimits = { sessionsPerIp: number; sessionsPerWidget: number; sessionWindowMs: number; messagesPerSession: number; pollsPerSession: number; configPerIp: number; contactPerSession: number };
export type WidgetDeps = {
  /** Pool connected as crm_worker: the only role that may call chat_widget_resolve and write visitor data. */
  workerDb: Db;
  /** Origins of our own web app. A request from one of these is the widget iframe: the embedding site is then named by X-Widget-Host. */
  webOrigins: string[];
  /** Key that signs and checks owner preview grants (see preview.ts). */
  previewKey: Buffer;
  limits?: Partial<WidgetLimits>;
  /** A visitor cannot send before this long after the session was created (spam check). */
  minFirstMessageMs?: number;
  now?: () => number;
};
type Widget = { id: string; workspaceId: string; accountId: string; enabled: boolean; origins: string[]; config: WidgetPublicConfig };
type Session = { id: string; visitorRef: string; contactId: string | null; conversationId: string | null; createdAt: Date; hasMessage: boolean };
type E = { Variables: { widget: Widget; preview: boolean } };

const DEFAULT_LIMITS: WidgetLimits = { sessionsPerIp: 10, sessionsPerWidget: 120, sessionWindowMs: 10 * 60_000, messagesPerSession: 20, pollsPerSession: 60, configPerIp: 60, contactPerSession: 5 };
const KEY_SHAPE = /^[A-Za-z0-9_-]{22,64}$/;
const normOrigin = (s: string | undefined) => (s ?? "").trim().replace(/\/+$/, "").toLowerCase();
const err = (c: Context, status: 400 | 401 | 403 | 404 | 413 | 429, code: string, message: string) => c.json({ error: { code, message } }, status);

/**
 * Public website-chat API, mounted at /public/widget. Unauthenticated: the widget key names the widget, a per-visitor bearer token names the session.
 * The workspace is derived from the key by the chat_widget_resolve SQL function and never taken from the caller; every other query runs in that workspace's RLS context
 * and is additionally filtered by (widget, session, conversation), so a token can only ever reach its own conversation.
 */
export function publicWidgetRoutes(deps: WidgetDeps) {
  const r = new Hono<E>();
  const L = { ...DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now;
  const minFirst = deps.minFirstMessageMs ?? 1500;
  const sessionsIp = new WindowCounter(L.sessionsPerIp, L.sessionWindowMs, now);
  const sessionsWidget = new WindowCounter(L.sessionsPerWidget, L.sessionWindowMs, now);
  const messages = new WindowCounter(L.messagesPerSession, 60_000, now);
  const polls = new WindowCounter(L.pollsPerSession, 60_000, now);
  const configIp = new WindowCounter(L.configPerIp, 60_000, now);
  const contacts = new WindowCounter(L.contactPerSession, 60_000, now);
  const clientIp = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const tooMany = (c: Context) => err(c, 429, "rate_limited", "Too many requests. Wait a moment and try again.");

  // Read by the web app's own server to build the per-widget `frame-ancestors` header of the widget page (browsers then refuse to frame it on any other site). The list is public by nature: it ends up in that header.
  r.get("/_frame/:key", async (c) => {
    const key = c.req.param("key");
    const row = KEY_SHAPE.test(key) ? rowsOf(await deps.workerDb.execute(sql`SELECT allowed_origins FROM chat_widget_resolve(${key})`))[0] : undefined;
    return c.json({ origins: row ? (row.allowed_origins as string[]).map(normOrigin) : [] });
  });

  r.use("/:key/*", bodyLimit({ maxSize: WEB_CHAT_LIMITS.bodyBytes, onError: (c) => err(c, 413, "too_large", "That message is too large.") }));

  // 1. key -> widget, 2. origin allowlist, 3. CORS headers. Order matters: an unknown key says nothing about origins, a wrong origin gets no CORS headers.
  r.use("/:key/*", async (c, next) => {
    const key = c.req.param("key") ?? "";
    if (!KEY_SHAPE.test(key)) return err(c, 404, "not_found", "Unknown widget.");
    const row = rowsOf(await deps.workerDb.execute(sql`SELECT * FROM chat_widget_resolve(${key})`))[0];
    if (!row) return err(c, 404, "not_found", "Unknown widget.");
    const widget: Widget = {
      id: row.id as string, workspaceId: row.workspace_id as string, accountId: row.integration_account_id as string, enabled: row.enabled as boolean, origins: (row.allowed_origins as string[]).map(normOrigin),
      config: { name: row.name as string, color: row.color as string, greeting: (row.greeting as string | null) ?? null, offlineMessage: (row.offline_message as string | null) ?? null, prechatForm: row.prechat_form as boolean, enabled: row.enabled as boolean },
    };
    // The site that embeds the widget: the browser's Origin when the call comes from that site directly; otherwise (our own iframe, or a same-origin GET that carries no Origin) the X-Widget-Host
    // the widget page sets from the parent it was framed by. Both are client-supplied, so a non-browser can claim any allowed value: the allowlist stops browsers, the rate limits stop the rest.
    const origin = normOrigin(c.req.header("origin"));
    const ours = origin !== "" && deps.webOrigins.map(normOrigin).includes(origin);
    const claimed = origin !== "" && !ours ? origin : normOrigin(c.req.header("x-widget-host"));
    // Owner preview (D270): a signed grant for THIS widget and workspace, sent from our own web app only, stands in for the allowlist. A grant header that does not check out is refused, never ignored.
    const grant = c.req.header("x-widget-preview");
    let preview = false;
    if (grant !== undefined) {
      const claims = verifyPreview(deps.previewKey, grant, now());
      const host = normOrigin(c.req.header("x-widget-host"));
      const fromUs = (origin === "" || ours) && (host === "" || deps.webOrigins.map(normOrigin).includes(host));
      if (!claims || claims.w !== widget.id || claims.ws !== widget.workspaceId || !fromUs) return err(c, 403, "preview_invalid", "This preview link is not valid or has expired.");
      preview = true;
    }
    if (!preview && claimed === "") return err(c, 403, "origin_required", "This request does not say which site it comes from.");
    if (!preview && (widget.origins.length === 0 || !widget.origins.includes(claimed))) return err(c, 403, "origin_not_allowed", "This site is not allowed to use this chat.");
    if (origin !== "" && !ours) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      c.header("Access-Control-Expose-Headers", "x-request-id");
    }
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header("Access-Control-Allow-Headers", "authorization, content-type, x-widget-host");
      c.header("Access-Control-Max-Age", "600");
      return c.body(null, 204);
    }
    c.header("Cache-Control", "no-store");
    c.set("widget", widget);
    c.set("preview", preview);
    await next();
  });

  /** Looks up the session of the bearer token inside the widget's workspace. A token of another widget or workspace finds nothing. Returns null for a missing, wrong or expired token. */
  async function sessionOf(c: Context<E>, tx: Tx): Promise<Session | null> {
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "");
    if (!m) return null;
    const w = c.get("widget");
    const s = rowsOf(
      await tx.execute(sql`
        SELECT s.id, s.visitor_ref, s.contact_id, s.conversation_id, s.created_at, s.last_seen_at,
               (s.conversation_id IS NOT NULL AND EXISTS (SELECT 1 FROM messages m WHERE m.workspace_id = s.workspace_id AND m.conversation_id = s.conversation_id AND m.direction = 'in')) AS has_message
        FROM chat_visitor_sessions s WHERE s.workspace_id = ${w.workspaceId} AND s.widget_id = ${w.id} AND s.token_hash = ${sha256(m[1]!)} AND s.expires_at > now()`),
    )[0];
    if (!s) return null;
    // sliding 30 days, written at most every 5 minutes
    await tx.execute(sql`UPDATE chat_visitor_sessions SET last_seen_at = now(), expires_at = now() + interval '30 days' WHERE workspace_id = ${w.workspaceId} AND id = ${s.id as string} AND last_seen_at < now() - interval '5 minutes'`);
    return { id: s.id as string, visitorRef: s.visitor_ref as string, contactId: (s.contact_id as string | null) ?? null, conversationId: (s.conversation_id as string | null) ?? null, createdAt: new Date(s.created_at as string), hasMessage: Boolean(s.has_message) };
  }
  const run = <T>(c: Context<E>, fn: (tx: Tx, w: Widget) => Promise<T>) => withContext(deps.workerDb, { workspaceId: c.get("widget").workspaceId }, (tx) => fn(tx, c.get("widget")));
  const invalid = (c: Context) => err(c, 401, "session_invalid", "Your chat session ended. Start again.");
  const disabled = (c: Context) => err(c, 403, "widget_disabled", "Chat is not available right now.");

  r.get("/:key/config", (c) => (configIp.allow(`cfg:${clientIp(c)}`) ? c.json(c.get("widget").config) : tooMany(c)));

  r.post("/:key/sessions", async (c) => {
    const w = c.get("widget");
    if (!w.enabled) return disabled(c);
    if (!sessionsIp.allow(`ip:${clientIp(c)}`) || !sessionsWidget.allow(`w:${w.id}`)) return tooMany(c);
    const token = randomBytes(32).toString("base64url"); // 256 bits, 43 characters; only its hash is stored and it is shown once
    const ipHash = sha256(`${w.workspaceId}:${clientIp(c)}`).slice(0, 16);
    const ua = c.get("preview") ? "CRM preview" : (c.req.header("user-agent") ?? "").replace(/\p{Cc}/gu, "").slice(0, 200) || null; // preview sessions are marked here (D272)
    const exp = await run(c, async (tx) => {
      for (let i = 0; i < 5; i++) {
        const ref = randomDigits(); // numeric because platform_identities.external_user_id is digits-only for every channel
        try {
          const row = await tx.transaction(async (sp) => rowsOf(await sp.execute(sql`
            INSERT INTO chat_visitor_sessions (workspace_id, widget_id, token_hash, visitor_ref, ip_hash, user_agent) VALUES (${w.workspaceId}, ${w.id}, ${sha256(token)}, ${ref}, ${ipHash}, ${ua}) RETURNING expires_at`))[0]!);
          return new Date(row.expires_at as string).toISOString();
        } catch (e) {
          if ((e as { cause?: { code?: string } }).cause?.code !== "23505") throw e;
        }
      }
      throw new Error("no_free_visitor_ref");
    });
    return c.json({ token, expiresAt: exp }, 201);
  });

  /** Creates the contact, identity and conversation of a visitor the first time one is needed (first message or pre-chat form). Serialised per session. */
  async function ensureConversation(tx: Tx, w: Widget, s: Session): Promise<{ conversationId: string; contactId: string }> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`webchat:${s.id}`}, 0))`);
    const cur = rowsOf(await tx.execute(sql`SELECT contact_id, conversation_id FROM chat_visitor_sessions WHERE workspace_id = ${w.workspaceId} AND id = ${s.id}`))[0]!;
    if (cur.conversation_id) return { conversationId: cur.conversation_id as string, contactId: cur.contact_id as string };
    const stage = rowsOf(await tx.execute(sql`SELECT id FROM lifecycle_stages WHERE workspace_id = ${w.workspaceId} AND archived_at IS NULL ORDER BY position LIMIT 1`))[0];
    if (!stage) throw new Error("no_lifecycle_stage");
    // The placeholder shape is the one the database lets the worker role replace later (contacts_worker_name_guard), so a pre-chat name can still be saved.
    const contact = rowsOf(await tx.execute(sql`INSERT INTO contacts (workspace_id, name, lifecycle_stage_id, source) VALUES (${w.workspaceId}, ${`Web chat user ${s.visitorRef.slice(-4)}`}, ${stage.id as string}, 'web_chat') RETURNING id`))[0]!;
    const identity = rowsOf(await tx.execute(sql`INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES (${w.workspaceId}, ${w.accountId}, ${s.visitorRef}, ${contact.id as string}) RETURNING id`))[0]!;
    const conv = rowsOf(await tx.execute(sql`INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id) VALUES (${w.workspaceId}, ${w.accountId}, ${identity.id as string}, ${contact.id as string}) RETURNING id`))[0]!;
    await tx.execute(sql`UPDATE chat_visitor_sessions SET contact_id = ${contact.id as string}, conversation_id = ${conv.id as string} WHERE workspace_id = ${w.workspaceId} AND id = ${s.id}`);
    return { conversationId: conv.id as string, contactId: contact.id as string };
  }

  r.get("/:key/messages", async (c) => {
    const w = c.get("widget");
    if (!w.enabled) return disabled(c);
    const afterRaw = c.req.query("after") ?? "0";
    if (!/^[0-9]{1,15}$/.test(afterRaw)) return err(c, 400, "invalid_query", "Invalid cursor.");
    const out = await run(c, async (tx) => {
      const s = await sessionOf(c, tx);
      if (!s) return null;
      if (!polls.allow(`poll:${s.id}`)) return "limited" as const;
      if (!s.conversationId) return [] as WidgetMessage[];
      // The visitor sees what they wrote and what agents actually sent. Pending, failed or unknown outbound rows are never shown.
      const rows = rowsOf(
        await tx.execute(sql`
          SELECT seq, direction, body, occurred_at FROM messages
          WHERE workspace_id = ${w.workspaceId} AND conversation_id = ${s.conversationId} AND seq > ${Number(afterRaw)} AND body IS NOT NULL AND (direction = 'in' OR (direction = 'out' AND delivery_state = 'sent'))
          ORDER BY seq LIMIT 100`),
      );
      return rows.map((m): WidgetMessage => ({ seq: Number(m.seq), from: m.direction === "in" ? "visitor" : "agent", body: m.body as string, at: new Date(m.occurred_at as string).toISOString() }));
    });
    if (out === null) return invalid(c);
    if (out === "limited") return tooMany(c);
    return c.json({ items: out });
  });

  r.post("/:key/messages", async (c) => {
    const w = c.get("widget");
    if (!w.enabled) return disabled(c);
    const raw = await c.req.json().catch(() => null);
    const parsed = hasNul(raw) ? null : WidgetSendBody.safeParse(raw);
    if (!parsed?.success) return err(c, 400, "invalid_body", parsed?.error.issues[0]?.message ?? "Write a message of 1 to 2000 characters.");
    const { body: text, website, clientId } = parsed.data;
    const res = await run(c, async (tx) => {
      const s = await sessionOf(c, tx);
      if (!s) return { bad: "session" as const };
      if (!messages.allow(`msg:${s.id}`)) return { bad: "limited" as const };
      // Honeypot: a field no human sees. A bot that fills it gets the normal answer and nothing is stored.
      if (website) return { fake: true as const };
      if (!s.hasMessage && now() - s.createdAt.getTime() < minFirst) return { bad: "fast" as const };
      const { conversationId, contactId } = await ensureConversation(tx, w, s);
      const ext = `wc:${clientId ?? randomUUID()}`;
      // pre-check under the session lock: a repeated client id returns the stored row (the seq trigger would burn a number on a conflicting insert)
      const prior = rowsOf(await tx.execute(sql`SELECT seq, body, occurred_at FROM messages WHERE integration_account_id = ${w.accountId} AND external_id = ${ext}`))[0];
      if (prior) return { msg: { seq: Number(prior.seq), from: "visitor" as const, body: prior.body as string, at: new Date(prior.occurred_at as string).toISOString() } };
      const ins = rowsOf(
        await tx.execute(sql`
          INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, attachments, delivery_state)
          VALUES (${w.workspaceId}, ${conversationId}, ${w.accountId}, 'in', ${ext}, 'contact', ${text}, '[]'::jsonb, 'received') RETURNING id, seq, occurred_at`),
      )[0]!;
      // A new inbound message reopens a resolved conversation and starts the contact's activity clock, as for every other channel.
      await tx.execute(sql`UPDATE conversations SET last_message_at = now(), last_inbound_at = now(), status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END, version = version + 1, updated_at = now() WHERE workspace_id = ${w.workspaceId} AND id = ${conversationId}`);
      await tx.execute(sql`UPDATE contacts SET last_activity_at = now() WHERE workspace_id = ${w.workspaceId} AND id = ${contactId}`);
      await saveExtracted(tx, { workspaceId: w.workspaceId, platform: "web_chat", contactId, conversationId, messageId: ins.id as string, text });
      return { msg: { seq: Number(ins.seq), from: "visitor" as const, body: text, at: new Date(ins.occurred_at as string).toISOString() } };
    });
    if ("bad" in res) return res.bad === "session" ? invalid(c) : res.bad === "limited" ? tooMany(c) : err(c, 429, "too_fast", "Please wait a second and send again.");
    if ("fake" in res) return c.json({ seq: 0, from: "visitor", body: text, at: new Date(now()).toISOString() }, 201);
    return c.json(res.msg, 201);
  });

  /** Optional pre-chat form: name and/or email. Creates the contact and conversation now so the details have somewhere to go; the first message may follow. */
  r.post("/:key/contact", async (c) => {
    const w = c.get("widget");
    if (!w.enabled) return disabled(c);
    const raw = await c.req.json().catch(() => null);
    const parsed = hasNul(raw) ? null : WidgetContactBody.safeParse(raw);
    if (!parsed?.success) return err(c, 400, "invalid_body", parsed?.error.issues[0]?.message ?? "Enter a name or an email.");
    const name = parsed.data.name?.replace(/\p{Cc}/gu, "").trim();
    const email = parsed.data.email?.toLowerCase();
    const res = await run(c, async (tx) => {
      const s = await sessionOf(c, tx);
      if (!s) return "session" as const;
      if (!contacts.allow(`contact:${s.id}`)) return "limited" as const;
      const { contactId } = await ensureConversation(tx, w, s);
      // Each change is its own savepoint: the database only lets the worker role replace a placeholder name and fill an empty email, so a second submit changes nothing and is not an error.
      if (name) await tx.transaction((sp) => sp.execute(sql`UPDATE contacts SET name = ${name}, version = version + 1, updated_at = now() WHERE workspace_id = ${w.workspaceId} AND id = ${contactId}`)).catch(() => undefined);
      if (email) await tx.transaction((sp) => sp.execute(sql`UPDATE contacts SET email = ${email}, email_normalized = ${email}, version = version + 1, updated_at = now() WHERE workspace_id = ${w.workspaceId} AND id = ${contactId} AND email IS NULL AND email_normalized IS NULL`)).catch(() => undefined);
      return "ok" as const;
    });
    if (res === "session") return invalid(c);
    if (res === "limited") return tooMany(c);
    return c.json({ ok: true });
  });

  return r;
}
