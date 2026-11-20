"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { CUSTOM_FIELD_TYPES, endpoints, TAG_COLORS, type CustomField, type Tag, type TagColor } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent, DialogActions, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/overlays";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Alert } from "@/components/ui/states";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { TAG_TONE } from "@/lib/contacts";

const TYPE_LABEL: Record<string, string> = { text: "Text", number: "Number", date: "Date", select: "Single choice", multiselect: "Multiple choice", boolean: "Yes / no", url: "Web address" };
const COLOR_LABEL: Record<TagColor, string> = { neutral: "Neutral", accent: "Violet", success: "Green", warning: "Amber", danger: "Red" };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "f_$1").slice(0, 40);
const leads = (n: number) => `${n} ${n === 1 ? "lead" : "leads"}`;
type Props = { tab: "fields" | "tags"; workspaceId: string; canManage: boolean; tags: Tag[]; fields: CustomField[] };

export function FieldsAndTags(p: Props) {
  return <ToastProvider><Inner {...p} /></ToastProvider>;
}

/** Overflow menu: quiet on desktop (appears on row hover or focus), always visible on touch. */
function RowMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" icon size="sm" aria-label={label} className="shrink-0 opacity-100 transition-opacity data-[state=open]:opacity-100 md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100 pointer-coarse:opacity-100"><MoreHorizontal /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
const ROW = "group/row flex min-h-12 items-center gap-3 border-b border-line-card px-4 py-2 last:border-b-0";

