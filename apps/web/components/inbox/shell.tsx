"use client";
import * as React from "react";
import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import { FilterX, Inbox, Search } from "lucide-react";
import { endpoints, type ConversationItem, type ConversationList, type ConversationListQuery, type Member } from "@crm/contracts";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { ToastProvider } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { browserApi } from "@/lib/client-api";
import { PLATFORM_LABEL, relTime, useNow } from "@/lib/inbox";
import { ChannelMark } from "./parts";
import { INBOX_CHANGED, InboxContext, type InboxCtx } from "./context";

type Filters = { status: "open" | "pending" | "resolved" | "all"; assignee: string; unread: boolean; q: string };
const DEFAULTS: Filters = { status: "open", assignee: "", unread: false, q: "" };
const POLL_MS = 10_000;

const toQuery = (f: Filters, cursor?: string): ConversationListQuery => ({
  status: f.status === "all" ? undefined : f.status,
  assignee: f.assignee || undefined,
  unread: f.unread ? "1" : undefined,
  q: f.q.trim() || undefined,
  limit: 30,
  cursor,
});

/** Merge a freshly polled head into the list we already show, so a refresh neither drops loaded pages nor reorders what the user is reading. */
function mergeHead(old: ConversationItem[], head: ConversationItem[]): ConversationItem[] {
  const fresh = new Map(head.map((c) => [c.id, c]));
  const kept = old.filter((c) => !fresh.has(c.id));
  return [...head, ...kept].sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "") || b.id.localeCompare(a.id));
}

export function InboxShell({ children, ...ctx }: InboxCtx & { children: React.ReactNode }) {
  return <ToastProvider><InboxContext.Provider value={ctx}><Inner members={ctx.members}>{children}</Inner></InboxContext.Provider></ToastProvider>;
}

function Inner({ children, members }: { children: React.ReactNode; members: Member[] }) {
  const ctx = React.useContext(InboxContext)!;
  const { workspaceId, myUserId } = ctx;
  const selected = useSelectedLayoutSegment();
  const now = useNow();
  const [f, setF] = React.useState<Filters>(DEFAULTS);
  const [q, setQ] = React.useState("");
  const [items, setItems] = React.useState<ConversationItem[] | null>(null);
  const [next, setNext] = React.useState<string | null>(null);
  const [unreadTotal, setUnreadTotal] = React.useState(0);
  const [error, setError] = React.useState(false);
  const [more, setMore] = React.useState(false);
  const fRef = React.useRef(f);
  const params = { workspaceId };

  // Search is debounced into the filters.
  React.useEffect(() => {
    const t = setTimeout(() => setF((x) => (x.q === q ? x : { ...x, q })), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = React.useCallback(async (mode: "replace" | "head") => {
    const filters = fRef.current;
    const r = await browserApi.call(endpoints.listConversations, { params: { workspaceId }, query: toQuery(filters) });
    if (fRef.current !== filters) return; // filters changed while in flight
    if (!r.ok) { if (mode === "replace") setError(true); return; }
    const d: ConversationList = r.data;
    setError(false);
    setUnreadTotal(d.totalUnread);
    if (mode === "replace") { setItems(d.items); setNext(d.nextCursor); } else setItems((old) => (old ? mergeHead(old, d.items) : d.items));
  }, [workspaceId]);

  // Filter change: show the skeleton, then replace.
  React.useEffect(() => {
    let live = true;
    fRef.current = f;
    void Promise.resolve().then(() => { if (live) { setItems(null); void load("replace"); } });
    return () => { live = false; };
  }, [f, load]);

  // Poll while visible, refetch when the tab returns, and when a thread changed something.
  React.useEffect(() => {
    const run = () => { if (document.visibilityState === "visible") void load("head"); };
    const t = setInterval(run, POLL_MS);
    document.addEventListener("visibilitychange", run);
    window.addEventListener(INBOX_CHANGED, run);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", run); window.removeEventListener(INBOX_CHANGED, run); };
  }, [load]);

  React.useEffect(() => { document.title = unreadTotal > 0 ? `(${unreadTotal > 99 ? "99+" : unreadTotal}) Inbox` : "Inbox"; }, [unreadTotal]);

  async function loadMore() {
    if (!next) return;
    setMore(true);
    const r = await browserApi.call(endpoints.listConversations, { params, query: toQuery(f, next) });
    setMore(false);
    if (r.ok) { setItems((old) => [...(old ?? []), ...r.data.items.filter((c) => !(old ?? []).some((o) => o.id === c.id))]); setNext(r.data.nextCursor); }
  }

  // j / k move between rows when focus is not in a field; Enter on a focused row opens it natively.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== "j" && e.key !== "k")) return;
      const el = e.target as HTMLElement;
      if (el.closest("input,textarea,select,[contenteditable=true]")) return;
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-conv-row]"));
      if (rows.length === 0) return;
      const i = rows.indexOf(document.activeElement as HTMLElement);
      rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "j" ? 1 : -1)))]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const dirty = f.status !== "open" || f.assignee !== "" || f.unread || f.q !== "";
  const clear = () => { setQ(""); setF(DEFAULTS); };

  return (
    <div className="flex h-[calc(100dvh-var(--topbar-h)-3.5rem)] min-h-[28rem] overflow-hidden rounded-card border border-line bg-surface max-md:h-[calc(100dvh-var(--topbar-h)-2rem)]">
      <section aria-label="Conversations" className={cn("min-w-0 flex-col border-r border-line md:flex md:w-[300px] md:shrink-0 lg:w-[340px]", selected ? "hidden" : "flex w-full")}>
        <div className="space-y-2 border-b border-line p-3">
          <div className="flex items-center gap-2">
            <h1 className="flex-1 text-md font-semibold text-fg">Inbox</h1>
            {unreadTotal > 0 && <Badge tone="accent">{unreadTotal > 99 ? "99+" : unreadTotal} unread</Badge>}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input aria-label="Search conversations" placeholder="Search name or message" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Select aria-label="Status" quiet active={f.status !== "open"} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Filters["status"] })}>
              <option value="open">Open</option><option value="pending">Pending</option><option value="resolved">Resolved</option><option value="all">All statuses</option>
            </Select>
            <Select aria-label="Assignee" quiet active={f.assignee !== ""} value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
              <option value="">Anyone</option><option value="me">Me</option><option value="unassigned">Unassigned</option>
              {members.filter((m) => m.userId !== myUserId && m.status === "active").map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
            </Select>
            <Button variant={f.unread ? "secondary" : "ghost"} size="sm" aria-pressed={f.unread} onClick={() => setF({ ...f, unread: !f.unread })}>Unread</Button>
            {dirty && <Button variant="ghost" size="sm" onClick={clear}><FilterX aria-hidden />Clear</Button>}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={items === null}>
          {error && items === null ? <ErrorState title="Couldn't load conversations" onRetry={() => { setError(false); void load("replace"); }} />
            : items === null ? <ListSkeleton />
            : items.length === 0 ? (
              <EmptyState icon={Inbox} title={dirty ? "No conversations match" : "No conversations yet"}
                description={dirty ? "Try a different filter or search." : "Messages sent to your connected Pages show up here."}
                action={dirty ? <Button size="sm" variant="secondary" onClick={clear}>Clear filters</Button> : <Button size="sm" variant="secondary" asChild><Link href={`/w/${workspaceId}/settings/integrations`}>Open integrations</Link></Button>} />
            ) : (
              <ul>
                {items.map((c) => <Row key={c.id} c={c} workspaceId={workspaceId} selected={selected === c.id} now={now} />)}
                {next && <li className="p-3 text-center"><Button variant="secondary" size="sm" loading={more} onClick={() => void loadMore()}>Load more</Button></li>}
              </ul>
            )}
        </div>
        <p role="status" className="sr-only">{items ? `${items.length} conversations${unreadTotal ? `, ${unreadTotal} unread` : ""}` : "Loading conversations"}</p>
      </section>

      <div className={cn("min-w-0 flex-1 md:flex", selected ? "flex" : "hidden")}>{children}</div>
    </div>
  );
}

