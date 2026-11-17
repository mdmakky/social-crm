import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Email channel ports and the Mailgun adapter. EVERYTHING HERE IS MOCK-TESTED ONLY: no request to Mailgun has ever been made from this code.
 * Facts confirmed from Mailgun's documentation on 2026-11-17: webhook signature = hex HMAC-SHA256 of timestamp+token with the account Webhook Signing Key (not the API key); routes forward() POST fields
 * (signature, timestamp, token, subject, sender, from, recipient, message-headers, body-plain, body-html, stripped-text, attachment-count, attachment-N); send API = POST /v3/{domain}/messages with HTTP basic auth and h:<Header> custom headers.
 * Everything marked UNVERIFIED below is a guess that must be checked against a real Mailgun account before the channel is called working.
 */

// ---------- ports ----------

export type OutboundEmail = {
  from: { name: string; address: string };
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  /** Our own generated Message-ID, without angle brackets. */
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  /** "no" for a human reply from the inbox; "auto-generated" for system mail (password reset, invitations). */
  autoSubmitted: "no" | "auto-generated";
};

/** outcome "rejected": the provider refused it, nothing was sent. "ambiguous": we cannot tell (timeout, 5xx, unreadable answer); never retried. */
export class EmailSendError extends Error {
  constructor(readonly outcome: "rejected" | "ambiguous", readonly status: number | null, readonly code: string) {
    super(code);
  }
}

export interface EmailProvider {
  readonly name: "mock" | "mailgun";
  send(m: OutboundEmail): Promise<{ providerId: string }>;
}

// ---------- small helpers (provider neutral) ----------

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export const randomToken = (len: number) => Array.from(randomBytes(len), (b) => B32[b % 32]).join("");
/** Header values never contain CR/LF (header injection) or other control characters. */
export const cleanHeader = (s: string, max = 900) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
export const normalizeMessageId = (s: string | null | undefined): string | null => {
  const m = /<([^<>\s]{1,900})>/.exec(s ?? "");
  const v = (m ? m[1]! : (s ?? "").trim()).slice(0, 900);
  return v === "" || /\s/.test(v) ? null : v;
};
const idsOf = (s: string | null | undefined) => [...(s ?? "").matchAll(/<([^<>\s]{1,900})>/g)].map((m) => m[1]!);

export function parseAddress(raw: string | null | undefined): { name: string; address: string } | null {
  const s = (raw ?? "").trim();
  const m = /^(.*?)<([^<>\s]+)>\s*$/.exec(s);
  const address = (m ? m[2]! : s).trim().toLowerCase();
  if (!/^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/.test(address) || address.endsWith(".") || !address.split("@")[1]!.includes(".")) return null;
  return { name: cleanHeader((m ? m[1]! : "").replace(/^"|"$/g, "")).slice(0, 80), address };
}

export const supportAddress = (token: string, domain: string, convToken?: string) => `support${"+"}${token}${convToken ? `-${convToken}` : ""}@${domain}`;
/** The token (and optional conversation token) of a recipient `support+<token>[-<convToken>]@<inboundDomain>`. Anything else is null: the workspace is never guessed. */
export function parseRecipient(recipient: string | null | undefined, inboundDomain: string): { token: string; convToken: string | null } | null {
  const a = parseAddress(recipient);
  if (!a) return null;
  const [local, dom] = a.address.split("@") as [string, string];
  if (dom !== inboundDomain.toLowerCase()) return null;
  const m = /^support\+([a-z2-7]{20})(?:-([a-z2-7]{16}))?$/.exec(local);
  return m ? { token: m[1]!, convToken: m[2] ?? null } : null;
}
export const newMessageId = (token: string, domain: string) => `crm.${token}.${randomToken(16)}@${domain}`;
/** The account token embedded in a Message-ID we generated (used to route bounce events to an account). */
export const tokenOfMessageId = (id: string) => /^crm\.([a-z2-7]{20})\.[a-z2-7]{16}@/.exec(id)?.[1] ?? null;
export const replySubject = (s: string | null | undefined) => {
  const base = cleanHeader(s ?? "", 400).replace(/^(\s*re\s*:\s*)+/i, "").trim();
  return `Re: ${base === "" ? "(no subject)" : base}`;
};

