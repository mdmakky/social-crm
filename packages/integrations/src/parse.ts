export type MetaEvent =
  | { kind: "message"; mid: string; senderId: string; recipientId: string; timestampMs: number; text: string | null; attachments: { type: string; url: string | null }[]; isEcho: boolean }
  | { kind: "read"; userId: string; watermarkMs: number }
  | { kind: "delivery"; userId: string; watermarkMs: number }
  | { kind: "ignored"; reason: string };
export type ParsedEntry = { accountId: string; raw: unknown; events: MetaEvent[] };
export type ParseResult =
  | { ok: false; reason: "not_json" | "bad_shape" | "unsupported_object" }
  | { ok: true; platform: "messenger" | "instagram"; entries: ParsedEntry[] };

const ID = /^[1-9][0-9]{0,99}$/;
const MAX_ENTRIES = 100;
const MAX_EVENTS = 1000;
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
    const attachments: { type: string; url: string | null }[] = [];
    if (Array.isArray(msg.attachments)) {
      for (const a of msg.attachments.slice(0, 20)) {
        if (!isObj(a) || typeof a.type !== "string" || a.type.length > 50) continue;
        const u = isObj(a.payload) ? a.payload.url : null;
        attachments.push({ type: a.type, url: typeof u === "string" && u.length <= 2000 && u.startsWith("https://") ? u : null });
      }
    }
    if (text === null && attachments.length === 0) return { kind: "ignored", reason: "empty" };
    return { kind: "message", mid: msg.mid, senderId, recipientId, timestampMs, text, attachments, isEcho: msg.is_echo === true };
  }
  if (isObj(m.read)) {
    const w = tsOf(m.read.watermark);
    return w === null ? { kind: "ignored", reason: "bad_watermark" } : { kind: "read", userId: senderId, watermarkMs: w };
  }
  if (isObj(m.delivery)) {
    const w = tsOf(m.delivery.watermark);
    return w === null ? { kind: "ignored", reason: "bad_watermark" } : { kind: "delivery", userId: senderId, watermarkMs: w };
  }
  return { kind: "ignored", reason: "unsupported_event" };
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
