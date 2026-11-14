"use client";
import * as React from "react";
import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import { Check, FilterX, Inbox, Search, SlidersHorizontal, X } from "lucide-react";
import { endpoints, type ConversationItem, type ConversationList, type ConversationListQuery, type Member } from "@crm/contracts";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { ToastProvider } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { browserApi } from "@/lib/client-api";
import { PLATFORM_LABEL, TAB_FILTERS, dayLabel, relTime, sameDay, tabOf, useNow, type InboxTab } from "@/lib/inbox";
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
  const searchRef = React.useRef<HTMLInputElement>(null);
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
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== "j" && e.key !== "k" && e.key !== "/")) return;
      const el = e.target as HTMLElement;
      if (el.closest("input,textarea,select,[contenteditable=true]")) return;
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); return; }
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-conv-row]"));
      if (rows.length === 0) return;
      const i = rows.indexOf(document.activeElement as HTMLElement);
      rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "j" ? 1 : -1)))]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tab = tabOf(f);
  const dirty = f.status !== "open" || tab === null || f.q !== "";
  const clear = () => { setQ(""); setF(DEFAULTS); };
  const setTab = (t: InboxTab) => setF((x) => ({ ...x, ...TAB_FILTERS[t] }));
  const TABS: { id: InboxTab; label: string }[] = [{ id: "all", label: "All" }, { id: "unread", label: "Unread" }, { id: "mine", label: "Mine" }, { id: "unassigned", label: "Unassigned" }];
  const STATUSES: { id: Filters["status"]; label: string }[] = [{ id: "open", label: "Open" }, { id: "pending", label: "Pending" }, { id: "resolved", label: "Resolved" }, { id: "all", label: "All statuses" }];

  return (
    <div className="flex h-[calc(100dvh-var(--topbar-h)-3.5rem)] min-h-[28rem] overflow-hidden rounded-card border border-line bg-surface max-md:h-[calc(100dvh-var(--topbar-h)-2rem)]">
      <section aria-label="Conversations" className={cn("min-w-0 flex-col border-r border-line md:flex md:w-[300px] md:shrink-0 lg:w-[352px]", selected ? "hidden" : "flex w-full")}>
        <div className="px-4 pt-4">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold tracking-title text-fg">Inbox</h1>
            {unreadTotal > 0 && <Badge tone="accent">{unreadTotal > 99 ? "99+" : unreadTotal} unread</Badge>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" icon size="sm" className="relative ml-auto" aria-label="Filter conversations"><SlidersHorizontal aria-hidden />{(f.status !== "open" || tab === null) && <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-accent" />}</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Status</DropdownMenuLabel>
                {STATUSES.map((o) => <DropdownMenuItem key={o.id} onSelect={() => setF({ ...f, status: o.id })}>{o.label}{f.status === o.id && <Check className="ml-auto !text-accent" aria-label="Selected" />}</DropdownMenuItem>)}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Assigned to</DropdownMenuLabel>
                {members.filter((m) => m.userId !== myUserId && m.status === "active").map((m) => <DropdownMenuItem key={m.userId} onSelect={() => setF({ ...f, ...TAB_FILTERS.all, assignee: m.userId })}>{m.name}{f.assignee === m.userId && <Check className="ml-auto !text-accent" aria-label="Selected" />}</DropdownMenuItem>)}
                {dirty && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={clear}><FilterX aria-hidden />Clear all filters</DropdownMenuItem></>}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input ref={searchRef} aria-label="Search conversations" placeholder="Search name or message" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8 pr-8" />
            {q ? <button type="button" aria-label="Clear search" onClick={() => { setQ(""); searchRef.current?.focus(); }} className="press absolute right-1.5 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-full bg-line text-fg-muted hover:bg-line-strong"><X className="size-3" aria-hidden /></button>
              : <kbd aria-hidden className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-surface px-1.5 text-xs text-fg-subtle md:block">/</kbd>}
          </div>
        </div>
        <div role="tablist" aria-label="Conversation views" className="mt-2 flex gap-0.5 border-b border-line px-2">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              className={cn("press relative inline-flex h-9 items-center gap-1.5 px-2 text-base font-medium pointer-coarse:h-11", tab === t.id ? "text-fg" : "text-fg-subtle hover:text-fg")}>
              {t.label}
              {t.id === "unread" && unreadTotal > 0 && <span className="rounded-full bg-hover px-1.5 text-xs text-fg-muted tabular-nums">{unreadTotal > 99 ? "99+" : unreadTotal}</span>}
              <span aria-hidden className={cn("absolute inset-x-2 -bottom-px h-0.5 origin-left rounded bg-accent transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]", tab === t.id ? "scale-x-100" : "scale-x-0")} />
            </button>
          ))}
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
                {items.map((c, i) => (
                  <React.Fragment key={c.id}>
                    {(i === 0 || !c.lastMessageAt || !items[i - 1]!.lastMessageAt || !sameDay(items[i - 1]!.lastMessageAt!, c.lastMessageAt)) && c.lastMessageAt && <li aria-hidden className="px-4 pb-1 pt-3 text-xs font-medium text-fg-subtle">{dayLabel(c.lastMessageAt, now)}</li>}
                    <Row c={c} workspaceId={workspaceId} selected={selected === c.id} now={now} index={i} />
                  </React.Fragment>
                ))}
                {next && <li className="p-3 text-center"><Button variant="secondary" size="sm" loading={more} onClick={() => void loadMore()}>Load more</Button></li>}
              </ul>
            )}
        </div>
        <p role="status" className="sr-only">{items ? `${items.length} conversations${unreadTotal ? `, ${unreadTotal} unread` : ""}` : "Loading conversations"}</p>
        <p aria-hidden className="hidden items-center gap-3 border-t border-line px-4 py-2 text-xs text-fg-subtle lg:flex"><span><Kbd>J</Kbd> <Kbd>K</Kbd> move</span><span><Kbd>/</Kbd> search</span><span><Kbd>C</Kbd> contact</span></p>
      </section>

      <div className={cn("min-w-0 flex-1 md:flex", selected ? "flex" : "hidden")}>{children}</div>
    </div>
  );
}