/** Plain-text quote stripper: cuts at "On ... wrote:" (also when the line is wrapped), at an "Original Message" marker, and drops a trailing run of ">" lines. Keeps the text unchanged if nothing would be left. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    const next = (lines[i + 1] ?? "").trim();
    if ((/^On\s.{1,300}\swrote:$/i.test(l)) || (/^On\s.{1,300}$/i.test(l) && /^(.{0,200}\s)?wrote:$/i.test(next)) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(l)) { cut = i; break; }
  }
  let kept = lines.slice(0, cut);
  while (kept.length && (kept[kept.length - 1]!.trim() === "" || kept[kept.length - 1]!.startsWith(">"))) kept.pop();
  const out = kept.join("\n").trim();
  return out === "" ? text.replace(/\r\n?/g, "\n").trim() : out;
}

// ---------- Mailgun: webhook signature ----------

export type SignatureCheck = { ok: true; token: string } | { ok: false; reason: "bad_signature" | "stale" | "malformed" };
/** hex HMAC-SHA256(timestamp + token) with the signing key (confirmed in Mailgun docs 2026-11-17). Constant-time compare; timestamps further than maxSkewMs from now are refused (docs: be lenient; 15 minutes by default). Replay of a token is handled by the caller (TokenSeen). */
export function verifyMailgunSignature(f: { timestamp?: string | null; token?: string | null; signature?: string | null }, signingKeys: string[], nowMs: number, maxSkewMs = 15 * 60_000): SignatureCheck {
  const { timestamp, token, signature } = f;
  if (typeof timestamp !== "string" || typeof token !== "string" || typeof signature !== "string" || !/^[0-9]{9,12}$/.test(timestamp) || token.length < 8 || token.length > 200 || !/^[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: "malformed" };
  const got = Buffer.from(signature, "hex");
  let ok = false;
  for (const k of signingKeys) {
    if (!k) continue;
    if (timingSafeEqual(got, createHmac("sha256", k).update(timestamp + token).digest())) ok = true; // no early exit
  }
  if (!ok) return { ok: false, reason: "bad_signature" };
  if (Math.abs(nowMs - Number(timestamp) * 1000) > maxSkewMs) return { ok: false, reason: "stale" };
  return { ok: true, token };
}
export const signMailgun = (timestamp: string, token: string, key: string) => createHmac("sha256", key).update(timestamp + token).digest("hex");

/** Remembers tokens for a while so a captured request cannot be replayed. In memory (single API instance); the Message-ID idempotency in the database is the backstop across instances. */
export class TokenSeen {
  private m = new Map<string, number>();
  constructor(private readonly ttlMs = 30 * 60_000, private readonly max = 50_000) {}
  has(token: string, now: number): boolean {
    return (this.m.get(token) ?? 0) > now;
  }
  /** true the first time a token is seen. */
  firstUse(token: string, now: number): boolean {
    for (const [k, t] of this.m) if (t <= now) this.m.delete(k); else break; // insertion order = expiry order
    if (this.m.has(token)) return false;
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value!);
    this.m.set(token, now + this.ttlMs);
    return true;
  }
}

// ---------- Mailgun: inbound route payload -> neutral event ----------

export type InboundEmail = {
  kind: "inbound";
  recipient: string;
  fromAddress: string | null;
  fromName: string;
  subject: string;
  /** Plain text only, quotes stripped, never HTML. */
  text: string;
  hasText: boolean;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  /** Why this message must not become a conversation message (auto-generated mail), else null. */
  ignoreReason: string | null;
  senderVerified: boolean;
  attachments: { name: string; size: number | null }[];
  attachmentCount: number;
  timestamp: number;
  /** Conversation token of the recipient address (support+<token>-<convToken>@), set by the ingress. */
  convToken?: string;
};
export type BounceEvent = { kind: "bounce"; event: "bounce" | "complaint"; messageId: string; reason: string };
export type StoredEmailEvent = InboundEmail | BounceEvent;

export const MAX_TEXT_CHARS = 20000;
const NO_TEXT = "(This email has no plain text part. HTML is not shown here.)";
const AUTOMATED = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|donotreply|bounce[s]?|notifications?)$/i;

