"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowDown, Check, ChevronLeft, Copy, MoreHorizontal, PanelRight, Send, X } from "lucide-react";
import { endpoints, MAX_REPLY_LENGTH, type ConversationDetail, type MessageDto, type UpdateConversationBody } from "@crm/contracts";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form-controls";
import { Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, ErrorState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { browserApi, errorMessage } from "@/lib/client-api";
import { continuesRun, dayLabel, isSendKey, relTime, replyUsage, sameDay, useNow, windowMinutesLeft } from "@/lib/inbox";
import { notifyInboxChanged, useInbox } from "./context";
import { Attachments, ChannelBadge, DeliveryStatus } from "./parts";
import { StageControl, useContactLead } from "./stage";

const PAGE = 50;
const POLL_MS = 10_000;
const byId = (a: MessageDto, b: MessageDto) => a.seq - b.seq;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const subscribeLg = (cb: () => void) => { const m = window.matchMedia("(min-width: 1024px)"); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); };
const useIsLg = () => React.useSyncExternalStore(subscribeLg, () => window.matchMedia("(min-width: 1024px)").matches, () => false);

export function Thread({ conversationId }: { conversationId: string }) {
  const { workspaceId, myUserId, canReply, canAssignAny, canEditLead, members } = useInbox();
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
  const [ctxOpen, setCtxOpen] = React.useState(() => { try { return window.localStorage.getItem("crm-inbox-ctx") === "1"; } catch { return false; } });
  const [sheet, setSheet] = React.useState(false);
  const logRef = React.useRef<HTMLDivElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const stick = React.useRef(true);
  const anchor = React.useRef<number | null>(null);
  const maxSeq = React.useRef(0);
  const readUpTo = React.useRef(0);
  const [firstRead, setFirstRead] = React.useState<number | null>(null);
  const params = { workspaceId, conversationId };
  const lead = useContactLead(workspaceId, detail?.contact.id ?? null, detail?.contact.name ?? "");

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

  // --- composer ---
  // One client id per draft: a repeat of the SAME request (double click, network retry) cannot send twice, because the server returns the stored message for a known id.
  const [draft, setDraft] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [deciding, setDeciding] = React.useState(false);
  const clientId = React.useRef<string | null>(null);
  const inFlight = React.useRef(false);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const merge = (msg: MessageDto) => {
    setMsgs((old) => { const map = new Map(old.map((x) => [x.id, x])); map.set(msg.id, msg); return [...map.values()].sort(byId); });
    maxSeq.current = Math.max(maxSeq.current, msg.seq);
    stick.current = true;
  };
  async function submit() {
    const text = draft.trim();
    if (!text || inFlight.current || !detail || replyUsage(detail.platform, text, MAX_REPLY_LENGTH).over) return;
    inFlight.current = true; // a ref, not state: two clicks in the same frame still see it
    setSubmitting(true);
    clientId.current ??= crypto.randomUUID();
    const r = await browserApi.call(endpoints.sendMessage, { params, body: { clientMsgId: clientId.current, body: text } });
    inFlight.current = false;
    setSubmitting(false);
    if (!r.ok) {
      // Keep the draft AND the client id: pressing Send again is a retry of the same request, which the server dedupes.
      const st = r.error.status;
      toast(st === 409 || st === 422 ? errorMessage(r.error) : r.error.kind === "network" || r.error.kind === "timeout" ? "No answer from the server. Your message may have been sent: check the conversation before sending it again." : errorMessage(r.error), "error");
      if (st === 409 || st === 422) { clientId.current = null; void refresh(false); }
      return;
    }
    clientId.current = null;
    merge(r.data.message);
    const st = r.data.message.deliveryState;
    if (st === "failed") setDraft((d) => (d === "" ? text : d)); // the text is not lost: edit and send again as a new message
    else setDraft("");
    if (st === "unknown") toast("Meta did not confirm this message. See the message below before sending it again.", "error");
    void refresh(false);
    composerRef.current?.focus();
  }
  async function decide(messageId: string, decision: "sent" | "not_sent") {
    setDeciding(true);
    const r = await browserApi.call(endpoints.decideDelivery, { params: { workspaceId, conversationId, messageId }, body: { decision } });
    setDeciding(false);
    if (!r.ok) { toast(errorMessage(r.error), "error"); return; }
    merge(r.data.message);
  }

  const toggleCtx = React.useCallback(() => {
    if (!lg) { setSheet((v) => !v); return; }
    setCtxOpen((v) => { try { window.localStorage.setItem("crm-inbox-ctx", v ? "0" : "1"); } catch { /* storage unavailable: the choice just is not remembered */ } return !v; });
  }, [lg]);
  // C toggles the contact panel when focus is not in a field.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "c" || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input,textarea,select,[contenteditable=true],[role=menu],[role=dialog]")) return;
      toggleCtx();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCtx]);

  if (failed === "gone") return <div className="flex flex-1 items-center justify-center p-6"><Alert tone="info">This conversation no longer exists or you can&apos;t open it. <Link className="font-medium underline" href={`/w/${workspaceId}/inbox`}>Back to inbox</Link></Alert></div>;
  if (failed === "error" && !detail) return <div className="flex-1"><ErrorState title="Couldn't load this conversation" onRetry={() => { setFailed(null); void refresh(true); }} /></div>;
  if (!detail) return <ThreadSkeleton />;

  const left = windowMinutesLeft(detail, now);
  const canType = detail.replyWindow === "open";
  const usage = replyUsage(detail.platform, draft, MAX_REPLY_LENGTH);
  const name = detail.contact.name;
  const assigneeOptions = [{ id: myUserId, name: "Me" }, ...(canAssignAny ? members.filter((m) => m.userId !== myUserId && m.status === "active").map((m) => ({ id: m.userId, name: m.name })) : [])];
  const current = detail.assignee;
  if (current && !assigneeOptions.some((o) => o.id === current.userId)) assigneeOptions.push({ id: current.userId, name: current.name });
  const panelOpen = lg ? ctxOpen : sheet;
  const STATUS: { id: ConversationDetail["status"]; label: string }[] = [{ id: "open", label: "Open" }, { id: "pending", label: "Pending" }, { id: "resolved", label: "Resolved" }];

  return (
    <div className="fade-in flex min-w-0 flex-1">
      <section aria-label={`Conversation with ${name}`} className="flex min-w-0 flex-1 flex-col bg-canvas">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-4 py-3">
          <Link href={`/w/${workspaceId}/inbox`} aria-label="Back to inbox" className="press -ml-2 inline-flex size-11 items-center justify-center rounded-control text-fg-muted hover:bg-hover md:hidden"><ChevronLeft className="size-5" aria-hidden /></Link>
          <Avatar name={name} src={detail.contact.avatarUrl} size="xl" />
          <div className="min-w-[9rem] flex-1 basis-40">
            <h2 ref={headingRef} tabIndex={-1} className="truncate text-md font-semibold text-fg outline-none"><Link href={`/w/${workspaceId}/contacts/${detail.contact.id}`} className="hover:underline">{name}</Link></h2>
            <div className="flex items-center gap-1.5"><ChannelBadge platform={detail.platform} account={detail.accountName} />{detail.status !== "open" && <Badge tone={detail.status === "resolved" ? "success" : "warning"}>{detail.status === "resolved" ? "Resolved" : "Pending"}</Badge>}</div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <StageControl ctl={lead} canEdit={canEditLead} />
            {canReply ? (
              <Select aria-label="Assignee" value={detail.assignee?.userId ?? ""} onChange={(e) => void change({ assigneeUserId: e.target.value || null })}>
                <option value="">Unassigned</option>
                {assigneeOptions.map((o) => <option key={o.id} value={o.id} disabled={!canAssignAny && o.id !== myUserId && o.id !== current?.userId}>{o.name}</option>)}
              </Select>
            ) : <span className="text-sm text-fg-muted">{detail.assignee ? `Assigned to ${detail.assignee.name}` : "Unassigned"}</span>}
            <Button variant={panelOpen ? "secondary" : "ghost"} size="sm" aria-expanded={panelOpen} aria-controls="contact-panel" onClick={toggleCtx} title="Contact (C)" className={cn("max-sm:px-0 max-sm:w-7 pointer-coarse:max-sm:w-11", panelOpen && "border-accent/30 bg-accent-subtle text-accent-fg")}><PanelRight aria-hidden /><span className="max-sm:sr-only">Contact</span></Button>
            {canReply && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" icon size="sm" aria-label="More actions"><MoreHorizontal aria-hidden /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Conversation status</DropdownMenuLabel>
                  {STATUS.map((o) => <DropdownMenuItem key={o.id} onSelect={() => void change({ status: o.id })}>{o.label}{detail.status === o.id && <Check className="ml-auto !text-accent" aria-label="Current status" />}</DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </header>

        <div className="relative min-h-0 flex-1">
          <div ref={logRef} role="log" aria-live="off" aria-label={`Messages with ${name}`} onScroll={onScroll} className="flex h-full flex-col overflow-y-auto px-6 py-5" tabIndex={0}>
            {hasMore && <div className="pb-3 text-center"><Button size="sm" variant="secondary" loading={earlier} onClick={() => void loadEarlier()}>Load earlier messages</Button></div>}
            {msgs.length === 0 && <p className="py-10 text-center text-sm text-fg-muted">No messages yet.</p>}
            <div className="mt-auto" />
            {msgs.map((m, i) => {
              const prev = msgs[i - 1];
              return (
                <React.Fragment key={m.id}>
                  {(!prev || !sameDay(prev.occurredAt, m.occurredAt)) && <p className="mb-3 mt-1 self-center rounded-full border border-line bg-surface px-3 py-0.5 text-xs font-medium text-fg-subtle">{dayLabel(m.occurredAt, now)}</p>}
                  {firstRead !== null && m.direction === "in" && m.seq > firstRead && !msgs.slice(0, i).some((x) => x.direction === "in" && x.seq > firstRead) && (
                    <p className="mb-3 flex items-center gap-2 text-xs font-semibold text-accent-fg"><span className="h-px flex-1 bg-accent/30" />New messages<span className="h-px flex-1 bg-accent/30" /></p>
                  )}
                  <Bubble m={m} now={now} run={continuesRun(m, msgs[i + 1])} onDecide={canReply ? decide : undefined} deciding={deciding} />
                </React.Fragment>
              );
            })}
          </div>
          <Button size="sm" variant={pendingNew > 0 ? "primary" : "secondary"} tabIndex={atBottom ? -1 : 0} aria-hidden={atBottom} onClick={toBottom}
            className={cn("absolute bottom-3 left-1/2 -translate-x-1/2 shadow-popover transition-[opacity,transform] duration-[var(--dur-base)] ease-[var(--ease-out)]", atBottom ? "pointer-events-none translate-y-2 opacity-0" : "opacity-100")}>
            <ArrowDown aria-hidden />{pendingNew > 0 ? `${pendingNew} new message${pendingNew > 1 ? "s" : ""}` : "Latest"}
          </Button>
        </div>
        <p role="status" aria-live="polite" className="sr-only">{announce}</p>

        <footer className="px-4 pb-4 pt-1">
          {!canReply ? <p className="py-3 text-sm text-fg-muted">You have read-only access.</p> : detail.platform === "whatsapp" ? <Alert tone="info">Replying on WhatsApp is not available yet. Incoming WhatsApp messages are shown here; sending comes in a later step.</Alert> : (
            <>
              {detail.replyWindow === "closed" && <Alert tone="warning" className="mb-2">You can&apos;t reply: more than 24 hours have passed since {name}&apos;s last message. Meta only allows replies within 24 hours. You can reply as soon as {name} writes again.</Alert>}
              {detail.replyWindow === "none" && <Alert tone="info" className="mb-2">There is no reply window yet. You can reply after {name} writes first.</Alert>}
              {left !== null && left < 120 && <Alert tone="warning" className="mb-2">The 24-hour reply window closes in {Math.floor(left / 60)} h {left % 60} min. After that you can&apos;t reply until {name} writes again.</Alert>}
              {left !== null && left >= 120 && <p className="mb-1.5 flex items-center gap-2 px-1 text-xs text-fg-subtle"><Badge tone="success">Reply window open</Badge>You can reply for {Math.floor(left / 60)} more hours.</p>}
              <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className={cn("rounded-xl border border-line-strong bg-surface transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus-within:border-accent focus-within:ring-[3px] focus-within:ring-accent/20", !canType && "bg-hover")}>
                <Textarea
                  ref={composerRef}
                  aria-label="Reply"
                  aria-describedby="composer-hint"
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); const t = e.currentTarget; t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 160)}px`; }}
                  onKeyDown={(e) => { if (isSendKey({ key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing })) { e.preventDefault(); void submit(); } }}
                  disabled={!canType}
                  placeholder={canType ? "Write a reply" : "Replies are unavailable for this conversation"}
                  className="min-h-14 resize-none rounded-xl border-0 bg-transparent px-4 pt-3 shadow-none hover:border-0 focus-visible:ring-0"
                  rows={2}
                />
                <div className="flex items-center gap-2 px-3 pb-2.5">
                  <p id="composer-hint" className="min-w-0 flex-1 text-xs text-fg-subtle max-sm:sr-only">Enter to send, Shift+Enter for a new line.{usage.used > usage.max * 0.8 ? ` ${usage.used}/${usage.max} ${usage.unit}` : ""}{usage.over ? <span className="text-danger-fg"> Too long for {detail.platform === "instagram" ? "Instagram" : "Messenger"}: shorten it to send.</span> : null}</p>
                  <Button type="submit" variant="primary" loading={submitting} disabled={!canType || draft.trim() === "" || usage.over}><Send aria-hidden />Send</Button>
                </div>
              </form>
            </>
          )}
        </footer>
      </section>

      {/* Closed by default. On wide screens the panel slides open in place; below that it is a sheet. */}
      <aside id="contact-panel" aria-label="Contact" aria-hidden={!(lg && ctxOpen)} inert={!(lg && ctxOpen)}
        className={cn("hidden shrink-0 overflow-hidden border-l bg-surface transition-[width,border-color] duration-[var(--dur-slow)] ease-[var(--ease-out)] lg:block", lg && ctxOpen ? "w-[320px] border-line" : "w-0 border-transparent")}>
        <div className={cn("h-full w-[320px] overflow-y-auto transition-[opacity,transform] duration-[var(--dur-slow)] ease-[var(--ease-out)]", lg && ctxOpen ? "translate-x-0 opacity-100" : "translate-x-3 opacity-0")}>
          <ContactPanel d={detail} workspaceId={workspaceId} now={now} lead={lead} canEditLead={canEditLead} onClose={toggleCtx} />
        </div>
      </aside>
      <Dialog open={sheet && !lg} onOpenChange={setSheet}>
        <DialogContent title="Contact" description={`Details for ${name}`}><ContactPanel d={detail} workspaceId={workspaceId} now={now} lead={lead} canEditLead={canEditLead} /></DialogContent>
      </Dialog>
    </div>
  );
}

function Bubble({ m, now, run, onDecide, deciding }: { m: MessageDto; now: number; run: boolean; onDecide?: (id: string, d: "sent" | "not_sent") => void; deciding: boolean }) {
  const out = m.direction === "out";
  const ext = m.senderKind === "external";
  const who = out && !ext ? (m.senderName ?? (m.senderKind === "system" ? "System" : "You")) : null;
  return (
    <div className={cn("rise flex", out ? "justify-end" : "justify-start", run ? "mb-0.5" : "mb-3")}>
      <div className={cn("flex max-w-[85%] flex-col md:max-w-[34rem]", out ? "items-end" : "items-start")}>
        <div className={cn("rounded-2xl border px-3.5 py-2 text-left text-base",
          !out ? "rounded-bl-sm border-line bg-surface text-fg" : ext ? "rounded-br-sm border-accent/20 bg-accent-subtle text-fg" : "rounded-br-sm border-transparent bg-accent text-on-accent")}>
          {m.body && <p className="whitespace-pre-wrap break-words leading-[1.55]">{m.body}</p>}
          <Attachments items={m.attachments} />
        </div>
        {!run && (
          <p className="mt-1 flex items-center gap-1.5 px-1 text-xs text-fg-subtle">
            {ext && <Badge tone="neutral" shape="square">Sent from another app</Badge>}
            {who && <span>{who} ·</span>}
            <time dateTime={m.occurredAt}>{hhmm(m.occurredAt)}</time>
          </p>
        )}
        <DeliveryStatus m={m} now={now} onDecide={onDecide} deciding={deciding} />
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = { messenger: "Messenger", instagram: "Instagram", whatsapp: "WhatsApp", manual: "Added by hand", import: "Imported", other: "Other" };

function CopyButton({ value, label }: { value: string; label: string }) {
  const toast = useToast();
  return (
    <Button variant="ghost" icon size="sm" aria-label={label} className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
      onClick={() => { void navigator.clipboard?.writeText(value).then(() => toast("Copied to clipboard"), () => toast("Could not copy. Select the text and copy it by hand.", "error")); }}>
      <Copy aria-hidden />
    </Button>
  );
}

/** Phones and emails read out of the conversation, with where they came from. Unverified values are marked, never presented as confirmed. */
function DetectedMethods({ methods }: { methods: ConversationDetail["contactSummary"]["methods"] }) {
  if (methods.length === 0) return null;
  return (
    <section aria-label="Detected phone numbers and emails" className="space-y-1.5">
      <h3 className="text-xs font-medium text-fg-subtle">Detected from conversation</h3>
      <ul className="space-y-1.5 text-sm">
        {methods.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <a className="min-w-0 truncate text-fg hover:underline" href={m.kind === "email" ? `mailto:${m.value}` : `tel:${m.value}`}>{m.value}</a>
            <span className="text-xs text-fg-subtle">{SOURCE_LABEL[m.source] ?? m.source}{m.isPrimary ? " · primary" : ""} · {m.verified ? "verified" : `auto-detected ${Math.round(m.confidence * 100)}%`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ContactPanel({ d, workspaceId, now, lead, canEditLead, onClose }: { d: ConversationDetail; workspaceId: string; now: number; lead: ReturnType<typeof useContactLead>; canEditLead: boolean; onClose?: () => void }) {
  const c = d.contactSummary;
  return (
    <div className="text-base">
      <div className="flex items-center gap-3 border-b border-line p-5">
        <Avatar name={c.name} src={c.avatarUrl} size="xl" />
        <div className="min-w-0 flex-1"><p className="truncate font-semibold text-fg">{c.name}</p><ChannelBadge platform={d.platform} account={d.accountName} /></div>
        {onClose && <Button variant="ghost" icon size="sm" aria-label="Close contact panel" onClick={onClose}><X aria-hidden /></Button>}
      </div>
      <div className="space-y-1 border-b border-line p-5">
        <h3 className="mb-1 text-xs font-semibold text-fg-subtle">Details</h3>
        {c.email ? <div className="group flex items-center gap-1"><a className="min-w-0 flex-1 truncate text-fg hover:underline" href={`mailto:${c.email}`}>{c.email}</a><CopyButton value={c.email} label="Copy email" /></div> : <p className="text-fg-subtle">No email yet</p>}
        {c.phone ? <div className="group flex items-center gap-1"><a className="tnum min-w-0 flex-1 truncate text-fg hover:underline" href={`tel:${c.phone}`}>{c.phone}</a><CopyButton value={c.phone} label="Copy phone" /></div> : <p className="text-fg-subtle">No phone yet</p>}
        <p className="pt-1 text-sm text-fg-muted">Last message {d.lastInboundAt ? `${relTime(d.lastInboundAt, now)} ago` : "none yet"}</p>
      </div>
      <div className="space-y-3 border-b border-line p-5">
        <h3 className="text-xs font-semibold text-fg-subtle">Lead</h3>
        {lead.phase === "loading" ? <Skeleton className="h-16 w-full" /> : lead.phase === "error" ? <p className="text-sm text-fg-muted">Couldn&apos;t load the lead. Reopen the panel to try again.</p> : lead.lead ? (
          <div className="rounded-lg border border-line p-3">
            <p className="truncate text-base font-medium text-fg">{lead.lead.title}</p>
            <div className="mt-2"><StageControl ctl={lead} canEdit={canEditLead} block className="w-full justify-start" /></div>
            {lead.pipeline && lead.stage && (
              <div aria-hidden className="mt-3 flex gap-0.5">
                {lead.pipeline.stages.filter((s) => !s.archived && s.kind === "open").sort((a, b) => a.position - b.position).map((s, i) => {
                  const idx = lead.pipeline!.stages.filter((x) => !x.archived && x.kind === "open").sort((a, b) => a.position - b.position).findIndex((x) => x.id === lead.stage!.id);
                  const lost = lead.stage!.kind === "lost";
                  return <span key={s.id} style={{ "--i": i } as React.CSSProperties} className={cn("grow-x h-1 flex-1 rounded-full transition-colors duration-[var(--dur-slow)]", lost ? "bg-danger" : lead.stage!.kind === "won" || i <= idx ? "bg-accent" : "bg-line")} />;
                })}
              </div>
            )}
            <Link href={`/w/${workspaceId}/leads`} className="mt-3 inline-block text-sm font-medium text-accent-fg hover:underline">Open leads</Link>
          </div>
        ) : (
          <div><p className="mb-2 text-sm text-fg-muted">No lead for this contact yet.</p><StageControl ctl={lead} canEdit={canEditLead} block className="w-full justify-start" /></div>
        )}
      </div>
      <div className="space-y-4 p-5">
        <DetectedMethods methods={c.methods} />
        <Button variant="secondary" size="sm" asChild><Link href={`/w/${workspaceId}/contacts/${c.id}`}>Open contact</Link></Button>
      </div>
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
