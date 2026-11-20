"use client";
import * as React from "react";
import { Archive, ArrowDown, ArrowUp, Check, Kanban, MoreHorizontal, Pencil, Plus, Star, X } from "lucide-react";
import { endpoints, type LostReasonDto, type PipelineDto, type PipelineList, type StageDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogContent, DialogActions, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/overlays";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { CURRENCIES } from "@/lib/leads";
import { useWorkspacePrefs } from "@/components/shell/workspace-prefs";
import { cn } from "@/lib/cn";

type Props = { workspaceId: string; canManage: boolean; initial: PipelineList | null };

export function PipelineSettings(p: Props) {
  return <ToastProvider><Inner {...p} /></ToastProvider>;
}

function Inner({ workspaceId, canManage, initial }: Props) {
  const toast = useToast();
  const [data, setData] = React.useState<PipelineList | null>(initial);
  const [announce, setAnnounce] = React.useState("");
  const [newOpen, setNewOpen] = React.useState(false);
  const [showArchived, setShowArchived] = React.useState(false);
  const w = { workspaceId };

  const reload = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.listPipelines, { params: w });
    if (r.ok) setData(r.data);
    return r.ok;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);
  /** Runs a mutation, then re-reads the truth. Errors become toasts; the caller never sees a half-applied state. */
  async function run<T>(call: () => Promise<{ ok: true; data: T } | { ok: false; error: Parameters<typeof errorMessage>[0] }>, ok: string): Promise<boolean> {
    const r = await call();
    if (!r.ok) { toast(errorMessage(r.error), "error"); await reload(); return false; }
    toast(ok); setAnnounce(ok);
    await reload();
    return true;
  }

  if (!data) return <ErrorState description="Pipelines could not be loaded." onRetry={() => void reload()} />;
  const live = data.pipelines.filter((x) => !x.archived);
  const archived = data.pipelines.filter((x) => x.archived);

  return (
    <div className="flex flex-col gap-4">
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      {!canManage && <Alert tone="info">Only owners and admins can change pipelines. You can see how they are set up.</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm text-fg-muted">Where a lead is in your sales process. The order here is the order on the board.</p>
        {canManage && <Button variant="primary" onClick={() => setNewOpen(true)}><Plus className="size-4" aria-hidden />New pipeline</Button>}
      </div>
      {live.length === 0 && <Panel><EmptyState icon={Kanban} title="No pipelines yet" description="Create a pipeline to start tracking leads." action={canManage ? <Button variant="primary" onClick={() => setNewOpen(true)}>New pipeline</Button> : undefined} /></Panel>}
      {live.map((pl) => <PipelineCard key={pl.id} pl={pl} canManage={canManage} w={w} run={run} setData={setData} />)}
      {archived.length > 0 && (
        <div>
          <Button variant="ghost" aria-expanded={showArchived} onClick={() => setShowArchived((s) => !s)}>{showArchived ? "Hide" : "Show"} archived pipelines ({archived.length})</Button>
          {showArchived && <div className="mt-2 flex flex-col gap-2">{archived.map((pl) => <Panel key={pl.id} className="flex items-center justify-between p-3 opacity-70"><span className="font-medium">{pl.name}</span><Badge>Archived</Badge></Panel>)}</div>}
        </div>
      )}
      <LostReasons reasons={data.lostReasons} canManage={canManage} w={w} run={run} />
      <NewPipeline open={newOpen} onOpenChange={setNewOpen} w={w} run={run} />
    </div>
  );
}

/** Quiet overflow menu: an always-visible small icon button (so it is reachable by keyboard and touch). */
function Menu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" icon size="sm" aria-label={label}><MoreHorizontal className="size-4" aria-hidden /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

type Run = <T>(call: () => Promise<{ ok: true; data: T } | { ok: false; error: Parameters<typeof errorMessage>[0] }>, ok: string) => Promise<boolean>;

