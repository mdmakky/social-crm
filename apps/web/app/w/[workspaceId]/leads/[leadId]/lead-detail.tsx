"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Lock, MoreHorizontal, Pencil, RotateCcw, Trash2, Trophy, XCircle } from "lucide-react";
import { endpoints, type LeadDto, type Member, type PipelineDto } from "@crm/contracts";
import type { ApiError } from "@crm/api-client";
import { type Role } from "@crm/core/permissions";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Textarea } from "@/components/ui/form-controls";
import { Dialog, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Tooltip, DialogActions } from "@/components/ui/overlays";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Alert } from "@/components/ui/states";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDate, formatDateTime } from "@/lib/format";
import { CURRENCIES, formatMoney, fromMinor, noun, OUTCOME_LABEL, OUTCOME_TONE, PRIORITY_LABEL, toMinor } from "@/lib/leads";
import { cn } from "@/lib/cn";
import { LeadTasks } from "./lead-tasks";

type Activity = { id: string; kind: string; actor: { id: string; name: string } | null; data: Record<string, unknown>; occurredAt: string };
type Transition = { id: string; fromStageId: string | null; toStageId: string; toOutcome: "open" | "won" | "lost"; actor: { id: string; name: string } | null; lostReasonId: string | null; occurredAt: string };
type Grant = { userId: string; name: string; canEdit: boolean };
type Props = {
  workspaceId: string; timeZone: string; role: Role; myUserId: string; initial: LeadDto; pipelines: PipelineDto[]; lostReasons: { id: string; name: string; archived: boolean }[];
  activities: Activity[]; transitions: Transition[]; members: Member[]; grants: Grant[] | null; canEdit: boolean; canDelete: boolean; canReopen: boolean;
};

const KIND_TEXT: Record<string, string> = {
  "lead.created": "created this", "lead.updated": "updated details", "lead.stage_changed": "moved the stage", "lead.won": "marked it won", "lead.lost": "marked it lost",
  "lead.reopened": "reopened it", "lead.deleted": "deleted it", "lead.restored": "restored it",
};

export function LeadDetail(props: Props) {
  return <ToastProvider><Inner {...props} /></ToastProvider>;
}

