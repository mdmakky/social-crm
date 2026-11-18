import { Camera, Mail, MessageCircle, MessageSquare, Phone, Send } from "lucide-react";
import type { ConversationItem, MessageDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DELIVERY, PLATFORM_LABEL, canDecideDelivery, failureText, isHttps } from "@/lib/inbox";

const CHANNEL_ICON = { messenger: MessageCircle, instagram: Camera, whatsapp: Phone, telegram: Send, email: Mail, web_chat: MessageSquare } as const;

/** Icon + text, never colour alone: speech bubble (Messenger) vs camera outline (Instagram) differ in shape. */
export function ChannelBadge({ platform, account }: { platform: ConversationItem["platform"]; account?: string | null }) {
  const Icon = CHANNEL_ICON[platform];
  return <Badge tone="neutral" shape="square" className="max-w-full"><Icon className="size-3 shrink-0" aria-hidden /><span className="shrink-0">{PLATFORM_LABEL[platform]}</span>{account ? <span className="min-w-0 truncate text-fg-subtle"> · {account}</span> : null}</Badge>;
}

/** Small channel mark on an avatar corner. The row's accessible text names the channel (sr-only). */
export function ChannelMark({ platform }: { platform: ConversationItem["platform"] }) {
  const Icon = CHANNEL_ICON[platform];
  return <span aria-hidden className="absolute -bottom-0.5 -right-0.5 inline-flex size-4 items-center justify-center rounded-full border border-surface bg-accent-subtle text-accent-fg"><Icon className="size-2.5" /></span>;
}

export function DeliveryStatus({ m, now, onDecide, deciding }: { m: MessageDto; now?: number; onDecide?: (id: string, decision: "sent" | "not_sent") => void; deciding?: boolean }) {
  const d = DELIVERY[m.deliveryState];
  if (!d || m.direction === "in") return null;
  if (m.deliveryState === "unknown") {
    return (
      <div className="mt-1 max-w-[34rem] rounded-control border border-dashed border-warning-fg/40 bg-warning-bg px-3 py-2 text-sm text-warning-fg">
        <p className="font-medium">Delivery unknown</p>
        <p>Delivery not confirmed. Check the channel app before resending. It is not retried.</p>
        {onDecide && (now !== undefined && canDecideDelivery(m, now) ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={deciding} onClick={() => onDecide(m.id, "sent")}>It was delivered</Button>
            <Button size="sm" variant="secondary" disabled={deciding} onClick={() => onDecide(m.id, "not_sent")}>It was not delivered</Button>
          </div>
        ) : <p className="mt-1 text-xs">You can mark it as delivered or not delivered 10 minutes after it was sent.</p>)}
      </div>
    );
  }
  if (m.deliveryState === "failed") return <p role="alert" className="mt-0.5 text-xs text-danger-fg">Not sent. {failureText(m.failureCode)}</p>;
  return <p className="mt-0.5 text-xs text-fg-subtle">{d.label}{m.deliveryState === "sending" ? "…" : ""}</p>;
}

export function Attachments({ items }: { items: MessageDto["attachments"] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1.5">
      {items.map((a, i) => (
        <li key={i} className="inline-flex items-center gap-2 rounded-control border border-line bg-canvas px-2 py-1 text-xs text-fg-muted">
          <span>Attachment · {a.type}</span>
          {isHttps(a.url) ? <a href={a.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-fg underline">Open</a> : <span className="text-fg-subtle">not available</span>}
        </li>
      ))}
    </ul>
  );
}
