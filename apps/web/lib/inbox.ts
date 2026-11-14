import * as React from "react";
import type { ConversationDetail, MessageDto } from "@crm/contracts";

const DAY = 86_400_000;
const tick = (cb: () => void) => { const t = setInterval(cb, 30_000); return () => clearInterval(t); };
/** Current time in 30 second steps, safe to read during render (no Date.now in the component body). Server snapshot is 0 (inbox data is client-fetched only). */
export const useNow = () => React.useSyncExternalStore(tick, () => Math.floor(Date.now() / 30_000) * 30_000, () => 0);

/** "now", "5m", "3h", "2d", then a short date. */
export function relTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  const d = now - t;
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < DAY) return `${Math.floor(d / 3_600_000)}h`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** "Today", "Yesterday", else "Mon 9 Nov". */
export function dayLabel(iso: string, now: number): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date(now)) - start(d)) / DAY);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
export const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();

export const WINDOW_MS = 24 * 3_600_000;
/** Meta replies are allowed for 24 hours after the contact's last message (UNVERIFIED details: docs/integrations/meta-api-verification-2026-11.md). */
export const windowClosesAt = (lastInboundAt: string | null) => (lastInboundAt ? new Date(lastInboundAt).getTime() + WINDOW_MS : null);
export function windowMinutesLeft(c: Pick<ConversationDetail, "replyWindow" | "lastInboundAt">, now: number): number | null {
  const end = windowClosesAt(c.lastInboundAt);
  return c.replyWindow === "open" && end ? Math.max(0, Math.round((end - now) / 60_000)) : null;
}

/** Truthful labels: an unknown delivery is never shown as sent. */
export const DELIVERY: Record<MessageDto["deliveryState"], { label: string; tone: "neutral" | "success" | "warning" | "danger" } | null> = {
  received: null,
  pending: { label: "Queued", tone: "neutral" },
  sending: { label: "Sending", tone: "neutral" },
  sent: { label: "Sent", tone: "success" },
  failed: { label: "Not sent", tone: "danger" },
  unknown: { label: "Delivery unknown", tone: "warning" },
};

export const PLATFORM_LABEL = { messenger: "Messenger", instagram: "Instagram" } as const;
export const isHttps = (u: string | null): u is string => !!u && /^https:\/\//i.test(u);

/** Plain-language reason for a failed send, from the stored failure code. Unknown codes get a generic line; Meta's own text is never stored or shown. */
export function failureText(code: string | null): string {
  switch (code) {
    case "recipient_unavailable": return "Meta says this person can't receive messages right now (they may have blocked the Page).";
    case "rate_limited": return "Meta is limiting this Page for the moment. Wait a little and try again.";
    case "token_invalid": return "The Page connection has expired. Reconnect it in Settings > Integrations.";
    case "token_unavailable": return "The Page connection can't be used. Reconnect it in Settings > Integrations.";
    case "permission_denied": return "Meta refused the message. The Page may be missing messaging permission.";
    case "invalid_request": return "Meta did not accept this message.";
    case "window_closed": return "Meta says the 24-hour reply window has closed. You can reply after the person writes again.";
    case "channel_access": return "Meta blocked this send. Check that the Instagram account still allows access to messages for connected tools, then reconnect it in Settings > Integrations.";
    case "thread_owned_elsewhere": return "Another app is handling this conversation, so Meta refused the reply.";
    case "marked_not_sent": return "You marked this message as not sent.";
    default: return "Meta did not accept this message.";
  }
}

/** A person may decide on an "unknown" message 10 minutes after it was sent; the server enforces the real clock. */
export const DECIDE_AFTER_MS = 10 * 60_000;
export const canDecideDelivery = (m: Pick<MessageDto, "deliveryState" | "occurredAt">, now: number) => m.deliveryState === "unknown" && now - new Date(m.occurredAt).getTime() >= DECIDE_AFTER_MS;

/** Send on plain Enter only: Shift+Enter is a newline, and Enter that confirms an IME composition (Bengali, Japanese...) must not send. */
export const isSendKey = (e: { key: string; shiftKey: boolean; isComposing?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }) =>
  e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.altKey;

/** Reply size limit per channel. Instagram is counted in UTF-8 bytes (Meta states 1,000 bytes; Bengali takes 3 bytes per letter), Messenger in characters (our own cap). */
export const IG_MAX_BYTES = 1000;
export function replyUsage(platform: "messenger" | "instagram", text: string, maxChars: number): { used: number; max: number; unit: "bytes" | "characters"; over: boolean } {
  if (platform === "instagram") { const used = new TextEncoder().encode(text).length; return { used, max: IG_MAX_BYTES, unit: "bytes", over: used > IG_MAX_BYTES }; }
  return { used: text.length, max: maxChars, unit: "characters", over: text.length > maxChars };
}
