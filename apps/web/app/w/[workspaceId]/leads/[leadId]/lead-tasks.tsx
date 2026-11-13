"use client";
import * as React from "react";
import { Plus } from "lucide-react";
import { endpoints, type LeadDto, type Member, type Task } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Alert } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { TaskDialog } from "@/components/tasks/task-dialog";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { STATUS_LABEL } from "@/lib/tasks";

/** Tasks linked to a lead. Next activity (the lead's earliest open due date) is computed by the DB; `onChanged` reloads the lead to show it. */
export function LeadTasks({ workspaceId, lead, members, myUserId, timeZone, canEdit, onChanged }: { workspaceId: string; lead: LeadDto; members: Member[]; myUserId: string; timeZone: string; canEdit: boolean; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [tasks, setTasks] = React.useState<Task[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const params = { workspaceId, leadId: lead.id };

  const load = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.listLeadTasks, { params: { workspaceId, leadId: lead.id } });
    if (r.ok) { setTasks(r.data); setError(null); } else setError(errorMessage(r.error));
  }, [workspaceId, lead.id]);
  React.useEffect(() => {
    let live = true;
    void browserApi.call(endpoints.listLeadTasks, { params: { workspaceId, leadId: lead.id } }).then((r) => {
      if (!live) return;
      if (r.ok) { setTasks(r.data); setError(null); } else setError(errorMessage(r.error));
    });
    return () => { live = false; };
  }, [workspaceId, lead.id]);

  async function act(t: Task, kind: "done" | "unlink") {
    setBusy(t.id);
    const r = kind === "done"
      ? await browserApi.call(endpoints.updateTask, { params: { workspaceId, taskId: t.id }, body: { status: "done", expectedVersion: t.version } })
      : await browserApi.call(endpoints.unlinkLeadTask, { params: { ...params, taskId: t.id } });
    setBusy(null);
    if (!r.ok) { toast(errorMessage(r.error), "error"); return; }
    toast(kind === "done" ? "Task completed." : "Task unlinked.");
    await Promise.all([load(), onChanged()]);
  }

  return (
    <Panel>
      <PanelHeader title="Tasks" description="Follow-ups linked to this record." actions={canEdit ? <Button size="sm" onClick={() => setOpen(true)}><Plus className="size-4" aria-hidden />Add task</Button> : undefined} />
      {error ? <div className="p-4"><Alert tone="error">{error}</Alert></div>
        : tasks === null ? <p className="p-4 text-sm text-fg-muted">Loading tasks…</p>
        : tasks.length === 0 ? <p className="p-4 text-sm text-fg-muted">No tasks yet.</p>
        : (
          <ul className="divide-y divide-line" aria-label="Linked tasks">
            {tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 p-4">
                <div className="min-w-0">
                  <p className={t.status === "done" || t.status === "cancelled" ? "text-fg-muted line-through" : "font-medium"}>{t.title}</p>
                  <p className="text-xs text-fg-subtle"><Badge>{STATUS_LABEL[t.status]}</Badge> <span className="ml-1">{t.dueAt ? <>Due <time dateTime={t.dueAt}>{formatDateTime(t.dueAt, timeZone)}</time></> : "No due date"}</span></p>
                </div>
                {canEdit && (
                  <div className="flex gap-2">
                    {(t.status === "open" || t.status === "in_progress") && <Button size="sm" disabled={busy === t.id} onClick={() => void act(t, "done")}>Mark done</Button>}
                    <Button size="sm" variant="ghost" disabled={busy === t.id} onClick={() => void act(t, "unlink")}>Unlink</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      {open && <TaskDialog open onOpenChange={setOpen} workspaceId={workspaceId} members={members} myUserId={myUserId} leadId={lead.id} defaultContact={lead.primaryContact.deleted ? null : { id: lead.primaryContact.id, name: lead.primaryContact.name }} onSaved={() => { toast("Task added."); void Promise.all([load(), onChanged()]); }} />}
    </Panel>
  );
}
