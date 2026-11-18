"use client";
import * as React from "react";
import { Lock, Trash2, Workflow } from "lucide-react";
import { endpoints, type ContactDetail, type ContactLead, type LostReasonDto, type Member, type PipelineDto } from "@crm/contracts";
import { Status } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogActions, DialogClose, DialogContent } from "@/components/ui/overlays";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Alert, EmptyState } from "@/components/ui/states";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { defaultPipeline, shownStage, stageHue, stagesForContact } from "@/lib/contact-lead";
import { CURRENCIES, fromMinor, toMinor } from "@/lib/leads";

type Props = {
  workspaceId: string; contact: ContactDetail; lead: ContactLead | null; pipelines: PipelineDto[]; lostReasons: LostReasonDto[]; members: Member[];
  canEdit: boolean; canEditOwner: boolean; canSetValue: boolean; canRemove: boolean; myUserId: string;
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

function Form({ workspaceId, contact, lead, pipelines, lostReasons, members, canEdit, canEditOwner, canSetValue, canRemove, onLead, onContact }: Props) {
  const [removeOpen, setRemoveOpen] = React.useState(false);
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
        <div className="grid gap-3 md:grid-cols-3">
        <Field label="Stage">{(x) => <Select {...x} value={stageId} onChange={(e) => setStageId(e.target.value)} disabled={!canEdit}>{stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        {lead?.valueHidden ? (
          <p className="inline-flex items-center gap-1.5 text-sm text-fg-subtle"><Lock className="size-3.5" aria-hidden />Value is hidden for your role.</p>
        ) : (
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <Field label="Value">{(x) => <Input {...x} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0.00" disabled={!canEdit || !canSetValue} />}</Field>
            <Field label="Currency">{(x) => <Select {...x} value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={!canEdit || !canSetValue}>{[...new Set([currency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}</Select>}</Field>
          </div>
        )}
        <Field label="Owner">{(x) => <Select {...x} value={owner} onChange={(e) => setOwner(e.target.value)} disabled={!canEditOwner}><option value="">Unassigned</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</Select>}</Field>
        </div>
        {target?.kind === "lost" && stageDirty && <Field label="Why was it lost?">{(x) => <Select {...x} value={reasonId} onChange={(e) => setReasonId(e.target.value)}>{lostReasons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}</Field>}
        {(canEdit || canEditOwner) && (
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!dirty}>Update</Button>
          </div>
        )}
      </form>
      {lead && canEdit && (
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
          <Button variant="secondary" size="sm" disabled={!canRemove} onClick={() => setRemoveOpen(true)}><Trash2 aria-hidden />Remove from pipeline</Button>
          {!canRemove && <p className="text-xs text-fg-subtle">Only an owner or admin can remove a contact from the pipeline.</p>}
        </div>
      )}
      {lead && canRemove && <ValueAccess workspaceId={workspaceId} leadId={lead.id} members={members} />}
      {lead && (
        <RemoveDialog open={removeOpen} onOpenChange={setRemoveOpen} name={contact.name} workspaceId={workspaceId} contactId={contact.id} lead={lead} onLead={onLead} />
      )}
    </Panel>
  );
}

/** Soft delete of the primary lead (DELETE /leads/:id). The contact, its history and tasks stay; an owner or admin restores it under Contacts, Recently removed. */
function RemoveDialog({ open, onOpenChange, name, workspaceId, contactId, lead, onLead }: { open: boolean; onOpenChange: (o: boolean) => void; name: string; workspaceId: string; contactId: string; lead: ContactLead; onLead: (l: ContactLead | null) => void }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const toast = useToast();
  async function remove() {
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.deleteLead, { params: { workspaceId, leadId: lead.id }, query: { expectedVersion: lead.version } });
    if (!r.ok) {
      setBusy(false);
      if (r.error.kind === "http" && r.error.code === "version_conflict") {
        const fresh = await browserApi.call(endpoints.getContactLead, { params: { workspaceId, contactId } });
        if (fresh.ok) onLead(fresh.data.lead);
        return setError("Someone else changed this just now. The latest values are shown; review them and try again.");
      }
      return setError(errorMessage(r.error));
    }
    const fresh = await browserApi.call(endpoints.getContactLead, { params: { workspaceId, contactId } });
    setBusy(false);
    onOpenChange(false);
    toast("Removed from the pipeline. Restore it under Contacts, Recently removed.");
    onLead(fresh.ok ? fresh.data.lead : null);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Remove from pipeline?" description={`${name} leaves the pipeline: the stage and value are no longer tracked. The contact, notes, tasks and history stay. You can restore it any time from Contacts, Recently removed.`}>
        {error && <Alert tone="error" className="mb-3">{error}</Alert>}
        <DialogActions><DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose><Button variant="danger" loading={busy} onClick={() => void remove()}>Remove</Button></DialogActions>
      </DialogContent>
    </Dialog>
  );
}

/** Owner/admin only: which agents may see (and edit) this contact's value. Everyone else never receives the value from the API. */
function ValueAccess({ workspaceId, leadId, members }: { workspaceId: string; leadId: string; members: Member[] }) {
  const [grants, setGrants] = React.useState<Map<string, boolean> | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const agents = members.filter((m) => m.role === "agent" && m.status === "active");
  const params = { workspaceId, leadId };
  const apply = React.useCallback((r: Awaited<ReturnType<typeof browserApi.call<typeof endpoints.listLeadValueGrants>>>) => {
    if (!r.ok) return setError(errorMessage(r.error));
    setError(null);
    setGrants(new Map(r.data.items.map((g) => [g.userId, g.canEdit])));
  }, []);
  const load = React.useCallback(() => browserApi.call(endpoints.listLeadValueGrants, { params: { workspaceId, leadId } }).then(apply), [workspaceId, leadId, apply]);
  React.useEffect(() => { let live = true; void browserApi.call(endpoints.listLeadValueGrants, { params: { workspaceId, leadId } }).then((r) => { if (live) apply(r); }); return () => { live = false; }; }, [workspaceId, leadId, apply]);

  async function change(userId: string, v: string) {
    setBusy(userId); setError(null);
    const r = v === "none"
      ? await browserApi.call(endpoints.removeLeadValueGrant, { params: { ...params, userId } })
      : await browserApi.call(endpoints.setLeadValueGrant, { params: { ...params, userId }, body: { canEdit: v === "edit" } });
    setBusy(null);
    if (!r.ok) return setError(errorMessage(r.error));
    await load();
  }
  return (
    <div className="border-t border-border px-4 py-3" role="group" aria-label="Who can see the value">
      <h3 className="text-sm font-medium text-fg">Who can see the value</h3>
      <p className="mb-2 text-xs text-fg-subtle">Owners and admins always can. Agents only when you allow it here, for this contact.</p>
      {error && <Alert tone="error" className="mb-2">{error} <button type="button" className="underline" onClick={() => void load()}>Try again</button></Alert>}
      {!grants && !error && <p role="status" className="text-sm text-fg-muted">Loading…</p>}
      {grants && agents.length === 0 && <p className="text-sm text-fg-muted">No agents in this workspace.</p>}
      {grants && agents.length > 0 && (
        <ul className="grid gap-2">
          {agents.map((m) => (
            <li key={m.userId} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{m.name}</span>
              <Select aria-label={`Value access for ${m.name}`} wrapperClassName="w-auto" disabled={busy === m.userId} value={grants.has(m.userId) ? (grants.get(m.userId) ? "edit" : "view") : "none"} onChange={(e) => void change(m.userId, e.target.value)}>
                <option value="none">No access</option><option value="view">Can see</option><option value="edit">Can see and edit</option>
              </Select>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
