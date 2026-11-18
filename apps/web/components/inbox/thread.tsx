"use client";
import { VoiceInputButton } from "@/components/ui/voice-input";
import * as React from "react";
import Link from "next/link";
import { ArrowDown, Check, ChevronDown, ChevronLeft, Clock, Copy, Lock, MoreHorizontal, PanelRight, Send, Sparkles, Square, X } from "lucide-react";
import { endpoints, MAX_REPLY_LENGTH, type AttachmentDto, type ConversationDetail, type MessageDto, type UpdateConversationBody } from "@crm/contracts";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form-controls";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/overlays";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, ErrorState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { browserApi, errorMessage } from "@/lib/client-api";
import { streamSuggestion } from "@/lib/ai-stream";
import { continuesRun, dayLabel, isSendKey, relTime, replyUsage, sameDay, useNow, windowMinutesLeft } from "@/lib/inbox";
import { notifyInboxChanged, useInbox } from "./context";
import { Attachments, ChannelBadge, DeliveryStatus } from "./parts";
import { AttachControls, MessageFiles, UploadList, useConversationAttachments, useUploads } from "./attachments";
import { StageControl, useContactLead } from "./stage";

const PAGE = 50;
const POLL_MS = 10_000;
const byId = (a: MessageDto, b: MessageDto) => a.seq - b.seq;
/** AI failures the person can fix (settings, credits, content): shown as a warning, not an error. */
const AI_WARNING = new Set(["budget_exceeded", "ai_not_configured", "payment_required", "blocked"]);
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** "21 h", "1 h 40 min", "35 min": how long the reply window stays open. */
const fmtLeft = (m: number) => (m >= 120 ? `${Math.floor(m / 60)} h` : `${m >= 60 ? `${Math.floor(m / 60)} h ` : ""}${m % 60} min`);

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
  const { data: att, refresh: refreshAtt } = useConversationAttachments(workspaceId, conversationId);
  const [pickNotice, setPickNotice] = React.useState<string | null>(null);
  const uploads = useUploads(workspaceId, conversationId, att?.limits, setPickNotice);

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
  // AI suggestion (draft only): the text lands in the composer, marked as an AI draft. Nothing is sent until the person presses Send.
  // The draft streams into the composer as it arrives: "connecting" (request sent, nothing yet), "streaming" (text arriving), then idle. Stop aborts the request and keeps what arrived (editable).
  const [suggestPhase, setSuggestPhase] = React.useState<"idle" | "connecting" | "streaming">("idle");
  const suggesting = suggestPhase !== "idle";
  const suggestAbort = React.useRef<AbortController | null>(null);
  const [aiDraft, setAiDraft] = React.useState<{ mock: boolean } | null>(null);
  const [aiProblem, setAiProblem] = React.useState<{ tone: "warning" | "error"; text: string } | null>(null);
  React.useEffect(() => () => suggestAbort.current?.abort(), []); // leaving the conversation stops the stream (and the provider call)
  const fitComposer = () => requestAnimationFrame(() => { const t = composerRef.current; if (t) { t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 160)}px`; } });
  async function suggest() {
    if (suggesting) return;
    if (draft.trim() && !window.confirm("Replace what you have written with an AI draft?")) return;
    const previous = draft;
    const ac = new AbortController();
    suggestAbort.current = ac;
    setSuggestPhase("connecting"); setAiProblem(null);
    const r = await streamSuggestion(workspaceId, conversationId, {
      signal: ac.signal,
      onDelta: (t) => { setSuggestPhase("streaming"); setDraft(t); setAiDraft((a) => a ?? { mock: false }); clientId.current = null; fitComposer(); },
    });
    suggestAbort.current = null;
    if ("fallback" in r) {
      // The stream route is not available: the same draft through the plain endpoint, shown all at once.
      const j = await browserApi.call(endpoints.suggestReply, { params: { workspaceId, conversationId } });
      setSuggestPhase("idle");
      if (!j.ok) { setAiProblem({ tone: AI_WARNING.has(j.error.code) ? "warning" : "error", text: j.error.code === "forbidden" ? "You don't have permission to use AI suggestions." : errorMessage(j.error) }); return; }
      setDraft(j.data.draft); setAiDraft({ mock: j.data.mock }); clientId.current = null;
      setAnnounce("AI draft added to the reply box. Review and edit it before sending.");
      requestAnimationFrame(() => { composerRef.current?.focus(); fitComposer(); });
      return;
    }
    setSuggestPhase("idle");
    if (r.ok) {
      setDraft(r.text); setAiDraft({ mock: r.mock });
      setAnnounce("AI draft added to the reply box. Review and edit it before sending."); // once, at the end: not per chunk
      requestAnimationFrame(() => { composerRef.current?.focus(); fitComposer(); });
      return;
    }
    if ("aborted" in r) {
      if (r.text) { setAnnounce("Stopped. The part of the draft that arrived is in the reply box."); } else { setDraft(previous); setAiDraft(null); setAnnounce("Stopped."); }
      requestAnimationFrame(() => composerRef.current?.focus());
      return;
    }
    // A failure after some text arrived keeps nothing half-written: restore what the person had.
    setDraft(previous); setAiDraft(null);
    setAiProblem({ tone: AI_WARNING.has(r.code) ? "warning" : "error", text: r.code === "forbidden" ? "You don't have permission to use AI suggestions." : r.status === 429 && r.code === "rate_limited" ? "Too many suggestions. Try again in a minute." : r.message });
    setAnnounce("The AI suggestion could not be completed.");
    fitComposer();
  }
  const merge =(msg: MessageDto) => {
    setMsgs((old) => { const map = new Map(old.map((x) => [x.id, x])); map.set(msg.id, msg); return [...map.values()].sort(byId); });
    maxSeq.current = Math.max(maxSeq.current, msg.seq);
    stick.current = true;
  };
  async function submit() {
    const text = draft.trim();
    const files = uploads.ready.map((u) => u.attachmentId!);
    if ((!text && files.length === 0) || uploads.busy || inFlight.current || !detail || replyUsage(detail.platform, text, MAX_REPLY_LENGTH).over) return;
    inFlight.current = true; // a ref, not state: two clicks in the same frame still see it
    setSubmitting(true);
    clientId.current ??= crypto.randomUUID();
    // Files go one per message (the channel sends one file per message): the text is the caption of the first, the rest follow without text. Without files this is the unchanged text send.
    const first = await browserApi.call(endpoints.sendMessage, { params, body: { clientMsgId: clientId.current, body: text, ...(files.length ? { attachmentIds: [files[0]!] } : {}) } });
    let r = first;
    for (const id of files.slice(1)) {
      if (!r.ok || r.data.message.deliveryState === "failed") break;
      r = await browserApi.call(endpoints.sendMessage, { params, body: { clientMsgId: crypto.randomUUID(), body: "", attachmentIds: [id] } });
      if (r.ok) merge(r.data.message);
    }
    inFlight.current = false;
    setSubmitting(false);
    if (!r.ok) {
      // Keep the draft AND the client id: pressing Send again is a retry of the same request, which the server dedupes.
      const st = r.error.status;
      toast(st === 409 || st === 422 ? errorMessage(r.error) : r.error.kind === "network" || r.error.kind === "timeout" ? "No answer from the server. It may have sent: check before resending." : errorMessage(r.error), "error");
      if (st === 409 || st === 422) { clientId.current = null; void refresh(false); }
      return;
    }
    clientId.current = null;
    merge(r.data.message);
    const st = r.data.message.deliveryState;
    if (st === "failed") setDraft((d) => (d === "" ? text : d)); // the text is not lost: edit and send again as a new message
    else { setDraft(""); setAiDraft(null); }
    if (files.length) { uploads.clear(); void refreshAtt(); }
    if (st === "unknown") toast("Meta did not confirm this message. Check it before resending.", "error");
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

  const left = detail.platform === "email" ? null : windowMinutesLeft(detail, now);
  // Email: no reply window. A sender that failed SPF/DKIM, or an address that bounced, cannot be answered (the server refuses too).
  const emailBlock = detail.platform === "email" && detail.email ? (detail.email.unverifiedSender ? "unverified" : detail.email.undeliverable ? "bounced" : null) : null;
  const canType = detail.replyWindow === "open" && !emailBlock;
  const usage = replyUsage(detail.platform, draft, MAX_REPLY_LENGTH);
  const name = detail.contact.name;
  // Reply window: a chip in the header, a thin line under it, and an explanation inside the conversation.
  const win: { tone: "ok" | "warn" | "closed" | "none"; text: string } | null = detail.platform === "email" ? null : detail.replyWindow === "closed" ? { tone: "closed", text: "Closed" } : detail.replyWindow === "none" ? { tone: "none", text: "Waiting for them" } : left !== null ? { tone: left < 120 ? "warn" : "ok", text: `${fmtLeft(left)} left` } : null;
  const channelName = detail.platform === "instagram" ? "Instagram" : detail.platform === "whatsapp" ? "WhatsApp" : detail.platform === "email" ? "email here" : "Messenger";
  const assigneeOptions = [{ id: myUserId, name: "Me" }, ...(canAssignAny ? members.filter((m) => m.userId !== myUserId && m.status === "active").map((m) => ({ id: m.userId, name: m.name })) : [])];
  const current = detail.assignee;
  if (current && !assigneeOptions.some((o) => o.id === current.userId)) assigneeOptions.push({ id: current.userId, name: current.name });
  const panelOpen = lg ? ctxOpen : sheet;
  const STATUS: { id: ConversationDetail["status"]; label: string }[] = [{ id: "open", label: "Open" }, { id: "pending", label: "Pending" }, { id: "resolved", label: "Resolved" }];

  return (
    <div className="fade-in flex min-w-0 flex-1">
      <section aria-label={`Conversation with ${name}`} className="flex min-w-0 flex-1 flex-col bg-canvas">
        <header className="border-b border-line bg-surface">
          <div className="flex items-center gap-1 py-1.5 pl-1 pr-1.5 md:gap-3 md:px-4 md:py-3">
            <Link href={`/w/${workspaceId}/inbox`} aria-label="Back to inbox" className="press inline-flex size-11 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-hover md:hidden"><ChevronLeft className="size-5" aria-hidden /></Link>
            <span className="hidden md:inline-flex"><Avatar name={name} src={detail.contact.avatarUrl} size="xl" /></span>
            <div className="min-w-0 flex-1">
              <h2 ref={headingRef} tabIndex={-1} className="truncate text-md font-semibold text-fg outline-none"><Link href={`/w/${workspaceId}/contacts/${detail.contact.id}`} className="inline-block hover:underline pointer-coarse:-my-3 pointer-coarse:py-3">{name}</Link></h2>
              <div className="flex min-w-0 items-center gap-1.5"><ChannelBadge platform={detail.platform} account={detail.accountName} />{detail.status !== "open" && <Badge tone={detail.status === "resolved" ? "success" : "warning"}>{detail.status === "resolved" ? "Resolved" : "Pending"}</Badge>}</div>
              {detail.fromPage && <FromPage url={detail.fromPage} />}
            </div>
            {win && (
              <Badge tone={win.tone === "ok" ? "success" : win.tone === "warn" ? "warning" : "neutral"} className="shrink-0" title={win.tone === "closed" ? "The 24-hour reply window is closed" : "The 24-hour reply window"}>
                {win.tone === "closed" ? <Lock className="size-3" aria-hidden /> : <Clock className="size-3" aria-hidden />}<span className="sr-only">Reply window: </span>{win.text}
              </Badge>
            )}
            <Button variant={panelOpen ? "secondary" : "ghost"} icon aria-expanded={panelOpen} aria-controls="contact-panel" aria-label="Lead" onClick={toggleCtx} title="Lead (C)" className={cn("shrink-0 pointer-coarse:size-11", panelOpen && "border-accent/30 bg-accent-subtle text-accent-fg")}><PanelRight aria-hidden /></Button>
            {canReply && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" icon aria-label="More actions" className="shrink-0 pointer-coarse:size-11"><MoreHorizontal aria-hidden /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Conversation status</DropdownMenuLabel>
                  {STATUS.map((o) => <DropdownMenuItem key={o.id} onSelect={() => void change({ status: o.id })}>{o.label}{detail.status === o.id && <Check className="ml-auto !text-accent" aria-label="Current status" />}</DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {(win?.tone === "ok" || win?.tone === "warn") && left !== null && <div aria-hidden className="h-[3px] bg-line"><div className={cn("h-full rounded-r-full transition-[width] duration-[var(--dur-slow)]", win.tone === "warn" ? "bg-warning" : "bg-success")} style={{ width: `${Math.max(2, Math.min(100, (left / 1440) * 100))}%` }} /></div>}
          <div className="grid grid-cols-2 gap-2 border-t border-line px-3 py-2.5 md:flex md:px-4">
            <StageControl ctl={lead} canEdit={canEditLead} tile />
            {canReply ? (
              <label className="press relative flex h-14 min-w-0 cursor-pointer flex-col justify-center rounded-xl border border-line bg-surface px-3 shadow-control hover:border-line-strong md:h-11 md:w-56 md:pointer-coarse:h-14">
                <span className="text-xs text-fg-subtle">Assignee</span>
                <span className="flex min-w-0 items-center gap-1.5 text-base font-semibold"><span className="truncate">{detail.assignee ? (assigneeOptions.find((o) => o.id === detail.assignee!.userId)?.name ?? detail.assignee.name) : "Unassigned"}</span><ChevronDown className="ml-auto size-4 shrink-0 text-fg-subtle" aria-hidden /></span>
                <select aria-label="Assignee" className="absolute inset-0 size-full cursor-pointer opacity-0" value={detail.assignee?.userId ?? ""} onChange={(e) => void change({ assigneeUserId: e.target.value || null })}>
                  <option value="">Unassigned</option>
                  {assigneeOptions.map((o) => <option key={o.id} value={o.id} disabled={!canAssignAny && o.id !== myUserId && o.id !== current?.userId}>{o.name}</option>)}
                </select>
              </label>
            ) : <span className="flex h-14 flex-col justify-center rounded-xl border border-line px-3 md:h-11"><span className="text-xs text-fg-subtle">Assignee</span><span className="truncate text-base font-semibold">{detail.assignee ? detail.assignee.name : "Unassigned"}</span></span>}
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
                  <Bubble m={m} now={now} run={continuesRun(m, msgs[i + 1])} onDecide={canReply ? decide : undefined} deciding={deciding} files={att?.items.filter((x) => x.messageId === m.id) ?? []} storageConfigured={att?.storageConfigured ?? true} onFilesChanged={refreshAtt} />
                </React.Fragment>
              );
            })}
            {detail.platform !== "email" && (detail.replyWindow === "closed" || detail.replyWindow === "none") && (
              <div role="note" className="mb-1 mt-4 self-stretch">
                <p className="flex items-center gap-3 text-xs font-semibold text-fg-muted"><span className="h-px flex-1 bg-line" /><span className="inline-flex items-center gap-1.5"><Lock className="size-3.5" aria-hidden />{detail.replyWindow === "closed" ? "Reply window closed" : "No reply window yet"}</span><span className="h-px flex-1 bg-line" /></p>
                <p className="mx-auto mt-1.5 max-w-prose text-center text-sm text-fg-muted">{detail.replyWindow === "closed" ? `More than 24 hours have passed since ${name}'s last message. ${detail.platform === "whatsapp" ? "WhatsApp allows replies only within 24 hours of the customer's last message." : "Meta only allows replies within 24 hours."} You can reply as soon as ${name} writes again.` : `You can reply after ${name} writes first.`}</p>
              </div>
            )}
          </div>
          <Button size="sm" variant={pendingNew > 0 ? "primary" : "secondary"} tabIndex={atBottom ? -1 : 0} aria-hidden={atBottom} onClick={toBottom}
            className={cn("absolute bottom-3 left-1/2 -translate-x-1/2 shadow-popover transition-[opacity,transform] duration-[var(--dur-base)] ease-[var(--ease-out)]", atBottom ? "pointer-events-none translate-y-2 opacity-0" : "opacity-100")}>
            <ArrowDown aria-hidden />{pendingNew > 0 ? `${pendingNew} new message${pendingNew > 1 ? "s" : ""}` : "Latest"}
          </Button>
        </div>
        <p role="status" aria-live="polite" className="sr-only">{announce}</p>

        <footer className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1 md:px-4 md:pb-4">
          {!canReply ? <p className="py-3 text-sm text-fg-muted">You have read-only access.</p> : (
            <>
              {emailBlock === "unverified" && <Alert tone="warning" className="mb-2">Unverified sender: this email failed the sender checks (SPF/DKIM), so it may not be from {detail.email?.address}. Replying is turned off. Reach them another way.</Alert>}
              {emailBlock === "bounced" && <Alert tone="warning" className="mb-2">Email to {detail.email?.address} bounced, so it is not sent again. Update the lead&apos;s email or reach them another way.</Alert>}
              {left !== null && left < 120 && detail.replyWindow === "open" && <p role="status" className="mb-1.5 flex items-center gap-1.5 px-1 text-sm font-medium text-warning-fg"><Clock className="size-4 shrink-0" aria-hidden />The reply window closes in {Math.floor(left / 60)} h {left % 60} min. After that you can&apos;t reply until {name} writes again.</p>}
              <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className={cn("rounded-2xl border border-line-strong bg-surface transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus-within:border-accent focus-within:ring-[3px] focus-within:ring-accent/20", !canType && "bg-hover")}>
                {(aiDraft || suggesting) && (
                  <div className="flex items-center gap-2 px-3 pt-2 text-sm text-fg-muted">
                    <Badge tone="accent"><Sparkles className="size-3" aria-hidden />AI draft{aiDraft?.mock ? " (mock)" : ""}</Badge>
                    <span className="min-w-0 flex-1" data-testid="ai-draft-status">{suggestPhase === "connecting" ? "Connecting to the AI provider…" : suggestPhase === "streaming" ? "Writing a draft… You can stop at any time." : "Review and edit before sending. Nothing is sent automatically."}</span>
                    {!suggesting && <button type="button" onClick={() => { setAiDraft(null); setDraft(""); }} className="rounded px-2 py-1 text-fg-muted underline underline-offset-2 hover:text-fg focus-visible:outline-2 pointer-coarse:min-h-11" aria-label="Discard AI draft">Discard</button>}
                  </div>
                )}
                <UploadList uploads={uploads} notice={pickNotice} />
                <Textarea
                  ref={composerRef}
                  aria-label="Reply"
                  aria-describedby="composer-hint"
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); if (e.target.value === "") setAiDraft(null); const t = e.currentTarget; t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 160)}px`; }}
                  onKeyDown={(e) => { if (isSendKey({ key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing })) { e.preventDefault(); void submit(); } }}
                  disabled={!canType}
                  readOnly={suggesting}
                  placeholder={canType ? "Write a reply" : "Replies are unavailable for this conversation"}
                  className="min-h-12 resize-none rounded-2xl border-0 bg-transparent px-4 pt-3 shadow-none hover:border-0 focus-visible:ring-0"
                  rows={1}
                />
                {canType && (usage.used > usage.max * 0.8 || usage.over) && (
                  <p role="status" className={cn("px-4 pb-1 text-xs", usage.over ? "font-semibold text-danger-fg" : "text-right text-fg-subtle")}>
                    {usage.over ? `Too long for ${channelName}: shorten it to send. ` : ""}{usage.used}/{usage.max} {usage.unit}
                  </p>
                )}
                {canType ? (
                  <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
                    <AttachControls uploads={uploads} platform={detail.platform} storageConfigured={att?.storageConfigured ?? false} disabled={submitting} />
                    <VoiceInputButton variant="toolbar" target={composerRef} disabled={submitting || suggesting} />
                    {suggesting
                      ? <Button type="button" variant="ghost" onClick={() => suggestAbort.current?.abort()} aria-label="Stop AI suggestion" className="pointer-coarse:h-11"><Square aria-hidden /><span className="max-sm:sr-only">Stop</span></Button>
                      : <Button type="button" variant="ghost" disabled={submitting} onClick={() => void suggest()} aria-label="Suggest reply with AI" className="pointer-coarse:h-11 pointer-coarse:min-w-11"><Sparkles aria-hidden /><span className="max-sm:sr-only">Suggest reply</span></Button>}
                    <span className="flex-1" />
                    <Button type="submit" variant="primary" size="lg" loading={submitting} disabled={suggesting || (draft.trim() === "" && uploads.ready.length === 0) || uploads.busy || usage.over} className="px-4 pointer-coarse:h-11"><Send aria-hidden />Send</Button>
                  </div>
                ) : (
                  <p className="flex items-center gap-2 px-4 pb-3 text-sm text-fg-muted"><Lock className="size-4 shrink-0" aria-hidden />{emailBlock ? "This email can't be answered here." : `Replies are off. You can reply when ${name} writes again.`}</p>
                )}
              </form>
              <p id="composer-hint" className="mt-1.5 px-1 text-xs text-fg-subtle max-sm:sr-only">Enter to send, Shift+Enter for a new line.</p>
              {aiProblem && <Alert tone={aiProblem.tone} className="mt-2">{aiProblem.text}</Alert>}
            </>
          )}
        </footer>
      </section>

      {/* Closed by default. On wide screens the panel slides open in place; below that it is a sheet. */}
      <aside id="contact-panel" aria-label="Lead" aria-hidden={!(lg && ctxOpen)} inert={!(lg && ctxOpen)}
        className={cn("hidden shrink-0 overflow-hidden border-l bg-surface transition-[width,border-color] duration-[var(--dur-slow)] ease-[var(--ease-out)] lg:block", lg && ctxOpen ? "w-[320px] border-line" : "w-0 border-transparent")}>
        <div className={cn("h-full w-[320px] overflow-y-auto transition-transform duration-[var(--dur-slow)] ease-[var(--ease-out)]", lg && ctxOpen ? "translate-x-0" : "translate-x-3")}>
          <ContactPanel d={detail} workspaceId={workspaceId} now={now} lead={lead} canEditLead={canEditLead} onClose={toggleCtx} />
        </div>
      </aside>
      <Sheet open={sheet && !lg} onOpenChange={setSheet} title="Lead" description={`Details for ${name}`}>
        <ContactPanel d={detail} workspaceId={workspaceId} now={now} lead={lead} canEditLead={canEditLead} />
      </Sheet>
    </div>
  );
}

function Bubble({ m, now, run, onDecide, deciding, files, storageConfigured, onFilesChanged }: { m: MessageDto; now: number; run: boolean; onDecide?: (id: string, d: "sent" | "not_sent") => void; deciding: boolean; files: AttachmentDto[]; storageConfigured: boolean; onFilesChanged: () => void }) {
  const out = m.direction === "out";
  const ext = m.senderKind === "external";
  const who = out && !ext ? (m.senderName ?? (m.senderKind === "system" ? "System" : "You")) : null;
  return (
    <div className={cn("rise flex", out ? "justify-end" : "justify-start", run ? "mb-0.5" : "mb-3")}>
      <div className={cn("flex max-w-[85%] flex-col md:max-w-[34rem]", out ? "items-end" : "items-start")}>
        <div className={cn("rounded-2xl border px-3.5 py-2 text-left text-base",
          !out ? "rounded-bl-sm border-line bg-surface text-fg" : ext ? "rounded-br-sm border-accent/20 bg-accent-subtle text-fg" : "rounded-br-sm border-transparent bg-accent text-on-accent")}>
          {m.email && (m.email.subject || m.email.unverifiedSender) && (
            <p className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
              {m.email.subject && <span data-testid="email-subject" className="break-words">{m.email.subject}</span>}
              {m.email.unverifiedSender && <Badge tone="warning" shape="square">Unverified sender</Badge>}
            </p>
          )}
          {/* Plain text only: React escapes it, line breaks are kept by CSS. No HTML from an email is ever rendered. */}
          {m.body && <p className="whitespace-pre-wrap break-words leading-[1.55]">{m.body}</p>}
          {m.email && m.email.attachmentCount > 0 && <p className="mt-1.5 text-xs opacity-80">{m.email.attachmentCount} attachment{m.email.attachmentCount === 1 ? "" : "s"} not stored{m.email.attachmentsNotStored.some((a) => a.name !== "attachment") ? ": " + m.email.attachmentsNotStored.map((a) => a.name).join(", ") : ""}.</p>}
          {files.length > 0 ? <MessageFiles items={files} storageConfigured={storageConfigured} onChanged={onFilesChanged} /> : <Attachments items={m.attachments} />}
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

const SOURCE_LABEL: Record<string, string> = { messenger: "Messenger", instagram: "Instagram", whatsapp: "WhatsApp", telegram: "Telegram", email: "Email", web_chat: "Web chat", manual: "Added by hand", import: "Imported", other: "Other" };

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
        {onClose && <Button variant="ghost" icon size="sm" aria-label="Close lead panel" onClick={onClose}><X aria-hidden /></Button>}
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
            <Link href={`/w/${workspaceId}/contacts/${lead.lead.primaryContact.id}`} className="mt-3 inline-block text-sm font-medium text-accent-fg hover:underline">Open lead</Link>
          </div>
        ) : (
          <div><p className="mb-2 text-sm text-fg-muted">This lead is not in the pipeline yet.</p><StageControl ctl={lead} canEdit={canEditLead} block className="w-full justify-start" /></div>
        )}
      </div>
      <div className="space-y-4 p-5">
        <DetectedMethods methods={c.methods} />
        <Button variant="secondary" size="sm" asChild><Link href={`/w/${workspaceId}/contacts/${c.id}`}>Open lead</Link></Button>
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

/** Web chat: the page the visitor wrote from. Text only; it becomes a link only when it parses as http(s). The API already stripped the query string and fragment. */
function FromPage({ url }: { url: string }) {
  let u: URL | null = null;
  try { u = new URL(url); } catch { /* shown as plain text below */ }
  const label = u ? `${u.host}${u.pathname === "/" ? "" : u.pathname}` : url;
  const href = u && (u.protocol === "https:" || u.protocol === "http:") ? u.href : null;
  return <p className="mt-0.5 truncate text-xs text-fg-muted" data-testid="from-page">From page: {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="underline hover:text-fg">{label}</a> : label}</p>;
}
