"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Circle, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { endpoints, type Member, type Task, type TaskEvent, type TaskPriority, type TaskStatus } from "@crm/contracts";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form-controls";
import { Select } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { eventText, fromLocalInput, PRIORITY_LABEL, STATUS_LABEL, toLocalInput } from "@/lib/tasks";
import { emptyFollowUp, FollowUpPicker, followUpLocal, followUpReady } from "./follow-up";

type Props = {
  workspaceId: string;
  timeZone: string;
  task: Task;
  members: Member[];
  myUserId: string;
  canEdit: boolean;
  onBack: () => void;
  onEdit: (t: Task) => void;
  /** A property changed, or the task was deleted (null). */
  onChanged: (t: Task | null) => void;
  /** The task was marked done; `followUp` is the task created for what happens next, if any. */
  onCompleted: (t: Task, followUp: Task | null) => void;
  onReopened: (t: Task) => void;
};

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex min-h-11 items-center gap-3 border-b border-line-card">
    <span className="w-24 shrink-0 text-sm text-fg-subtle">{label}</span>
    <div className="min-w-0 flex-1 text-base text-fg">{children}</div>
  </div>
);

export function TaskPanel({ task, workspaceId, timeZone, members, myUserId, canEdit, onBack, onEdit, onChanged, onCompleted, onReopened }: Props) {
  const [events, setEvents] = React.useState<TaskEvent[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [histErr, setHistErr] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [fu, setFu] = React.useState(emptyFollowUp);
  const [desc, setDesc] = React.useState(task.description ?? "");
  const [due, setDue] = React.useState(toLocalInput(task.dueAt));
  const params = { workspaceId, taskId: task.id };
  const closed = task.status === "done" || task.status === "cancelled";
  const active = members.filter((m) => m.status === "active");

  const [seen, setSeen] = React.useState(task.version);
  if (seen !== task.version) { setSeen(task.version); setDesc(task.description ?? ""); setDue(toLocalInput(task.dueAt)); }

  const loadEvents = React.useCallback(async (after?: string) => {
    const r = await browserApi.call(endpoints.listTaskEvents, { params: { workspaceId, taskId: task.id }, query: { limit: 20, cursor: after } });
    if (!r.ok) return setHistErr(true);
    setHistErr(false);
    setEvents((e) => (after ? [...(e ?? []), ...r.data.items] : r.data.items));
    setCursor(r.data.nextCursor);
  }, [workspaceId, task.id]);
  React.useEffect(() => { const t = setTimeout(() => void loadEvents(), 0); return () => clearTimeout(t); }, [loadEvents, task.version]);

  async function patch(body: { status?: TaskStatus; priority?: TaskPriority; assigneeUserId?: string | null; dueAt?: string | null; description?: string | null }) {
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.updateTask, { params, body: { ...body, expectedVersion: task.version } });
    setBusy(false);
    if (!r.ok) { setError(r.error.code === "version_conflict" ? "Someone else changed this task. Reopen it to see the latest version." : errorMessage(r.error)); return false; }
    onChanged(r.data);
    return true;
  }

  async function complete() {
    if (!followUpReady(fu)) return;
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.updateTask, { params, body: { status: "done", expectedVersion: task.version } });
    if (!r.ok) { setBusy(false); return setError(r.error.code === "version_conflict" ? "Someone else changed this task. Reopen it to see the latest version." : errorMessage(r.error)); }
    let created: Task | null = null;
    const local = followUpLocal(fu);
    if (local) {
      const c = await browserApi.call(endpoints.createWorkspaceTask, { params: { workspaceId }, body: { title: `Follow up: ${task.title.replace(/^follow[- ]?up:?\s*/i, "")}`.slice(0, 200), dueAt: fromLocalInput(local), priority: task.priority, assigneeUserId: task.assignee?.id ?? myUserId, contactId: task.contact?.id ?? null } });
      if (c.ok) created = c.data; else setError(`The task is done, but the follow-up could not be created: ${errorMessage(c.error)}`);
    }
    setBusy(false);
    setFu(emptyFollowUp());
    onCompleted(r.data, created);
  }
  async function reopen() {
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.updateTask, { params, body: { status: "open", expectedVersion: task.version } });
    setBusy(false);
    if (!r.ok) return setError(errorMessage(r.error));
    onReopened(r.data);
  }
  async function remove() {
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.deleteTask, { params });
    setBusy(false);
    if (!r.ok) return setError(errorMessage(r.error));
    onChanged(null);
  }

  const flat = "h-9 w-full";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line-card px-4 py-2 lg:hidden">
        <Button variant="ghost" onClick={onBack}><ArrowLeft />Tasks</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-4 lg:px-8 lg:pt-6">
        <div className="flex items-start gap-3">
          <h2 className="min-w-0 flex-1 break-words text-xl font-semibold leading-snug tracking-title text-fg">{task.title}</h2>
          {canEdit && <Button variant="ghost" size="sm" onClick={() => onEdit(task)}><Pencil />Edit</Button>}
        </div>
        {error && <Alert tone="error" className="mt-3">{error}</Alert>}

        <div className="mt-4 border-t border-line-card">
          <Row label="Status">
            {canEdit && !closed ? (
              <Select aria-label="Status" quiet wrapperClassName="-ml-2.5 max-w-52" className={flat} disabled={busy} value={task.status} onChange={(e) => void patch({ status: e.target.value as TaskStatus })}>
                <option value="open">Open</option><option value="in_progress">In progress</option><option value="cancelled">Cancelled</option>
              </Select>
            ) : STATUS_LABEL[task.status]}
          </Row>
          <Row label="Priority">
            {canEdit ? (
              <Select aria-label="Priority" quiet wrapperClassName="-ml-2.5 max-w-52" className={flat} disabled={busy} value={task.priority} onChange={(e) => void patch({ priority: e.target.value as TaskPriority })}>
                {(["urgent", "high", "normal", "low"] as const).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </Select>
            ) : PRIORITY_LABEL[task.priority]}
          </Row>
          <Row label="Due">
            {canEdit ? (
              <input aria-label="Due" type="datetime-local" value={due} disabled={busy} onChange={(e) => setDue(e.target.value)} onBlur={() => { if (due !== toLocalInput(task.dueAt)) void patch({ dueAt: fromLocalInput(due) }); }} className="-ml-2 h-9 rounded-control bg-transparent px-2 text-base text-fg hover:bg-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/20" />
            ) : task.dueAt ? formatDateTime(task.dueAt, timeZone) : "No due date"}
          </Row>
          <Row label="Assignee">
            {canEdit ? (
              <Select aria-label="Assignee" quiet wrapperClassName="-ml-2.5 max-w-64" className={flat} disabled={busy} value={task.assignee?.id ?? ""} onChange={(e) => void patch({ assigneeUserId: e.target.value || null })}>
                <option value="">Unassigned</option>
                {active.map((m) => <option key={m.userId} value={m.userId}>{m.name}{m.userId === myUserId ? " (you)" : ""}</option>)}
              </Select>
            ) : task.assignee?.name ?? "Unassigned"}
          </Row>
          <Row label="Contact">
            {task.contact ? <Link href={`/w/${workspaceId}/contacts/${task.contact.id}`} className="inline-flex items-center gap-2 underline-offset-2 hover:underline"><Avatar name={task.contact.name} size="xs" />{task.contact.name}</Link> : <span className="text-fg-subtle">Not linked</span>}
          </Row>
        </div>

        <div className="mt-5">
          <label htmlFor="task-notes" className="mb-1.5 block text-sm font-semibold text-fg">Notes</label>
          <Textarea voice={canEdit} id="task-notes" rows={3} maxLength={4000} readOnly={!canEdit} placeholder={canEdit ? "Add a note" : "No notes"} value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={() => { if (desc.trim() !== (task.description ?? "")) void patch({ description: desc.trim() || null }); }} className="bg-subtle focus-visible:bg-surface" />
        </div>

        {canEdit ? (
          closed ? (
            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line-card pt-4">
              <Button variant="secondary" loading={busy} onClick={() => void reopen()}><RotateCcw />Reopen</Button>
              {task.completedAt && <span className="text-sm text-fg-subtle">Completed {formatDateTime(task.completedAt, timeZone)}</span>}
            </div>
          ) : (
            <div className="mt-5 border-t border-line-card pt-4">
              <FollowUpPicker value={fu} onChange={setFu} disabled={busy} />
              <div className="mt-4 flex justify-end max-sm:sticky max-sm:bottom-0 max-sm:-mx-4 max-sm:border-t max-sm:border-line-card max-sm:bg-surface max-sm:px-4 max-sm:py-3">
                <Button variant="primary" size="lg" className="max-sm:w-full" disabled={!followUpReady(fu)} loading={busy} onClick={() => void complete()}><CheckCircle2 />Mark done</Button>
              </div>
            </div>
          )
        ) : (
          <p className="mt-5 text-sm text-fg-muted">View only. The assignee, creator and admins can edit.</p>
        )}

        <section aria-labelledby="task-history" className="mt-6 border-t border-line-card pt-4">
          <h3 id="task-history" className="mb-2 text-sm font-semibold text-fg">History</h3>
          {histErr && events === null ? (
            <Alert tone="error">History could not be loaded. <Button variant="ghost" size="sm" onClick={() => void loadEvents()}>Try again</Button></Alert>
          ) : events === null ? (
            <p className="text-sm text-fg-muted" role="status">Loading history…</p>
          ) : (
            <>
              <ol className="flex flex-col gap-2" aria-label="Task history, newest first">
                {events.map((e) => (
                  <li key={e.id} className="flex items-start gap-2 text-sm">
                    <Circle className="mt-1.5 size-2 shrink-0 fill-current text-fg-subtle" aria-hidden />
                    <span className="min-w-0 flex-1 break-words text-fg">{eventText(e, timeZone)}</span>
                    <time dateTime={e.occurredAt} className="tnum shrink-0 text-xs text-fg-subtle">{formatDateTime(e.occurredAt, timeZone)}</time>
                  </li>
                ))}
              </ol>
              {cursor && <Button variant="ghost" size="sm" className="mt-2" onClick={() => void loadEvents(cursor)}>Show older history</Button>}
            </>
          )}
        </section>

        {canEdit && (
          <div className="mt-6 flex justify-end">
            {confirmDelete ? (
              <span className="flex items-center gap-2"><span className="text-sm text-fg-muted">Delete this task?</span><Button variant="danger" loading={busy} onClick={() => void remove()}>Delete</Button><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep</Button></span>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDelete(true)}><Trash2 />Delete</Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
