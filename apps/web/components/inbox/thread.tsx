"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowDown, ChevronLeft, PanelRight, Send } from "lucide-react";
import { endpoints, type ConversationDetail, type MessageDto, type UpdateConversationBody } from "@crm/contracts";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form-controls";
import { Select } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, ErrorState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { browserApi, errorMessage } from "@/lib/client-api";
import { dayLabel, relTime, sameDay, useNow, windowMinutesLeft } from "@/lib/inbox";
import { notifyInboxChanged, useInbox } from "./context";
import { Attachments, ChannelBadge, DeliveryStatus } from "./parts";

const PAGE = 50;
const POLL_MS = 10_000;
const byId = (a: MessageDto, b: MessageDto) => a.seq - b.seq;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const subscribeLg = (cb: () => void) => { const m = window.matchMedia("(min-width: 1024px)"); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); };
const useIsLg = () => React.useSyncExternalStore(subscribeLg, () => window.matchMedia("(min-width: 1024px)").matches, () => false);

export function Thread({ conversationId }: { conversationId: string }) {
  const { workspaceId, myUserId, canReply, canAssignAny, members } = useInbox();
  const toast = useToast();
  const now = useNow();
  const lg = useIsLg();
  const [detail, setDetail] = React.useState<ConversationDetail | null>(null);
  const [msgs, setMsgs] = React.useState<MessageDto[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  const [failed, setFailed] = React.useState<"gone" | "error" | null>(null);
  const [earlier, setEarlier] = React.useState(false);
  const [atBottom, setAtBottom] = React.useState(true);
  const [pendingNew, setPendingNew] = React.useState(0);
  const [announce, setAnnounce] = React.useState("");
  const [ctxOpen, setCtxOpen] = React.useState(() => { try { return window.localStorage.getItem("crm-inbox-ctx") !== "0"; } catch { return true; } });
  const [sheet, setSheet] = React.useState(false);
  const logRef = React.useRef<HTMLDivElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const stick = React.useRef(true);
  const anchor = React.useRef<number | null>(null);
  const maxSeq = React.useRef(0);
  const readUpTo = React.useRef(0);
  const [firstRead, setFirstRead] = React.useState<number | null>(null);
  const params = { workspaceId, conversationId };

  const refresh = React.useCallback(async (initial: boolean) => {
    const [d, m] = await Promise.all([
      browserApi.call(endpoints.getConversation, { params: { workspaceId, conversationId } }),
      browserApi.call(endpoints.listConversationMessages, { params: { workspaceId, conversationId }, query: { limit: PAGE } }),
    ]);
    if (!d.ok || !m.ok) {
      const status = !d.ok ? d.error.status : !m.ok ? m.error.status : 0;
      if (initial) setFailed(status === 404 || status === 403 ? "gone" : "error");
      return;
    }
    setFailed(null);
    setDetail((old) => (old && old.version > d.data.version ? old : d.data));
    if (initial) {
      setFirstRead(d.data.lastReadSeq);
      readUpTo.current = d.data.lastReadSeq;
      maxSeq.current = m.data.items.at(-1)?.seq ?? 0;
      setMsgs(m.data.items);
      setHasMore(m.data.hasMore);
      stick.current = true;
      return;
    }
    const known = maxSeq.current;
    const fresh = m.data.items.filter((x) => x.seq > known);
    setMsgs((old) => { const map = new Map(old.map((x) => [x.id, x])); for (const x of m.data.items) map.set(x.id, x); return [...map.values()].sort(byId); });
    if (fresh.length > 0) {
      maxSeq.current = Math.max(known, ...fresh.map((x) => x.seq));
      const inbound = fresh.filter((x) => x.direction === "in");
      if (inbound.length > 0) setAnnounce(`${d.data.contact.name}: ${(inbound.at(-1)!.body ?? "attachment").slice(0, 200)}`);
      if (logRef.current && logRef.current.scrollHeight - logRef.current.scrollTop - logRef.current.clientHeight < 80) stick.current = true;
      else setPendingNew((n) => n + fresh.length);
    }
  }, [workspaceId, conversationId]);

  React.useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => { if (live) void refresh(true); });
    const run = () => { if (document.visibilityState === "visible") void refresh(false); };
    const t = setInterval(run, POLL_MS);
    document.addEventListener("visibilitychange", run);
    return () => { live = false; clearInterval(t); document.removeEventListener("visibilitychange", run); };
  }, [refresh]);

  // Scrolling: stick to the newest message only when the user is already there; keep position after prepending older history.
  React.useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (anchor.current !== null) { el.scrollTop = el.scrollHeight - anchor.current; anchor.current = null; }
    else if (stick.current) { el.scrollTop = el.scrollHeight; stick.current = false; }
  }, [msgs]);
  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(bottom);
    if (bottom) setPendingNew(0);
  };
  const toBottom = () => { const el = logRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); setPendingNew(0); };

  // Focus the heading once the conversation is shown (spec 11).
  const shown = detail !== null;
  React.useEffect(() => { if (shown) headingRef.current?.focus({ preventScroll: true }); }, [shown]);

  // Mark read: newest message seen, tab visible, scrolled to the end; debounced; forward only.
  const top = msgs.at(-1)?.seq ?? 0;
  React.useEffect(() => {
    if (!detail || !atBottom || top <= readUpTo.current) return;
    const t = setTimeout(async () => {
      if (document.visibilityState !== "visible" || top <= readUpTo.current) return;
      const r = await browserApi.call(endpoints.markConversationRead, { params: { workspaceId, conversationId }, body: { upToSeq: top } });
      if (r.ok) { readUpTo.current = Math.max(readUpTo.current, r.data.lastReadSeq); setDetail((d) => (d ? { ...d, lastReadSeq: r.data.lastReadSeq, unreadCount: r.data.unreadCount } : d)); notifyInboxChanged(); }
    }, 500);
    return () => clearTimeout(t);
  }, [detail, atBottom, top, workspaceId, conversationId]);

  async function loadEarlier() {
    const first = msgs[0]?.seq;
    if (!first || !logRef.current) return;
    setEarlier(true);
    const r = await browserApi.call(endpoints.listConversationMessages, { params, query: { before: first, limit: PAGE } });
    setEarlier(false);
    if (!r.ok) { toast(errorMessage(r.error), "error"); return; }
    anchor.current = logRef.current.scrollHeight - logRef.current.scrollTop;
    setMsgs((old) => { const map = new Map(old.map((x) => [x.id, x])); for (const x of r.data.items) map.set(x.id, x); return [...map.values()].sort(byId); });
    setHasMore(r.data.hasMore);
  }

  const nameOf = (id: string) => (id === myUserId ? members.find((m) => m.userId === id)?.name ?? "Me" : members.find((m) => m.userId === id)?.name ?? "Teammate");
  /** Optimistic status/assignee change with rollback; the version is the optimistic-concurrency token. */
  // Changes are applied one after another, each with the version the previous one returned: two quick edits (status, then assignee) must not both carry the same
  // stale expectedVersion, or the second would be refused as a conflict that never happened.
  const versionRef = React.useRef(0);
  React.useEffect(() => { if (detail) versionRef.current = detail.version; }, [detail]);
  const queue = React.useRef<Promise<void>>(Promise.resolve());
  function change(p: Pick<UpdateConversationBody, "status" | "assigneeUserId">) {
    queue.current = queue.current.then(() => apply(p));
    return queue.current;
  }
  async function apply(p: Pick<UpdateConversationBody, "status" | "assigneeUserId">) {
    if (!detail) return;
    const prev = detail;
    setDetail((d) => (d ? { ...d, ...(p.status ? { status: p.status } : {}), ...(p.assigneeUserId !== undefined ? { assignee: p.assigneeUserId ? { userId: p.assigneeUserId, name: nameOf(p.assigneeUserId) } : null } : {}) } : d));
    const r = await browserApi.call(endpoints.updateConversation, { params, body: { ...p, expectedVersion: versionRef.current } });
    if (!r.ok) {
      setDetail(prev);
      if (r.error.status === 409) { toast("Someone else changed this conversation. It was reloaded.", "error"); void refresh(false); }
      else if (r.error.status === 403) toast(p.assigneeUserId !== undefined ? "You can only assign conversations to yourself." : "You don't have permission to do that.", "error");
      else toast(errorMessage(r.error), "error");
      return;
    }
    versionRef.current = r.data.version;
    setDetail(r.data);
    notifyInboxChanged();
  }

  const toggleCtx = () => {
    if (!lg) { setSheet(true); return; }
    setCtxOpen((v) => { try { window.localStorage.setItem("crm-inbox-ctx", v ? "0" : "1"); } catch { /* storage unavailable: the choice just is not remembered */ } return !v; });
  };

  if (failed === "gone") return <div className="flex flex-1 items-center justify-center p-6"><Alert tone="info">This conversation no longer exists or you can&apos;t open it. <Link className="font-medium underline" href={`/w/${workspaceId}/inbox`}>Back to inbox</Link></Alert></div>;
  if (failed === "error" && !detail) return <div className="flex-1"><ErrorState title="Couldn't load this conversation" onRetry={() => { setFailed(null); void refresh(true); }} /></div>;
  if (!detail) return <ThreadSkeleton />;

  const left = windowMinutesLeft(detail, now);
  const name = detail.contact.name;
  const assigneeOptions = [{ id: myUserId, name: "Me" }, ...(canAssignAny ? members.filter((m) => m.userId !== myUserId && m.status === "active").map((m) => ({ id: m.userId, name: m.name })) : [])];
  const current = detail.assignee;
  if (current && !assigneeOptions.some((o) => o.id === current.userId)) assigneeOptions.push({ id: current.userId, name: current.name });

  return (
    <div className="flex min-w-0 flex-1">
      <section aria-label={`Conversation with ${name}`} className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2.5">
          <Link href={`/w/${workspaceId}/inbox`} aria-label="Back to inbox" className="-ml-1 inline-flex size-11 items-center justify-center rounded-control text-fg-muted hover:bg-hover md:hidden"><ChevronLeft className="size-5" aria-hidden /></Link>
          <Avatar name={name} src={detail.contact.avatarUrl} size="lg" />
          <div className="min-w-[9rem] flex-1 basis-40">
            <h2 ref={headingRef} tabIndex={-1} className="truncate text-md font-semibold text-fg outline-none"><Link href={`/w/${workspaceId}/contacts/${detail.contact.id}`} className="hover:underline">{name}</Link></h2>
            <ChannelBadge platform={detail.platform} account={detail.accountName} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {canReply ? (
              <Select aria-label="Status" value={detail.status} onChange={(e) => void change({ status: e.target.value as ConversationDetail["status"] })}>
                <option value="open">Open</option><option value="pending">Pending</option><option value="resolved">Resolved</option>
              </Select>
            ) : <span className="text-sm text-fg-muted">Status: {detail.status}</span>}
            {canReply ? (
              <Select aria-label="Assignee" value={detail.assignee?.userId ?? ""} onChange={(e) => void change({ assigneeUserId: e.target.value || null })}>
                <option value="">Unassigned</option>
                {assigneeOptions.map((o) => <option key={o.id} value={o.id} disabled={!canAssignAny && o.id !== myUserId && o.id !== current?.userId}>{o.name}</option>)}
              </Select>
            ) : <span className="text-sm text-fg-muted">{detail.assignee ? `Assigned to ${detail.assignee.name}` : "Unassigned"}</span>}
            <Button variant="ghost" size="sm" aria-expanded={lg ? ctxOpen : sheet} onClick={toggleCtx}><PanelRight aria-hidden />Contact</Button>
          </div>
        </header>

        <div className="relative min-h-0 flex-1">
          <div ref={logRef} role="log" aria-live="off" aria-label={`Messages with ${name}`} onScroll={onScroll} className="h-full space-y-1 overflow-y-auto px-4 py-3" tabIndex={0}>
            {hasMore && <div className="pb-2 text-center"><Button size="sm" variant="secondary" loading={earlier} onClick={() => void loadEarlier()}>Load earlier messages</Button></div>}
            {msgs.length === 0 && <p className="py-10 text-center text-sm text-fg-muted">No messages yet.</p>}
            {msgs.map((m, i) => {
              const prev = msgs[i - 1];
              return (
                <React.Fragment key={m.id}>
                  {(!prev || !sameDay(prev.occurredAt, m.occurredAt)) && <p className="py-2 text-center text-xs font-medium text-fg-subtle">{dayLabel(m.occurredAt, now)}</p>}
                  {firstRead !== null && m.direction === "in" && m.seq > firstRead && !msgs.slice(0, i).some((x) => x.direction === "in" && x.seq > firstRead) && (
                    <p className="flex items-center gap-2 py-1 text-xs font-medium text-accent-fg"><span className="h-px flex-1 bg-accent/30" />New messages<span className="h-px flex-1 bg-accent/30" /></p>
                  )}
                  <Bubble m={m} />
                </React.Fragment>
              );
            })}
          </div>
          {pendingNew > 0 && !atBottom && (
            <Button size="sm" variant="primary" className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-popover" onClick={toBottom}><ArrowDown aria-hidden />{pendingNew} new message{pendingNew > 1 ? "s" : ""}</Button>
          )}
        </div>
        <p role="status" aria-live="polite" className="sr-only">{announce}</p>

        <footer className="border-t border-line p-3">
          {!canReply ? <p className="text-sm text-fg-muted">You have read-only access.</p> : (
            <>
              {detail.replyWindow === "closed" && <Alert tone="warning" className="mb-2">You can&apos;t reply: more than 24 hours have passed since {name}&apos;s last message. Meta only allows replies within 24 hours. You can reply as soon as {name} writes again.</Alert>}
              {detail.replyWindow === "none" && <Alert tone="info" className="mb-2">There is no reply window yet. You can reply after {name} writes first.</Alert>}
              {left !== null && left < 120 && <Alert tone="warning" className="mb-2">The 24-hour reply window closes in {Math.floor(left / 60)} h {left % 60} min. After that you can&apos;t reply until {name} writes again.</Alert>}
              <form onSubmit={(e) => e.preventDefault()} className="flex items-end gap-2">
                <Textarea aria-label="Reply" aria-describedby="composer-why" disabled placeholder="Write a reply" className="min-h-11 flex-1" rows={2} />
                <Button variant="primary" disabled aria-describedby="composer-why"><Send aria-hidden />Send</Button>
              </form>
              <p id="composer-why" className="mt-1.5 text-xs text-fg-subtle">Sending arrives in the next release. You can read, assign and resolve conversations now.</p>
            </>
          )}
        </footer>
      </section>

      {lg && ctxOpen && <aside aria-label="Contact" className="hidden w-[300px] shrink-0 overflow-y-auto border-l border-line p-4 lg:block"><ContactPanel d={detail} workspaceId={workspaceId} now={now} /></aside>}
      <Dialog open={sheet && !lg} onOpenChange={setSheet}>
        <DialogContent title="Contact" description={`Details for ${name}`}><ContactPanel d={detail} workspaceId={workspaceId} now={now} /></DialogContent>
      </Dialog>
    </div>
  );
}

