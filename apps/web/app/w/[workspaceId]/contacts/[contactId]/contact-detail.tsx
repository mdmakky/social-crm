"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, ChevronDown, Clock, MessageSquare, MoreHorizontal, Pencil, Plus, Trash2, Workflow, X } from "lucide-react";
import { endpoints, type ActivityItem, type ContactDetail, type CustomField, type DuplicateCandidate, type LifecycleStage, type Member, type Note, type Role, type Tag, type Task } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { CustomFieldInput } from "@/components/contacts/custom-field-input";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/overlays";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Alert, EmptyState } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";
import { activityText, relativeTime, sourceLabel, SOURCE_LABEL, TAG_TONE } from "@/lib/contacts";
import { formatDateTime } from "@/lib/format";

type Props = {
  workspaceId: string; role: Role; timeZone: string; myUserId: string;
  contact: ContactDetail; notes: Note[]; activity: { items: ActivityItem[]; nextCursor: string | null }; tasks: Task[];
  allTags: Tag[]; stages: LifecycleStage[]; members: Member[]; fields: CustomField[];
  perms: { edit: boolean; delete: boolean };
};

export function ContactDetailView(props: Props) {
  const { workspaceId, role, timeZone, myUserId, stages, members, fields, perms } = props;
  const router = useRouter();
  const [c, setC] = React.useState(props.contact);
  const [notes, setNotes] = React.useState(props.notes);
  const [activity, setActivity] = React.useState(props.activity);
  const [tasks, setTasks] = React.useState(props.tasks);
  const [allTags, setAllTags] = React.useState(props.allTags);
  const [savedVersion, setSavedVersion] = React.useState<number | null>(null); // the form remounts on each version, so the confirmation lives here
  const p = { workspaceId, contactId: c.id };

  const refreshActivity = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.listActivity, { params: { workspaceId, contactId: props.contact.id }, query: { limit: 20 } });
    if (r.ok) setActivity(r.data);
  }, [workspaceId, props.contact.id]);

  return (
    <>
      <Link href={`/w/${workspaceId}/contacts`} className="mb-3 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-4" aria-hidden />Contacts</Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={c.name} size="lg" />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-title text-fg">{c.name}</h1>
            <p className="truncate text-sm text-fg-muted">{[c.email, c.phone, c.company].filter(Boolean).join(" · ") || "No contact details yet"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge>{c.lifecycleStage.name}</Badge>
          {perms.delete && <DeleteMenu workspaceId={workspaceId} contact={c} onDeleted={() => router.push(`/w/${workspaceId}/contacts`)} />}
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <div className="grid gap-4 lg:col-span-2">
          <DetailsPanel key={c.version} c={c} saved={savedVersion === c.version} onSaved={(d, viaSave) => { setC(d); if (viaSave) setSavedVersion(d.version); void refreshActivity(); }} stages={stages} members={members} fields={fields} canEdit={perms.edit} workspaceId={workspaceId} myUserId={myUserId} />
          <TagsPanel c={c} allTags={allTags} canEdit={perms.edit} workspaceId={workspaceId} onChanged={(d, t) => { setC(d); if (t) setAllTags(t); void refreshActivity(); }} />
          <NotesPanel notes={notes} setNotes={setNotes} p={p} role={role} myUserId={myUserId} canEdit={perms.edit} timeZone={timeZone} onChanged={refreshActivity} />
          <ActivityPanel activity={activity} setActivity={setActivity} p={p} timeZone={timeZone} />
        </div>
        <div className="grid gap-4">
          <TasksPanel tasks={tasks} setTasks={setTasks} p={p} canEdit={perms.edit} role={role} myUserId={myUserId} members={members} timeZone={timeZone} onChanged={async () => { void refreshActivity(); const d = await browserApi.call(endpoints.getContact, { params: p }); if (d.ok) setC(d.data); }} />
          <Panel>
            <PanelHeader title="Conversations" />
            <EmptyState icon={MessageSquare} title="No conversations yet" description="Messages from connected channels will appear here once a channel is connected." className="py-8" />
          </Panel>
          <Panel>
            <PanelHeader title="Pipeline records" />
            <EmptyState icon={Workflow} title="No pipeline records yet" description="Leads and opportunities for this contact will appear here. The lifecycle stage above is separate from any pipeline." className="py-8" />
          </Panel>
        </div>
      </div>
    </>
  );
}

