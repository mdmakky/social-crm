"use client";
import * as React from "react";
import { Check, Lock, Workflow } from "lucide-react";
import { endpoints, type ContactDetail, type ContactLead, type LostReasonDto, type Member, type PipelineDto, type StageDto } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { Dialog, DialogActions, DialogClose, DialogContent } from "@/components/ui/overlays";
import { Panel } from "@/components/ui/panel";
import { Alert, EmptyState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { cn } from "@/lib/cn";
import { useStageValueGate } from "@/components/contacts/stage-value";
import { defaultPipeline, shownStage, stagesForContact } from "@/lib/contact-lead";
import { CURRENCIES, fromMinor, toMinor } from "@/lib/leads";
import { useWorkspacePrefs } from "@/components/shell/workspace-prefs";

type Props = {
  workspaceId: string; contact: ContactDetail; lead: ContactLead | null; pipelines: PipelineDto[]; lostReasons: LostReasonDto[]; members: Member[];
  canEdit: boolean; canEditOwner: boolean; canSetValue: boolean; myUserId: string;
  onLead: (l: ContactLead | null) => void; onContact: (c: ContactDetail) => void;
};

const CONFLICT = "Someone else changed this just now. The latest values are shown; review them and save again.";

/**
 * The one place for a lead's stage, value and owner. No lead yet = the first stage of the default pipeline, shown as that stage; the first change creates the lead.
 * Everything autosaves (no Update button): a stage click, a value on blur or Enter, an owner pick. Stage and value go through PUT /contacts/:id/lead (same code as every
 * lead change: history, ad events, automations). Owner is the contact's owner and is kept on the lead too.
 */
export function LeadPanel(props: Props) {
  // The form remounts on every new version so it always starts from what was saved; the confirmation and any error live out here so they survive that.
  const [saved, setSaved] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { if (!saved) return; const t = setTimeout(() => setSaved(0), 2500); return () => clearTimeout(t); }, [saved]);
  return <Form key={`${props.lead?.id ?? "none"}:${props.lead?.version ?? 0}:${props.contact.version}`} {...props} error={error} setError={setError} saved={saved > 0} onSaved={() => setSaved(Date.now())} />;
}

