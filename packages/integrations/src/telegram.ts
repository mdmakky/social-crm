import { createHash, timingSafeEqual } from "node:crypto";
import { cleanProfileName, SendError } from "./graph.ts";
import type { MetaEvent, MetaAttachment } from "./parse.ts";

/**
 * Telegram Bot API client, parser and mock. Facts come from core.telegram.org/bots/api, /faq and /webhooks (docs/integrations/telegram.md). The REAL client (createTelegramClient) has NEVER been run
 * against Telegram: everything marked UNVERIFIED stays unverified until a recorded real request. The mock (createMockTelegram) is MOCK ONLY and proves our code, not Telegram.
 * The bot token is part of every Bot API URL (Telegram's design): URLs are built only inside this file, never logged, never put in an error message.
 */

export type TelegramBot = { id: string; username: string | null; firstName: string };
export type TelegramWebhookInfo = { url: string; pendingUpdateCount: number; lastErrorAt: Date | null; lastErrorMessage: string | null };
export type SetWebhookArgs = { url: string; secretToken: string; maxConnections: number; allowedUpdates: string[]; dropPendingUpdates: boolean };

/** Updates we ask Telegram for. Always sent explicitly: omitting it keeps the previous setting (docs). edited_message is deliberately not requested. */
export const TELEGRAM_ALLOWED_UPDATES = ["message", "my_chat_member"];
/** Bot API sendMessage text limit: 1-4096 characters after entities parsing (docs). We send plain text, no parse_mode, and refuse longer text with a 422 instead of splitting it. */
export const TELEGRAM_MAX_TEXT = 4096;

/** Failure of a getMe / webhook call. `kind` is what the caller needs to answer a person; no response text is kept. */
export class TelegramError extends Error {
  constructor(readonly kind: "auth" | "throttle" | "other", readonly status: number, readonly code: number | null) {
    super(`telegram_error_${code ?? status}`);
  }
}

/** A sendMessage failure. `reason` is the code stored on the message (telegram_* so the inbox words them for Telegram, not Meta). `rejected` = Telegram refused (nothing delivered); `ambiguous` = may have been delivered (never retried). Extends SendError so the shared send pipeline handles it. */
export class TelegramSendError extends SendError {
  constructor(outcome: "rejected" | "ambiguous", httpStatus: number | null, code: number | null, readonly reason: string, readonly retryAfter: number | null = null) {
    super(outcome, httpStatus, code, null);
  }
}