function Inner({ workspaceId, timeZone, role, myUserId, initial, pipelines, lostReasons, activities: act0, transitions: tr0, members, grants: grants0, canEdit, canDelete, canReopen }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [lead, setLead] = React.useState(initial);
  const [activities, setActivities] = React.useState(act0);
  const [transitions, setTransitions] = React.useState(tr0);
  const [grants, setGrants] = React.useState(grants0);
  const [pending, setPending] = React.useState<string | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);
  const [lostFor, setLostFor] = React.useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [announce, setAnnounce] = React.useState("");

  const pipeline = pipelines.find((p) => p.id === lead.pipelineId);
  const label = noun(pipeline?.kind);
  const stages = pipeline?.stages.filter((s) => !s.archived) ?? [];
  const stage = pipeline?.stages.find((s) => s.id === lead.stageId);
  const closed = lead.outcome !== "open";
  const deleted = !!lead.deletedAt;
  const readOnly = !canEdit || deleted || lead.primaryContact.deleted;
  const stageById = (id: string | null) => pipelines.flatMap((p) => p.stages).find((s) => s.id === id)?.name ?? "a removed stage";
  const reasonName = (id: string | null) => lostReasons.find((r) => r.id === id)?.name;

  async function refresh() {
    const lp = { workspaceId, leadId: lead.id };
    const [l, a, t] = await Promise.all([browserApi.call(endpoints.getLead, { params: lp }), browserApi.call(endpoints.listLeadActivities, { params: lp }), browserApi.call(endpoints.listLeadTransitions, { params: lp })]);
    if (l.ok) setLead(l.data);
    if (a.ok) setActivities(a.data.items);
    if (t.ok) setTransitions(t.data.items);
  }
  const fail = async (e: ApiError) => {
    toast(e.kind === "http" && e.code === "version_conflict" ? "Someone else changed this. It was reloaded; try again." : errorMessage(e), "error");
    if (e.kind === "http" && e.code === "version_conflict") await refresh();
  };

  async function moveTo(stageId: string, lostReasonId?: string) {
    const target = pipeline?.stages.find((s) => s.id === stageId);
    if (!target || stageId === lead.stageId || pending) return;
    const before = lead;
    setPending(stageId);
    setLead({ ...lead, stageId, outcome: target.kind, ...(target.kind === "won" ? { probability: 100 } : target.kind === "lost" ? { probability: 0 } : {}) }); // optimistic; rolled back on failure
    const r = await browserApi.call(endpoints.moveLead, { params: { workspaceId, leadId: lead.id }, body: { expectedVersion: before.version, stageId, ...(lostReasonId ? { lostReasonId } : {}) } });
    setPending(null);
    if (!r.ok) { setLead(before); await fail(r.error); return; }
    setLead(r.data);
    setAnnounce(`Moved to ${target.name}`);
    toast(target.kind === "won" ? "Marked as won." : target.kind === "lost" ? "Marked as lost." : `Moved to ${target.name}.`);
    await refresh();
  }

  async function remove() {
    const r = await browserApi.call(endpoints.deleteLead, { params: { workspaceId, leadId: lead.id }, query: { expectedVersion: lead.version } });
    if (!r.ok) { await fail(r.error); return; }
    toast(`${label} deleted.`);
    router.push(`/w/${workspaceId}/leads`);
  }
  async function restore() {
    const r = await browserApi.call(endpoints.restoreLead, { params: { workspaceId, leadId: lead.id }, body: { expectedVersion: lead.version } });
    if (!r.ok) { await fail(r.error); return; }
    setLead(r.data); toast(`${label} restored.`); await refresh();
  }
  async function resetProbability() {
    const r = await browserApi.call(endpoints.updateLead, { params: { workspaceId, leadId: lead.id }, body: { expectedVersion: lead.version, resetProbability: true } });
    if (!r.ok) { await fail(r.error); return; }
    setLead(r.data); toast("Probability reset to the stage default."); await refresh();
  }

  const timeline = activities;
  return (
    <>
      <div className="mb-4"><Link href={`/w/${workspaceId}/leads`} className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-4" aria-hidden />Leads</Link></div>

      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="break-words text-xl font-semibold tracking-title text-fg">{lead.title}</h1>
            <Badge tone={OUTCOME_TONE[lead.outcome]}>{OUTCOME_LABEL[lead.outcome]}</Badge>
            {deleted && <Badge tone="danger">Deleted</Badge>}
          </div>
          <p className="mt-1 text-sm text-fg-muted">
            {label} in {pipeline?.name ?? "pipeline"} · <Link className="text-accent-fg underline underline-offset-2" href={`/w/${workspaceId}/contacts/${lead.primaryContact.id}`}>{lead.primaryContact.name}</Link>{lead.primaryContact.deleted && " (deleted contact)"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {deleted && canDelete && <Button onClick={() => void restore()}><RotateCcw className="size-4" aria-hidden />Restore</Button>}
          {!readOnly && <Button onClick={() => setEditOpen(true)}><Pencil className="size-4" aria-hidden />Edit</Button>}
          {canDelete && !deleted && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="secondary" icon aria-label="More actions"><MoreHorizontal className="size-4" aria-hidden /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end"><DropdownMenuItem danger onSelect={() => setDeleteOpen(true)}><Trash2 className="size-4" aria-hidden />Delete {label.toLowerCase()}</DropdownMenuItem></DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      {lead.primaryContact.deleted && <Alert tone="warning" className="mb-4">The primary contact was deleted, so this {label.toLowerCase()} is read-only history.</Alert>}

      {/* Stage track: every open stage is a button; Won and Lost close the lead. Closed leads can only be reopened by admins. */}
      <Panel className="mb-4 p-3">
        <nav aria-label="Stage" className="flex flex-wrap items-center gap-1.5">
          {stages.filter((s) => s.kind === "open").map((s) => {
            const here = s.id === lead.stageId;
            const locked = readOnly || (closed && !canReopen);
            return (
              <button key={s.id} type="button" disabled={locked || pending !== null} aria-current={here ? "step" : undefined} onClick={() => void moveTo(s.id)}
                className={cn("rounded-control border px-3 py-1.5 text-sm font-medium transition-colors duration-150 pointer-coarse:min-h-11", here ? "border-accent bg-accent-subtle text-accent-fg" : "border-line bg-surface text-fg-muted hover:bg-hover hover:text-fg", pending === s.id && "animate-pulse", "disabled:cursor-not-allowed disabled:opacity-60")}>
                {s.name}<span className="ml-1.5 text-xs text-fg-subtle tabular-nums">{s.defaultProbability}%</span>
              </button>
            );
          })}
          <span className="mx-1 hidden h-5 w-px bg-line sm:block" aria-hidden />
          {stages.filter((s) => s.kind === "won").map((s) => (
            <Button key={s.id} variant={lead.outcome === "won" ? "primary" : "secondary"} disabled={readOnly || pending !== null || (closed && !canReopen) || lead.stageId === s.id} onClick={() => void moveTo(s.id)}><Trophy className="size-4" aria-hidden />{s.name}</Button>
          ))}
          {stages.filter((s) => s.kind === "lost").map((s) => (
            <Button key={s.id} disabled={readOnly || pending !== null || (closed && !canReopen) || lead.stageId === s.id} onClick={() => setLostFor(s.id)}><XCircle className="size-4" aria-hidden />{s.name}</Button>
          ))}
        </nav>
        {closed && !canReopen && canEdit && <p className="mt-2 text-xs text-fg-subtle">Only an owner or admin can reopen a closed {label.toLowerCase()}.</p>}
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Panel>
            <PanelHeader title="Details" />
            <dl className="grid grid-cols-1 gap-x-6 gap-y-4 p-4 sm:grid-cols-2">
              <Row label="Value">
                {lead.valueHidden ? <Tooltip label="Lead value is restricted. Ask an owner or admin for access." side="top"><span className="inline-flex items-center gap-1.5 text-fg-subtle"><Lock className="size-3.5" aria-hidden />Restricted</span></Tooltip>
                  : lead.valueMinor !== null && lead.currency ? <span className="text-base font-semibold tabular-nums">{formatMoney(lead.valueMinor, lead.currency)}</span> : <span className="text-fg-subtle">Not set</span>}
              </Row>
              <Row label="Probability">
                <span className="tabular-nums">{lead.probability}%</span>
                {lead.probabilityManual && <><Badge className="ml-2">Manual</Badge>{!readOnly && !closed && <button type="button" className="ml-2 text-sm text-accent-fg hover:underline" onClick={() => void resetProbability()}>Reset to {stage?.defaultProbability}%</button>}</>}
              </Row>
              <Row label="Expected close">{lead.expectedCloseDate ? formatDate(`${lead.expectedCloseDate}T12:00:00Z`, "UTC") : <span className="text-fg-subtle">Not set</span>}</Row>
              <Row label="Priority">{PRIORITY_LABEL[lead.priority]}</Row>
              <Row label="Owner">{lead.owner ? <span className="inline-flex items-center gap-2"><Avatar name={lead.owner.name} />{lead.owner.name}</span> : <span className="text-fg-subtle">Unassigned</span>}</Row>
              <Row label="Source"><span className="capitalize">{lead.source}</span></Row>
              <Row label="Stage">{stage?.name ?? "—"}</Row>
              <Row label="Next activity">{lead.nextActivityAt ? <time dateTime={lead.nextActivityAt}>{formatDateTime(lead.nextActivityAt, timeZone)}</time> : <span className="text-fg-subtle">None scheduled</span>}</Row>
              <Row label="Closed">{lead.closedAt ? <>{formatDateTime(lead.closedAt, timeZone)}{lead.outcome === "lost" && reasonName(lead.lostReasonId) ? ` · ${reasonName(lead.lostReasonId)}` : ""}</> : <span className="text-fg-subtle">Open</span>}</Row>
            </dl>
            {lead.description && <div className="border-t border-line p-4"><h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-subtle">Description</h3><p className="whitespace-pre-wrap break-words text-base text-fg">{lead.description}</p></div>}
          </Panel>

          <LeadTasks workspaceId={workspaceId} lead={lead} members={members} myUserId={myUserId} timeZone={timeZone} canEdit={!readOnly} onChanged={refresh} />

          <Panel>
            <PanelHeader title="Timeline" description="Everything that happened to this record." />
            {timeline.length === 0 ? <p className="p-4 text-sm text-fg-muted">No activity yet.</p> : (
              <ol className="relative p-4">
                {timeline.map((a, i) => (
                  <li key={a.id} className="relative flex gap-3 pb-4 last:pb-0">
                    {i < timeline.length - 1 && <span className="absolute left-[5px] top-3 h-full w-px bg-line" aria-hidden />}
                    <span className="relative mt-1.5 size-[11px] shrink-0 rounded-full border-2 border-accent bg-surface" aria-hidden />
                    <div className="min-w-0 text-base">
                      <p><span className="font-medium">{a.actor?.name ?? "System"}</span> {KIND_TEXT[a.kind] ?? a.kind}{a.kind === "lead.stage_changed" || a.kind === "lead.won" || a.kind === "lead.lost" || a.kind === "lead.reopened" ? <span className="text-fg-muted"> to {stageById(String(a.data.toStageId ?? ""))}</span> : null}
                        {a.kind === "lead.updated" && Array.isArray(a.data.fields) ? <span className="text-fg-muted"> ({(a.data.fields as string[]).join(", ")})</span> : null}</p>
                      <p className="text-xs text-fg-subtle"><time dateTime={a.occurredAt}>{formatDateTime(a.occurredAt, timeZone)}</time></p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>

        <div className="flex flex-col gap-4">
          <Panel>
            <PanelHeader title="Stage history" description="Immutable record of every move." />
            <ol className="p-4 text-sm" aria-label="Stage history">
              {transitions.map((t) => (
                <li key={t.id} className="flex items-baseline justify-between gap-2 border-b border-line py-2 first:pt-0 last:border-b-0 last:pb-0">
                  <span className="min-w-0"><span className="text-fg-muted">{t.fromStageId ? `${stageById(t.fromStageId)} → ` : "Started in "}</span><span className="font-medium">{stageById(t.toStageId)}</span>{t.lostReasonId && <span className="block text-xs text-fg-subtle">{reasonName(t.lostReasonId)}</span>}</span>
                  <time className="shrink-0 text-xs text-fg-subtle" dateTime={t.occurredAt}>{formatDateTime(t.occurredAt, timeZone)}</time>
                </li>
              ))}
            </ol>
          </Panel>
          {grants && <ValueAccess workspaceId={workspaceId} leadId={lead.id} grants={grants} setGrants={setGrants} members={members} myRole={role} />}
        </div>
      </div>

      {editOpen && <EditDialog key={lead.version} open onOpenChange={setEditOpen} lead={lead} members={members} role={role} myUserId={myUserId} workspaceId={workspaceId} onSaved={async (l) => { setLead(l); toast("Saved."); await refresh(); }} onError={fail} />}
      <Dialog open={lostFor !== null} onOpenChange={(o) => !o && setLostFor(null)}>
        <DialogContent title="Mark as lost" description="Choose the reason. It is kept in the history.">
          <LostForm reasons={lostReasons.filter((r) => !r.archived)} onCancel={() => setLostFor(null)} onSubmit={(reasonId) => { const s = lostFor!; setLostFor(null); void moveTo(s, reasonId); }} />
        </DialogContent>
      </Dialog>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent title={`Delete this ${label.toLowerCase()}?`} description="It disappears from lists and the board. An owner or admin can restore it.">
          <DialogActions><Button onClick={() => setDeleteOpen(false)}>Cancel</Button><Button variant="danger" onClick={() => void remove()}>Delete</Button></DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div><dt className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{label}</dt><dd className="mt-0.5 text-base text-fg">{children}</dd></div>
);

function LostForm({ reasons, onCancel, onSubmit }: { reasons: { id: string; name: string }[]; onCancel: () => void; onSubmit: (id: string) => void }) {
  const [id, setId] = React.useState(reasons[0]?.id ?? "");
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (id) onSubmit(id); }}>
      <Field label="Reason">{(p) => <Select {...p} value={id} onChange={(e) => setId(e.target.value)}>{reasons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}</Field>
      {reasons.length === 0 && <Alert tone="warning">No lost reasons are available. An admin can add some in Settings → Pipelines.</Alert>}
      <DialogActions><Button type="button" onClick={onCancel}>Cancel</Button><Button type="submit" variant="primary" disabled={!id}>Mark as lost</Button></DialogActions>
    </form>
  );
}

function EditDialog({ open, onOpenChange, lead, members, role, myUserId, workspaceId, onSaved, onError }: { open: boolean; onOpenChange: (o: boolean) => void; lead: LeadDto; members: Member[]; role: Role; myUserId: string; workspaceId: string; onSaved: (l: LeadDto) => Promise<void>; onError: (e: ApiError) => Promise<void> }) {
  const [title, setTitle] = React.useState(lead.title);
  const [description, setDescription] = React.useState(lead.description ?? "");
  const [currency, setCurrency] = React.useState(lead.currency ?? "USD");
  const [value, setValue] = React.useState(lead.valueMinor !== null && lead.currency ? fromMinor(lead.valueMinor, lead.currency) : "");
  const [close, setClose] = React.useState(lead.expectedCloseDate ?? "");
  const [probability, setProbability] = React.useState(String(lead.probability));
  const [priority, setPriority] = React.useState(lead.priority);
  const [owner, setOwner] = React.useState(lead.owner?.id ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const closed = lead.outcome !== "open";
  const ownerChoices = role === "agent" ? members.filter((m) => m.userId === myUserId) : members;

  async function save() {
    setError(null);
    if (!title.trim()) return setError("Give it a title.");
    const body: Record<string, unknown> = { expectedVersion: lead.version };
    if (title.trim() !== lead.title) body.title = title.trim();
    if ((description.trim() || null) !== lead.description) body.description = description.trim() || null;
    if ((close || null) !== lead.expectedCloseDate) body.expectedCloseDate = close || null;
    if (priority !== lead.priority) body.priority = priority;
    if ((owner || null) !== (lead.owner?.id ?? null)) body.ownerUserId = owner || null;
    if (!closed && Number(probability) !== lead.probability) {
      const n = Number(probability);
      if (!Number.isInteger(n) || n < 1 || n > 99) return setError("Probability is a whole number from 1 to 99.");
      body.probability = n;
    }
    if (lead.canEditValue) {
      const m = value.trim() ? toMinor(value, currency) : null;
      if (value.trim() && m === null) return setError("Enter the value as a number, for example 2500 or 2,500.50.");
      if (m !== lead.valueMinor || (m !== null && currency !== lead.currency)) { body.valueMinor = m; body.currency = m === null ? null : currency; }
    }
    if (Object.keys(body).length === 1) { onOpenChange(false); return; }
    setBusy(true);
    const r = await browserApi.call(endpoints.updateLead, { params: { workspaceId, leadId: lead.id }, body: body as never });
    setBusy(false);
    if (!r.ok) { if (r.error.kind === "http" && r.error.status === 400) return setError(errorMessage(r.error)); onOpenChange(false); await onError(r.error); return; }
    onOpenChange(false);
    await onSaved(r.data);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Edit details">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          <Field label="Title">{(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} autoFocus />}</Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {lead.canEditValue ? (
              <div className="grid grid-cols-[1fr_6rem] gap-2">
                <Field label="Value">{(p) => <Input {...p} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
                <Field label="Currency">{(p) => <Select {...p} value={currency} onChange={(e) => setCurrency(e.target.value)}>{[...new Set([currency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}</Select>}</Field>
              </div>
            ) : <div />}
            <Field label="Expected close date">{(p) => <Input {...p} type="date" value={close} onChange={(e) => setClose(e.target.value)} min="2000-01-01" max="2100-12-31" />}</Field>
            <Field label="Probability (%)" hint={closed ? "Fixed while closed" : lead.probabilityManual ? "Manual" : "Stage default. Editing makes it manual."}>{(p) => <Input {...p} inputMode="numeric" value={probability} disabled={closed} onChange={(e) => setProbability(e.target.value)} />}</Field>
            <Field label="Priority">{(p) => <Select {...p} value={priority} onChange={(e) => setPriority(e.target.value as LeadDto["priority"])}>{Object.entries(PRIORITY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
            <Field label="Owner">{(p) => <Select {...p} value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Unassigned</option>{ownerChoices.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</Select>}</Field>
          </div>
          <Field label="Description">{(p) => <Textarea {...p} rows={4} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />}</Field>
          <DialogActions><Button type="button" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : "Save"}</Button></DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Owner/admin only: who may see (and optionally edit) this record's lead value. Agents and viewers without a grant never receive the value from the API. */
function ValueAccess({ workspaceId, leadId, grants, setGrants, members }: { workspaceId: string; leadId: string; grants: Grant[]; setGrants: (g: Grant[]) => void; members: Member[]; myRole: Role }) {
  const toast = useToast();
  const [pick, setPick] = React.useState("");
  const candidates = members.filter((m) => m.role === "agent" && !grants.some((g) => g.userId === m.userId));
  const lp = { workspaceId, leadId };
  async function setGrant(userId: string, canEdit: boolean) {
    const r = await browserApi.call(endpoints.setLeadValueGrant, { params: { ...lp, userId }, body: { canEdit } });
    if (!r.ok) return toast(errorMessage(r.error), "error");
    const l = await browserApi.call(endpoints.listLeadValueGrants, { params: lp });
    if (l.ok) setGrants(l.data.items);
    setPick("");
    toast("Access updated.");
  }
  async function revoke(userId: string) {
    const r = await browserApi.call(endpoints.removeLeadValueGrant, { params: { ...lp, userId } });
    if (!r.ok) return toast(errorMessage(r.error), "error");
    setGrants(r.data.items);
    toast("Access removed.");
  }
  return (
    <Panel>
      <PanelHeader title="Lead value access" description="Owners and admins always see it. Agents only with access granted here." />
      <div className="flex flex-col gap-3 p-4 text-sm">
        {grants.length === 0 && <p className="text-fg-muted">No agents have access.</p>}
        {grants.map((g) => (
          <div key={g.userId} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">{g.name}</span>
            <span className="flex items-center gap-2">
              <Select aria-label={`Access for ${g.name}`} wrapperClassName="w-auto" value={g.canEdit ? "edit" : "view"} onChange={(e) => void setGrant(g.userId, e.target.value === "edit")}><option value="view">Can view</option><option value="edit">Can edit</option></Select>
              <Button variant="ghost" size="sm" aria-label={`Remove access for ${g.name}`} onClick={() => void revoke(g.userId)}>Remove</Button>
            </span>
          </div>
        ))}
        {candidates.length > 0 && (
          <div className="flex items-center gap-2">
            <Select aria-label="Grant access to" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Add an agent…</option>{candidates.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</Select>
            <Button disabled={!pick} onClick={() => void setGrant(pick, false)}>Grant</Button>
          </div>
        )}
      </div>
    </Panel>
  );
}