function Form({ workspaceId, contact, lead, pipelines, lostReasons, members, canEdit, canEditOwner, canSetValue, onLead, onContact, error, setError, saved, onSaved }: Props & { error: string | null; setError: (e: string | null) => void; saved: boolean; onSaved: () => void }) {
  const prefs = useWorkspacePrefs();
  const stages = stagesForContact(pipelines, { lead });
  const cur = shownStage(pipelines, lead);
  const currency0 = lead?.currency ?? defaultPipeline(pipelines)?.defaultCurrency ?? prefs.currency;
  const money0 = lead?.valueMinor != null && lead.currency ? fromMinor(lead.valueMinor, lead.currency) : "";
  const [value, setValue] = React.useState(money0);
  const [currency, setCurrency] = React.useState(currency0);
  const [busy, setBusy] = React.useState(false);
  const [lostFor, setLostFor] = React.useState<StageDto | null>(null);
  const [reasonId, setReasonId] = React.useState(lostReasons[0]?.id ?? "");
  const { gate, dialog } = useStageValueGate(workspaceId);

  if (!cur) {
    return (
      <Panel>
        <EmptyState icon={Workflow} title="No stages set up yet" description="An admin needs to add the stages first, under Settings, Stages." className="py-8" />
      </Panel>
    );
  }

  /** Writes whatever changed. A lead is created by the first change; owner follows along on the lead when one exists. */
  async function commit(change: { stage?: StageDto; value?: { minor: number | null; currency: string | null }; owner?: string }) {
    setError(null);
    setBusy(true);
    try {
      const leadWrite = !!change.stage || !!change.value || (change.owner !== undefined && !!lead);
      if (leadWrite) {
        const r = await browserApi.call(endpoints.putContactLead, {
          params: { workspaceId, contactId: contact.id },
          body: { ...(lead ? { expectedVersion: lead.version } : {}), ...(change.stage ? { stageId: change.stage.id, ...(change.stage.kind === "lost" ? { lostReasonId: reasonId } : {}) } : {}), ...(change.value ? { valueMinor: change.value.minor, currency: change.value.currency } : {}), ...(change.owner !== undefined ? { ownerUserId: change.owner || null } : {}) },
        });
        if (!r.ok) {
          if (r.error.kind === "http" && r.error.code === "version_conflict") {
            const fresh = await browserApi.call(endpoints.getContactLead, { params: { workspaceId, contactId: contact.id } });
            setError(CONFLICT);
            if (fresh.ok) onLead(fresh.data.lead);
            return;
          }
          return setError(errorMessage(r.error));
        }
        onLead(r.data.lead);
      }
      if (change.owner !== undefined) {
        const r = await browserApi.call(endpoints.updateContact, { params: { workspaceId, contactId: contact.id }, body: { expectedVersion: contact.version, ownerUserId: change.owner || null } });
        if (!r.ok) return setError(errorMessage(r.error));
        onContact(r.data);
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  /** Asks the server whether an ad rule needs a deal value for this move; if so, the dialog decides (value saved with the move, move without it, or cancel). */
  async function moveTo(s: StageDto) {
    setBusy(true);
    const choice = await gate(contact, s);
    setBusy(false);
    if (choice.cancel) return;
    void commit({ stage: s, ...(choice.value ? { value: { minor: choice.value.valueMinor, currency: choice.value.currency } } : {}) });
  }
  const pickStage = (s: StageDto) => {
    if (s.id === cur.id && !cur.virtual) return;
    if (s.kind === "lost") return setLostFor(s);
    void moveTo(s);
  };
  const saveValue = () => {
    if (!canSetValue || !canEdit || lead?.valueHidden) return;
    const changed = value.trim() !== money0 || (value.trim() !== "" && currency !== currency0);
    if (!changed) return;
    if (value.trim() === "") return void commit({ value: { minor: null, currency: null } });
    const m = toMinor(value, currency);
    if (m === null) return setError("Enter the value as a number, for example 2500 or 2,500.50.");
    void commit({ value: { minor: m, currency } });
  };

  const chip = "flex min-w-[9.5rem] flex-1 flex-col gap-0.5 rounded-card border border-line bg-surface px-3 py-2 sm:flex-none";
  const inline = "min-h-8 rounded-control border border-transparent bg-transparent px-1 text-md font-semibold text-fg hover:border-line focus-visible:border-accent focus-visible:bg-surface focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/20 disabled:cursor-not-allowed disabled:text-fg-muted pointer-coarse:min-h-11";
  return (
    <>
      <Panel className="px-4 py-3">
        {error && <Alert tone="error" className="mb-3">{error}</Alert>}
        <StageStepper stages={stages} current={cur} disabled={!canEdit || busy} onPick={pickStage} />
        {!lead && canEdit && <p className="mt-2 text-xs text-fg-subtle">Not tracked yet. Change anything here to start.</p>}
      </Panel>

      <div className="flex flex-wrap items-stretch gap-2.5">
        {lead?.valueHidden ? (
          <p className={cn(chip, "justify-center text-sm text-fg-subtle")}><span className="inline-flex items-center gap-1.5"><Lock className="size-3.5" aria-hidden />Value is hidden for your role.</span></p>
        ) : (
          <div className={cn(chip, "min-w-[12rem]")}>
            <label htmlFor="lead-value" className="text-xs text-fg-subtle">Value</label>
            <span className="flex items-center gap-1">
              <input id="lead-value" inputMode="decimal" placeholder="Add value" className={cn(inline, "w-28 min-w-0 flex-1 sm:flex-none")} value={value} disabled={!canEdit || !canSetValue || busy} onChange={(e) => setValue(e.target.value)} onBlur={saveValue} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur(); } }} />
              <select aria-label="Currency" className={cn(inline, "w-[4.5rem] appearance-none text-sm font-medium text-fg-muted")} value={currency} disabled={!canEdit || !canSetValue || busy} onChange={(e) => { setCurrency(e.target.value); if (value.trim()) { const m = toMinor(value, e.target.value); if (m !== null) void commit({ value: { minor: m, currency: e.target.value } }); } }}>{[...new Set([currency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}</select>
            </span>
          </div>
        )}
        <div className={chip}>
          <label htmlFor="lead-owner" className="text-xs text-fg-subtle">Owner</label>
          <select id="lead-owner" className={cn(inline, "min-w-0 max-w-full appearance-none truncate")} value={contact.owner?.id ?? ""} disabled={!canEditOwner || busy} onChange={(e) => void commit({ owner: e.target.value })}>
            <option value="">Unassigned</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          </select>
        </div>
        <span role="status" aria-live="polite" className={cn("inline-flex items-center gap-1 self-center text-sm text-success-fg empty:hidden transition-opacity duration-[var(--dur-base)] motion-reduce:transition-none", saved ? "opacity-100" : "opacity-0")}>{saved && <><Check className="size-4" aria-hidden />Saved</>}</span>
      </div>

      <Dialog open={!!lostFor} onOpenChange={(o) => { if (!o) setLostFor(null); }}>
        <DialogContent title="Mark as lost?" description={`${contact.name} moves to ${lostFor?.name ?? "Lost"}. Say why, so reports stay useful.`}>
          <Field label="Why was it lost?">{(x) => <Select {...x} value={reasonId} onChange={(e) => setReasonId(e.target.value)}>{lostReasons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}</Field>
          <DialogActions className="mt-3">
            <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
            <Button variant="primary" disabled={!reasonId} onClick={() => { const s = lostFor!; setLostFor(null); void moveTo(s); }}>Mark as lost</Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
      {dialog}
    </>
  );
}

/**
 * Open stages are bars (done ones filled, the current one in the accent colour); won and lost are buttons beside them. With many stages, and on a phone, only the
 * current stage keeps its label and a stage list takes over for the rest. Every bar is a real button with the stage name for assistive tech.
 */
export function StageStepper({ stages, current, disabled, onPick }: { stages: StageDto[]; current: { id: string; kind: StageDto["kind"] }; disabled: boolean; onPick: (s: StageDto) => void }) {
  const open = stages.filter((s) => s.kind === "open");
  const outcomes = stages.filter((s) => s.kind !== "open");
  const curIdx = open.findIndex((s) => s.id === current.id);
  const many = open.length > 6;
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-3 sm:flex-nowrap">
      <ol aria-label="Stage" className="flex min-w-0 flex-1 basis-full gap-1.5 sm:basis-0">
        {open.map((s, i) => {
          const cur = s.id === current.id;
          const done = current.kind !== "open" || (curIdx >= 0 && i < curIdx);
          return (
            <li key={s.id} className={cn("min-w-0", cur ? "flex-[2] sm:flex-1" : "flex-1")}>
              <button type="button" disabled={disabled} title={s.name} aria-label={`Set stage to ${s.name}`} aria-current={cur ? "step" : undefined} onClick={() => onPick(s)} className="press group block min-h-7 w-full pt-1 text-left pointer-coarse:min-h-11">
                <span className={cn("block h-1.5 rounded-full transition-colors duration-[var(--dur-base)] motion-reduce:transition-none", cur ? "bg-accent" : done ? "bg-accent/35" : "bg-line group-hover:bg-line-strong")} />
                <span className={cn("mt-2 block truncate text-sm font-medium", cur ? "text-fg" : "text-fg-subtle group-hover:text-fg", !cur && (many ? "hidden" : "max-sm:hidden"))}>{s.name}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="flex w-full items-center gap-2 sm:w-auto">
        <Select aria-label="Stage" wrapperClassName={cn("min-w-0 flex-1 sm:w-44 sm:flex-none", many ? "" : "sm:hidden")} value={current.id} disabled={disabled} onChange={(e) => { const s = stages.find((x) => x.id === e.target.value); if (s) onPick(s); }}>
          {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        {outcomes.length > 0 && (
          <div className="flex shrink-0 gap-2 sm:border-l sm:border-line sm:pl-4">
            {outcomes.map((s) => {
              const cur = s.id === current.id;
              return <Button key={s.id} size="md" disabled={disabled} aria-pressed={cur} onClick={() => onPick(s)} className={cn("max-w-32", cur && (s.kind === "won" ? "border-success-fg/30 bg-success-bg text-success-fg" : "border-danger-fg/30 bg-danger-bg text-danger-fg"))}><span className="truncate">{s.name}</span></Button>;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Soft delete of the primary lead (DELETE /leads/:id). The lead, its history and tasks stay; an owner or admin restores it under Leads, Recently removed. */
export function RemoveLeadDialog({ open, onOpenChange, name, workspaceId, contactId, lead, onLead }: { open: boolean; onOpenChange: (o: boolean) => void; name: string; workspaceId: string; contactId: string; lead: ContactLead; onLead: (l: ContactLead | null) => void }) {
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
    toast("Removed from the pipeline. Restore it under Leads, Recently removed.");
    onLead(fresh.ok ? fresh.data.lead : null);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Remove from pipeline?" description={`${name} leaves the pipeline: the stage and value are no longer tracked. The lead, notes, tasks and history stay. You can restore it any time from Leads, Recently removed.`}>
        {error && <Alert tone="error" className="mb-3">{error}</Alert>}
        <DialogActions><DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose><Button variant="danger" loading={busy} onClick={() => void remove()}>Remove</Button></DialogActions>
      </DialogContent>
    </Dialog>
  );
}

/** Owner/admin only: which agents may see (and edit) this lead's value. Everyone else never receives the value from the API. */
export function ValueAccess({ workspaceId, leadId, members }: { workspaceId: string; leadId: string; members: Member[] }) {
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
    <div className="px-4 py-3" role="group" aria-label="Who can see the value">
      <p className="mb-2 text-sm text-fg-subtle">Owners and admins always can. Agents only when you allow it here, for this lead.</p>
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