function Bubble({ m }: { m: MessageDto }) {
  const out = m.direction === "out";
  const who = out ? m.senderName ?? (m.senderKind === "external" ? "Sent from another app" : m.senderKind === "system" ? "System" : "You") : null;
  return (
    <div className={cn("flex", out ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[85%] md:max-w-[34rem]", out && "text-right")}>
        <div className={cn("inline-block rounded-card border px-3 py-2 text-left text-base", out ? "border-accent/20 bg-accent-subtle text-fg" : "border-line bg-surface text-fg")}>
          {who && <p className="mb-0.5 text-xs font-medium text-fg-muted">{who}</p>}
          {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
          <Attachments items={m.attachments} />
          <p className="mt-1 text-xs text-fg-subtle"><time dateTime={m.occurredAt}>{hhmm(m.occurredAt)}</time></p>
        </div>
        <DeliveryStatus m={m} />
      </div>
    </div>
  );
}

function ContactPanel({ d, workspaceId, now }: { d: ConversationDetail; workspaceId: string; now: number }) {
  const c = d.contactSummary;
  return (
    <div className="space-y-4 text-base">
      <div className="flex items-center gap-3"><Avatar name={c.name} src={c.avatarUrl} size="xl" /><div className="min-w-0"><p className="truncate font-semibold text-fg">{c.name}</p><ChannelBadge platform={d.platform} account={d.accountName} /></div></div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-fg-subtle">Email</dt><dd className="min-w-0 truncate">{c.email ? <a className="text-accent-fg underline" href={`mailto:${c.email}`}>{c.email}</a> : <span className="text-fg-subtle">Not set</span>}</dd>
        <dt className="text-fg-subtle">Phone</dt><dd className="min-w-0 truncate">{c.phone ? <a className="text-accent-fg underline" href={`tel:${c.phone}`}>{c.phone}</a> : <span className="text-fg-subtle">Not set</span>}</dd>
        <dt className="text-fg-subtle">Last message</dt><dd>{d.lastInboundAt ? `${relTime(d.lastInboundAt, now)} ago` : "None yet"}</dd>
      </dl>
      <Button variant="secondary" size="sm" asChild><Link href={`/w/${workspaceId}/contacts/${c.id}`}>Open contact</Link></Button>
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div role="status" aria-label="Loading conversation" className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-line p-3"><Skeleton className="size-8 rounded-full" /><Skeleton className="h-4 w-40" /></div>
      <div className="flex-1 space-y-3 p-4"><Skeleton className="h-10 w-56" /><Skeleton className="ml-auto h-10 w-48" /><Skeleton className="h-10 w-64" /></div>
    </div>
  );
}
