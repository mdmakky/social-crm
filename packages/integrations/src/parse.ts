/** A media reference. `url` is only ever a public https link (Messenger, Instagram). WhatsApp media is not public: only its id is kept here (url stays null), to be downloaded later with the account token. */
export type MetaAttachment = { type: string; url: string | null; mediaId?: string; mime?: string; name?: string };
export type MetaEvent =
  | { kind: "message"; mid: string; senderId: string; recipientId: string; timestampMs: number; text: string | null; attachments: MetaAttachment[]; isEcho: boolean }
  /** WhatsApp status of a message WE sent (matched by message id): only delivered and read are used, the rest is ignored. */
  | { kind: "status"; mid: string; status: "delivered" | "read"; userId: string; timestampMs: number }
  | { kind: "read"; userId: string; watermarkMs: number }
  | { kind: "delivery"; userId: string; watermarkMs: number }
  | { kind: "ignored"; reason: string };
export type ParsedEntry = { accountId: string; raw: unknown; events: MetaEvent[] };
export type ParseResult =
  | { ok: false; reason: "not_json" | "bad_shape" | "unsupported_object" }
  | { ok: true; platform: "messenger" | "instagram" | "whatsapp"; entries: ParsedEntry[] };

const ID = /^[1-9][0-9]{0,99}$/;
const MAX_ENTRIES = 100;
const MAX_EVENTS = 1000;
// WhatsApp batches up to 1000 updates per POST (Meta), and each change becomes one stored row, so the cap is not the Messenger one: dropping a change would lose messages that Meta will not resend.
const MAX_WA_CHANGES = 1000;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const idOf = (v: unknown): string | null => (isObj(v) && typeof v.id === "string" && ID.test(v.id) ? v.id : null);
const tsOf = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

function parseEvent(m: unknown): MetaEvent {
  if (!isObj(m)) return { kind: "ignored", reason: "bad_shape" };
  const senderId = idOf(m.sender);
  const recipientId = idOf(m.recipient);
  if (!senderId || !recipientId) return { kind: "ignored", reason: "bad_id" };
  if (isObj(m.message)) {
    const msg = m.message;
    const timestampMs = tsOf(m.timestamp);
    if (timestampMs === null) return { kind: "ignored", reason: "bad_timestamp" };
    if (typeof msg.mid !== "string" || msg.mid === "" || msg.mid.length > 255) return { kind: "ignored", reason: "bad_mid" };
    const text = typeof msg.text === "string" && msg.text !== "" ? msg.text.slice(0, 20000) : null;
    const attachments: MetaAttachment[] = [];
    if (Array.isArray(msg.attachments)) {
      for (const a of msg.attachments.slice(0, 20)) {
        if (!isObj(a) || typeof a.type !== "string" || a.type.length > 50) continue;
        const u = isObj(a.payload) ? a.payload.url : null;
        attachments.push({ type: a.type, url: typeof u === "string" && u.length <= 2000 && u.startsWith("https://") ? u : null });
      }
    }
    // Instagram marks media it cannot give us (shares, some story replies) as is_unsupported: keep a visible placeholder instead of dropping the message silently.
    if (text === null && attachments.length === 0 && msg.is_unsupported === true) attachments.push({ type: "unsupported", url: null });
    if (text === null && attachments.length === 0) return { kind: "ignored", reason: "empty" };
    return { kind: "message", mid: msg.mid, senderId, recipientId, timestampMs, text, attachments, isEcho: msg.is_echo === true };
  }
  if (isObj(m.read)) {
    // Messenger sends a watermark; Instagram's messaging_seen carries read.mid (docs 2026-11-14), so the event time is the watermark there.
    const w = tsOf(m.read.watermark) ?? (typeof m.read.mid === "string" ? tsOf(m.timestamp) : null);
    return w === null ? { kind: "ignored", reason: "bad_watermark" } : { kind: "read", userId: senderId, watermarkMs: w };
  }
  if (isObj(m.delivery)) {
    const w = tsOf(m.delivery.watermark);
    return w === null ? { kind: "ignored", reason: "bad_watermark" } : { kind: "delivery", userId: senderId, watermarkMs: w };
  }
  return { kind: "ignored", reason: "unsupported_event" };
}

const SECONDS = /^[0-9]{1,12}$/;
const MEDIA_ID = /^[0-9A-Za-z_-]{1,100}$/;
const WA_MEDIA = new Set(["image", "video", "document", "audio", "sticker"]);
const short = (v: unknown, max: number): string | undefined => (typeof v === "string" && v !== "" && v.length <= max ? v : undefined);
const secondsToMs = (v: unknown): number | null => {
  const n = typeof v === "string" && SECONDS.test(v) ? Number(v) : typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v < 1e12 ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
};

