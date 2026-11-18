"use client";
import * as React from "react";
import Link from "next/link";
import { ChevronDown, MessageSquare } from "lucide-react";
import { endpoints, type ConversationItem } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { browserApi, errorMessage } from "@/lib/client-api";
import { relativeTime, sourceLabel } from "@/lib/contacts";
import { cn } from "@/lib/cn";

/** A collapsed section: one quiet row until opened. Native details/summary, so keyboard and screen readers work without script. */
export function Accordion({ title, hint, children, className, defaultOpen }: { title: string; hint?: React.ReactNode; children: React.ReactNode; className?: string; defaultOpen?: boolean }) {
  return (
    <details data-panel open={defaultOpen} className={cn("group rounded-card bg-surface shadow-sheet", className)}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-card px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="text-base font-semibold text-fg">{title}</span>
        <span className="flex min-w-0 items-center gap-2 text-sm text-fg-subtle"><span className="truncate">{hint}</span><ChevronDown className="size-4 shrink-0 transition-transform duration-[var(--dur-base)] group-open:rotate-180 motion-reduce:transition-none" aria-hidden /></span>
      </summary>
      <div className="border-t border-line-card">{children}</div>
    </details>
  );
}

/** The latest conversation with this lead: channel, the last message and a way into the Inbox. Nothing to show for roles without Inbox access. */
export function ConversationSummary({ workspaceId, contactId, contactName, canView, timeZone }: { workspaceId: string; contactId: string; contactName: string; canView: boolean; timeZone: string }) {
  const [state, setState] = React.useState<"loading" | "error" | "ready">(canView ? "loading" : "ready");
  const [conv, setConv] = React.useState<ConversationItem | null>(null);
  const [err, setErr] = React.useState("");
  const load = React.useCallback(async () => {
    setState("loading");
    const r = await browserApi.call(endpoints.listConversations, { params: { workspaceId }, query: { q: contactName, limit: 100 } });
    if (!r.ok) { setErr(errorMessage(r.error)); return setState("error"); }
    setConv(r.data.items.filter((c) => c.contact.id === contactId).sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""))[0] ?? null);
    setState("ready");
  }, [workspaceId, contactId, contactName]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; load() sets the loading state first
  React.useEffect(() => { if (canView) void load(); }, [canView, load]);
  if (!canView) return null;
  return (
    <Panel>
      <PanelHeader title="Conversation" description={conv ? `${sourceLabel(conv.platform)}${conv.lastMessageAt ? ` · ${relativeTime(conv.lastMessageAt, timeZone)}` : ""}` : undefined} />
      {state === "loading" && <div role="status" aria-label="Loading conversation" className="flex flex-col gap-2 p-4"><Skeleton className="h-9 w-2/3" /><Skeleton className="h-9 w-1/2" /></div>}
      {state === "error" && <div className="p-4"><p role="alert" className="mb-2 text-sm text-danger-fg">The conversation could not be loaded. {err}</p><Button size="sm" onClick={() => void load()}>Try again</Button></div>}
      {state === "ready" && !conv && <p className="flex items-center gap-2 px-4 py-4 text-sm text-fg-muted"><MessageSquare className="size-4 shrink-0 text-fg-subtle" aria-hidden />No conversations yet. Messages from this lead show here.</p>}
      {state === "ready" && conv && (
        <div className="flex flex-col items-start gap-3 p-4">
          {conv.preview ? <p className={cn("max-w-[88%] rounded-2xl border border-line-card bg-canvas px-3.5 py-2 text-base text-fg", conv.previewDirection === "out" ? "self-end rounded-br-md" : "rounded-bl-md")}>{conv.previewDirection === "out" && <span className="sr-only">You: </span>}{conv.preview}</p> : <p className="text-sm text-fg-muted">The latest message is an attachment.</p>}
          <Button asChild size="md"><Link href={`/w/${workspaceId}/inbox/${conv.id}`}>Open in Inbox</Link></Button>
        </div>
      )}
    </Panel>
  );
}
