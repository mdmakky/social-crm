import { Camera, MessageCircle } from "lucide-react";
import type { ConversationItem, MessageDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { DELIVERY, PLATFORM_LABEL, isHttps } from "@/lib/inbox";

/** Icon + text, never colour alone: speech bubble (Messenger) vs camera outline (Instagram) differ in shape. */
export function ChannelBadge({ platform, account }: { platform: ConversationItem["platform"]; account?: string | null }) {
  const Icon = platform === "instagram" ? Camera : MessageCircle;
  return <Badge tone="neutral" shape="square"><Icon className="size-3" aria-hidden />{PLATFORM_LABEL[platform]}{account ? <span className="text-fg-subtle"> · {account}</span> : null}</Badge>;
}

/** Small channel mark on an avatar corner. The row's accessible text names the channel (sr-only). */
export function ChannelMark({ platform }: { platform: ConversationItem["platform"] }) {
  const Icon = platform === "instagram" ? Camera : MessageCircle;
  return <span aria-hidden className="absolute -bottom-0.5 -right-0.5 inline-flex size-4 items-center justify-center rounded-full border border-surface bg-accent-subtle text-accent-fg"><Icon className="size-2.5" /></span>;
}

export function DeliveryStatus({ m }: { m: MessageDto }) {
  const d = DELIVERY[m.deliveryState];
  if (!d || m.direction === "in") return null;
  if (m.deliveryState === "unknown") {
    return (
      <div className="mt-1 max-w-[34rem] rounded-control border border-dashed border-warning-fg/40 bg-warning-bg px-3 py-2 text-sm text-warning-fg">
        <p className="font-medium">Delivery unknown</p>
        <p>We could not confirm that Meta received this message. Check the conversation in the Facebook or Instagram app before sending it again. It is never retried automatically.</p>
      </div>
    );
  }
  const detail = m.deliveryState === "failed" && m.failureCode ? ` (${m.failureCode})` : "";
  return <p className={cn("mt-0.5 text-xs", d.tone === "danger" ? "text-danger-fg" : "text-fg-subtle")}>{d.label}{detail}</p>;
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
