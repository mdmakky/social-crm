"use client";
import * as React from "react";
import { Archive, ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import { CUSTOM_FIELD_TYPES, endpoints, TAG_COLORS, type CustomField, type LifecycleStage, type Tag, type TagColor } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/overlays";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Alert } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";
import { TAG_TONE } from "@/lib/contacts";

const TYPE_LABEL: Record<string, string> = { text: "Text", number: "Number", date: "Date", select: "Single choice", multiselect: "Multiple choice", boolean: "Yes / no", url: "Web address" };

export function ContactSettings({ workspaceId, canManage, stages: s0, tags: t0, fields: f0 }: { workspaceId: string; canManage: boolean; stages: LifecycleStage[]; tags: Tag[]; fields: CustomField[] }) {
  const [stages, setStages] = React.useState(s0);
  const [tags, setTags] = React.useState(t0);
  const [fields, setFields] = React.useState(f0);
  const [error, setError] = React.useState<string | null>(null);
  const p = { workspaceId };
  const fail = (e: Parameters<typeof errorMessage>[0]) => setError(errorMessage(e));

  // ----- stages -----
  const [stageName, setStageName] = React.useState("");
  const [editing, setEditing] = React.useState<{ id: string; name: string } | null>(null);
  async function addStage(e: React.FormEvent) {
    e.preventDefault();
    if (!stageName.trim()) return;
    setError(null);
    const r = await browserApi.call(endpoints.createLifecycleStage, { params: p, body: { name: stageName } });
    if (!r.ok) return fail(r.error);
    setStages([...stages, r.data]); setStageName("");
  }
  async function renameStage() {
    if (!editing) return;
    const r = await browserApi.call(endpoints.updateLifecycleStage, { params: { ...p, stageId: editing.id }, body: { name: editing.name } });
    if (!r.ok) return fail(r.error);
    setStages(stages.map((s) => (s.id === r.data.id ? r.data : s))); setEditing(null); setError(null);
  }
  const [confirmStage, setConfirmStage] = React.useState<LifecycleStage | null>(null);
  const [confirmTag, setConfirmTag] = React.useState<Tag | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const askArchive = (s: LifecycleStage) => { setDialogError(null); if (s.contactCount > 0) setConfirmStage(s); else void archiveStage(s, true); };
  async function archiveStage(s: LifecycleStage, archived: boolean) {
    setBusy(true);
    const r = await browserApi.call(endpoints.updateLifecycleStage, { params: { ...p, stageId: s.id }, body: { archived } });
    setBusy(false);
    if (!r.ok) return confirmStage ? setDialogError(errorMessage(r.error)) : fail(r.error);
    setStages(stages.map((x) => (x.id === s.id ? r.data : x))); setError(null); setConfirmStage(null);
  }
  async function move(i: number, d: -1 | 1) {
    const next = [...stages]; const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    const r = await browserApi.call(endpoints.reorderLifecycleStages, { params: p, body: { ids: next.map((x) => x.id) } });
    if (!r.ok) return fail(r.error);
    setStages(r.data); setError(null);
  }

  // ----- tags -----
  const [editTag, setEditTag] = React.useState<{ id: string; name: string; color: TagColor } | null>(null);
  async function saveTag() {
    if (!editTag) return;
    const r = await browserApi.call(endpoints.updateTag, { params: { ...p, tagId: editTag.id }, body: { name: editTag.name, color: editTag.color } });
    if (!r.ok) return fail(r.error);
    setTags(tags.map((t) => (t.id === r.data.id ? r.data : t))); setEditTag(null); setError(null);
  }
  async function deleteTag(t: Tag) {
    setBusy(true);
    const r = await browserApi.call(endpoints.deleteTag, { params: { ...p, tagId: t.id } });
    setBusy(false);
    if (!r.ok) return setDialogError(errorMessage(r.error));
    setTags(tags.filter((x) => x.id !== t.id)); setError(null); setConfirmTag(null);
  }

  // ----- custom fields -----
  const [nf, setNf] = React.useState({ label: "", key: "", type: "text", options: "", required: false });
  const [keyTouched, setKeyTouched] = React.useState(false);
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "f_$1").slice(0, 40);
  async function addField(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const options = nf.options.split(/[\n,]/).map((o) => o.trim()).filter(Boolean);
    const r = await browserApi.call(endpoints.createCustomField, { params: p, body: { key: nf.key || slug(nf.label), label: nf.label, type: nf.type as CustomField["type"], options: options.length ? options : undefined, required: nf.required } });
    if (!r.ok) return fail(r.error);
    setFields([...fields, r.data]); setNf({ label: "", key: "", type: "text", options: "", required: false }); setKeyTouched(false);
  }
  async function archiveField(f: CustomField, archived: boolean) {
    const r = await browserApi.call(endpoints.updateCustomField, { params: { ...p, fieldId: f.id }, body: { archived } });
    if (!r.ok) return fail(r.error);
    setFields(fields.map((x) => (x.id === f.id ? r.data : x))); setError(null);
  }

  return (
    <div className="grid max-w-3xl gap-4">
      {error && <Alert tone="error">{error}</Alert>}
      {!canManage && <Alert tone="info">Only owners and admins can change these settings.</Alert>}

      <Panel>
        <PanelHeader title="Lifecycle stages" description="Where a contact is in your relationship with them. Independent of any sales pipeline." />
        <ul>
          {stages.map((s, i) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 last:border-b-0">
              {editing?.id === s.id ? (
                <form className="flex flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); void renameStage(); }}>
                  <Input aria-label={`Rename ${s.name}`} value={editing.name} onChange={(e) => setEditing({ id: s.id, name: e.target.value })} maxLength={40} autoFocus />
                  <Button type="submit" variant="primary" size="sm">Save</Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
                </form>
              ) : (
                <>
                  <span className={`flex-1 text-base ${s.archived ? "text-fg-subtle line-through" : "text-fg"}`}>{s.name}</span>
                  <span className="tnum text-sm text-fg-subtle">{s.contactCount} {s.contactCount === 1 ? "contact" : "contacts"}</span>
                  {s.archived && <Badge>Archived</Badge>}
                  {canManage && (
                    <span className="flex items-center gap-1">
                      <Button variant="ghost" icon size="sm" aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => void move(i, -1)}><ArrowUp /></Button>
                      <Button variant="ghost" icon size="sm" aria-label={`Move ${s.name} down`} disabled={i === stages.length - 1} onClick={() => void move(i, 1)}><ArrowDown /></Button>
                      <Button variant="secondary" size="sm" onClick={() => setEditing({ id: s.id, name: s.name })}>Rename</Button>
                      {s.archived ? <Button variant="secondary" size="sm" onClick={() => void archiveStage(s, false)}><RotateCcw />Restore</Button> : <Button variant="secondary" size="sm" onClick={() => askArchive(s)}><Archive />Archive</Button>}
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
        {canManage && (
          <form onSubmit={addStage} className="flex gap-2 border-t border-line p-4">
            <Input aria-label="New lifecycle stage" placeholder="Add a stage, for example Onboarding" value={stageName} onChange={(e) => setStageName(e.target.value)} maxLength={40} />
            <Button type="submit"><Plus />Add stage</Button>
          </form>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="Custom fields" description="Extra information to keep on every contact. Archiving hides a field but keeps its stored values." />
        {fields.length === 0 ? <p className="px-4 py-4 text-sm text-fg-muted">No custom fields yet.</p> : (
          <ul>
            {fields.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <p className={`text-base ${f.archived ? "text-fg-subtle line-through" : "text-fg"}`}>{f.label}{f.required && <span className="text-fg-subtle"> · required</span>}</p>
                  <p className="text-xs text-fg-subtle">{TYPE_LABEL[f.type]}{f.options.length ? ` · ${f.options.join(", ")}` : ""} · key {f.key}</p>
                </div>
                {f.archived && <Badge>Archived</Badge>}
                {canManage && (f.archived ? <Button variant="secondary" size="sm" onClick={() => void archiveField(f, false)}><RotateCcw />Restore</Button> : <Button variant="secondary" size="sm" onClick={() => void archiveField(f, true)}><Archive />Archive</Button>)}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <form onSubmit={addField} className="grid gap-3 border-t border-line p-4 sm:grid-cols-2">
            <Field label="Label">{(x) => <Input {...x} value={nf.label} onChange={(e) => setNf({ ...nf, label: e.target.value, key: keyTouched ? nf.key : slug(e.target.value) })} maxLength={60} />}</Field>
            <Field label="Type">{(x) => <Select {...x} value={nf.type} onChange={(e) => setNf({ ...nf, type: e.target.value })}>{CUSTOM_FIELD_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</Select>}</Field>
            <Field label="Key" hint="Used in imports and exports. Lowercase letters, numbers and underscores.">{(x) => <Input {...x} value={nf.key} onChange={(e) => { setKeyTouched(true); setNf({ ...nf, key: e.target.value }); }} maxLength={40} />}</Field>
            {(nf.type === "select" || nf.type === "multiselect") && <Field label="Options" hint="One per line or comma-separated.">{(x) => <Input {...x} value={nf.options} onChange={(e) => setNf({ ...nf, options: e.target.value })} />}</Field>}
            <div className="flex items-center sm:col-span-2"><Checkbox label="Required when adding a contact" checked={nf.required} onChange={(e) => setNf({ ...nf, required: e.target.checked })} /></div>
            <div className="sm:col-span-2"><Button type="submit" disabled={!nf.label.trim()}><Plus />Add field</Button></div>
          </form>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="Tags" description="Anyone who can edit contacts can create tags. Renaming and deleting is limited to admins." />
        {tags.length === 0 ? <p className="px-4 py-4 text-sm text-fg-muted">No tags yet. Add one from any contact.</p> : (
          <ul>
            {tags.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 last:border-b-0">
                {editTag?.id === t.id ? (
                  <form className="flex flex-1 flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void saveTag(); }}>
                    <Input aria-label={`Rename tag ${t.name}`} value={editTag.name} onChange={(e) => setEditTag({ ...editTag, name: e.target.value })} maxLength={40} className="max-w-48" autoFocus />
                    <Select aria-label="Tag color" value={editTag.color} onChange={(e) => setEditTag({ ...editTag, color: e.target.value as TagColor })} className="w-auto">{TAG_COLORS.map((c) => <option key={c} value={c}>{c[0]!.toUpperCase() + c.slice(1)}</option>)}</Select>
                    <Button type="submit" variant="primary" size="sm">Save</Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditTag(null)}>Cancel</Button>
                  </form>
                ) : (
                  <>
                    <Badge tone={TAG_TONE[t.color]}>{t.name}</Badge>
                    <span className="flex-1 tnum text-sm text-fg-subtle">{t.contactCount} {t.contactCount === 1 ? "contact" : "contacts"}</span>
                    {canManage && <span className="flex gap-1"><Button variant="secondary" size="sm" onClick={() => setEditTag({ id: t.id, name: t.name, color: t.color })}>Edit</Button><Button variant="ghost" icon size="sm" aria-label={`Delete tag ${t.name}`} onClick={() => { setDialogError(null); setConfirmTag(t); }}><Trash2 /></Button></span>}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Dialog open={!!confirmStage} onOpenChange={(o) => { if (!o && !busy) setConfirmStage(null); }}>
        <DialogContent title={`Archive "${confirmStage?.name ?? ""}"?`} description={`${confirmStage?.contactCount ?? 0} ${confirmStage?.contactCount === 1 ? "contact is" : "contacts are"} in this stage. Archived stages stay on the contacts that already have them but cannot be newly assigned. You can restore the stage later.`}>
          {dialogError && <Alert tone="error" className="mb-3">{dialogError}</Alert>}
          <div className="flex justify-end gap-2">
            <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
            <Button variant="danger" loading={busy} onClick={() => confirmStage && void archiveStage(confirmStage, true)}>Archive stage</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmTag} onOpenChange={(o) => { if (!o && !busy) setConfirmTag(null); }}>
        <DialogContent title={`Delete tag "${confirmTag?.name ?? ""}"?`} description={`It will be removed from ${confirmTag?.contactCount ?? 0} ${confirmTag?.contactCount === 1 ? "contact" : "contacts"}. This cannot be undone.`}>
          {dialogError && <Alert tone="error" className="mb-3">{dialogError}</Alert>}
          <div className="flex justify-end gap-2">
            <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
            <Button variant="danger" loading={busy} onClick={() => confirmTag && void deleteTag(confirmTag)}>Delete tag</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