function Inner({ tab, workspaceId, canManage, tags: t0, fields: f0 }: Props) {
  const toast = useToast();
  const router = useRouter();
  const [tags, setTags] = React.useState(t0);
  const [fields, setFields] = React.useState(f0);
  const [error, setError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const w = { workspaceId };
  const fail = (e: Parameters<typeof errorMessage>[0]) => setError(errorMessage(e));
  const done = (msg: string) => { setError(null); toast(msg); router.refresh(); };

  // ----- fields -----
  const blank = { label: "", key: "", type: "text", options: "", required: false };
  const [nf, setNf] = React.useState(blank);
  const [keyTouched, setKeyTouched] = React.useState(false);
  async function addField(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const options = nf.options.split(/[\n,]/).map((o) => o.trim()).filter(Boolean);
    setBusy(true);
    const r = await browserApi.call(endpoints.createCustomField, { params: w, body: { key: nf.key || slug(nf.label), label: nf.label, type: nf.type as CustomField["type"], options: options.length ? options : undefined, required: nf.required } });
    setBusy(false);
    if (!r.ok) return fail(r.error);
    setFields([...fields, r.data]); setNf(blank); setKeyTouched(false); setAdding(false); done("Field added.");
  }
  async function archiveField(f: CustomField, archived: boolean) {
    const r = await browserApi.call(endpoints.updateCustomField, { params: { ...w, fieldId: f.id }, body: { archived } });
    if (!r.ok) return fail(r.error);
    setFields(fields.map((x) => (x.id === f.id ? r.data : x))); done(archived ? "Field archived." : "Field restored.");
  }

  // ----- tags -----
  const [nt, setNt] = React.useState<{ name: string; color: TagColor }>({ name: "", color: "neutral" });
  const [editTag, setEditTag] = React.useState<{ id: string; name: string; color: TagColor } | null>(null);
  const [confirmTag, setConfirmTag] = React.useState<Tag | null>(null);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  async function addTag(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const r = await browserApi.call(endpoints.createTag, { params: w, body: { name: nt.name, color: nt.color } });
    setBusy(false);
    if (!r.ok) return fail(r.error);
    setTags([...tags, r.data]); setNt({ name: "", color: "neutral" }); setAdding(false); done("Tag added.");
  }
  async function saveTag() {
    if (!editTag) return;
    const r = await browserApi.call(endpoints.updateTag, { params: { ...w, tagId: editTag.id }, body: { name: editTag.name, color: editTag.color } });
    if (!r.ok) return fail(r.error);
    setTags(tags.map((t) => (t.id === r.data.id ? r.data : t))); setEditTag(null); done("Tag updated.");
  }
  async function deleteTag(t: Tag) {
    setBusy(true);
    const r = await browserApi.call(endpoints.deleteTag, { params: { ...w, tagId: t.id } });
    setBusy(false);
    if (!r.ok) return setDialogError(errorMessage(r.error));
    setTags(tags.filter((x) => x.id !== t.id)); setConfirmTag(null); done("Tag deleted.");
  }

  const colorPicker = (value: TagColor, onChange: (c: TagColor) => void) => (
    <div role="radiogroup" aria-label="Tag color" className="flex flex-wrap gap-1.5">
      {TAG_COLORS.map((c) => (
        <label key={c} className="cursor-pointer has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus)] rounded-full">
          <input type="radio" name="tag-color" value={c} checked={value === c} onChange={() => onChange(c)} className="peer sr-only" />
          <Badge tone={TAG_TONE[c]} className={value === c ? "ring-2 ring-accent ring-offset-1" : "opacity-80"}>{COLOR_LABEL[c]}</Badge>
        </label>
      ))}
    </div>
  );

  const isFields = tab === "fields";
  const liveFields = fields.filter((f) => !f.archived);
  const orderedFields = [...liveFields, ...fields.filter((f) => f.archived)];
  const addLabel = isFields ? "Add a field" : "Add a tag";

  return (
    <div className="grid gap-4">
      {error && <Alert tone="error">{error}</Alert>}
      {!canManage && <Alert tone="info">Only owners and admins can change these settings.</Alert>}
      <Panel>
        <PanelHeader
          title={isFields ? "Fields" : "Tags"}
          description={isFields ? "Extra information to keep on every lead, like budget or area." : "Labels anyone who edits leads can add."}
          actions={canManage ? <Button variant="primary" size="sm" aria-expanded={adding} onClick={() => setAdding((v) => !v)}><Plus />{addLabel}</Button> : undefined}
        />
        {canManage && adding && isFields && (
          <form onSubmit={addField} aria-label="Add a field" className="grid items-start gap-3 border-b border-line-card bg-hover/40 p-4 sm:grid-cols-2">
            <Field label="Label">{(x) => <Input {...x} value={nf.label} placeholder="Preferred contact time" autoFocus onChange={(e) => setNf({ ...nf, label: e.target.value, key: keyTouched ? nf.key : slug(e.target.value) })} maxLength={60} />}</Field>
            <Field label="Type">{(x) => <Select {...x} value={nf.type} onChange={(e) => setNf({ ...nf, type: e.target.value })}>{CUSTOM_FIELD_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</Select>}</Field>
            {(nf.type === "select" || nf.type === "multiselect") && <Field label="Options" hint="One per line or comma-separated." className="sm:col-span-2">{(x) => <Input {...x} value={nf.options} onChange={(e) => setNf({ ...nf, options: e.target.value })} />}</Field>}
            <div className="sm:col-span-2"><Checkbox label="Required when adding a lead" checked={nf.required} onChange={(e) => setNf({ ...nf, required: e.target.checked })} /></div>
            <details className="sm:col-span-2">
              <summary className="cursor-pointer text-sm font-medium text-fg-muted">Advanced</summary>
              <Field label="Key" hint="Used by imports and integrations. Lowercase letters, numbers, underscores." className="mt-2 sm:max-w-sm">{(x) => <Input {...x} value={nf.key} onChange={(e) => { setKeyTouched(true); setNf({ ...nf, key: e.target.value }); }} maxLength={40} />}</Field>
            </details>
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" variant="primary" loading={busy} disabled={!nf.label.trim()}>Add field</Button>
              <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </form>
        )}
        {canManage && adding && !isFields && (
          <form onSubmit={addTag} aria-label="Add a tag" className="grid gap-3 border-b border-line-card bg-hover/40 p-4">
            <Field label="Tag name" className="sm:max-w-sm">{(x) => <Input {...x} value={nt.name} placeholder="Referral" autoFocus onChange={(e) => setNt({ ...nt, name: e.target.value })} maxLength={40} />}</Field>
            {colorPicker(nt.color, (c) => setNt({ ...nt, color: c }))}
            <div className="flex gap-2">
              <Button type="submit" variant="primary" loading={busy} disabled={!nt.name.trim()}>Add tag</Button>
              <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </form>
        )}

        {isFields ? (
          fields.length === 0 ? <p className="px-4 py-6 text-sm text-fg-muted">No custom fields yet. Add one to keep the details you always ask for, like budget or area.</p> : (
            <ul>
              {orderedFields.map((f) => (
                <li key={f.id} className={`${ROW} ${f.archived ? "text-fg-subtle" : ""}`}>
                  <div className="min-w-0 flex-1">
                    <p className={`truncate text-base ${f.archived ? "text-fg-subtle" : "text-fg"}`}>{f.label}</p>
                    {f.options.length > 0 && <p className="truncate text-xs text-fg-subtle" title={f.options.join(", ")}>{f.options.join(", ")}</p>}
                  </div>
                  <Badge>{TYPE_LABEL[f.type]}</Badge>
                  {f.required && <Badge tone="accent">Required</Badge>}
                  {f.archived && <Badge>Archived</Badge>}
                  <span className="hidden text-xs text-fg-subtle lg:inline" title="Key">key {f.key}</span>
                  {canManage && (
                    <RowMenu label={`More actions for ${f.label}`}>
                      {f.archived ? <DropdownMenuItem onSelect={() => void archiveField(f, false)}><RotateCcw />Restore</DropdownMenuItem> : <DropdownMenuItem onSelect={() => void archiveField(f, true)}><Archive />Archive</DropdownMenuItem>}
                    </RowMenu>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : tags.length === 0 ? <p className="px-4 py-6 text-sm text-fg-muted">No tags yet. Add one from any lead or here.</p> : (
          <ul>
            {tags.map((t) => (
              <li key={t.id} className={ROW}>
                {editTag?.id === t.id ? (
                  <form className="flex flex-1 flex-wrap items-center gap-3" onSubmit={(e) => { e.preventDefault(); void saveTag(); }}>
                    <Input aria-label={`Rename tag ${t.name}`} value={editTag.name} onChange={(e) => setEditTag({ ...editTag, name: e.target.value })} maxLength={40} className="max-w-48" autoFocus />
                    {colorPicker(editTag.color, (c) => setEditTag({ ...editTag, color: c }))}
                    <Button type="submit" variant="primary" size="sm">Save</Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditTag(null)}>Cancel</Button>
                  </form>
                ) : (
                  <>
                    <span className="flex-1"><Badge tone={TAG_TONE[t.color]}>{t.name}</Badge></span>
                    <span className="tnum text-sm text-fg-subtle">{leads(t.contactCount)}</span>
                    {canManage && (
                      <RowMenu label={`More actions for ${t.name}`}>
                        <DropdownMenuItem onSelect={() => setEditTag({ id: t.id, name: t.name, color: t.color })}><Pencil />Rename or change color</DropdownMenuItem>
                        <DropdownMenuItem danger onSelect={() => { setDialogError(null); setConfirmTag(t); }}><Trash2 />Delete</DropdownMenuItem>
                      </RowMenu>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {isFields && fields.length > 0 && <p className="border-t border-line-card px-4 py-2.5 text-xs text-fg-subtle">Fields cannot be deleted, only archived. Archiving hides it from forms and keeps the data.</p>}
      </Panel>

      <Dialog open={!!confirmTag} onOpenChange={(o) => { if (!o && !busy) setConfirmTag(null); }}>
        <DialogContent title={`Delete ${confirmTag?.name ?? ""}?`} description={`It will be removed from ${leads(confirmTag?.contactCount ?? 0)}. This cannot be undone.`}>
          {dialogError && <Alert tone="error" className="mb-3">{dialogError}</Alert>}
          <DialogActions>
            <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
            <Button variant="danger" loading={busy} onClick={() => confirmTag && void deleteTag(confirmTag)}>Delete tag</Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}