function PipelineCard({ pl, canManage, w, run, setData }: { pl: PipelineDto; canManage: boolean; w: { workspaceId: string }; run: Run; setData: React.Dispatch<React.SetStateAction<PipelineList | null>> }) {
  const toast = useToast();
  const [name, setName] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [archiveStage, setArchiveStage] = React.useState<StageDto | null>(null);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const open = pl.stages.filter((s) => s.kind === "open" && !s.archived);
  const terminal = pl.stages.filter((s) => s.kind !== "open");
  const archivedStages = pl.stages.filter((s) => s.kind === "open" && s.archived);
  const pp = { ...w, pipelineId: pl.id };

  async function reorder(i: number, dir: -1 | 1) {
    const ids = open.map((s) => s.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    const before = pl;
    // optimistic: show the new order at once; rolled back if the server refuses
    setData((d) => d && { ...d, pipelines: d.pipelines.map((x) => x.id === pl.id ? { ...x, stages: [...ids.map((id, k) => ({ ...x.stages.find((s) => s.id === id)!, position: k })), ...x.stages.filter((s) => !ids.includes(s.id))] } : x) });
    const r = await browserApi.call(endpoints.reorderPipelineStages, { params: pp, body: { stageIds: ids } });
    if (!r.ok) { setData((d) => d && { ...d, pipelines: d.pipelines.map((x) => (x.id === pl.id ? before : x)) }); toast(errorMessage(r.error), "error"); return; }
    setData((d) => d && { ...d, pipelines: d.pipelines.map((x) => (x.id === pl.id ? r.data : x)) });
    toast("Stage order saved.");
  }

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-card px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {name === null ? <h3 className="truncate text-base font-semibold">{pl.name}</h3> : (
            <form className="flex items-center gap-1" onSubmit={async (e) => { e.preventDefault(); if (name.trim() && name.trim() !== pl.name && await run(() => browserApi.call(endpoints.updatePipeline, { params: pp, body: { name: name.trim(), expectedVersion: pl.version } }), "Pipeline renamed.")) setName(null); else if (name.trim() === pl.name) setName(null); }}>
              <Input aria-label="Pipeline name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus onKeyDown={(e) => e.key === "Escape" && setName(null)} />
              <Button type="submit" icon aria-label="Save name"><Check className="size-4" aria-hidden /></Button>
              <Button type="button" icon variant="ghost" aria-label="Cancel renaming" onClick={() => setName(null)}><X className="size-4" aria-hidden /></Button>
            </form>
          )}
          <Badge tone={pl.kind === "sales" ? "accent" : "neutral"}>{pl.kind === "sales" ? "Sales" : "Qualification"}</Badge>
          {pl.isDefault && <Badge tone="success"><Star className="size-3" aria-hidden />Default</Badge>}
          <span className="text-xs text-fg-subtle">{pl.defaultCurrency}</span>
        </div>
        {canManage && name === null && (
          <div className="flex items-center gap-1">
            <Menu label={`Actions for pipeline ${pl.name}`}>
              <DropdownMenuItem aria-label={`Rename pipeline ${pl.name}`} onSelect={() => setName(pl.name)}><Pencil aria-hidden />Rename</DropdownMenuItem>
              {!pl.isDefault && <DropdownMenuItem onSelect={() => void run(() => browserApi.call(endpoints.updatePipeline, { params: pp, body: { isDefault: true, expectedVersion: pl.version } }), `${pl.name} is now the default.`)}><Star aria-hidden />Make default</DropdownMenuItem>}
              {!pl.isDefault && <DropdownMenuItem danger aria-label={`Archive pipeline ${pl.name}`} onSelect={() => setArchiveOpen(true)}><Archive aria-hidden />Archive</DropdownMenuItem>}
            </Menu>
          </div>
        )}
      </div>
      <ol aria-label={`${pl.name} stages`} className="divide-y divide-line-card">
        {open.map((s, i) => (
          <StageRow key={s.id} s={s} canManage={canManage} first={i === 0} last={i === open.length - 1} onUp={() => void reorder(i, -1)} onDown={() => void reorder(i, 1)}
            onSave={(patch) => run(() => browserApi.call(endpoints.updatePipelineStage, { params: { ...w, stageId: s.id }, body: patch }), "Stage updated.")} onArchive={() => setArchiveStage(s)} canArchive={open.length > 1} />
        ))}
        {terminal.map((s) => (
          <StageRow key={s.id} s={s} canManage={canManage} first last fixed onUp={() => {}} onDown={() => {}} onSave={(patch) => run(() => browserApi.call(endpoints.updatePipelineStage, { params: { ...w, stageId: s.id }, body: patch }), "Stage updated.")} onArchive={() => {}} canArchive={false} />
        ))}
        {archivedStages.map((s) => <li key={s.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-base text-fg-muted opacity-70"><span className="min-w-0 truncate">{s.name}</span><Badge>Archived</Badge></li>)}
      </ol>
      <p className="border-t border-line-card px-4 py-2 text-sm text-fg-subtle">Won and Lost always stay at the end. You can rename them, but not move or archive them.</p>
      {canManage && (
        <div className="border-t border-line-card p-3">
          {adding ? <AddStage onCancel={() => setAdding(false)} onAdd={async (n, pr) => { const ok = await run(() => browserApi.call(endpoints.createPipelineStage, { params: pp, body: { name: n, defaultProbability: pr } }), "Stage added."); if (ok) setAdding(false); return ok; }} />
            : <Button variant="primary" onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden />Add stage</Button>}
        </div>
      )}
      <Dialog open={archiveStage !== null} onOpenChange={(o) => !o && setArchiveStage(null)}>
        <DialogContent title={`Archive “${archiveStage?.name ?? ""}”?`} description="Its leads move to the stage you choose.">
          {archiveStage && <ArchiveStageForm stage={archiveStage} options={open.filter((s) => s.id !== archiveStage.id)} onCancel={() => setArchiveStage(null)} onConfirm={async (to) => { const ok = await run(() => browserApi.call(endpoints.archivePipelineStage, { params: { ...w, stageId: archiveStage.id }, body: { moveToStageId: to } }), "Stage archived."); if (ok) setArchiveStage(null); }} />}
        </DialogContent>
      </Dialog>
      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent title={`Archive “${pl.name}”?`} description="Archived pipelines take no new leads. Close open leads first.">
          <DialogActions><Button onClick={() => setArchiveOpen(false)}>Cancel</Button><Button variant="danger" onClick={async () => { await run(() => browserApi.call(endpoints.archivePipeline, { params: pp, body: { expectedVersion: pl.version } }), "Pipeline archived."); setArchiveOpen(false); }}>Archive</Button></DialogActions>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

function StageRow({ s, canManage, first, last, fixed, onUp, onDown, onSave, onArchive, canArchive }: { s: StageDto; canManage: boolean; first: boolean; last: boolean; fixed?: boolean; onUp: () => void; onDown: () => void; onSave: (p: { name?: string; defaultProbability?: number }) => Promise<boolean>; onArchive: () => void; canArchive: boolean }) {
  const [edit, setEdit] = React.useState(false);
  const [name, setName] = React.useState(s.name);
  const [prob, setProb] = React.useState(String(s.defaultProbability));
  async function save() {
    const patch: { name?: string; defaultProbability?: number } = {};
    if (name.trim() && name.trim() !== s.name) patch.name = name.trim();
    if (!fixed && Number(prob) !== s.defaultProbability) patch.defaultProbability = Number(prob);
    if (!Object.keys(patch).length || (await onSave(patch))) setEdit(false);
  }
  return (
    <li className="flex items-center gap-2 px-4 py-2.5">
      {edit ? (
        <form className="flex flex-1 flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <Input aria-label={`Name of stage ${s.name}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus className="min-w-0 flex-1 basis-40" onKeyDown={(e) => e.key === "Escape" && setEdit(false)} />
          {!fixed && <Input aria-label="Default probability (%)" inputMode="numeric" value={prob} onChange={(e) => setProb(e.target.value)} className="w-20" />}
          <Button type="submit" icon aria-label="Save stage"><Check className="size-4" aria-hidden /></Button>
          <Button type="button" icon variant="ghost" aria-label="Cancel editing" onClick={() => { setEdit(false); setName(s.name); setProb(String(s.defaultProbability)); }}><X className="size-4" aria-hidden /></Button>
        </form>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-base font-medium">{s.name}{fixed && <span className="ml-2 text-sm font-normal text-fg-subtle">{s.kind === "won" ? "Won" : "Lost"}</span>}</span>
          <span className="text-sm tabular-nums text-fg-muted">{s.kind === "open" ? `${s.defaultProbability}%` : s.kind === "won" ? "100%" : "0%"}</span>
          {canManage && (
            <span className="flex items-center">
              {!fixed && <><Button variant="ghost" icon size="sm" aria-label={`Move ${s.name} up`} disabled={first} onClick={onUp}><ArrowUp className="size-4" aria-hidden /></Button>
                <Button variant="ghost" icon size="sm" aria-label={`Move ${s.name} down`} disabled={last} onClick={onDown}><ArrowDown className="size-4" aria-hidden /></Button></>}
              <Menu label={`Actions for ${s.name}`}>
                <DropdownMenuItem aria-label={`Edit ${s.name}`} onSelect={() => setEdit(true)}><Pencil aria-hidden />{fixed ? "Rename" : "Rename or edit"}</DropdownMenuItem>
                {!fixed && <DropdownMenuItem danger aria-label={`Archive ${s.name}`} disabled={!canArchive} onSelect={onArchive}><Archive aria-hidden />Archive</DropdownMenuItem>}
              </Menu>
            </span>
          )}
        </>
      )}
    </li>
  );
}

function AddStage({ onAdd, onCancel }: { onAdd: (name: string, p: number) => Promise<boolean>; onCancel: () => void }) {
  const [name, setName] = React.useState("");
  const [prob, setProb] = React.useState("50");
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); const n = Number(prob); if (!name.trim()) return setErr("Name the stage."); if (!Number.isInteger(n) || n < 1 || n > 99) return setErr("Probability is a whole number from 1 to 99."); setErr(null); await onAdd(name.trim(), n); }} noValidate>
      <Field label="Stage name" error={err} className="min-w-0 flex-1 basis-48">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />}</Field>
      <Field label="Probability %" className="w-28">{(p) => <Input {...p} inputMode="numeric" value={prob} onChange={(e) => setProb(e.target.value)} />}</Field>
      <Button type="submit" variant="primary">Add</Button><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
    </form>
  );
}

