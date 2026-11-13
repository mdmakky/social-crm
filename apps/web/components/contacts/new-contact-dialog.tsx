"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { endpoints, type CustomField, type DuplicateCandidate, type LifecycleStage, type Member } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/overlays";
import { Alert } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";
import { CustomFieldInput } from "./custom-field-input";

type Props = { workspaceId: string; stages: LifecycleStage[]; members: Member[]; fields: CustomField[]; myUserId: string };

export function NewContactDialog({ open, onOpenChange, ...rest }: Props & { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add contact" description="Start with what you know. You can add notes, tags and tasks afterwards." className="max-h-[90dvh] max-w-lg overflow-y-auto">
        {/* The form lives inside the content, so it remounts (and resets) every time the dialog opens. */}
        <NewContactForm {...rest} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function NewContactForm({ workspaceId, stages, members, fields, myUserId, onClose }: Props & { onClose: () => void }) {
  const router = useRouter();
  const active = stages.filter((s) => !s.archived);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [dupes, setDupes] = React.useState<DuplicateCandidate[] | null>(null);
  const [custom, setCustom] = React.useState<Record<string, unknown>>({});
  const formRef = React.useRef<HTMLFormElement>(null);

  async function submit(allowDuplicate: boolean) {
    const f = new FormData(formRef.current!);
    const name = String(f.get("name") ?? "").trim();
    setError(null);
    setFieldErrors({});
    if (!name) { setFieldErrors({ name: "Enter a name." }); formRef.current?.querySelector<HTMLInputElement>("[name=name]")?.focus(); return; }
    setBusy(true);
    const res = await browserApi.call(endpoints.createContact, {
      params: { workspaceId },
      body: { name, email: String(f.get("email") ?? "").trim() || null, phone: String(f.get("phone") ?? "").trim() || null, company: String(f.get("company") ?? "").trim() || null, lifecycleStageId: String(f.get("stage") ?? "") || undefined, ownerUserId: String(f.get("owner") ?? "") || null, custom, allowDuplicate },
    });
    setBusy(false);
    if (res.ok) { onClose(); router.push(`/w/${workspaceId}/contacts/${res.data.id}`); return; }
    const e = res.error;
    if (e.code === "duplicate_contact") return setDupes((e.details as { candidates: DuplicateCandidate[] }).candidates);
    if (e.code === "invalid_custom_fields") return setFieldErrors(e.details as Record<string, string>);
    setError(errorMessage(e));
  }

  return (
    <form ref={formRef} noValidate onSubmit={(e) => { e.preventDefault(); void submit(false); }} className="flex flex-col gap-3">
      {error && <Alert tone="error">{error}</Alert>}
      {dupes && (
        <Alert tone="warning">
          <p className="font-medium">This looks like a contact you already have.</p>
          <ul className="mt-1">
            {dupes.map((d) => (
              <li key={d.id}><Link className="underline underline-offset-2" href={`/w/${workspaceId}/contacts/${d.id}`}>{d.name}</Link> <span className="text-fg-muted">· same {d.matchedOn.join(" and ")}</span></li>
            ))}
          </ul>
        </Alert>
      )}
      <Field label="Name" error={fieldErrors.name}>{(p) => <Input {...p} name="name" autoFocus autoComplete="off" maxLength={120} />}</Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email">{(p) => <Input {...p} name="email" type="email" autoComplete="off" inputMode="email" />}</Field>
        <Field label="Phone">{(p) => <Input {...p} name="phone" type="tel" autoComplete="off" inputMode="tel" />}</Field>
      </div>
      <Field label="Company">{(p) => <Input {...p} name="company" autoComplete="off" maxLength={120} />}</Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Lifecycle stage">{(p) => <Select {...p} name="stage" defaultValue={active[0]?.id}>{active.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        <Field label="Owner">{(p) => <Select {...p} name="owner" defaultValue={myUserId}><option value="">Unassigned</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}{m.userId === myUserId ? " (you)" : ""}</option>)}</Select>}</Field>
      </div>
      {fields.map((f) => <CustomFieldInput key={f.id} def={f} value={custom[f.key]} onChange={(v) => setCustom((c) => ({ ...c, [f.key]: v }))} error={fieldErrors[f.key]} />)}
      <div className="mt-2 flex justify-end gap-2">
        <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
        {dupes ? <Button variant="secondary" loading={busy} onClick={() => void submit(true)}>Create anyway</Button> : null}
        <Button type="submit" variant="primary" loading={busy}>Add contact</Button>
      </div>
    </form>
  );
}
