"use client";
import * as React from "react";
import { Check, CheckCircle2, FilterX, ListChecks, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { endpoints, type Member, type Task, type TaskPage, type TaskSummary } from "@crm/contracts";
import { dueState } from "@crm/core/tasks";
import { type Role } from "@crm/core/permissions";
import { canEditTask } from "@crm/core/tasks";
import { Avatar } from "@/components/ui/avatar";
import { Status } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/panel";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { ContactPicker } from "@/components/tasks/contact-picker";
import { TaskPanel } from "@/components/tasks/task-panel";
import { TaskDialog } from "@/components/tasks/task-dialog";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { DEFAULT_FILTERS, PRIORITY_HUE, PRIORITY_LABEL, SORT_OPTIONS, STATUS_OPTIONS, summaryQuery, toApiQuery, toSearchParams, VIEWS, type SortKey, type TaskFilters, type ViewKey } from "@/lib/tasks";

type Props = { workspaceId: string; timeZone: string; role: Role; myUserId: string; initial: TaskPage | null; initialSummary: TaskSummary | null; initialFilters: TaskFilters; members: Member[]; canCreate: boolean };

const COUNT_KEY: Record<ViewKey, keyof TaskSummary> = { open: "active", overdue: "overdue", today: "today", upcoming: "upcoming", no_date: "noDate", completed: "completed" };
const EMPTY: Record<ViewKey, { title: string; text: string }> = {
  open: { title: "No open tasks", text: "Create a task to keep track of follow-ups and to-dos for you and your team." },
  overdue: { title: "Nothing is overdue", text: "Every task with a due date is on schedule. Nice work." },
  today: { title: "Nothing due today", text: "Tasks due today will show up here." },
  upcoming: { title: "Nothing coming up", text: "Tasks with a due date in the future will show up here." },
  no_date: { title: "Every open task has a due date", text: "Tasks without a due date will show up here so they don't get lost." },
  completed: { title: "No completed tasks yet", text: "Tasks you mark as done will show up here." },
};

export function TasksView({ workspaceId, timeZone, role, myUserId, initial, initialSummary, initialFilters, members, canCreate }: Props) {
  const [f, setF] = React.useState<TaskFilters>(initialFilters);
  const [page, setPage] = React.useState<TaskPage>(initial ?? { items: [], total: 0, nextCursor: null });
  const [summary, setSummary] = React.useState<TaskSummary | null>(initialSummary);
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">(initial ? "idle" : "error");
  const [errorText, setErrorText] = React.useState<string | null>(null);
  const [moreBusy, setMoreBusy] = React.useState(false);
  const [newOpen, setNewOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Task | null>(null);
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [detail, setDetail] = React.useState<Task | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; undo?: () => void } | null>(null);
  const [now] = React.useState(() => new Date());
  const seq = React.useRef(0);
  const first = React.useRef(true);

  const load = React.useCallback(async (filters: TaskFilters) => {
    const mine = ++seq.current;
    setStatus("loading");
    const q = { workspaceId };
    const [list, sum] = await Promise.all([browserApi.call(endpoints.listTasks, { params: q, query: toApiQuery(filters, timeZone) }), browserApi.call(endpoints.taskSummary, { params: q, query: summaryQuery(filters, timeZone) })]);
    if (mine !== seq.current) return; // a newer request superseded this one
    if (sum.ok) setSummary(sum.data);
    if (!list.ok) { setErrorText(errorMessage(list.error)); setStatus("error"); return; }
    setPage(list.data);
    setErrorText(null);
    setStatus("idle");
  }, [workspaceId, timeZone]);

  React.useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => {
      const p = toSearchParams(f).toString();
      window.history.replaceState(null, "", p ? `?${p}` : window.location.pathname);
      void load(f);
    }, 250);
    return () => clearTimeout(t);
  }, [f, load]);

  const refresh = () => void load(f);
  const set = (p: Partial<TaskFilters>) => setF((x) => ({ ...x, ...p }));
  const setView = (view: ViewKey) => setF((x) => ({ ...x, view, status: undefined, sort: view === "completed" ? "updated:desc" : x.view === "completed" ? "due:asc" : x.sort }));
  const filtered = !!(f.assignee || f.status || f.priority || f.search || f.contactId || f.dueFrom || f.dueTo);
  const clear = () => setF((x) => ({ ...DEFAULT_FILTERS, view: x.view, sort: x.sort }));

  async function loadMore() {
    if (!page.nextCursor) return;
    setMoreBusy(true);
    const r = await browserApi.call(endpoints.listTasks, { params: { workspaceId }, query: { ...toApiQuery(f, timeZone), cursor: page.nextCursor } });
    setMoreBusy(false);
    if (!r.ok) return setErrorText(errorMessage(r.error));
    setErrorText(null);
    setPage((p) => ({ ...r.data, items: [...p.items, ...r.data.items] }));
  }

  const mayEdit = (t: Task) => canEditTask(role, myUserId, t);
  const onSaved = (t: Task) => { setNotice({ text: `Saved: ${t.title}` }); setDetail((d) => (d && d.id === t.id ? t : d)); refresh(); };
  const onCompleted = (t: Task, followUp: Task | null) => {
    setDetail(t);
    setErrorText(null);
    setNotice({
      text: followUp ? `Done. Follow-up set for ${formatDateTime(followUp.dueAt ?? "", timeZone)}` : `Marked done: ${t.title}`,
      undo: async () => {
        const u = await browserApi.call(endpoints.updateTask, { params: { workspaceId, taskId: t.id }, body: { status: "open", expectedVersion: t.version } });
        if (followUp) await browserApi.call(endpoints.deleteTask, { params: { workspaceId, taskId: followUp.id } });
        if (u.ok) { setDetail(u.data); setNotice({ text: `Restored: ${t.title}` }); } else { setNotice(null); setErrorText(errorMessage(u.error)); }
        refresh();
      },
    });
    refresh();
  };
  const onReopened = (t: Task) => { setDetail(t); setNotice({ text: `Reopened: ${t.title}` }); refresh(); };

  const grouped = f.sort.startsWith("due");
  const groupOf = (t: Task): string => {
    if (t.status === "done" || t.status === "cancelled") return "Closed";
    const s = dueState(t, now, timeZone);
    if (s === "overdue") return "Overdue";
    if (s === "today") return "Today";
    if (s === "none" || !t.dueAt) return "No date";
    return (new Date(t.dueAt).getTime() - now.getTime()) / 864e5 <= 7 ? "This week" : "Later";
  };
  const GROUPS = ["Overdue", "Today", "This week", "Later", "No date", "Closed"];
  const groups: { name: string; items: Task[] }[] = grouped
    ? GROUPS.map((name) => ({ name, items: page.items.filter((t) => groupOf(t) === name) })).filter((g) => g.items.length)
    : [{ name: "", items: page.items }];

  const empty = status === "error" && page.items.length === 0 ? "error" : page.items.length === 0 && status !== "loading" ? "empty" : null;
  const rowCount = page.items.length;

  return (
    <>
      <PageHeader
        title="Tasks"
        description={status === "error" && !page.items.length ? undefined : `${page.total.toLocaleString("en-US")} ${page.total === 1 ? "task" : "tasks"}${filtered ? " match your filters" : ""}`}
        actions={canCreate ? <Button variant="primary" onClick={() => setNewOpen(true)}><Plus />New task</Button> : undefined}
      />
      {notice && (
        <Alert tone="success" className="mb-3">
          <span className="flex flex-wrap items-center gap-2">
            {notice.text}
            {notice.undo && <Button size="sm" variant="secondary" onClick={() => void notice.undo!()}>Undo</Button>}
            <Button size="sm" variant="ghost" icon aria-label="Dismiss message" onClick={() => setNotice(null)}><X /></Button>
          </span>
        </Alert>
      )}
      {errorText && rowCount > 0 && <Alert tone="error" className="mb-3">{errorText}</Alert>}

      <div className="grid gap-4 lg:h-[calc(100dvh-12rem)] lg:min-h-[34rem] lg:grid-cols-[minmax(340px,420px)_minmax(0,1fr)]">
        <section aria-label="Task list" className="flex min-h-0 flex-col overflow-hidden rounded-card bg-surface shadow-sheet">
          <div className="border-b border-line-card px-3 pt-3">
            <div role="group" aria-label="Task views" className="-mx-1 mb-2 flex gap-1 overflow-x-auto px-1 pb-1" data-scroll="allowed">
              {VIEWS.map((v) => {
                const n = summary?.[COUNT_KEY[v.key]];
                const on = f.view === v.key;
                return (
                  <button key={v.key} type="button" aria-pressed={on} onClick={() => setView(v.key)} className={cn("press relative inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-control px-2.5 text-base pointer-coarse:h-11", on ? "font-semibold text-fg after:absolute after:inset-x-2.5 after:-bottom-0.5 after:h-0.5 after:rounded after:bg-accent" : "text-fg-subtle hover:text-fg")}>
                    {v.label}
                    {n !== undefined && <span className={`tnum rounded-full px-1.5 text-xs ${v.key === "overdue" && n > 0 ? "bg-danger-bg text-danger-fg" : "bg-hover text-fg-muted"}`}>{n.toLocaleString("en-US")}</span>}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2 pb-3">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
                <Input aria-label="Search tasks" type="search" placeholder="Search title or description" className="pl-8" value={f.search ?? ""} onChange={(e) => set({ search: e.target.value || undefined })} />
              </div>
              <Button variant="secondary" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((o) => !o)}><SlidersHorizontal />Filters{filtered ? " (on)" : ""}</Button>
            </div>
            {filtersOpen && (
              <div className="flex flex-wrap items-center gap-2 pb-3">
                <Select aria-label="Assignee" wrapperClassName="min-w-0" className="w-auto" value={f.assignee ?? ""} onChange={(e) => set({ assignee: e.target.value || undefined })}>
                  <option value="">Anyone</option>
                  <option value="me">Assigned to me</option>
                  <option value="unassigned">Unassigned</option>
                  {members.filter((m) => m.status === "active" && m.userId !== myUserId).map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
                </Select>
                {f.view === "open" && (
                  <Select aria-label="Status" className="w-auto min-w-32" value={f.status ?? ""} onChange={(e) => set({ status: e.target.value || undefined })}>
                    {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                )}
                <Select aria-label="Priority" className="w-auto min-w-28" value={f.priority ?? ""} onChange={(e) => set({ priority: e.target.value || undefined })}>
                  <option value="">Any priority</option>
                  <option value="urgent,high">Urgent and high</option>
                  {(["urgent", "high", "normal", "low"] as const).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                </Select>
                <div className="w-full max-w-full">
                  {!f.contactId && <label htmlFor="task-filter-contact" className="sr-only">Filter by lead</label>}
                  <ContactPicker id="task-filter-contact" workspaceId={workspaceId} value={f.contactId ? { id: f.contactId, name: f.contactName ?? "Lead" } : null} onChange={(c) => set({ contactId: c?.id, contactName: c?.name })} />
                </div>
                <label className="flex items-center gap-1.5 text-sm text-fg-muted">Due from<Input aria-label="Due from" type="date" className="w-36" value={f.dueFrom ?? ""} onChange={(e) => set({ dueFrom: e.target.value || undefined })} /></label>
                <label className="flex items-center gap-1.5 text-sm text-fg-muted">to<Input aria-label="Due to" type="date" className="w-36" value={f.dueTo ?? ""} onChange={(e) => set({ dueTo: e.target.value || undefined })} /></label>
                <Select aria-label="Sort by" className="w-auto" value={f.sort} onChange={(e) => set({ sort: e.target.value as SortKey })}>
                  {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
                {filtered && <Button variant="ghost" onClick={clear}><FilterX />Clear</Button>}
              </div>
            )}
          </div>

          <div className={cn("min-h-0 flex-1 overflow-y-auto", status === "loading" && "opacity-70 transition-opacity")} aria-busy={status === "loading"}>
            {empty === "error" ? (
              <ErrorState title="Tasks could not be loaded" description={errorText ?? "Check your connection and try again."} onRetry={refresh} />
            ) : empty === "empty" ? (
              filtered ? (
                <EmptyState icon={FilterX} title="No tasks match these filters" description="Try a different search or clear the filters." action={<Button onClick={clear}>Clear filters</Button>} />
              ) : (
                <EmptyState icon={f.view === "completed" ? CheckCircle2 : ListChecks} title={EMPTY[f.view].title} description={EMPTY[f.view].text} action={canCreate && f.view === "open" ? <Button variant="primary" onClick={() => setNewOpen(true)}><Plus />New task</Button> : undefined} />
              )
            ) : (
              <>
                <ul aria-label="Tasks" className="px-2 pb-2">
                  {groups.map((g) => (
                    <li key={g.name || "all"} className="list-none">
                      {g.name && <p className={cn("px-2.5 pb-1 pt-3 text-xs font-semibold", g.name === "Overdue" ? "text-danger-fg" : "text-fg-muted")}>{g.name} <span className="tnum font-normal text-fg-subtle">· {g.items.length}</span></p>}
                      <ul>
                        {g.items.map((t) => {
                          const closed = t.status === "done" || t.status === "cancelled";
                          const on = detail?.id === t.id;
                          return (
                            <li key={t.id}>
                              <button type="button" aria-current={on ? "true" : undefined} onClick={() => setDetail(t)} className={cn("press flex w-full items-center gap-3 rounded-control px-2.5 py-2.5 text-left pointer-coarse:py-3", on ? "bg-accent-soft ring-1 ring-accent/25" : "hover:bg-hover")}>
                                <StatusIcon status={t.status} />
                                <span className="min-w-0 flex-1">
                                  <span className={cn("block truncate text-base font-medium", closed ? "text-fg-subtle line-through" : "text-fg")}>{t.title}</span>
                                  <span className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-fg-subtle">{t.contact ? <span className="truncate">{t.contact.name}</span> : <span>No contact</span>}<DueCell t={t} now={now} tz={timeZone} /></span>
                                </span>
                                {(t.priority === "high" || t.priority === "urgent") && <Status hue={PRIORITY_HUE[t.priority]}>{PRIORITY_LABEL[t.priority]}</Status>}
                                {t.assignee && <Avatar name={t.assignee.name} size="xs" />}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  ))}
                </ul>
                <div className="flex items-center justify-between gap-3 border-t border-line-card px-4 py-3 text-sm text-fg-muted">
                  <span role="status">{status === "loading" ? "Updating…" : `Showing ${rowCount.toLocaleString("en-US")} of ${page.total.toLocaleString("en-US")}`}</span>
                  {page.nextCursor && <Button onClick={loadMore} loading={moreBusy}>Load more</Button>}
                </div>
              </>
            )}
          </div>
        </section>

        <section aria-label="Task detail" className={cn("flex min-h-0 flex-col bg-surface", detail ? "fixed inset-0 z-[60] lg:static lg:z-auto lg:rounded-card lg:shadow-sheet" : "hidden lg:flex lg:rounded-card lg:shadow-sheet")}>
          {detail ? (
            <TaskPanel
              key={detail.id}
              workspaceId={workspaceId}
              timeZone={timeZone}
              task={detail}
              members={members}
              myUserId={myUserId}
              canEdit={mayEdit(detail)}
              onBack={() => setDetail(null)}
              onEdit={(t) => setEditing(t)}
              onChanged={(t) => { setDetail(t); refresh(); }}
              onCompleted={onCompleted}
              onReopened={onReopened}
            />
          ) : (
            <div className="grid flex-1 place-items-center p-8 text-center text-fg-subtle"><div><ListChecks className="mx-auto mb-2 size-6" aria-hidden /><p className="font-medium text-fg">Select a task</p><p className="text-sm">Pick one from the list to see it here.</p></div></div>
          )}
        </section>
      </div>

      <TaskDialog open={newOpen} onOpenChange={setNewOpen} workspaceId={workspaceId} members={members} myUserId={myUserId} onSaved={onSaved} />
      <TaskDialog open={editing !== null} onOpenChange={(o) => { if (!o) setEditing(null); }} workspaceId={workspaceId} members={members} myUserId={myUserId} task={editing} onSaved={onSaved} key={editing?.id ?? "none"} />
    </>
  );
}

function StatusIcon({ status }: { status: Task["status"] }) {
  const label = status === "done" ? "Done" : status === "in_progress" ? "In progress" : status === "cancelled" ? "Cancelled" : "Open";
  return (
    <span role="img" aria-label={label} className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border-2", status === "done" ? "border-success bg-success text-on-accent" : status === "in_progress" ? "border-accent bg-[linear-gradient(90deg,var(--accent)_50%,transparent_50%)]" : "border-line-control")}>
      {status === "done" && <Check className="size-3" aria-hidden />}
    </span>
  );
}

function DueCell({ t, now, tz }: { t: Task; now: Date; tz: string }) {
  if (!t.dueAt) return <span className="shrink-0">· No due date</span>;
  const state = dueState(t, now, tz);
  return (
    <time dateTime={t.dueAt} suppressHydrationWarning className={`tnum shrink-0 ${state === "overdue" ? "font-medium text-danger-fg" : state === "today" ? "font-medium text-fg" : ""}`}>
      · {state === "overdue" ? "Overdue · " : state === "today" ? "Today · " : ""}{formatDateTime(t.dueAt, tz)}
    </time>
  );
}
