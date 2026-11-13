"use client";
import * as React from "react";
import { endpoints, TASK_PRIORITIES, TASK_STATUSES, type Member, type Task, type TaskPriority, type TaskStatus } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/overlays";
import { Alert } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";
import { fromLocalInput, PRIORITY_LABEL, STATUS_LABEL, toLocalInput } from "@/lib/tasks";
import { ContactPicker, type PickedContact } from "./contact-picker";

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  members: Member[];
  myUserId: string;
  /** Edit this task; omit to create. */
  task?: Task | null;
  /** Pre-select a contact when creating. */
  defaultContact?: PickedContact | null;
  onSaved: (t: Task) => void;
};

export function TaskDialog({ open, onOpenChange, ...rest }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={rest.task ? "Edit task" : "New task"} description={rest.task ? "Change the details. Every change is added to the task's history." : "Something to do, for you or a teammate. Link a contact if it relates to one."} className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <TaskForm {...rest} close={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

type Form = { title: string; description: string; assignee: string; due: string; priority: TaskPriority; status: TaskStatus; contact: PickedContact | null };
const initial = (t: Task | null | undefined, myUserId: string, dc: PickedContact | null | undefined): Form => ({
  title: t?.title ?? "",
  description: t?.description ?? "",
  assignee: t ? t.assignee?.id ?? "" : myUserId,
  due: toLocalInput(t?.dueAt ?? null),
  priority: t?.priority ?? "normal",
  status: t?.status ?? "open",
  contact: t ? (t.contact ? { id: t.contact.id, name: t.contact.name } : null) : dc ?? null,
});

function TaskForm({ workspaceId, members, myUserId, task, defaultContact, onSaved, close }: Omit<Props, "open" | "onOpenChange"> & { close: () => void }) {
  const [f, setF] = React.useState<Form>(() => initial(task, myUserId, defaultContact));
  const [version, setVersion] = React.useState(task?.version ?? 1);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [titleError, setTitleError] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState<Task | null>(null);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const active = members.filter((m) => m.status === "active");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!f.title.trim()) return setTitleError("Give the task a title.");
    setTitleError(null); setError(null); setConflict(null); setBusy(true);
    const common = { title: f.title.trim(), description: f.description.trim() || null, dueAt: fromLocalInput(f.due), priority: f.priority, assigneeUserId: f.assignee || null, contactId: f.contact?.id ?? null };
    const res = task
      ? await browserApi.call(endpoints.updateTask, { params: { workspaceId, taskId: task.id }, body: { ...common, status: f.status, expectedVersion: version } })
      : await browserApi.call(endpoints.createWorkspaceTask, { params: { workspaceId }, body: common });
    setBusy(false);
    if (res.ok) { onSaved(res.data); close(); return; }
    if (res.error.code === "version_conflict") { setConflict((res.error.details as { current: Task }).current); return; }
    setError(errorMessage(res.error));
  }
  const loadLatest = () => {
    if (!conflict) return;
    setF(initial(conflict, myUserId, null)); setVersion(conflict.version); setConflict(null);
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-3">
      {error && <Alert tone="error">{error}</Alert>}
      {conflict && (
        <Alert tone="warning">
          <p className="font-medium">Someone else changed this task while you were editing.</p>
          <p className="mt-0.5">Load their version to see what changed, then make your edit again.</p>
          <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={loadLatest}>Load the latest version</Button>
        </Alert>
      )}
      <Field label="Title" error={titleError}>{(p) => <Input {...p} name="title" autoFocus autoComplete="off" maxLength={200} value={f.title} onChange={(e) => set({ title: e.target.value })} />}</Field>
      <Field label="Description" hint="Optional. Context for whoever picks this up.">{(p) => <Textarea {...p} name="description" rows={3} maxLength={4000} value={f.description} onChange={(e) => set({ description: e.target.value })} />}</Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Assignee">{(p) => <Select {...p} name="assignee" value={f.assignee} onChange={(e) => set({ assignee: e.target.value })}><option value="">Unassigned</option>{active.map((m) => <option key={m.userId} value={m.userId}>{m.name}{m.userId === myUserId ? " (you)" : ""}</option>)}</Select>}</Field>
        <Field label="Priority">{(p) => <Select {...p} name="priority" value={f.priority} onChange={(e) => set({ priority: e.target.value as TaskPriority })}>{TASK_PRIORITIES.map((x) => <option key={x} value={x}>{PRIORITY_LABEL[x]}</option>)}</Select>}</Field>
        <Field label="Due">{(p) => <Input {...p} name="due" type="datetime-local" value={f.due} onChange={(e) => set({ due: e.target.value })} />}</Field>
        {task && <Field label="Status">{(p) => <Select {...p} name="status" value={f.status} onChange={(e) => set({ status: e.target.value as TaskStatus })}>{TASK_STATUSES.map((x) => <option key={x} value={x}>{STATUS_LABEL[x]}</option>)}</Select>}</Field>}
      </div>
      <Field label="Related contact" hint="Optional. The task also shows on that contact's page.">{(p) => <ContactPicker id={p.id} describedBy={p["aria-describedby"]} workspaceId={workspaceId} value={f.contact} onChange={(c) => set({ contact: c })} />}</Field>
      <div className="mt-2 flex justify-end gap-2">
        <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
        <Button type="submit" variant="primary" loading={busy}>{task ? "Save changes" : "Create task"}</Button>
      </div>
    </form>
  );
}