function Row({ c, workspaceId, selected, now, index }: { c: ConversationItem; workspaceId: string; selected: boolean; now: number; index: number }) {
  const unread = c.unreadCount > 0;
  return (
    <li className="rise" style={{ "--i": Math.min(index, 10) } as React.CSSProperties}>
      <Link href={`/w/${workspaceId}/inbox/${c.id}`} data-conv-row aria-current={selected ? "true" : undefined}
        className={cn("press relative flex min-h-[4.25rem] gap-3 border-b border-line-card px-4 py-3 outline-none before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:origin-center before:scale-y-0 before:bg-accent before:transition-transform before:duration-[var(--dur-base)] before:ease-[var(--ease-out)] hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-accent", selected && "bg-accent-subtle before:scale-y-100")}>
        <span className="relative shrink-0 self-start"><Avatar name={c.contact.name} src={c.contact.avatarUrl} size="xl" /><ChannelMark platform={c.platform} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-md text-fg", unread ? "font-semibold" : "font-medium")}>{c.contact.name}</span>
            <time dateTime={c.lastMessageAt ?? undefined} title={c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString() : undefined} className={cn("shrink-0 text-xs tabular-nums", unread ? "font-medium text-accent-fg" : "text-fg-subtle")}>{relTime(c.lastMessageAt, now)}</time>
          </span>
          <span className="flex items-center gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-base", unread ? "text-fg" : "text-fg-subtle")}>{c.preview === null ? <span className="italic">Attachment</span> : <>{c.previewDirection === "out" ? "You: " : ""}{c.preview}</>}</span>
            {c.status !== "open" && <Badge tone="neutral" shape="square">{c.status === "pending" ? "Pending" : "Resolved"}</Badge>}
            {c.assignee && <Avatar name={c.assignee.name} size="xs" />}
            {unread && <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" />}
          </span>
          <span className="sr-only">{unread ? `${c.unreadCount} unread. ` : ""}via {PLATFORM_LABEL[c.platform]}{c.assignee ? `, assigned to ${c.assignee.name}` : ", unassigned"}</span>
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
