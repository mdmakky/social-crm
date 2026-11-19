"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Bell, CheckCheck, CheckCircle2, CheckSquare, ChevronRight, Clock, FileUp, Settings, User, X } from "lucide-react";
import { endpoints, type NotificationDto, type Task } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { browserApi, errorMessage } from "@/lib/client-api";
import { cn } from "@/lib/cn";
import { useWorkspacePrefs } from "@/components/shell/workspace-prefs";
import { notificationLink } from "./notification-list";
import { NOTIFICATIONS_CHANGED } from "./notification-bell";

const changed = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
const FILTERS = [
  { id: "all", label: "All", match: () => true },
  { id: "reminders", label: "Reminders", match: (k: string) => k === "task.reminder" },
  { id: "tasks", label: "Tasks", match: (k: string) => k === "task.assigned" },
  { id: "leads", label: "Leads", match: (k: string) => k.startsWith("contact.") || k.startsWith("lead.") },
  { id: "system", label: "System", match: (k: string) => k === "import.completed" },
] as const;
type FilterId = (typeof FILTERS)[number]["id"];
const kindIcon = (k: string) => (k === "task.reminder" ? Clock : k === "task.assigned" ? CheckSquare : k === "import.completed" ? FileUp : User);

const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};
const timeOf = (d: Date, h12 = true) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: h12 });
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
/** "Overdue 2 h", "in 48 min", "Tomorrow", "Mon 23 Nov" and a tone for the chip. */
function dueInfo(iso: string, now: Date, h12 = true): { label: string; tone: "danger" | "warning" | "accent" | "neutral"; at: string } {
  const d = new Date(iso);
  const diff = Math.round((d.getTime() - now.getTime()) / 60_000);
  const hm = (n: number) => (n >= 60 ? `${Math.floor(n / 60)} h${n % 60 ? ` ${n % 60} min` : ""}` : `${n} min`);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const at = sameDay(d, now) ? `${timeOf(d, h12)} today` : timeOf(d, h12);
  if (diff < 0) return { label: `Overdue ${hm(Math.min(-diff, 60 * 24 * 30))}`, tone: "danger", at };
  if (diff <= 60) return { label: `in ${hm(Math.max(diff, 1))}`, tone: "warning", at };
  if (sameDay(d, now)) return { label: `in ${hm(diff)}`, tone: "accent", at };
  if (sameDay(d, tomorrow)) return { label: "Tomorrow", tone: "neutral", at };
  return { label: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }), tone: "neutral", at };
}
const SNOOZE = [
  { label: "10 min", at: (n: Date) => new Date(n.getTime() + 10 * 60_000) },
  { label: "1 hour", at: (n: Date) => new Date(n.getTime() + 60 * 60_000) },
  { label: "Tomorrow", at: (n: Date) => new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 9, 0) },
];

