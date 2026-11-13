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
