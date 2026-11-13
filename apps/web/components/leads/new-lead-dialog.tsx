"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { endpoints, type PipelineDto } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Textarea } from "@/components/ui/form-controls";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { Alert } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { ContactPicker, type PickedContact } from "@/components/tasks/contact-picker";
import { browserApi, errorMessage } from "@/lib/client-api";
import { CURRENCIES, noun, toMinor } from "@/lib/leads";

/** Create dialog. Deal value is only offered when the caller may set it; the server enforces the same rule. */
export function NewLeadDialog({ open, onOpenChange, workspaceId, pipelines, canSetValue, defaultContact }: { open: boolean; onOpenChange: (o: boolean) => void; workspaceId: string; pipelines: PipelineDto[]; canSetValue: boolean; defaultContact?: PickedContact | null }) {
  const router = useRouter();
  const toast = useToast();
  const active = pipelines.filter((p) => !p.archived);
  const [pipelineId, setPipelineId] = React.useState(active.find((p) => p.isDefault)?.id ?? active[0]?.id ?? "");
  const pipeline = active.find((p) => p.id === pipelineId);
  const [title, setTitle] = React.useState("");
  const [contact, setContact] = React.useState<PickedContact | null>(defaultContact ?? null);
  const [value, setValue] = React.useState("");
  const [currency, setCurrency] = React.useState(pipeline?.defaultCurrency ?? "USD");
  const [close, setClose] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [dupes, setDupes] = React.useState<{ id: string; title: string }[] | null>(null);
  const label = noun(pipeline?.kind);

  async function submit(allowDuplicate: boolean) {
    setError(null);
    if (!title.trim()) return setError("Give it a title.");
    if (!contact) return setError("Choose the primary contact.");
    let valueMinor: number | undefined;
    if (canSetValue && value.trim()) {
      const m = toMinor(value, currency);
      if (m === null) return setError("Enter the value as a number, for example 2500 or 2,500.50.");
      valueMinor = m;
    }
    setBusy(true);
    const r = await browserApi.call(endpoints.createLead, { params: { workspaceId }, body: { title: title.trim(), primaryContactId: contact.id, pipelineId, ...(description.trim() ? { description: description.trim() } : {}), ...(valueMinor !== undefined ? { valueMinor, currency } : {}), ...(close ? { expectedCloseDate: close } : {}), allowDuplicate } });
    setBusy(false);
    if (!r.ok) {
      if (r.error.kind === "http" && r.error.code === "duplicate_lead") {
        setDupes(((r.error as unknown as { details?: { duplicates?: { id: string; title: string }[] } }).details?.duplicates) ?? []);
        return;
      }
      return setError(errorMessage(r.error));
    }
    toast(`${label} created.`);
    onOpenChange(false);
    router.push(`/w/${workspaceId}/leads/${r.data.id}`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`New ${label.toLowerCase()}`} description="Every one is linked to a primary contact and starts in the first stage of its pipeline.">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(false); }} noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          {dupes && (
            <Alert tone="warning">
              This contact already has an open {label.toLowerCase()} in this pipeline: {dupes.map((d) => d.title).join(", ")}.{" "}
              <button type="button" className="font-medium underline" onClick={() => void submit(true)}>Create another anyway</button>
            </Alert>
          )}
          <Field label="Title">{(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} autoFocus />}</Field>
          <Field label="Primary contact">{(p) => <ContactPicker {...p} workspaceId={workspaceId} value={contact} onChange={(c) => { setContact(c); setDupes(null); }} />}</Field>
          {active.length > 1 && (
            <Field label="Pipeline">{(p) => <Select {...p} value={pipelineId} onChange={(e) => { setPipelineId(e.target.value); setCurrency(active.find((x) => x.id === e.target.value)?.defaultCurrency ?? "USD"); setDupes(null); }}>{active.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {canSetValue && (
              <div className="grid grid-cols-[1fr_6rem] gap-2">
                <Field label="Value">{(p) => <Input {...p} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0.00" />}</Field>
                <Field label="Currency">{(p) => <Select {...p} value={currency} onChange={(e) => setCurrency(e.target.value)}>{[...new Set([currency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}</Select>}</Field>
              </div>
            )}
            <Field label="Expected close date">{(p) => <Input {...p} type="date" value={close} onChange={(e) => setClose(e.target.value)} min="2000-01-01" max="2100-12-31" />}</Field>
          </div>
          <Field label="Description" hint="Optional">{(p) => <Textarea {...p} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />}</Field>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>{busy ? "Creating…" : `Create ${label.toLowerCase()}`}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