function TaskRow({ h12, t, now, busy, snoozing, onDone, onSnoozeToggle, onSnooze, onOpen }: { h12: boolean; t: Task; now: Date; busy: boolean; snoozing: boolean; onDone: () => void; onSnoozeToggle: () => void; onSnooze: (d: Date) => void; onOpen: () => void }) {
  const info = t.dueAt ? dueInfo(t.dueAt, now, h12) : null;
  return (
    <li className="rounded-card border border-line p-3" data-testid="panel-task">
      <p className="font-semibold text-fg">{t.title}</p>
      <p className="mt-0.5 text-sm text-fg-muted">{t.contact ? `Lead · ${t.contact.name}` : "Task · assigned to you"}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {info && <Badge tone={info.tone}>{info.label}</Badge>}
        {info && <span className="text-xs text-fg-subtle">{info.at}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="primary" disabled={busy} onClick={onDone}><CheckCircle2 />Done</Button>
        <Button size="sm" aria-expanded={snoozing} disabled={busy} onClick={onSnoozeToggle}><Clock />Snooze</Button>
        <Button size="sm" variant="ghost" onClick={onOpen}>Open<ChevronRight /></Button>
      </div>
      {snoozing && (
        <div role="group" aria-label="Snooze for" className="mt-2 flex flex-wrap gap-1.5">
          {SNOOZE.map((s) => <button key={s.label} type="button" disabled={busy} onClick={() => onSnooze(s.at(now))} className="press inline-flex h-8 items-center rounded-full bg-subtle px-3 text-sm font-medium hover:bg-accent-subtle hover:text-accent-fg pointer-coarse:h-11 pointer-coarse:flex-1 pointer-coarse:justify-center">{s.label}</button>)}
        </div>
      )}
    </li>
  );
}

export function NotificationPanel({ workspaceId, open, onOpenChange, anchor }: { workspaceId: string; open: boolean; onOpenChange: (o: boolean) => void; anchor: React.RefObject<HTMLElement | null> }) {
  const router = useRouter();
  const h12 = useWorkspacePrefs().timeFormat === "12h";
  const [tab, setTab] = React.useState<"tasks" | "updates">("tasks");
  const [filter, setFilter] = React.useState<FilterId>("all");
  const [tasks, setTasks] = React.useState<Task[] | null>(null);
  const [items, setItems] = React.useState<NotificationDto[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [snoozeId, setSnoozeId] = React.useState<string | null>(null);
  const [undo, setUndo] = React.useState<{ msg: string; run: () => void } | null>(null);
  const [now, setNow] = React.useState(() => new Date());
  const undoTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = React.useCallback(async () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const [t, n] = await Promise.all([
      browserApi.call(endpoints.listTasks, { params: { workspaceId }, query: { assignee: "me", status: "open,in_progress", sort: "due", limit: 50, tz, dueTo: new Date(Date.now() + 8 * 86_400_000).toISOString() } }),
      browserApi.call(endpoints.listNotifications, { params: { workspaceId }, query: { limit: 40 } }),
    ]);
    setNow(new Date());
    if (!t.ok) { setError(errorMessage(t.error)); return; }
    if (!n.ok) { setError(errorMessage(n.error)); return; }
    setError(null);
    setTasks(t.data.items.filter((x) => x.dueAt));
    setItems(n.data.items);
  }, [workspaceId]);
  React.useEffect(() => { if (open) { void load(); } }, [open, load]); // eslint-disable-line react-hooks/set-state-in-effect
  React.useEffect(() => {
    if (!open) return;
    const on = () => void load();
    window.addEventListener(NOTIFICATIONS_CHANGED, on);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED, on);
  }, [open, load]);

  const flash = (msg: string, run: () => void) => { clearTimeout(undoTimer.current); setUndo({ msg, run }); undoTimer.current = setTimeout(() => setUndo(null), 6000); };

  async function patchTask(t: Task, body: { status?: "done" | "open"; dueAt?: string; remindAt?: string | null }) {
    setBusy(t.id);
    const r = await browserApi.call(endpoints.updateTask, { params: { workspaceId, taskId: t.id }, body: { ...body, expectedVersion: t.version } });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return null; }
    return r.data;
  }
  async function done(t: Task) {
    const u = await patchTask(t, { status: "done" });
    if (!u) return;
    setTasks((cur) => (cur ?? []).filter((x) => x.id !== t.id));
    flash("Marked done", () => { void patchTask(u, { status: "open" }).then(() => load()); setUndo(null); });
    changed();
  }
  async function snooze(t: Task, to: Date) {
    // keep the same lead time for the reminder; drop it when it would already be in the past
    const lead = t.remindAt && t.dueAt ? new Date(t.dueAt).getTime() - new Date(t.remindAt).getTime() : null;
    const remind = lead !== null && to.getTime() - lead > now.getTime() ? new Date(to.getTime() - lead).toISOString() : null;
    const u = await patchTask(t, { dueAt: to.toISOString(), remindAt: remind });
    if (!u) return;
    setSnoozeId(null);
    setTasks((cur) => (cur ?? []).map((x) => (x.id === t.id ? u : x)).sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? "")));
    flash(`Snoozed to ${to.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${timeOf(to, h12)}`, () => { void patchTask(u, { dueAt: t.dueAt!, remindAt: t.remindAt }).then(() => load()); setUndo(null); });
  }
  async function read(n: NotificationDto) {
    if (n.readAt) return;
    const r = await browserApi.call(endpoints.setNotificationRead, { params: { workspaceId, notificationId: n.id }, body: { read: true } });
    if (r.ok) { setItems((cur) => (cur ?? []).map((x) => (x.id === n.id ? r.data : x))); changed(); }
  }
  async function markAll() {
    const r = await browserApi.call(endpoints.markAllNotificationsRead, { params: { workspaceId } });
    if (!r.ok) return setError(errorMessage(r.error));
    const stamp = new Date().toISOString();
    setItems((cur) => (cur ?? []).map((x) => (x.readAt ? x : { ...x, readAt: stamp })));
    changed();
  }
  const go = (href: string | null) => { onOpenChange(false); if (href) router.push(href); };
  const taskHref = (t: Task) => (t.contact ? `/w/${workspaceId}/contacts/${t.contact.id}` : `/w/${workspaceId}/tasks`);
  const itemHref = (n: NotificationDto) => (n.kind.startsWith("task.") && n.entityType === "task" && !n.data.contactId ? `/w/${workspaceId}/tasks` : notificationLink(workspaceId, n));

  const unread = (items ?? []).filter((n) => !n.readAt).length;
  const today = (tasks ?? []).filter((t) => new Date(t.dueAt!) < new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const upcoming = (tasks ?? []).filter((t) => !today.includes(t));
  const shown = (items ?? []).filter((n) => FILTERS.find((f) => f.id === filter)!.match(n.kind));
  const count = (id: FilterId) => (items ?? []).filter((n) => FILTERS.find((f) => f.id === id)!.match(n.kind)).length;
  const loading = tasks === null && !error;
  const group = (label: string, list: Task[]) => list.length > 0 && (
    <section aria-label={label}>
      <h4 className="bg-subtle px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{label} · {list.length}</h4>
      <ul className="flex flex-col gap-2 p-3">
        {list.map((t) => <TaskRow key={t.id} h12={h12} t={t} now={now} busy={busy === t.id} snoozing={snoozeId === t.id} onDone={() => void done(t)} onSnoozeToggle={() => setSnoozeId(snoozeId === t.id ? null : t.id)} onSnooze={(d) => void snooze(t, d)} onOpen={() => go(taskHref(t))} />)}
      </ul>
    </section>
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="scrim fixed inset-0 z-40 bg-fg/25 md:bg-transparent" />
        <DialogPrimitive.Content
          onCloseAutoFocus={(e) => { e.preventDefault(); anchor.current?.focus(); }}
          data-testid="notification-panel"
          className="pop sheet fixed inset-x-0 bottom-0 z-50 flex h-[88dvh] flex-col overflow-hidden rounded-t-[var(--radius-sheet)] bg-surface shadow-popover outline-none md:inset-x-auto md:bottom-auto md:right-4 md:top-[calc(var(--topbar-total)+0.25rem)] md:h-auto md:max-h-[calc(100dvh-var(--topbar-total)-1.5rem)] md:w-[min(880px,calc(100vw-2rem))] md:rounded-card md:border md:border-line"
        >
          <span aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong md:hidden" />
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <DialogPrimitive.Title className="text-md font-semibold text-fg">Notifications</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">Your tasks and updates</DialogPrimitive.Description>
            {unread > 0 && <Badge tone="accent">{unread} new</Badge>}
            <span className="flex-1" />
            <Button size="sm" variant="ghost" aria-label="Mark all read" disabled={unread === 0} onClick={() => void markAll()}><CheckCheck /><span className="max-md:sr-only">Mark all read</span></Button>
            <Button variant="ghost" icon aria-label="Notification settings" onClick={() => go(`/w/${workspaceId}/settings/notifications`)}><Settings /></Button>
            <DialogPrimitive.Close asChild><Button variant="ghost" icon aria-label="Close" className="md:hidden"><X /></Button></DialogPrimitive.Close>
          </div>
          <div role="tablist" aria-label="Notifications" className="flex gap-1 border-b border-line px-3 md:hidden">
            {([["tasks", "My tasks", tasks?.length ?? 0], ["updates", "Updates", items?.length ?? 0]] as const).map(([id, label, n]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cn("press relative flex min-h-11 items-center gap-1.5 px-3 text-sm font-medium", tab === id ? "text-fg after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded after:bg-accent" : "text-fg-subtle")}>{label}<Badge tone="neutral">{n}</Badge></button>
            ))}
          </div>
          {error ? (
            <div className="flex flex-col items-start gap-2 p-4" role="alert"><p className="text-sm text-danger-fg">{error}</p><Button size="sm" onClick={() => { setError(null); void load(); }}>Try again</Button></div>
          ) : (
            <div className="grid min-h-0 flex-1 md:grid-cols-2 md:divide-x md:divide-line">
              <section aria-label="My tasks" className={cn("min-h-0 flex-col overflow-y-auto overscroll-contain md:flex md:max-h-[34rem]", tab === "tasks" ? "flex" : "hidden")}>
                <div className="hidden items-center gap-2 px-4 pb-1 pt-3 md:flex"><CheckSquare className="size-4 text-fg-subtle" aria-hidden /><h3 className="font-semibold text-fg">My tasks</h3>{today.length > 0 && <Badge tone={today.some((t) => new Date(t.dueAt!) < now) ? "danger" : "neutral"}>{today.length} today</Badge>}<span className="flex-1" /><Link href={`/w/${workspaceId}/tasks`} onClick={() => onOpenChange(false)} className="text-sm font-semibold text-accent-fg">All tasks</Link></div>
                {loading ? <div className="flex flex-col gap-2 p-3" role="status" aria-label="Loading tasks"><Skeleton className="h-24" /><Skeleton className="h-24" /></div> : tasks!.length === 0 ? (
                  <div className="flex flex-col items-center gap-1 px-4 py-10 text-center text-fg-muted"><CheckCircle2 className="size-6" aria-hidden /><p className="font-semibold text-fg">All caught up</p><p className="text-sm">No tasks due in the next week.</p></div>
                ) : <>{group("Today", today)}{group("Upcoming", upcoming)}</>}
              </section>
              <section aria-label="Updates" className={cn("min-h-0 flex-col overflow-y-auto overscroll-contain md:flex md:max-h-[34rem]", tab === "updates" ? "flex" : "hidden")}>
                <div className="hidden items-center gap-2 px-4 pb-1 pt-3 md:flex"><Bell className="size-4 text-fg-subtle" aria-hidden /><h3 className="font-semibold text-fg">Updates</h3>{unread > 0 && <Badge tone="accent">{unread} new</Badge>}</div>
                <div role="group" aria-label="Filter updates" data-scroll="allowed" className="flex gap-1.5 overflow-x-auto border-b border-line px-4 py-2.5">
                  {FILTERS.map((f) => <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} className={cn("press inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-3 text-sm font-medium pointer-coarse:h-11", filter === f.id ? "border-fg bg-fg text-surface" : "border-line-strong bg-surface text-fg-muted hover:bg-hover")}>{f.label}<span className="text-xs opacity-70">{count(f.id)}</span></button>)}
                </div>
                {items === null ? <div className="flex flex-col gap-2 p-3" role="status" aria-label="Loading updates"><Skeleton className="h-16" /><Skeleton className="h-16" /></div> : shown.length === 0 ? (
                  <div className="px-4 py-10 text-center text-fg-muted"><Bell className="mx-auto mb-1 size-6" aria-hidden /><p>Nothing here.</p></div>
                ) : (
                  <ul>
                    {shown.map((n) => {
                      const Icon = kindIcon(n.kind);
                      const body = n.kind === "task.reminder" && typeof n.data.dueAt === "string" ? `Due ${dueInfo(n.data.dueAt, now, h12).at.replace(" today", "")}${sameDay(new Date(n.data.dueAt), now) ? " today" : `, ${new Date(n.data.dueAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`}.` : n.body;
                      return (
                        <li key={n.id} className="border-b border-line last:border-b-0">
                          <button type="button" data-testid="panel-update" data-unread={!n.readAt} onClick={() => { void read(n); const h = itemHref(n); if (h) go(h); }} className={cn("press relative grid w-full grid-cols-[2.25rem_minmax(0,1fr)] gap-3 px-4 py-3 text-left hover:bg-subtle", !n.readAt && "bg-accent-subtle/40 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-accent")}>
                            <span className={cn("grid size-9 place-items-center rounded-control", n.kind === "task.reminder" ? "bg-warning-subtle text-warning-fg" : "bg-accent-subtle text-accent-fg")}><Icon className="size-4" aria-hidden /></span>
                            <span className="min-w-0">
                              <span className="flex items-center gap-2"><b className="min-w-0 flex-1 font-semibold text-fg">{n.title}</b><time className="shrink-0 text-xs text-fg-subtle" dateTime={n.createdAt}>{ago(n.createdAt)}</time>{!n.readAt && <i aria-label="Unread" className="size-2 shrink-0 rounded-full bg-accent" />}</span>
                              {body && <span className="mt-0.5 block text-sm text-fg-muted [overflow-wrap:anywhere]">{body}</span>}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          )}
          {undo && (
            <div role="status" className="flex items-center gap-3 bg-fg px-4 py-2.5 text-sm text-surface"><CheckCircle2 className="size-4" aria-hidden /><span>{undo.msg}</span><button type="button" onClick={undo.run} className="press ml-auto min-h-8 font-semibold text-accent-subtle pointer-coarse:min-h-11">Undo</button></div>
          )}
          <div className="flex items-center justify-between gap-3 border-t border-line bg-subtle px-4 py-2.5">
            <Link href={`/w/${workspaceId}/notifications`} onClick={() => onOpenChange(false)} className="inline-flex min-h-8 items-center gap-1 font-semibold text-accent-fg pointer-coarse:min-h-11">View all notifications<ChevronRight className="size-4" aria-hidden /></Link>
            <Link href={`/w/${workspaceId}/settings/notifications`} onClick={() => onOpenChange(false)} className="text-sm text-fg-muted hover:text-fg">Notification settings</Link>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