function DeleteMenu({ workspaceId, contact, onDeleted }: { workspaceId: string; contact: ContactDetail; onDeleted: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="secondary" icon aria-label="More actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end"><DropdownMenuItem danger onSelect={() => { setError(null); setOpen(true); }}><Trash2 aria-hidden />Delete contact</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`Delete ${contact.name}?`} description="The contact disappears from lists and search. The deletion is recorded in the audit log.">
          {error && <Alert tone="error" className="mb-3">{error}</Alert>}
          <div className="flex justify-end gap-2">
            <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
            <Button variant="danger" loading={busy} onClick={async () => { setBusy(true); const r = await browserApi.call(endpoints.deleteContact, { params: { workspaceId, contactId: contact.id } }); setBusy(false); if (r.ok) onDeleted(); else setError(errorMessage(r.error)); }}>Delete contact</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DetailsPanel({ c, saved, onSaved, stages, members, fields, canEdit, workspaceId, myUserId }: { c: ContactDetail; saved: boolean; onSaved: (d: ContactDetail, viaSave?: boolean) => void; stages: LifecycleStage[]; members: Member[]; fields: CustomField[]; canEdit: boolean; workspaceId: string; myUserId: string }) {
  const initial = React.useMemo(() => ({ name: c.name, email: c.email ?? "", phone: c.phone ?? "", company: c.company ?? "", stage: c.lifecycleStage.id, owner: c.owner?.id ?? "", source: c.source, custom: c.custom }), [c]);
  const [form, setForm] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [conflict, setConflict] = React.useState<ContactDetail | null>(null);
  const [dupes, setDupes] = React.useState<DuplicateCandidate[] | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const stageOptions = stages.filter((s) => !s.archived || s.id === c.lifecycleStage.id);

  async function save(allowDuplicate = false) {
    if (!form.name.trim()) return setFieldErrors({ name: "Enter a name." });
    setBusy(true); setError(null); setFieldErrors({}); setConflict(null); setDupes(null);
    const customDiff: Record<string, unknown> = {};
    for (const f of fields) if (JSON.stringify(form.custom[f.key] ?? null) !== JSON.stringify(c.custom[f.key] ?? null)) customDiff[f.key] = form.custom[f.key] ?? null;
    const r = await browserApi.call(endpoints.updateContact, {
      params: { workspaceId, contactId: c.id },
      body: { expectedVersion: c.version, name: form.name.trim(), email: form.email.trim() || null, phone: form.phone.trim() || null, company: form.company.trim() || null, lifecycleStageId: form.stage, ownerUserId: form.owner || null, source: form.source as never, custom: Object.keys(customDiff).length ? customDiff : undefined, allowDuplicate },
    });
    setBusy(false);
    if (r.ok) { onSaved(r.data, true); return; }
    const e = r.error;
    if (e.code === "version_conflict") {
      const current = (e.details as { current?: ContactDetail } | undefined)?.current;
      if (current) setConflict(current);
      else setError(errorMessage(e));
      return;
    }
    if (e.code === "duplicate_contact") return setDupes((e.details as { candidates: DuplicateCandidate[] }).candidates);
    if (e.code === "invalid_custom_fields") return setFieldErrors(e.details as Record<string, string>);
    setError(errorMessage(e));
  }

  return (
    <Panel>
      <PanelHeader title="Details" description={canEdit ? undefined : "You have read-only access."} />
      <form noValidate onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex flex-col gap-3 p-4">
        {error && <Alert tone="error">{error}</Alert>}
        {saved && !dirty && <Alert tone="success">Saved.</Alert>}
        {conflict && (
          <Alert tone="warning">
            <p className="font-medium">Someone else changed this contact.</p>
            <p>Your edits weren&rsquo;t saved. Load the latest version, then re-apply what you need.</p>
            <Button className="mt-2" size="sm" onClick={() => { onSaved(conflict); setConflict(null); }}>Load latest</Button>
          </Alert>
        )}
        {dupes && (
          <Alert tone="warning">
            <p className="font-medium">Another contact has that email or phone.</p>
            <ul>{dupes.map((d) => <li key={d.id}><Link className="underline underline-offset-2" href={`/w/${workspaceId}/contacts/${d.id}`}>{d.name}</Link></li>)}</ul>
            <Button className="mt-2" size="sm" onClick={() => void save(true)}>Save anyway</Button>
          </Alert>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" error={fieldErrors.name}>{(x) => <Input {...x} value={form.name} onChange={(e) => set({ name: e.target.value })} disabled={!canEdit} maxLength={120} />}</Field>
          <Field label="Company">{(x) => <Input {...x} value={form.company} onChange={(e) => set({ company: e.target.value })} disabled={!canEdit} maxLength={120} />}</Field>
          <Field label="Email">{(x) => <Input {...x} type="email" inputMode="email" value={form.email} onChange={(e) => set({ email: e.target.value })} disabled={!canEdit} />}</Field>
          <Field label="Phone">{(x) => <Input {...x} type="tel" inputMode="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} disabled={!canEdit} />}</Field>
          <Field label="Lifecycle stage">{(x) => <Select {...x} value={form.stage} onChange={(e) => set({ stage: e.target.value })} disabled={!canEdit}>{stageOptions.map((s) => <option key={s.id} value={s.id}>{s.name}{s.archived ? " (archived)" : ""}</option>)}</Select>}</Field>
          <Field label="Owner">{(x) => <Select {...x} value={form.owner} onChange={(e) => set({ owner: e.target.value })} disabled={!canEdit}><option value="">Unassigned</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}{m.userId === myUserId ? " (you)" : ""}</option>)}</Select>}</Field>
          <Field label="Source">{(x) => <Select {...x} value={form.source} onChange={(e) => set({ source: e.target.value })} disabled={!canEdit}>{Object.keys(SOURCE_LABEL).map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}</Select>}</Field>
        </div>
        {fields.length > 0 && (
          <div className="mt-1 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
            {fields.map((f) => (
              <div key={f.id} className={canEdit ? "" : "pointer-events-none opacity-80"}>
                <CustomFieldInput def={f} value={form.custom[f.key]} onChange={(v) => set({ custom: { ...form.custom, [f.key]: v } })} error={fieldErrors[f.key]} />
              </div>
            ))}
          </div>
        )}
        {canEdit && (
          <div className="flex items-center gap-2 pt-1">
            <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>Save changes</Button>
            {dirty && <Button variant="ghost" onClick={() => { setForm(initial); setFieldErrors({}); setError(null); }}>Discard</Button>}
          </div>
        )}
      </form>
    </Panel>
  );
}

function TagsPanel({ c, allTags, canEdit, workspaceId, onChanged }: { c: ContactDetail; allTags: Tag[]; canEdit: boolean; workspaceId: string; onChanged: (d: ContactDetail, tags?: Tag[]) => void }) {
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const listId = React.useId();
  async function add(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.addContactTag, { params: { workspaceId, contactId: c.id }, body: { name: n } });
    setBusy(false);
    if (!r.ok) return setError(errorMessage(r.error));
    setName("");
    const t = await browserApi.call(endpoints.listTags, { params: { workspaceId } });
    onChanged(r.data, t.ok ? t.data : undefined);
  }
  async function remove(tagId: string) {
    const r = await browserApi.call(endpoints.removeContactTag, { params: { workspaceId, contactId: c.id, tagId } });
    if (!r.ok) return setError(errorMessage(r.error));
    onChanged(r.data);
  }
  return (
    <Panel>
      <PanelHeader title="Tags" />
      <div className="flex flex-col gap-3 p-4">
        {error && <Alert tone="error">{error}</Alert>}
        {c.tags.length === 0 ? <p className="text-sm text-fg-muted">No tags yet.</p> : (
          <ul className="flex flex-wrap gap-1.5" aria-label="Tags on this contact">
            {c.tags.map((t) => (
              <li key={t.id}>
                <Badge tone={TAG_TONE[t.color]} className="gap-1 pr-1">
                  {t.name}
                  {canEdit && <button type="button" aria-label={`Remove tag ${t.name}`} onClick={() => void remove(t.id)} className="rounded-full p-0.5 hover:bg-line"><X className="size-3" /></button>}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <form onSubmit={add} className="flex gap-2">
            <Input aria-label="Add a tag" list={listId} placeholder="Add a tag" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className="max-w-56" />
            <datalist id={listId}>{allTags.filter((t) => !c.tags.some((x) => x.id === t.id)).map((t) => <option key={t.id} value={t.name} />)}</datalist>
            <Button type="submit" loading={busy}><Plus />Add</Button>
          </form>
        )}
      </div>
    </Panel>
  );
}

function NotesPanel({ notes, setNotes, p, role, myUserId, canEdit, timeZone, onChanged }: { notes: Note[]; setNotes: (n: Note[]) => void; p: { workspaceId: string; contactId: string }; role: Role; myUserId: string; canEdit: boolean; timeZone: string; onChanged: () => void }) {
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<{ id: string; body: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return setError("Write something first.");
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.createNote, { params: p, body: { body: text } });
    setBusy(false);
    if (!r.ok) return setError(errorMessage(r.error));
    setNotes([r.data, ...notes]); setText(""); onChanged();
  }
  async function saveEdit() {
    if (!editing) return;
    const r = await browserApi.call(endpoints.updateNote, { params: { ...p, noteId: editing.id }, body: { body: editing.body } });
    if (!r.ok) return setError(errorMessage(r.error));
    setNotes(notes.map((n) => (n.id === r.data.id ? r.data : n))); setEditing(null);
  }
  async function remove(id: string) {
    const r = await browserApi.call(endpoints.deleteNote, { params: { ...p, noteId: id } });
    if (!r.ok) return setError(errorMessage(r.error));
    setNotes(notes.filter((n) => n.id !== id)); setConfirmDelete(null); onChanged();
  }
  return (
    <Panel>
      <PanelHeader title="Notes" description="Visible to everyone in the workspace." />
      <div className="flex flex-col gap-4 p-4">
        {error && <Alert tone="error">{error}</Alert>}
        {canEdit && (
          <form onSubmit={add} className="flex flex-col gap-2">
            <Textarea aria-label="Add a note" placeholder="Write a note about this contact" value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} />
            <div><Button type="submit" variant="primary" loading={busy}>Add note</Button></div>
          </form>
        )}
        {notes.length === 0 ? <p className="text-sm text-fg-muted">No notes yet.{canEdit ? " Add one to keep context for your team." : ""}</p> : (
          <ul className="flex flex-col gap-3">
            {notes.map((n) => {
              const mine = can(role, "note.edit", { isOwn: n.author.id === myUserId });
              return (
                <li key={n.id} className="rounded-lg bg-subtle p-3">
                  <div className="mb-1 flex items-center gap-2 text-sm">
                    <Avatar name={n.author.name} size="xs" />
                    <span className="font-medium text-fg">{n.author.name}</span>
                    <time dateTime={n.createdAt} className="tnum text-fg-subtle">{formatDateTime(n.createdAt, timeZone)}</time>
                    {mine && editing?.id !== n.id && (
                      <span className="ml-auto flex gap-1">
                        <Button variant="ghost" icon size="sm" aria-label="Edit note" onClick={() => setEditing({ id: n.id, body: n.body })}><Pencil /></Button>
                        {confirmDelete === n.id ? <Button variant="danger" size="sm" onClick={() => void remove(n.id)}>Confirm delete</Button> : <Button variant="ghost" icon size="sm" aria-label="Delete note" onClick={() => setConfirmDelete(n.id)}><Trash2 /></Button>}
                      </span>
                    )}
                  </div>
                  {editing?.id === n.id ? (
                    <div className="flex flex-col gap-2">
                      <Textarea aria-label="Edit note" value={editing.body} onChange={(e) => setEditing({ id: n.id, body: e.target.value })} maxLength={5000} />
                      <div className="flex gap-2"><Button variant="primary" size="sm" onClick={() => void saveEdit()}>Save</Button><Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button></div>
                    </div>
                  ) : <p className="whitespace-pre-wrap break-words text-base text-fg">{n.body}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function ActivityPanel({ activity, setActivity, p, timeZone }: { activity: { items: ActivityItem[]; nextCursor: string | null }; setActivity: (a: { items: ActivityItem[]; nextCursor: string | null }) => void; p: { workspaceId: string; contactId: string }; timeZone: string }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  async function more() {
    if (!activity.nextCursor) return;
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.listActivity, { params: p, query: { limit: 20, cursor: activity.nextCursor } });
    setBusy(false);
    if (!r.ok) return setError(errorMessage(r.error));
    setActivity({ items: [...activity.items, ...r.data.items], nextCursor: r.data.nextCursor });
  }
  return (
    <Panel>
      <PanelHeader title="Activity" description="Newest first." />
      {activity.items.length === 0 ? <EmptyState icon={Clock} title="No activity yet" description="Changes, notes and tasks for this contact appear here." className="py-8" /> : (
        <ol>
          {activity.items.map((a) => (
            <li key={a.id} className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0">
              <Avatar name={a.actorName ?? "System"} size="xs" className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-base text-fg">{activityText(a.kind, a.data, a.actorName)}</p>
                {a.kind === "note.added" && typeof a.data.preview === "string" && <p className="mt-0.5 line-clamp-2 text-sm text-fg-muted">{a.data.preview}</p>}
              </div>
              <time dateTime={a.occurredAt} suppressHydrationWarning title={formatDateTime(a.occurredAt, timeZone)} className="tnum shrink-0 text-sm text-fg-subtle">{relativeTime(a.occurredAt, timeZone)}</time>
            </li>
          ))}
        </ol>
      )}
      {(activity.nextCursor || error) && (
        <div className="flex flex-col items-center gap-2 border-t border-line p-3">
          {error && <Alert tone="error">{error}</Alert>}
          {activity.nextCursor && <Button onClick={more} loading={busy}><ChevronDown />Load older activity</Button>}
        </div>
      )}
    </Panel>
  );
}

function TasksPanel({ tasks, setTasks, p, canEdit, role, myUserId, members, timeZone, onChanged }: { tasks: Task[]; setTasks: (t: Task[]) => void; p: { workspaceId: string; contactId: string }; canEdit: boolean; role: Role; myUserId: string; members: Member[]; timeZone: string; onChanged: () => void }) {
  const [title, setTitle] = React.useState("");
  const [due, setDue] = React.useState("");
  const [assignee, setAssignee] = React.useState(myUserId);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return setError("Describe the follow-up.");
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.createTask, { params: p, body: { title: title.trim(), dueAt: due ? new Date(due).toISOString() : null, assigneeUserId: assignee || null } });
    setBusy(false);
    if (!r.ok) return setError(errorMessage(r.error));
    setTasks([...tasks, r.data].sort((a, b) => (a.status === b.status ? (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9") : a.status === "open" ? -1 : 1)));
    setTitle(""); setDue(""); onChanged();
  }
  async function toggle(t: Task) {
    const r = await browserApi.call(endpoints.updateTask, { params: { workspaceId: p.workspaceId, taskId: t.id }, body: { status: t.status === "open" ? "done" : "open" } });
    if (!r.ok) return setError(errorMessage(r.error));
    setTasks(tasks.map((x) => (x.id === t.id ? r.data : x))); onChanged();
  }
  async function remove(t: Task) {
    const r = await browserApi.call(endpoints.deleteTask, { params: { workspaceId: p.workspaceId, taskId: t.id } });
    if (!r.ok) return setError(errorMessage(r.error));
    setTasks(tasks.filter((x) => x.id !== t.id)); onChanged();
  }
  const [now] = React.useState(() => Date.now());
  const open = tasks.filter((t) => t.status === "open");
  const overdue = (t: Task) => t.status === "open" && t.dueAt !== null && new Date(t.dueAt).getTime() < now;
  return (
    <Panel>
      <PanelHeader title="Tasks and follow-ups" description={open.length ? `${open.length} open` : undefined} />
      <div className="flex flex-col gap-3 p-4">
        {error && <Alert tone="error">{error}</Alert>}
        {tasks.length === 0 ? <p className="text-sm text-fg-muted">No tasks yet.{canEdit ? " Add a follow-up so this contact isn’t forgotten." : ""}</p> : (
          <ul className="flex flex-col gap-2">
            {tasks.map((t) => {
              const mine = can(role, "task.edit", { isOwn: t.assignee?.id === myUserId });
              return (
                <li key={t.id} className="flex items-start gap-2">
                  <button type="button" role="checkbox" aria-checked={t.status === "done"} aria-label={`${t.status === "done" ? "Reopen" : "Complete"}: ${t.title}`} disabled={!mine} onClick={() => void toggle(t)} className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border pointer-coarse:size-7 ${t.status === "done" ? "border-accent bg-accent text-on-accent" : "border-line-strong bg-surface"} disabled:opacity-50`}>
                    {t.status === "done" && <Check className="size-3.5" aria-hidden />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className={`break-words text-base ${t.status === "done" ? "text-fg-subtle line-through" : "text-fg"}`}>{t.title}</p>
                    <p className="text-xs text-fg-subtle">
                      {t.dueAt ? <><span className={overdue(t) ? "font-medium text-danger-fg" : ""}>{overdue(t) ? "Overdue · " : "Due "}{formatDateTime(t.dueAt, timeZone)}</span> · </> : null}
                      {t.assignee?.name ?? "Unassigned"}
                    </p>
                  </div>
                  {mine && <Button variant="ghost" icon size="sm" aria-label={`Delete task: ${t.title}`} onClick={() => void remove(t)}><Trash2 /></Button>}
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && (
          <form onSubmit={add} className="flex flex-col gap-2 border-t border-line pt-3">
            <Input aria-label="New task" placeholder="Follow-up, for example Send the quote" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            <div className="flex flex-wrap gap-2">
              <Input aria-label="Due date and time" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className="w-auto flex-1" />
              <Select aria-label="Assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} className="w-auto flex-1"><option value="">Unassigned</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}{m.userId === myUserId ? " (you)" : ""}</option>)}</Select>
            </div>
            <div><Button type="submit" loading={busy}><Plus />Add task</Button></div>
          </form>
        )}
      </div>
    </Panel>
  );
}
