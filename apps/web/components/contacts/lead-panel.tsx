"use client";
import * as React from "react";
import { Lock, Workflow } from "lucide-react";
import { endpoints, type ContactDetail, type ContactLead, type LostReasonDto, type Member, type PipelineDto } from "@crm/contracts";
import { Status } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Alert, EmptyState } from "@/components/ui/states";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { defaultPipeline, shownStage, stageHue, stagesForContact } from "@/lib/contact-lead";
import { CURRENCIES, fromMinor, toMinor } from "@/lib/leads";

type Props = {
  workspaceId: string; contact: ContactDetail; lead: ContactLead | null; pipelines: PipelineDto[]; lostReasons: LostReasonDto[]; members: Member[];
  canEdit: boolean; canEditOwner: boolean; canSetValue: boolean; myUserId: string;
  onLead: (l: ContactLead | null) => void; onContact: (c: ContactDetail) => void;
};

/**
 * The one place for a contact's stage, value and owner. No lead yet = the first stage of the default pipeline, shown as that stage; saving a change creates the lead.
 * Stage and value go through PUT /contacts/:id/lead (same code as every lead change: history, ad events, automations). Owner is the contact's owner and is kept on the lead too.
 */
export function LeadPanel(props: Props) {
  // Remount on every new version so the form always starts from what was saved.
  return <ToastProvider><Form key={`${props.lead?.id ?? "none"}:${props.lead?.version ?? 0}:${props.contact.version}`} {...props} /></ToastProvider>;
}

function Form({ workspaceId, contact, lead, pipelines, lostReasons, members, canEdit, canEditOwner, canSetValue, onLead, onContact }: Props) {
  const stages = stagesForContact(pipelines, { lead });
  const cur = shownStage(pipelines, lead);
  const currency0 = lead?.currency ?? defaultPipeline(pipelines)?.defaultCurrency ?? "USD";
  const [stageId, setStageId] = React.useState(cur?.id ?? "");
  const [value, setValue] = React.useState(lead?.valueMinor != null && lead.currency ? fromMinor(lead.valueMinor, lead.currency) : "");
  const [currency, setCurrency] = React.useState(currency0);
  const [owner, setOwner] = React.useState(contact.owner?.id ?? "");
  const [reasonId, setReasonId] = React.useState(lostReasons[0]?.id ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const toast = useToast();

  const target = stages.find((s) => s.id === stageId);
  const valueShown = !lead?.valueHidden;
  const valueDirty = valueShown && canSetValue && (value.trim() !== (lead?.valueMinor != null && lead.currency ? fromMinor(lead.valueMinor, lead.currency) : "") || (value.trim() !== "" && currency !== currency0));
  const stageDirty = !!target && target.id !== cur?.id;
  const ownerDirty = canEditOwner && owner !== (contact.owner?.id ?? "");
  const dirty = stageDirty || valueDirty || ownerDirty;

  if (!cur) {
    return (
      <Panel>
        <PanelHeader title="Stage, value and owner" />
        <EmptyState icon={Workflow} title="No stages set up yet" description="An admin needs to add the stages first, under Settings, Stages." className="py-8" />
      </Panel>
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    let money: { valueMinor: number | null; currency: string | null } | null = null;
    if (valueDirty) {
      if (value.trim() === "") money = { valueMinor: null, currency: null };
      else {
        const m = toMinor(value, currency);
        if (m === null) return setError("Enter the value as a number, for example 2500 or 2,500.50.");
        money = { valueMinor: m, currency };
      }
    }
    if (target?.kind === "lost" && stageDirty && !reasonId) return setError("Choose why it was lost.");
    setBusy(true);
    try {
      // Owner follows along on the lead when one exists (or is being created by this save); the contact keeps the owner either way.
      const leadWrite = stageDirty || valueDirty || (ownerDirty && !!lead);
      if (leadWrite) {
        const r = await browserApi.call(endpoints.putContactLead, {
          params: { workspaceId, contactId: contact.id },
          body: { ...(lead ? { expectedVersion: lead.version } : {}), ...(stageDirty ? { stageId, ...(target?.kind === "lost" ? { lostReasonId: reasonId } : {}) } : {}), ...(money ?? {}), ...(ownerDirty ? { ownerUserId: owner || null } : {}) },
        });
        if (!r.ok) {
          if (r.error.kind === "http" && r.error.code === "version_conflict") {
            const fresh = await browserApi.call(endpoints.getContactLead, { params: { workspaceId, contactId: contact.id } });
            if (fresh.ok) onLead(fresh.data.lead);
            return setError("Someone else changed this just now. The latest values are shown; review them and save again.");
          }
          return setError(errorMessage(r.error));
        }
        onLead(r.data.lead);
      }
      if (ownerDirty) {
        const r = await browserApi.call(endpoints.updateContact, { params: { workspaceId, contactId: contact.id }, body: { expectedVersion: contact.version, ownerUserId: owner || null } });
        if (!r.ok) return setError(errorMessage(r.error));
        onContact(r.data);
      }
      toast("Saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel>
      <PanelHeader
        title="Stage, value and owner"
        description={lead ? undefined : "Not tracked yet. Change anything here to start."}
        actions={cur && <span className="inline-flex items-center gap-2"><Status hue={stageHue(cur)}>{cur.name}</Status>{!!lead?.moreCount && <span className="text-xs text-fg-subtle" title={`This contact also has ${lead.moreCount} older or closed ${lead.moreCount === 1 ? "lead" : "leads"}.`}>+{lead.moreCount} more</span>}</span>}
      />
      <form noValidate onSubmit={save} className="flex flex-col gap-3 p-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="Stage">{(x) => <Select {...x} value={stageId} onChange={(e) => setStageId(e.target.value)} disabled={!canEdit}>{stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        {target?.kind === "lost" && stageDirty && <Field label="Why was it lost?">{(x) => <Select {...x} value={reasonId} onChange={(e) => setReasonId(e.target.value)}>{lostReasons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}</Field>}
        {lead?.valueHidden ? (
          <p className="inline-flex items-center gap-1.5 text-sm text-fg-subtle"><Lock className="size-3.5" aria-hidden />Value is hidden for your role.</p>
        ) : (
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <Field label="Value">{(x) => <Input {...x} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0.00" disabled={!canEdit || !canSetValue} />}</Field>
            <Field label="Currency">{(x) => <Select {...x} value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={!canEdit || !canSetValue}>{[...new Set([currency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}</Select>}</Field>
          </div>
        )}
        <Field label="Owner">{(x) => <Select {...x} value={owner} onChange={(e) => setOwner(e.target.value)} disabled={!canEditOwner}><option value="">Unassigned</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</Select>}</Field>
        {(canEdit || canEditOwner) && (
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!dirty}>Save</Button>
          </div>
        )}
      </form>
    </Panel>
  );
}