/** One WhatsApp inbound message (value.messages[]). The sender is identified by wa_id (`from`). A sender that has only a business-scoped user id (username users, no phone) is ignored with its own reason, not guessed. */
function parseWaMessage(m: unknown, phoneNumberId: string): MetaEvent {
  if (!isObj(m)) return { kind: "ignored", reason: "bad_shape" };
  const from = typeof m.from === "string" && ID.test(m.from) ? m.from : null;
  if (!from) return { kind: "ignored", reason: typeof m.from_user_id === "string" ? "bsuid_only" : "bad_id" };
  const mid = short(m.id, 255);
  if (!mid) return { kind: "ignored", reason: "bad_mid" };
  const timestampMs = secondsToMs(m.timestamp);
  if (timestampMs === null) return { kind: "ignored", reason: "bad_timestamp" };
  const type = typeof m.type === "string" ? m.type : "";
  const body = (v: unknown) => (typeof v === "string" && v !== "" ? v.slice(0, 20000) : null);
  let text: string | null = null;
  const attachments: MetaAttachment[] = [];
  if (type === "text") text = isObj(m.text) ? body(m.text.body) : null;
  else if (type === "button") text = isObj(m.button) ? body(m.button.text) : null;
  else if (type === "interactive" && isObj(m.interactive)) {
    const i = m.interactive;
    const reply = isObj(i.button_reply) ? i.button_reply : isObj(i.list_reply) ? i.list_reply : null;
    text = reply ? body(reply.title) : null;
    if (text === null) attachments.push({ type: "unsupported", url: null });
  } else if (WA_MEDIA.has(type) && isObj(m[type])) {
    const o = m[type] as Record<string, unknown>;
    const a: MetaAttachment = { type, url: null };
    if (typeof o.id === "string" && MEDIA_ID.test(o.id)) a.mediaId = o.id;
    const mime = short(o.mime_type, 100);
    if (mime) a.mime = mime;
    const name = short(o.filename, 200);
    if (name) a.name = name;
    attachments.push(a);
    text = body(o.caption); // the caption is the message text
  } else if (type === "reaction" || type === "system") return { kind: "ignored", reason: type };
  else attachments.push({ type: type === "location" ? "location" : "unsupported", url: null }); // location, contacts, order, unsupported, future types: a visible placeholder instead of a silent drop
  if (text === null && attachments.length === 0) return { kind: "ignored", reason: "empty" };
  return { kind: "message", mid, senderId: from, recipientId: phoneNumberId, timestampMs, text, attachments, isEcho: false };
}

/** One WhatsApp status of a message we sent (value.statuses[]). The status is applied only if the message id is one of ours (see process.ts). */
function parseWaStatus(s: unknown): MetaEvent {
  if (!isObj(s)) return { kind: "ignored", reason: "bad_shape" };
  const mid = short(s.id, 255);
  const userId = typeof s.recipient_id === "string" && ID.test(s.recipient_id) ? s.recipient_id : null;
  const timestampMs = secondsToMs(s.timestamp);
  if (!mid || !userId || timestampMs === null) return { kind: "ignored", reason: "bad_status" };
  if (s.status === "delivered" || s.status === "read") return { kind: "status", mid, status: s.status, userId, timestampMs };
  return { kind: "ignored", reason: "unused_status" };
}

/** WhatsApp: object "whatsapp_business_account", entry[].id is the WABA id and is NOT the routing key. Each changes[] item (field "messages") is its own entry, routed by value.metadata.phone_number_id. */
function parseWhatsApp(body: Record<string, unknown>): ParseResult {
  const entries: ParsedEntry[] = [];
  for (const e of body.entry as unknown[]) {
    if (!isObj(e) || !Array.isArray(e.changes)) continue;
    for (const ch of e.changes) {
      if (entries.length >= MAX_WA_CHANGES) break;
      if (!isObj(ch) || ch.field !== "messages" || !isObj(ch.value)) continue; // other fields (account_update, templates, ...) are not part of this slice
      const v = ch.value;
      const phoneNumberId = isObj(v.metadata) && typeof v.metadata.phone_number_id === "string" && ID.test(v.metadata.phone_number_id) ? v.metadata.phone_number_id : null;
      if (!phoneNumberId) continue;
      const messages = Array.isArray(v.messages) ? v.messages.slice(0, MAX_EVENTS).map((m) => parseWaMessage(m, phoneNumberId)) : [];
      const statuses = Array.isArray(v.statuses) ? v.statuses.slice(0, MAX_EVENTS).map(parseWaStatus) : [];
      if (messages.length + statuses.length === 0) continue;
      entries.push({ accountId: phoneNumberId, raw: { id: e.id, changes: [ch] }, events: [...messages, ...statuses] });
    }
  }
  return { ok: true, platform: "whatsapp", entries };
}

export function parseMetaWebhook(raw: Uint8Array): ParseResult {
  try {
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      return { ok: false, reason: "not_json" };
    }
    if (!isObj(body) || !Array.isArray(body.entry)) return { ok: false, reason: "bad_shape" };
    if (body.object === "whatsapp_business_account") return parseWhatsApp(body);
    const platform = body.object === "page" ? "messenger" : body.object === "instagram" ? "instagram" : null;
    if (!platform) return { ok: false, reason: "unsupported_object" };
    const entries: ParsedEntry[] = [];
    for (const e of body.entry.slice(0, MAX_ENTRIES)) {
      if (!isObj(e) || typeof e.id !== "string" && typeof e.id !== "number") continue;
      const accountId = String(e.id);
      if (!ID.test(accountId)) continue;
      const messaging = Array.isArray(e.messaging) ? e.messaging.slice(0, MAX_EVENTS) : [];
      entries.push({ accountId, raw: e, events: messaging.map(parseEvent) });
    }
    return { ok: true, platform, entries };
  } catch {
    return { ok: false, reason: "bad_shape" };
  }
}
