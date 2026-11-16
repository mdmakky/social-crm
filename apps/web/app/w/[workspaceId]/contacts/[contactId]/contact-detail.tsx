"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, ChevronDown, Clock, MessageSquare, MoreHorizontal, Pencil, Plus, Trash2, Workflow, X } from "lucide-react";
import { endpoints, type ActivityItem, type ContactDetail, type ContactMethodDto, type CustomField, type DuplicateCandidate, type LifecycleStage, type Member, type Note, type Role, type LeadDto, type PipelineDto, type Tag, type Task } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { AdConsentPanel } from "./ad-consent-panel";
import { CustomFieldInput } from "@/components/contacts/custom-field-input";
import { DetectedMethodsPanel } from "@/components/contacts/detected-methods";
import { Avatar } from "@/components/ui/avatar";
import { Badge, hueOf, Status } from "@/components/ui/badge";
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
import { formatMoney, OUTCOME_LABEL, OUTCOME_TONE } from "@/lib/leads";

type Props = {
  workspaceId: string; role: Role; timeZone: string; myUserId: string;
  contact: ContactDetail; deals: { items: LeadDto[]; pipelines: PipelineDto[] } | null; notes: Note[]; methods: ContactMethodDto[] | null; activity: { items: ActivityItem[]; nextCursor: string | null }; tasks: Task[];
  allTags: Tag[]; stages: LifecycleStage[]; members: Member[]; fields: CustomField[];
  perms: { edit: boolean; delete: boolean; consent: boolean };
};

/** Panels inside one group share a single surface and are divided by hairlines (no stack of identical boxes). */
const GROUP = "overflow-hidden rounded-card bg-surface shadow-sheet [&>[data-panel]]:rounded-none [&>[data-panel]]:bg-transparent [&>[data-panel]]:shadow-none [&>[data-panel]+[data-panel]]:border-t [&>[data-panel]+[data-panel]]:border-line-card";

/** Well-known stage names get a meaningful dot; custom stages hash to a stable hue. */
const STAGE_HUE: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = { new: 1, lead: 3, qualified: 5, opportunity: 4, customer: 2, churned: 6 };
const mailtoHref = (e: string) => `mailto:${encodeURI(e)}`;
const telHref = (p: string) => `tel:${p.replace(/[^\d+*#,;]/g, "")}`;

type Form = { name: string; email: string; phone: string; company: string; stage: string; owner: string; source: string; custom: Record<string, unknown> };
const toForm = (c: ContactDetail): Form => ({ name: c.name, email: c.email ?? "", phone: c.phone ?? "", company: c.company ?? "", stage: c.lifecycleStage.id, owner: c.owner?.id ?? "", source: c.source, custom: c.custom });
const FORM_LABEL: Record<string, string> = { name: "Name", email: "Email", phone: "Phone", company: "Company", stage: "Lifecycle stage", owner: "Owner", source: "Source" };
const differs = (a: unknown, b: unknown) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
/** Labels of the fields where `b` differs from `a` (custom fields by key). */
const changedLabels = (a: Form, b: Form, fields: CustomField[]) => [
  ...Object.keys(FORM_LABEL).filter((k) => differs(a[k as keyof Form], b[k as keyof Form])).map((k) => FORM_LABEL[k]),
  ...fields.filter((f) => differs(a.custom[f.key], b.custom[f.key])).map((f) => f.label),
];
/** Latest server values, with only the fields I changed (vs `base`) laid on top. */
function mergeMine(base: Form, mine: Form, latest: Form, fields: CustomField[]): Form {
  const out: Form = { ...latest, custom: { ...latest.custom } };
  for (const k of Object.keys(FORM_LABEL) as (keyof typeof FORM_LABEL & keyof Form)[]) if (differs(base[k], mine[k])) (out as Record<string, unknown>)[k] = mine[k];
  for (const f of fields) if (differs(base.custom[f.key], mine.custom[f.key])) out.custom[f.key] = mine.custom[f.key];
  return out;
}