export interface TelegramClient {
  getMe(token: string): Promise<TelegramBot>;
  setWebhook(token: string, a: SetWebhookArgs): Promise<void>;
  deleteWebhook(token: string): Promise<void>;
  getWebhookInfo(token: string): Promise<TelegramWebhookInfo>;
  /** Plain text to a private chat. Returns `${chatId}:${message_id}` (message ids are unique per chat only). Throws TelegramSendError. */
  sendMessage(token: string, chatId: string, text: string): Promise<{ messageId: string }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Maps a failed sendMessage to a stored reason. 403 (bot blocked / user deactivated) and 400 "chat not found" mean the person cannot be reached: the wording is UNVERIFIED, so it is matched loosely and everything else is a generic refusal. */
export function classifyTelegramSend(status: number | null, code: number | null, description: string | null, retryAfter: number | null): TelegramSendError {
  if (status === null || status >= 500 || code === null) return new TelegramSendError("ambiguous", status, code, status === null ? "no_response" : "unreadable_response");
  if (code === 429 || status === 429) return new TelegramSendError("rejected", status, 429, "telegram_rate_limited", retryAfter);
  if (code === 401) return new TelegramSendError("rejected", status, code, "telegram_token_invalid");
  if (code === 403 || (code === 400 && /chat not found|user is deactivated/i.test(description ?? ""))) return new TelegramSendError("rejected", status, code, "not_reachable");
  return new TelegramSendError("rejected", status, code, "telegram_rejected");
}

export function createTelegramClient(cfg: { fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number } = {}): TelegramClient {
  const f = cfg.fetch ?? fetch;
  const base = cfg.baseUrl ?? "https://api.telegram.org";
  const timeoutMs = cfg.timeoutMs ?? 10_000;
  type Raw = { status: number | null; json: Record<string, unknown> | null };
  async function call(token: string, method: string, payload?: Record<string, unknown>): Promise<Raw> {
    try {
      const res = await f(`${base}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? {}), signal: AbortSignal.timeout(timeoutMs) });
      const json = await res.json().catch(() => null);
      return { status: res.status, json: isObj(json) ? json : null };
    } catch {
      return { status: null, json: null };
    }
  }
  const fail = (r: Raw): never => {
    const code = typeof r.json?.error_code === "number" ? r.json.error_code : null;
    const status = r.status ?? 0;
    throw new TelegramError(code === 401 || status === 401 ? "auth" : code === 429 || status === 429 ? "throttle" : "other", status, code);
  };
  return {
    async getMe(token) {
      const r = await call(token, "getMe");
      const u = r.json?.result;
      if (r.json?.ok !== true || !isObj(u) || typeof u.id !== "number" || u.is_bot !== true) return fail(r);
      return { id: String(u.id), username: typeof u.username === "string" ? u.username : null, firstName: typeof u.first_name === "string" ? u.first_name : "" };
    },
    async setWebhook(token, a) {
      const r = await call(token, "setWebhook", { url: a.url, secret_token: a.secretToken, max_connections: a.maxConnections, allowed_updates: a.allowedUpdates, drop_pending_updates: a.dropPendingUpdates });
      if (r.json?.ok !== true) fail(r);
    },
    async deleteWebhook(token) {
      const r = await call(token, "deleteWebhook", { drop_pending_updates: false });
      if (r.json?.ok !== true) fail(r);
    },
    async getWebhookInfo(token) {
      const r = await call(token, "getWebhookInfo");
      const i = r.json?.result;
      if (r.json?.ok !== true || !isObj(i)) return fail(r);
      const at = typeof i.last_error_date === "number" ? new Date(i.last_error_date * 1000) : null;
      return { url: typeof i.url === "string" ? i.url : "", pendingUpdateCount: typeof i.pending_update_count === "number" ? i.pending_update_count : 0, lastErrorAt: at, lastErrorMessage: typeof i.last_error_message === "string" ? i.last_error_message.slice(0, 200) : null };
    },
    async sendMessage(token, chatId, text) {
      const r = await call(token, "sendMessage", { chat_id: Number(chatId), text }); // no parse_mode: plain text
      const m = r.json?.result;
      if (r.json?.ok === true && isObj(m) && typeof m.message_id === "number") return { messageId: `${chatId}:${m.message_id}` };
      if (r.status !== null && r.status < 300) throw classifyTelegramSend(r.status, null, null, null); // 2xx without a readable message id: it may have been delivered
      const params = r.json?.parameters;
      throw classifyTelegramSend(r.status, typeof r.json?.error_code === "number" ? r.json.error_code : null, typeof r.json?.description === "string" ? r.json.description : null, isObj(params) && typeof params.retry_after === "number" ? params.retry_after : null);
    },
  };
}

// ---- webhook secret ----------------------------------------------------------------------------
/** Only the SHA-256 of the secret_token is stored: the token is random (256 bits), so a fast hash is enough, and the plain value exists only in the setWebhook call. */
export const hashTelegramSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");
/** Constant time. A missing or wrong header, or an unknown account (`expectedHash` null), is false. Never throws. */
export function verifyTelegramSecret(header: string | null | undefined, expectedHash: string | null): boolean {
  const want = Buffer.from(expectedHash && /^[0-9a-f]{64}$/.test(expectedHash) ? expectedHash : "0".repeat(64), "hex");
  const got = createHash("sha256").update(typeof header === "string" ? header : "").digest();
  const same = timingSafeEqual(got, want);
  return same && expectedHash !== null && typeof header === "string" && header !== "";
}

// ---- parser ------------------------------------------------------------------------------------
export type TelegramParse = { ok: false; reason: "not_json" | "bad_shape" } | { ok: true; updateId: number; events: MetaEvent[] };
const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);
const short = (v: unknown, max: number): string | undefined => (typeof v === "string" && v !== "" && v.length <= max ? v : undefined);
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const clean = (v: string | undefined) => v?.replace(/[\u0000-\u001f\u007f]/g, "");

function attachmentsOf(m: Record<string, unknown>): MetaAttachment[] {
  const out: MetaAttachment[] = [];
  const add = (type: string, o: unknown) => {
    // file_id is kept as metadata only (a file URL embeds the bot token, so none is ever stored); `url` stays null and the inbox shows a placeholder.
    const a: MetaAttachment = { type, url: null };
    if (isObj(o)) {
      const id = short(o.file_id, 200);
      if (id) a.fileId = id;
      const mime = short(o.mime_type, 100);
      if (mime) a.mime = mime;
      const name = clean(short(o.file_name, 200));
      if (name) a.name = name;
    }
    out.push(a);
  };
  if (Array.isArray(m.photo) && m.photo.length > 0) add("photo", m.photo[m.photo.length - 1]); // sizes are listed smallest to largest
  for (const t of ["document", "voice", "video", "audio", "video_note", "animation", "sticker"]) if (isObj(m[t])) add(t, m[t]);
  if (out.length === 0 && ["location", "contact", "venue", "poll", "dice"].some((t) => isObj(m[t]))) out.push({ type: "unsupported", url: null });
  return out;
}

/**
 * One Telegram Update. Only `message` and `my_chat_member` in a PRIVATE chat are used; edited_message, groups, channels, business messages and every other update type are ignored.
 * The sender is identified by the numeric user id (stable); the username is optional and mutable, so it is display only. `botId` comes from the account the update was routed to.
 */
export function parseTelegramUpdate(raw: Uint8Array, botId: string): TelegramParse {
  let u: unknown;
  try { u = JSON.parse(Buffer.from(raw).toString("utf8")); } catch { return { ok: false, reason: "not_json" }; }
  const updateId = isObj(u) && typeof u.update_id === "number" && Number.isSafeInteger(u.update_id) && u.update_id >= 0 ? u.update_id : null;
  if (!isObj(u) || updateId === null) return { ok: false, reason: "bad_shape" };
  const ign = (reason: string): TelegramParse => ({ ok: true, updateId, events: [{ kind: "ignored", reason }] });
  if (isObj(u.my_chat_member)) {
    const c = u.my_chat_member;
    const chatId = isObj(c.chat) && c.chat.type === "private" ? posInt(c.chat.id) : null;
    const status = isObj(c.new_chat_member) ? c.new_chat_member.status : null;
    const at = posInt(c.date);
    if (!chatId || !at || (status !== "kicked" && status !== "member")) return ign("unsupported_member_update");
    return { ok: true, updateId, events: [{ kind: "reachability", userId: String(chatId), unreachable: status === "kicked", timestampMs: at * 1000 }] };
  }
  if (!isObj(u.message)) return ign(typeof u.edited_message !== "undefined" ? "edited_message" : "unsupported_update");
  const m = u.message;
  if (!isObj(m.chat) || m.chat.type !== "private") return ign("not_private");
  const chatId = posInt(m.chat.id);
  const from = isObj(m.from) ? m.from : null;
  const userId = from ? posInt(from.id) : null;
  const messageId = posInt(m.message_id);
  const at = posInt(m.date);
  if (!chatId || !userId || !messageId || !at || !from) return ign("bad_shape");
  if (from.is_bot === true) return ign("from_bot");
  if (chatId !== userId) return ign("id_mismatch"); // in a private chat the chat id is the user id
  const text = typeof m.text === "string" && m.text !== "" ? m.text.slice(0, 20000) : typeof m.caption === "string" && m.caption !== "" ? m.caption.slice(0, 20000) : null;
  const attachments = attachmentsOf(m);
  if (text === null && attachments.length === 0) return ign("empty");
  const profileName = cleanProfileName([from.first_name, from.last_name].filter((x) => typeof x === "string").join(" ")) ?? cleanProfileName(from.username);
  return { ok: true, updateId, events: [{ kind: "message", mid: `${chatId}:${messageId}`, senderId: String(userId), recipientId: botId, timestampMs: at * 1000, text, attachments, isEcho: false, profileName }] };
}

// ---- MOCK ONLY ---------------------------------------------------------------------------------
/** MOCK ONLY: never a real token. The E2E spec pastes this value. */
export const MOCK_TELEGRAM_TOKEN = "7000000001:mock-telegram-token-not-real-0000";
export type MockTelegramState = {
  bots: Map<string, { id: string; username: string }>;
  webhooks: Map<string, SetWebhookArgs>;
  sent: { chatId: string; text: string }[];
  calls: string[];
};
export function createMockTelegram(state?: Partial<MockTelegramState>): TelegramClient & { state: MockTelegramState } {
  const s: MockTelegramState = { bots: state?.bots ?? new Map([[MOCK_TELEGRAM_TOKEN, { id: "7000000001", username: "mock_support_bot" }]]), webhooks: state?.webhooks ?? new Map(), sent: state?.sent ?? [], calls: state?.calls ?? [] };
  const bot = (t: string) => {
    const b = s.bots.get(t);
    if (!b) throw new TelegramError("auth", 401, 401);
    return b;
  };
  let n = 0;
  return {
    state: s,
    async getMe(t) { s.calls.push("getMe"); const b = bot(t); return { id: b.id, username: b.username, firstName: "Mock Support Bot" }; },
    async setWebhook(t, a) { s.calls.push("setWebhook"); bot(t); s.webhooks.set(t, a); },
    async deleteWebhook(t) { s.calls.push("deleteWebhook"); bot(t); s.webhooks.delete(t); },
    async getWebhookInfo(t) { s.calls.push("getWebhookInfo"); bot(t); return { url: s.webhooks.get(t)?.url ?? "", pendingUpdateCount: 0, lastErrorAt: null, lastErrorMessage: null }; },
    async sendMessage(t, chatId, text) { s.calls.push("sendMessage"); bot(t); s.sent.push({ chatId, text }); return { messageId: `${chatId}:${9000 + ++n}` }; },
  };
}

/** MOCK ONLY fixtures built from the Update shape in the Bot API reference. Not captured from Telegram. */
export const tgUser = (id: number, extra: Record<string, unknown> = {}) => ({ id, is_bot: false, first_name: "Mina", last_name: "Rahman", language_code: "en", ...extra });
export const tgPrivateText = (a: { updateId: number; userId: number; messageId: number; text?: string; extra?: Record<string, unknown>; date?: number; user?: Record<string, unknown> }) => ({
  update_id: a.updateId,
  message: { message_id: a.messageId, from: tgUser(a.userId, a.user), chat: { id: a.userId, type: "private", first_name: "Mina" }, date: a.date ?? Math.floor(Date.now() / 1000), ...(a.text !== undefined ? { text: a.text } : {}), ...(a.extra ?? {}) },
});
export const tgMyChatMember = (a: { updateId: number; userId: number; status: "kicked" | "member"; date?: number }) => ({
  update_id: a.updateId,
  my_chat_member: { chat: { id: a.userId, type: "private" }, from: tgUser(a.userId), date: a.date ?? Math.floor(Date.now() / 1000), old_chat_member: { status: a.status === "kicked" ? "member" : "kicked" }, new_chat_member: { status: a.status } },
});