function ArchiveStageForm({ stage, options, onCancel, onConfirm }: { stage: StageDto; options: StageDto[]; onCancel: () => void; onConfirm: (to: string) => Promise<void> }) {
  const [to, setTo] = React.useState(options[0]?.id ?? "");
  const [busy, setBusy] = React.useState(false);
  return (
    <form className="flex flex-col gap-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await onConfirm(to); setBusy(false); }}>
      <Field label={`Move leads from “${stage.name}” to`}>{(p) => <Select {...p} value={to} onChange={(e) => setTo(e.target.value)}>{options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
      <DialogActions><Button type="button" onClick={onCancel}>Cancel</Button><Button type="submit" variant="danger" disabled={!to || busy}>Archive stage</Button></DialogActions>
    </form>
  );
}

function NewPipeline({ open, onOpenChange, w, run }: { open: boolean; onOpenChange: (o: boolean) => void; w: { workspaceId: string }; run: Run }) {
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<"lead" | "sales">("sales");
  const [currency, setCurrency] = React.useState(useWorkspacePrefs().currency);
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New pipeline" description="Starts with a few stages plus Won and Lost.">
        <form className="flex flex-col gap-4" noValidate onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return setErr("Name the pipeline."); setErr(null); if (await run(() => browserApi.call(endpoints.createPipeline, { params: w, body: { name: name.trim(), kind, defaultCurrency: currency } }), "Pipeline created.")) { setName(""); onOpenChange(false); } }}>
          <Field label="Name" error={err}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />}</Field>
          <Field label="Type" hint="Describes what the stages are for. Everything in it is still called a lead.">{(p) => <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as "lead" | "sales")}><option value="sales">Sales</option><option value="lead">Lead qualification</option></Select>}</Field>
          <Field label="Default currency">{(p) => <Select {...p} value={currency} onChange={(e) => setCurrency(e.target.value)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>}</Field>
          <DialogActions><Button type="button" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" variant="primary">Create pipeline</Button></DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LostReasons({ reasons, canManage, w, run }: { reasons: LostReasonDto[]; canManage: boolean; w: { workspaceId: string }; run: Run }) {
  const [name, setName] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  return (
    <Panel>
      <PanelHeader title="Lost reasons" description="Asked when a lead is marked lost." />
      <ul aria-label="Lost reasons" className="divide-y divide-line-card">
        {reasons.map((r) => (
          <li key={r.id} className={cn("flex items-center justify-between gap-2 px-4 py-2.5", r.archived && "opacity-70")}>
            <span className={cn("min-w-0 truncate", r.archived && "text-fg-muted")}>{r.name}</span>
            <span className="flex items-center gap-2">
              {r.archived && <Badge>Archived</Badge>}
              {canManage && <Menu label={`Actions for ${r.name}`}>
                <DropdownMenuItem onSelect={() => void run(() => browserApi.call(endpoints.updateLostReason, { params: { ...w, lostReasonId: r.id }, body: { archived: !r.archived } }), r.archived ? "Reason restored." : "Reason archived.")}>{r.archived ? "Restore" : "Archive"}</DropdownMenuItem>
              </Menu>}
            </span>
          </li>
        ))}
      </ul>
      {canManage && (
        <div className="border-t border-line-card p-3">
          {adding ? (
            <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (name.trim() && await run(() => browserApi.call(endpoints.createLostReason, { params: w, body: { name: name.trim() } }), "Reason added.")) { setName(""); setAdding(false); } }}>
              <Field label="New reason" className="min-w-0 flex-1 basis-48">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus onKeyDown={(e) => e.key === "Escape" && setAdding(false)} />}</Field>
              <Button type="submit" variant="primary" disabled={!name.trim()}>Add</Button><Button type="button" variant="ghost" onClick={() => { setAdding(false); setName(""); }}>Cancel</Button>
            </form>
          ) : <Button variant="primary" onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden />Add a reason</Button>}
        </div>
      )}
    </Panel>
  );
}
