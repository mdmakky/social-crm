"use client";
import * as React from "react";
import { tabClass, tabListClass } from "@/components/ui/tabs";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, CheckCircle2, FilterX, ListChecks, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { endpoints, type Member, type Task, type TaskPage, type TaskSummary } from "@crm/contracts";
import { dueState } from "@crm/core/tasks";
import { type Role } from "@crm/core/permissions";
import { canEditTask } from "@crm/core/tasks";
import { Avatar } from "@/components/ui/avatar";
import { Badge, Status } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { PageHeader, Panel } from "@/components/ui/panel";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ContactPicker } from "@/components/tasks/contact-picker";
import { TaskDetail } from "@/components/tasks/task-detail";
import { TaskDialog } from "@/components/tasks/task-dialog";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { DEFAULT_FILTERS, PRIORITY_HUE, PRIORITY_LABEL, SORT_OPTIONS, STATUS_LABEL, STATUS_OPTIONS, summaryQuery, toApiQuery, toSearchParams, VIEWS, type SortKey, type TaskFilters, type ViewKey } from "@/lib/tasks";

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
  const [showFilters, setShowFilters] = React.useState(false);
  const [newOpen, setNewOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Task | null>(null);
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
  async function toggle(t: Task) {
    const to = t.status === "done" || t.status === "cancelled" ? "open" : "done";
    const r = await browserApi.call(endpoints.updateTask, { params: { workspaceId, taskId: t.id }, body: { status: to, expectedVersion: t.version } });
    if (!r.ok) { setNotice(null); setErrorText(r.error.code === "version_conflict" ? "Someone else changed that task. The list has been refreshed." : errorMessage(r.error)); return refresh(); }
    setErrorText(null);
    setNotice({
      text: to === "done" ? `Marked done: ${t.title}` : `Reopened: ${t.title}`,
      undo: async () => {
        const u = await browserApi.call(endpoints.updateTask, { params: { workspaceId, taskId: t.id }, body: { status: t.status, expectedVersion: r.data.version } });
        setNotice(u.ok ? { text: `Restored: ${t.title}` } : null);
        if (!u.ok) setErrorText(errorMessage(u.error));
        refresh();
      },
    });
    refresh();
  }

  const onSaved = (t: Task) => { setNotice({ text: `Saved: ${t.title}` }); setDetail((d) => (d && d.id === t.id ? t : d)); refresh(); };
  const dueCell = (t: Task) => <DueCell t={t} now={now} tz={timeZone} />;
  const bySort = (col: "due" | "priority") => {
    const [s, d] = f.sort.split(":");
    const active = s === col;
    set({ sort: (active ? `${col}:${d === "asc" ? "desc" : "asc"}` : col === "due" ? "due:asc" : "priority:desc") as SortKey });
  };
  const sortState = (col: "due" | "priority") => { const [s, d] = f.sort.split(":"); return s === col ? (d === "asc" ? "ascending" : "descending") : "none"; };

  return (
    <>
      <PageHeader
        title="Tasks"
        description={status === "error" && !page.items.length ? undefined : `${page.total.toLocaleString("en-US")} ${page.total === 1 ? "task" : "tasks"}${filtered ? " match your filters" : ""}`}
        actions={canCreate ? <Button variant="primary" onClick={() => setNewOpen(true)}><Plus />New task</Button> : undefined}
      />

      <div role="group" aria-label="Task views" className={tabListClass} data-scroll="allowed">
        {VIEWS.map((v) => {
          const n = summary?.[COUNT_KEY[v.key]];
          const on = f.view === v.key;
          return (
            <button key={v.key} type="button" aria-pressed={on} onClick={() => setView(v.key)} className={tabClass(on)}>
              {v.label}
              {n !== undefined && <span className={`tnum rounded-full px-1.5 text-xs ${v.key === "overdue" && n > 0 ? "bg-danger-bg text-danger-fg" : "bg-hover text-fg-muted"}`}>{n.toLocaleString("en-US")}</span>}
            </button>
          );
        })}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-48 sm:max-w-52">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input aria-label="Search tasks" type="search" placeholder="Search title or description" className="pl-8" value={f.search ?? ""} onChange={(e) => set({ search: e.target.value || undefined })} />
        </div>
        <Button variant="secondary" className="md:hidden" aria-expanded={showFilters} onClick={() => setShowFilters((s) => !s)}><SlidersHorizontal />Filters{filtered ? " (on)" : ""}</Button>
        <div className={`${showFilters ? "flex" : "hidden"} w-full flex-wrap items-center gap-2 md:flex md:w-auto`}>
          <Select aria-label="Assignee" className="w-auto" value={f.assignee ?? ""} onChange={(e) => set({ assignee: e.target.value || undefined })}>
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
          <div className="w-48 max-w-full">
            {!f.contactId && <label htmlFor="task-filter-contact" className="sr-only">Filter by lead</label>}
            <ContactPicker id="task-filter-contact" workspaceId={workspaceId} value={f.contactId ? { id: f.contactId, name: f.contactName ?? "Contact" } : null} onChange={(c) => set({ contactId: c?.id, contactName: c?.name })} />
          </div>
          <label className="flex items-center gap-1.5 text-sm text-fg-muted">Due from<Input aria-label="Due from" type="date" className="w-36" value={f.dueFrom ?? ""} onChange={(e) => set({ dueFrom: e.target.value || undefined })} /></label>
          <label className="flex items-center gap-1.5 text-sm text-fg-muted">to<Input aria-label="Due to" type="date" className="w-36" value={f.dueTo ?? ""} onChange={(e) => set({ dueTo: e.target.value || undefined })} /></label>
          {filtered && <Button variant="ghost" onClick={clear}><FilterX />Clear</Button>}
        </div>
        <div className="ml-auto">
          <Select aria-label="Sort by" className="w-auto" value={f.sort} onChange={(e) => set({ sort: e.target.value as SortKey })}>
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </div>
      </div>

      {notice && (
        <Alert tone="success" className="mb-3">
          <span className="flex flex-wrap items-center gap-2">
            {notice.text}
            {notice.undo && <Button size="sm" variant="secondary" onClick={() => void notice.undo!()}>Undo</Button>}
            <Button size="sm" variant="ghost" icon aria-label="Dismiss message" onClick={() => setNotice(null)}><X /></Button>
          </span>
        </Alert>
      )}
      {errorText && page.items.length > 0 && <Alert tone="error" className="mb-3">{errorText}</Alert>}

      <Panel className={status === "loading" ? "opacity-70 transition-opacity" : ""} aria-busy={status === "loading"}>
        {status === "error" && page.items.length === 0 ? (
          <ErrorState title="Tasks could not be loaded" description={errorText ?? "Check your connection and try again."} onRetry={refresh} />
        ) : page.items.length === 0 && status !== "loading" ? (
          filtered ? (
            <EmptyState icon={FilterX} title="No tasks match these filters" description="Try a different search or clear the filters." action={<Button onClick={clear}>Clear filters</Button>} />
          ) : (
            <EmptyState icon={f.view === "completed" ? CheckCircle2 : ListChecks} title={EMPTY[f.view].title} description={EMPTY[f.view].text} action={canCreate && f.view === "open" ? <Button variant="primary" onClick={() => setNewOpen(true)}><Plus />New task</Button> : undefined} />
          )
        ) : (
          <>
            <div className="t-table">
              <Table scrollLabel="Tasks table, scrolls sideways when columns do not fit">
                <THead>
                  <tr>
                    <TH className="w-12"><span className="sr-only">Done</span></TH>
                    <TH>Task</TH>
                    <TH aria-sort={sortState("due")}><SortButton label="Due" state={sortState("due")} onClick={() => bySort("due")} /></TH>
                    <TH aria-sort={sortState("priority")}><SortButton label="Priority" state={sortState("priority")} onClick={() => bySort("priority")} /></TH>
                    <TH>Assignee</TH>
                    <TH>Lead</TH>
                  </tr>
                </THead>
                <TBody>
                  {page.items.map((t) => (
                    <TR key={t.id} className="group cursor-pointer" onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button")) setDetail(t); }}>
                      <TD className="w-12"><CheckBox t={t} allowed={mayEdit(t)} onToggle={toggle} /></TD>
                      <TD className="min-w-64 max-w-md">
                        <button type="button" onClick={() => setDetail(t)} className={`block max-w-full truncate rounded text-left text-base font-medium hover:underline ${t.status === "done" || t.status === "cancelled" ? "text-fg-subtle line-through" : "text-fg"}`}>{t.title}</button>
                        {(t.status === "in_progress" || t.status === "cancelled") && <Badge tone={t.status === "in_progress" ? "accent" : "neutral"} className="mt-0.5">{STATUS_LABEL[t.status]}</Badge>}
                      </TD>
                      <TD className="whitespace-nowrap">{dueCell(t)}</TD>
                      <TD><Status hue={PRIORITY_HUE[t.priority]}>{PRIORITY_LABEL[t.priority]}</Status></TD>
                      <TD className="whitespace-nowrap">{t.assignee ? <span className="inline-flex items-center gap-2"><Avatar name={t.assignee.name} size="xs" />{t.assignee.name}</span> : <span className="text-fg-subtle">Unassigned</span>}</TD>
                      <TD className="max-w-56">{t.contact ? <Link href={`/w/${workspaceId}/contacts/${t.contact.id}`} className="block truncate underline-offset-2 hover:underline">{t.contact.name}</Link> : <span className="text-fg-subtle">None</span>}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
            <ul className="t-cards" aria-label="Tasks">
              {page.items.map((t) => (
                <li key={t.id} className="flex items-start gap-1 border-b border-line-card px-2 py-1 last:border-b-0">
                  <CheckBox t={t} allowed={mayEdit(t)} onToggle={toggle} />
                  <button type="button" onClick={() => setDetail(t)} className="min-w-0 flex-1 rounded px-1 py-2 text-left active:bg-hover">
                    <span className={`block break-words text-base font-medium ${t.status === "done" || t.status === "cancelled" ? "text-fg-subtle line-through" : "text-fg"}`}>{t.title}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      {dueCell(t)}
                      <Status hue={PRIORITY_HUE[t.priority]}>{PRIORITY_LABEL[t.priority]}</Status>
                      {(t.status === "in_progress" || t.status === "cancelled") && <Badge tone={t.status === "in_progress" ? "accent" : "neutral"}>{STATUS_LABEL[t.status]}</Badge>}
                    </span>
                    <span className="mt-1 block truncate text-sm text-fg-muted">{t.assignee?.name ?? "Unassigned"}{t.contact ? ` · ${t.contact.name}` : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between gap-3 border-t border-line-card px-4 py-3 text-sm text-fg-muted">
              <span role="status">{status === "loading" ? "Updating…" : `Showing ${page.items.length.toLocaleString("en-US")} of ${page.total.toLocaleString("en-US")}`}</span>
              {page.nextCursor && <Button onClick={loadMore} loading={moreBusy}>Load more</Button>}
            </div>
          </>
        )}
      </Panel>

      <TaskDialog open={newOpen} onOpenChange={setNewOpen} workspaceId={workspaceId} members={members} myUserId={myUserId} onSaved={onSaved} />
      <TaskDialog open={editing !== null} onOpenChange={(o) => { if (!o) setEditing(null); }} workspaceId={workspaceId} members={members} myUserId={myUserId} task={editing} onSaved={onSaved} key={editing?.id ?? "none"} />
      <TaskDetail
        workspaceId={workspaceId}
        timeZone={timeZone}
        task={detail}
        canEdit={detail ? mayEdit(detail) : false}
        onClose={() => setDetail(null)}
        onEdit={(t) => { setDetail(null); setEditing(t); }}
        onChanged={(t) => { setDetail(t); refresh(); }}
      />
    </>
  );
}

function SortButton({ label, state, onClick }: { label: string; state: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 rounded text-xs font-medium text-fg-muted hover:text-fg">
      {label}
      {state === "ascending" ? <ArrowUp className="size-3" aria-hidden /> : state === "descending" ? <ArrowDown className="size-3" aria-hidden /> : <ArrowUpDown className="size-3 text-fg-disabled" aria-hidden />}
    </button>
  );
}

function CheckBox({ t, allowed, onToggle }: { t: Task; allowed: boolean; onToggle: (t: Task) => void }) {
  const done = t.status === "done";
  const closed = done || t.status === "cancelled";
  const label = `${closed ? "Reopen" : "Mark done"}: ${t.title}`;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={label}
      aria-disabled={!allowed}
      title={allowed ? undefined : "Only the assignee, the creator and workspace admins can change this task"}
      onClick={() => { if (allowed) onToggle(t); }}
      className={`flex size-8 shrink-0 items-center justify-center rounded pointer-coarse:size-11 ${allowed ? "" : "cursor-not-allowed opacity-50"}`}
    >
      <span className={`flex size-5 items-center justify-center rounded border ${done ? "border-accent bg-accent text-on-accent" : "border-line-control bg-surface"}`}>{done && <Check className="size-3.5" aria-hidden />}</span>
    </button>
  );
}

function DueCell({ t, now, tz }: { t: Task; now: Date; tz: string }) {
  if (!t.dueAt) return <span className="text-fg-subtle">No due date</span>;
  const state = dueState(t, now, tz);
  return (
    <time dateTime={t.dueAt} suppressHydrationWarning className={`tnum ${state === "overdue" ? "font-medium text-danger-fg" : state === "today" ? "font-medium text-fg" : "text-fg-muted"}`}>
      {state === "overdue" ? "Overdue · " : state === "today" ? "Today · " : ""}{formatDateTime(t.dueAt, tz)}
    </time>
  );
}