function Row({ c, workspaceId, selected, now }: { c: ConversationItem; workspaceId: string; selected: boolean; now: number }) {
  const unread = c.unreadCount > 0;
  return (
    <li>
      <Link href={`/w/${workspaceId}/inbox/${c.id}`} data-conv-row aria-current={selected ? "true" : undefined}
        className={cn("relative flex min-h-16 gap-2.5 border-b border-line-card px-3 py-2.5 outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-accent", selected && "bg-accent-subtle before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent")}>
        <span className="relative shrink-0 self-start"><Avatar name={c.contact.name} src={c.contact.avatarUrl} size="lg" /><ChannelMark platform={c.platform} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-base text-fg", unread ? "font-semibold" : "font-medium")}>{c.contact.name}</span>
            <time dateTime={c.lastMessageAt ?? undefined} title={c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString() : undefined} className="shrink-0 text-xs tabular-nums text-fg-subtle">{relTime(c.lastMessageAt, now)}</time>
          </span>
          <span className="flex items-center gap-1.5">
            <span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "text-fg" : "text-fg-muted")}>{c.preview === null ? <span className="italic">Attachment</span> : <>{c.previewDirection === "out" ? "You: " : ""}{c.preview}</>}</span>
            {c.status !== "open" && <Badge tone="neutral" shape="square">{c.status === "pending" ? "Pending" : "Resolved"}</Badge>}
            {unread && <Badge tone="accent"><span aria-hidden>{c.unreadCount > 99 ? "99+" : c.unreadCount}</span><span className="sr-only">{c.unreadCount} unread</span></Badge>}
            {c.assignee && <Avatar name={c.assignee.name} size="xs" />}
          </span>
          <span className="sr-only">via {PLATFORM_LABEL[c.platform]}{c.assignee ? `, assigned to ${c.assignee.name}` : ", unassigned"}</span>
        </span>
      </Link>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading conversations">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex gap-2.5 border-b border-line-card px-3 py-3"><Skeleton className="size-8 rounded-full" /><div className="flex-1"><Skeleton className="mb-1.5 h-4 w-32" /><Skeleton className="h-3 w-48" /></div></div>
      ))}
    </div>
  );
}