export function ContactDetailView(props: Props) {
  const { workspaceId, role, timeZone, myUserId, stages, members, fields, perms } = props;
  const router = useRouter();
  const [c, setC] = React.useState(props.contact);
  const [notes, setNotes] = React.useState(props.notes);
  const [activity, setActivity] = React.useState(props.activity);
  const [tasks, setTasks] = React.useState(props.tasks);
  const [allTags, setAllTags] = React.useState(props.allTags);
  const [savedVersion, setSavedVersion] = React.useState<number | null>(null); // the form remounts on each version, so the confirmation lives here
  const [carry, setCarry] = React.useState<Form | null>(null); // my unsaved edits, re-applied on top after a conflict reload
  const p = { workspaceId, contactId: c.id };

  const refreshActivity = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.listActivity, { params: { workspaceId, contactId: props.contact.id }, query: { limit: 20 } });
    // keep older pages the user already loaded: prepend only unseen items, keep the existing cursor
    if (r.ok) setActivity((prev) => (prev.items.length === 0 ? r.data : { items: [...r.data.items.filter((i) => !prev.items.some((x) => x.id === i.id)), ...prev.items], nextCursor: prev.nextCursor }));
  }, [workspaceId, props.contact.id]);

  return (
    <>
      <Link href={`/w/${workspaceId}/contacts`} className="mb-3 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-4" aria-hidden />Contacts</Link>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={c.name} size="xl" />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-title text-fg">{c.name}</h1>
            <p className="break-words text-base text-fg-subtle">
              {!c.email && !c.phone && !c.company && "No contact details yet"}
              {[
                c.email && <a key="e" className="underline underline-offset-2 hover:text-fg" href={mailtoHref(c.email)}>{c.email}</a>,
                c.phone && <a key="p" className="underline underline-offset-2 hover:text-fg" href={telHref(c.phone)}>{c.phone}</a>,
                c.company && <span key="c">{c.company}</span>,
              ].filter(Boolean).flatMap((x, i) => (i ? [" · ", x] : [x]))}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Status hue={STAGE_HUE[c.lifecycleStage.name.trim().toLowerCase()] ?? hueOf(c.lifecycleStage.name)}>{c.lifecycleStage.name}</Status>
          {perms.delete && <DeleteMenu workspaceId={workspaceId} contact={c} onDeleted={() => router.push(`/w/${workspaceId}/contacts`)} />}
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <div className="grid gap-4 lg:col-span-2">
          <div className={GROUP}>
          <DetailsPanel key={c.version} c={c} carry={carry} onCarryUsed={() => setCarry(null)} onCarry={setCarry} saved={savedVersion === c.version} onSaved={(d, viaSave) => { setC(d); if (viaSave) setSavedVersion(d.version); void refreshActivity(); }} stages={stages} members={members} fields={fields} canEdit={perms.edit} workspaceId={workspaceId} myUserId={myUserId} />
          <DetectedMethodsPanel workspaceId={workspaceId} contactId={c.id} initial={props.methods} canEdit={perms.edit} timeZone={timeZone} onPrimaryChanged={() => { void browserApi.call(endpoints.getContact, { params: { workspaceId, contactId: c.id } }).then((r) => { if (r.ok) setC(r.data); }); }} />
          <AdConsentPanel workspaceId={workspaceId} contactId={c.id} canEdit={perms.consent} timeZone={timeZone} members={members} />
          <TagsPanel c={c} allTags={allTags} canEdit={perms.edit} workspaceId={workspaceId} onChanged={(d, t) => { setC(d); if (t) setAllTags(t); void refreshActivity(); }} />
          </div>
          <div className={GROUP}>
          <NotesPanel notes={notes} setNotes={setNotes} p={p} role={role} myUserId={myUserId} canEdit={perms.edit} timeZone={timeZone} onChanged={refreshActivity} />
          <ActivityPanel activity={activity} setActivity={setActivity} p={p} timeZone={timeZone} />
          </div>
        </div>
        <div className={GROUP}>
          <TasksPanel tasks={tasks} setTasks={setTasks} p={p} canEdit={perms.edit} role={role} myUserId={myUserId} members={members} timeZone={timeZone} onChanged={async () => { void refreshActivity(); const d = await browserApi.call(endpoints.getContact, { params: p }); if (d.ok) setC(d.data); }} />
          <Panel>
            <PanelHeader title="Conversations" />
            <EmptyState icon={MessageSquare} title="Conversations are not available yet" description="The unified inbox is planned for Phase 4. Nothing is stored for this contact until then." className="py-8" />
          </Panel>
          <Panel>
            <PanelHeader title="Deals" description={props.deals?.items.length ? `${props.deals.items.length} linked` : undefined} />
            {!props.deals ? (
              <EmptyState icon={Workflow} title="Deals are not shown for your role" description="Ask an owner or admin for access to leads and pipelines." className="py-8" />
            ) : props.deals.items.length === 0 ? (
              <EmptyState icon={Workflow} title="No deals yet" description="Deals created for this contact show here. The lifecycle stage above is separate from any pipeline." className="py-8" action={<Link href={`/w/${workspaceId}/pipeline`} className="text-sm font-medium text-accent-fg hover:underline">Open pipeline</Link>} />
            ) : (
              <ul>
                {props.deals.items.map((l) => (
                  <li key={l.id} className="flex items-center gap-3 border-b border-line-card px-4 py-2.5 last:border-b-0">
                    <div className="min-w-0 flex-1">
                      <Link href={`/w/${workspaceId}/leads/${l.id}`} className="block truncate text-base font-medium text-fg hover:underline">{l.title}</Link>
                      <p className="truncate text-xs text-fg-subtle">{props.deals!.pipelines.find((x) => x.id === l.pipelineId)?.stages.find((x) => x.id === l.stageId)?.name ?? "Stage"}{l.valueMinor !== null && l.currency ? ` · ${formatMoney(l.valueMinor, l.currency)}` : ""}</p>
                    </div>
                    <Badge tone={l.outcome === "open" ? "neutral" : OUTCOME_TONE[l.outcome]}>{OUTCOME_LABEL[l.outcome]}</Badge>
                  </li>
                ))}
              </ul>
            )}
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

function DetailsPanel({ c, carry, onCarry, onCarryUsed, saved, onSaved, stages, members, fields, canEdit, workspaceId, myUserId }: { c: ContactDetail; carry: Form | null; onCarry: (f: Form) => void; onCarryUsed: () => void; saved: boolean; onSaved: (d: ContactDetail, viaSave?: boolean) => void; stages: LifecycleStage[]; members: Member[]; fields: CustomField[]; canEdit: boolean; workspaceId: string; myUserId: string }) {
  const initial = React.useMemo(() => toForm(c), [c]);
  const [form, setForm] = React.useState<Form>(carry ?? initial);
  React.useEffect(() => { if (carry) onCarryUsed(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- consume the carried edits once, on mount
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [conflict, setConflict] = React.useState<ContactDetail | null>(null);
  const [dupes, setDupes] = React.useState<DuplicateCandidate[] | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  // unsaved edits: the browser asks before a reload or tab close (in-app navigation cannot be guarded reliably)
  React.useEffect(() => {
    if (!dirty || !canEdit) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty, canEdit]);
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
            <p>Your edits weren&rsquo;t saved, and they are still in the form.</p>
            {(() => { const theirs = changedLabels(initial, toForm(conflict), fields); return theirs.length > 0 && <p>They changed: {theirs.join(", ")}.</p>; })()}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={() => { onCarry(mergeMine(initial, form, toForm(conflict), fields)); onSaved(conflict); setConflict(null); }}>Apply my changes on top</Button>
              <Button size="sm" onClick={() => { onSaved(conflict); setConflict(null); }}>Discard mine, load latest</Button>
            </div>
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
          <Field label="Email" action={c.email ? <a className="text-sm text-fg-muted underline underline-offset-2 hover:text-fg" href={mailtoHref(c.email)}>Send email</a> : undefined}>{(x) => <Input {...x} type="email" inputMode="email" value={form.email} onChange={(e) => set({ email: e.target.value })} disabled={!canEdit} />}</Field>
          <Field label="Phone" action={c.phone ? <a className="text-sm text-fg-muted underline underline-offset-2 hover:text-fg" href={telHref(c.phone)}>Call</a> : undefined}>{(x) => <Input {...x} type="tel" inputMode="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} disabled={!canEdit} />}</Field>
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
                <Badge shape="square" tone={TAG_TONE[t.color]} className="gap-1 pr-1">
                  {t.name}
                  {canEdit && <button type="button" aria-label={`Remove tag ${t.name}`} onClick={() => void remove(t.id)} className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-full hover:bg-line"><X className="size-3.5" aria-hidden /></button>}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <form onSubmit={add} className="flex items-end gap-2">
            <Field label="Add a tag" className="max-w-56 flex-1">{(x) => <Input {...x} list={listId} placeholder="For example wholesale" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />}</Field>
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
            <Field label="Add a note">{(x) => <Textarea {...x} placeholder="Write a note about this contact" value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} />}</Field>
            <div><Button type="submit" variant="primary" loading={busy}>Add note</Button></div>
          </form>
        )}
        {notes.length === 0 ? <p className="text-sm text-fg-muted">No notes yet.{canEdit ? " Add one to keep context for your team." : ""}</p> : (
          <ul className="flex flex-col gap-3">
            {notes.map((n) => {
              const mine = can(role, "note.edit", { isOwn: n.author.id === myUserId });
              return (
                <li key={n.id} className="rounded-card bg-subtle p-3">
                  <div className="mb-1 flex items-center gap-2 text-sm">
                    <Avatar name={n.author.name} size="xs" />
                    <span className="font-medium text-fg">{n.author.name}</span>
                    <time dateTime={n.createdAt} className="tnum text-fg-subtle">{formatDateTime(n.createdAt, timeZone)}</time>
                    {mine && editing?.id !== n.id && (
                      <span className="ml-auto flex gap-1">
                        <Button variant="ghost" icon size="sm" aria-label={`Edit note by ${n.author.name} on ${formatDateTime(n.createdAt, timeZone)}: ${n.body.slice(0, 30)}`} onClick={() => setEditing({ id: n.id, body: n.body })}><Pencil /></Button>
                        {confirmDelete === n.id ? <Button variant="danger" size="sm" aria-label={`Confirm delete note by ${n.author.name} on ${formatDateTime(n.createdAt, timeZone)}: ${n.body.slice(0, 30)}`} onClick={() => void remove(n.id)}>Confirm delete</Button> : <Button variant="ghost" icon size="sm" aria-label={`Delete note by ${n.author.name} on ${formatDateTime(n.createdAt, timeZone)}: ${n.body.slice(0, 30)}`} onClick={() => setConfirmDelete(n.id)}><Trash2 /></Button>}
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
    setTasks([...tasks, r.data].sort((a, b) => (a.status === b.status ? (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9") : a.status === "open" || a.status === "in_progress" ? -1 : 1)));
    setTitle(""); setDue(""); onChanged();
  }
  async function toggle(t: Task) {
    const r = await browserApi.call(endpoints.updateTask, { params: { workspaceId: p.workspaceId, taskId: t.id }, body: { status: t.status === "open" || t.status === "in_progress" ? "done" : "open" } });
    if (!r.ok) return setError(errorMessage(r.error));
    setTasks(tasks.map((x) => (x.id === t.id ? r.data : x))); onChanged();
  }
  async function remove(t: Task) {
    const r = await browserApi.call(endpoints.deleteTask, { params: { workspaceId: p.workspaceId, taskId: t.id } });
    if (!r.ok) return setError(errorMessage(r.error));
    setTasks(tasks.filter((x) => x.id !== t.id)); onChanged();
  }
  const [now] = React.useState(() => Date.now());
  const isActive = (t: Task) => t.status === "open" || t.status === "in_progress";
  const open = tasks.filter(isActive);
  const overdue = (t: Task) => isActive(t) && t.dueAt !== null && new Date(t.dueAt).getTime() < now;
  return (
    <Panel>
      <PanelHeader title="Tasks and follow-ups" description={open.length ? `${open.length} open` : undefined} />
      <div className="flex flex-col gap-3 p-4">
        {error && <Alert tone="error">{error}</Alert>}
        {tasks.length === 0 ? <p className="text-sm text-fg-muted">No tasks yet.{canEdit ? " Add a follow-up so this contact isn’t forgotten." : ""}</p> : (
          <ul className="flex flex-col gap-2">
            {tasks.map((t) => {
              const mine = can(role, "task.edit", { isOwn: t.assignee?.id === myUserId || t.createdBy?.id === myUserId });
              return (
                <li key={t.id} className="flex items-start gap-2">
                  <button type="button" role="checkbox" aria-checked={t.status === "done"} aria-label={`${t.status === "done" ? "Reopen" : "Complete"}: ${t.title}`} disabled={!mine} onClick={() => void toggle(t)} className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border pointer-coarse:size-7 ${t.status === "done" ? "border-accent bg-accent text-on-accent" : "border-line-control bg-surface"} disabled:opacity-50`}>
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
            <Field label="New task">{(x) => <Input {...x} placeholder="Follow-up, for example Send the quote" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />}</Field>
            <div className="flex flex-wrap gap-2">
              <Field label="Due" className="min-w-40 flex-1">{(x) => <Input {...x} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
              <Field label="Assign to" className="min-w-40 flex-1">{(x) => <Select {...x} value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">Unassigned</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}{m.userId === myUserId ? " (you)" : ""}</option>)}</Select>}</Field>
            </div>
            <div><Button type="submit" loading={busy}><Plus />Add task</Button></div>
          </form>
        )}
      </div>
    </Panel>
  );
}
