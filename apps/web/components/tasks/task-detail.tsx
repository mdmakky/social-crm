"use client";
import * as React from "react";
import Link from "next/link";
import { CheckCircle2, Circle, History, Pencil, RotateCcw, Trash2, User } from "lucide-react";
import { endpoints, type Task, type TaskEvent } from "@crm/contracts";
import { dueState } from "@crm/core/tasks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { Alert } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { eventText, PRIORITY_LABEL, PRIORITY_TONE, STATUS_LABEL } from "@/lib/tasks";

type Props = {
  workspaceId: string;
  timeZone: string;
  /** The task to show; null closes the dialog. */
  task: Task | null;
  canEdit: boolean;
  onClose: () => void;
  onEdit: (t: Task) => void;
  /** Called after a status change or delete so the list can refresh. */
  onChanged: (t: Task | null) => void;
};

export function TaskDetail({ task, onClose, ...rest }: Props) {
  return (
    <Dialog open={task !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      {task && (
        <DialogContent title={task.title} description="Task details and history" className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
          <Body key={task.id} task={task} onClose={onClose} {...rest} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function Body({ task: initial, workspaceId, timeZone, canEdit, onClose, onEdit, onChanged }: Omit<Props, "task"> & { task: Task }) {
  const [changed, setChanged] = React.useState<Task | null>(null);
  // The parent hands us a fresh task after an edit; a newer local copy (from Mark done) wins until then.
  const task = changed && changed.version > initial.version ? changed : initial;
  const [events, setEvents] = React.useState<TaskEvent[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [histState, setHistState] = React.useState<"loading" | "idle" | "error">("loading");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [now] = React.useState(() => new Date());
  const params = { workspaceId, taskId: task.id };

  const loadEvents = React.useCallback(async (after?: string) => {
    const r = await browserApi.call(endpoints.listTaskEvents, { params: { workspaceId, taskId: initial.id }, query: { limit: 20, cursor: after } });
    if (!r.ok) return setHistState("error");
    setEvents((e) => (after ? [...(e ?? []), ...r.data.items] : r.data.items));
    setCursor(r.data.nextCursor);
    setHistState("idle");
  }, [workspaceId, initial.id]);
  React.useEffect(() => {
    const t = setTimeout(() => void loadEvents(), 0);
    return () => clearTimeout(t);
  }, [loadEvents, initial.version]);

  async function setStatus(status: "done" | "open") {
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.updateTask, { params, body: { status, expectedVersion: task.version } });
    setBusy(false);
    if (!r.ok) return setError(r.error.code === "version_conflict" ? "Someone else changed this task. Close and reopen it to see the latest version." : errorMessage(r.error));
    setChanged(r.data); onChanged(r.data); void loadEvents();
  }
  async function remove() {
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.deleteTask, { params });
    setBusy(false);
    if (!r.ok) return setError(errorMessage(r.error));
    onChanged(null); onClose();
  }

  const state = dueState(task, now, timeZone);
  const closed = task.status === "done" || task.status === "cancelled";
  return (
    <div className="flex flex-col gap-4">
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={task.status === "done" ? "success" : task.status === "cancelled" ? "neutral" : task.status === "in_progress" ? "accent" : "neutral"}>{STATUS_LABEL[task.status]}</Badge>
        <Badge tone={PRIORITY_TONE[task.priority]}>{PRIORITY_LABEL[task.priority]} priority</Badge>
        {state === "overdue" && <Badge tone="danger">Overdue</Badge>}
        {state === "today" && <Badge tone="warning">Due today</Badge>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-fg-muted">Due</dt>
        <dd className="text-fg">{task.dueAt ? formatDateTime(task.dueAt, timeZone) : "No due date"}</dd>
        <dt className="text-fg-muted">Assignee</dt>
        <dd className="text-fg">{task.assignee?.name ?? "Unassigned"}</dd>
        <dt className="text-fg-muted">Contact</dt>
        <dd className="text-fg">{task.contact ? <Link className="inline-flex items-center gap-1 underline underline-offset-2" href={`/w/${workspaceId}/contacts/${task.contact.id}`}><User className="size-3.5" aria-hidden />{task.contact.name}</Link> : "Not linked"}</dd>
        <dt className="text-fg-muted">Created</dt>
        <dd className="text-fg">{formatDateTime(task.createdAt, timeZone)}{task.createdBy?.name ? ` by ${task.createdBy.name}` : ""}</dd>
        {task.completedAt && <><dt className="text-fg-muted">Completed</dt><dd className="text-fg">{formatDateTime(task.completedAt, timeZone)}</dd></>}
      </dl>
      {task.description && <p className="whitespace-pre-wrap break-words rounded-control bg-canvas p-3 text-base text-fg">{task.description}</p>}

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          {closed ? (
            <Button variant="secondary" loading={busy} onClick={() => void setStatus("open")}><RotateCcw />Reopen</Button>
          ) : (
            <Button variant="primary" loading={busy} onClick={() => void setStatus("done")}><CheckCircle2 />Mark done</Button>
          )}
          <Button variant="secondary" onClick={() => onEdit(task)}><Pencil />Edit</Button>
          {confirmDelete ? (
            <span className="ml-auto flex items-center gap-2"><span className="text-sm text-fg-muted">Delete this task?</span><Button variant="danger" loading={busy} onClick={() => void remove()}>Delete</Button><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep</Button></span>
          ) : (
            <Button variant="ghost" className="ml-auto" onClick={() => setConfirmDelete(true)}><Trash2 />Delete</Button>
          )}
        </div>
      ) : (
        <p className="text-sm text-fg-muted">You can view this task but not change it. Only its assignee, its creator and workspace admins can.</p>
      )}

      <section aria-labelledby="task-history" className="border-t border-line pt-3">
        <h3 id="task-history" className="mb-2 flex items-center gap-1.5 text-sm font-medium text-fg"><History className="size-4 text-fg-subtle" aria-hidden />History</h3>
        {histState === "error" && events === null ? (
          <Alert tone="error">History could not be loaded. <Button variant="ghost" size="sm" onClick={() => { setHistState("loading"); void loadEvents(); }}>Try again</Button></Alert>
        ) : events === null ? (
          <p className="text-sm text-fg-muted" role="status">Loading history…</p>
        ) : (
          <>
            <ol className="flex flex-col gap-2" aria-label="Task history, newest first">
              {events.map((e) => (
                <li key={e.id} className="flex items-start gap-2 text-sm">
                  <Circle className="mt-1 size-2 shrink-0 fill-current text-fg-subtle" aria-hidden />
                  <span className="min-w-0 flex-1 break-words text-fg">{eventText(e, timeZone)}</span>
                  <time dateTime={e.occurredAt} className="tnum shrink-0 text-xs text-fg-subtle">{formatDateTime(e.occurredAt, timeZone)}</time>
                </li>
              ))}
            </ol>
            {cursor && <Button variant="ghost" size="sm" className="mt-2" loading={histState === "loading"} onClick={() => { setHistState("loading"); void loadEvents(cursor); }}>Show older history</Button>}
          </>
        )}
      </section>
    </div>
  );
}