const verdict = (v: string | null | undefined) => (v ?? "").trim().toLowerCase().split(/[\s;(]/)[0] ?? "";
const baseDomain = (a: string) => a.split("@")[1]?.toLowerCase().split(".").slice(-2).join(".") ?? "";

/**
 * Parses the form fields Mailgun forwards for a route (field names confirmed 2026-11-17, except the verdicts).
 * UNVERIFIED: SPF and DKIM verdicts are read from the `X-Mailgun-Spf` and `X-Mailgun-Dkim-Check-Result` message headers (or fields of the same name). A sender counts as verified only when BOTH say "pass" and
 * the envelope sender and the From header share a registrable domain (a cheap stand-in for alignment; the two-label domain split is wrong for suffixes like co.uk, which only makes it stricter or looser by one label, UNVERIFIED).
 */
export function parseMailgunInbound(f: Record<string, string>, files: { name: string; size: number }[] = []): InboundEmail | null {
  const recipient = f["recipient"];
  if (!recipient) return null;
  const headers = new Map<string, string>();
  try {
    const raw = JSON.parse(f["message-headers"] ?? "[]") as unknown;
    if (Array.isArray(raw)) for (const h of raw) if (Array.isArray(h) && typeof h[0] === "string" && typeof h[1] === "string" && !headers.has(h[0].toLowerCase())) headers.set(h[0].toLowerCase(), h[1]);
  } catch { /* unreadable header list: treated as no headers */ }
  const hdr = (n: string) => headers.get(n) ?? f[n] ?? null;
  const from = parseAddress(hdr("from") ?? f["from"] ?? f["sender"]);
  const envelope = f["sender"];
  const messageIdHeader = normalizeMessageId(hdr("message-id"));
  const bodyPlain = f["body-plain"] ?? "";
  const stripped = f["stripped-text"] ?? "";
  let text = (stripped.trim() !== "" ? stripped : bodyPlain.trim() !== "" ? stripQuoted(bodyPlain) : "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  const hasText = text !== "";
  if (!hasText) text = NO_TEXT;
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS - 20) + "\n[message cut]";
  const prec = (hdr("precedence") ?? "").trim().toLowerCase();
  const auto = (hdr("auto-submitted") ?? "").trim().toLowerCase();
  const ct = (hdr("content-type") ?? "").toLowerCase();
  let ignoreReason: string | null = null;
  if (auto !== "" && auto !== "no") ignoreReason = "auto_submitted";
  else if (["bulk", "junk", "list", "auto_reply"].includes(prec)) ignoreReason = "precedence";
  else if (headers.has("list-id") || headers.has("list-unsubscribe")) ignoreReason = "mailing_list";
  else if (ct.startsWith("multipart/report")) ignoreReason = "delivery_report";
  else if (envelope !== undefined && (envelope.trim() === "" || envelope.trim() === "<>")) ignoreReason = "empty_return_path";
  else if (from && AUTOMATED.test(from.address.split("@")[0]!)) ignoreReason = "automated_sender";
  else if (!from) ignoreReason = "no_sender";
  const spf = verdict(hdr("x-mailgun-spf")), dkim = verdict(hdr("x-mailgun-dkim-check-result"));
  const envAddr = parseAddress(envelope ?? "");
  const senderVerified = !!from && spf === "pass" && dkim === "pass" && !!envAddr && baseDomain(envAddr.address) === baseDomain(from.address);
  const named = [...files.map((a) => ({ name: cleanHeader(a.name, 100) || "file", size: a.size }))];
  const count = Math.max(Number(f["attachment-count"] ?? 0) || 0, named.length);
  const ts = Number(f["timestamp"]);
  return {
    kind: "inbound", recipient, fromAddress: from?.address ?? null, fromName: from?.name ?? "", subject: cleanHeader(f["subject"] ?? hdr("subject") ?? "", 300),
    text, hasText, messageId: messageIdHeader ?? "", inReplyTo: normalizeMessageId(hdr("in-reply-to")), references: idsOf(hdr("references")).slice(-50), ignoreReason, senderVerified,
    attachments: named.slice(0, 20), attachmentCount: Math.min(count, 1000), timestamp: Number.isFinite(ts) ? ts : 0,
  };
}

/**
 * Event webhook payload (bounces and complaints). UNVERIFIED: the shape below ({signature:{timestamp,token,signature}, "event-data":{event, severity, recipient, reason, message:{headers:{"message-id"}}}}) is from memory;
 * the documentation page for it could not be fetched on 2026-11-17. `failed` + `permanent` is treated as a bounce, `complained` as a complaint, everything else is ignored.
 */
export function parseMailgunEvent(body: unknown): { signature: { timestamp: string; token: string; signature: string }; event: BounceEvent | null } | null {
  const b = body as { signature?: Record<string, unknown>; "event-data"?: Record<string, unknown> } | null;
  const s = b?.signature;
  if (!s || typeof s["timestamp"] !== "string" || typeof s["token"] !== "string" || typeof s["signature"] !== "string") return null;
  const signature = { timestamp: s["timestamp"], token: s["token"], signature: s["signature"] };
  const d = b?.["event-data"] as { event?: unknown; severity?: unknown; reason?: unknown; message?: { headers?: Record<string, unknown> } } | undefined;
  const mid = normalizeMessageId(typeof d?.message?.headers?.["message-id"] === "string" ? (d.message.headers["message-id"] as string) : null);
  const ev = d?.event === "failed" && d.severity === "permanent" ? "bounce" : d?.event === "complained" ? "complaint" : null;
  return { signature, event: ev && mid ? { kind: "bounce", event: ev, messageId: mid, reason: cleanHeader(typeof d?.reason === "string" ? d.reason : ev, 100) } : null };
}

// ---------- Mailgun: sending ----------

export type MailgunConfig = { apiKey: string; domain: string; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number };
/** UNVERIFIED end to end: the endpoint, basic auth and h: headers are from the docs, but this adapter has never talked to Mailgun. UNVERIFIED too: that Mailgun keeps a Message-Id header we set (our threading relies on it). */
export function createMailgunProvider(cfg: MailgunConfig): EmailProvider {
  const f = cfg.fetch ?? fetch;
  const base = (cfg.baseUrl ?? "https://api.mailgun.net").replace(/\/+$/, "");
  return {
    name: "mailgun",
    async send(m) {
      const p = new URLSearchParams();
      p.set("from", `${m.from.name.replace(/[<>"]/g, "")} <${m.from.address}>`);
      p.set("to", m.to);
      p.set("subject", cleanHeader(m.subject));
      p.set("text", m.text);
      p.set("h:Reply-To", m.replyTo);
      p.set("h:Message-Id", `<${m.messageId}>`);
      if (m.inReplyTo) p.set("h:In-Reply-To", `<${m.inReplyTo}>`);
      if (m.references.length) p.set("h:References", m.references.map((r) => `<${r}>`).join(" "));
      p.set("h:Auto-Submitted", m.autoSubmitted);
      let res: Response;
      try {
        res = await f(`${base}/v3/${encodeURIComponent(cfg.domain)}/messages`, { method: "POST", headers: { authorization: "Basic " + Buffer.from(`api:${cfg.apiKey}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" }, body: p, signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000) });
      } catch {
        throw new EmailSendError("ambiguous", null, "no_response");
      }
      if (res.status === 401 || res.status === 403) throw new EmailSendError("rejected", res.status, "provider_auth");
      if (res.status === 429) throw new EmailSendError("rejected", 429, "rate_limited");
      if (res.status >= 400 && res.status < 500) throw new EmailSendError("rejected", res.status, "provider_rejected");
      if (res.status >= 500) throw new EmailSendError("ambiguous", res.status, "provider_unavailable");
      const j = (await res.json().catch(() => null)) as { id?: unknown } | null;
      if (res.status !== 200 || !j || typeof j.id !== "string") throw new EmailSendError("ambiguous", res.status, "unreadable_response");
      return { providerId: j.id.slice(0, 200) };
    },
  };
}

// ---------- Mock provider ----------

export const MOCK_SIGNING_KEY = "mock-mailgun-signing-key-not-a-secret";
/** In-memory provider for development and tests. Labeled mock everywhere it is shown. `next` scripts the answer of the following send(s). */
export class MockEmailProvider implements EmailProvider {
  readonly name = "mock" as const;
  readonly outbox: (OutboundEmail & { providerId: string })[] = [];
  next: (EmailSendError | "ok")[] = [];
  async send(m: OutboundEmail) {
    const r = this.next.shift() ?? "ok";
    if (r !== "ok") throw r;
    const providerId = `<mock.${randomToken(12)}@mock.invalid>`;
    this.outbox.push({ ...m, providerId });
    return { providerId };
  }
}

/** Builds the form fields Mailgun would POST for an inbound route, signed with `key`. For tests, the mock provider and the browser test only. */
export function buildMockInbound(o: {
  recipient: string; from?: string; sender?: string; subject?: string; text?: string; html?: string; messageId?: string; inReplyTo?: string; references?: string[];
  spf?: string; dkim?: string; extraHeaders?: [string, string][]; attachments?: number; key?: string; timestamp?: number; token?: string; strippedText?: string;
}): Record<string, string> {
  const from = o.from ?? "Customer <customer@example.org>";
  const headers: [string, string][] = [["From", from], ["Subject", o.subject ?? "Hello"], ["Message-Id", `<${o.messageId ?? `${randomToken(12)}@example.org`}>`], ["X-Mailgun-Spf", o.spf ?? "Pass"], ["X-Mailgun-Dkim-Check-Result", o.dkim ?? "Pass"]];
  if (o.inReplyTo) headers.push(["In-Reply-To", `<${o.inReplyTo}>`]);
  if (o.references?.length) headers.push(["References", o.references.map((r) => `<${r}>`).join(" ")]);
  headers.push(...(o.extraHeaders ?? []));
  const timestamp = String(o.timestamp ?? Math.floor(Date.now() / 1000));
  const token = o.token ?? randomToken(40);
  const f: Record<string, string> = {
    recipient: o.recipient, from, sender: o.sender ?? (parseAddress(from)?.address ?? ""), subject: o.subject ?? "Hello", "message-headers": JSON.stringify(headers),
    "body-plain": o.text ?? "Hi, I need help with my order.", timestamp, token, signature: signMailgun(timestamp, token, o.key ?? MOCK_SIGNING_KEY),
  };
  if (o.html !== undefined) f["body-html"] = o.html;
  if (o.strippedText !== undefined) f["stripped-text"] = o.strippedText;
  if (o.attachments) f["attachment-count"] = String(o.attachments);
  return f;
}
