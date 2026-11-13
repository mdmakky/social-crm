"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, DragOverlay, pointerWithin, closestCorners, type CollisionDetection, type DragEndEvent, type DragStartEvent, type Announcements } from "@dnd-kit/core";
import { CalendarDays, GripVertical, Kanban, Lock, MoreHorizontal, Plus, Trophy, XCircle } from "lucide-react";
import { endpoints, type LeadDto, type LostReasonDto, type PipelineDto, type StageDto } from "@crm/contracts";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { Dialog, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/overlays";
import { PageHeader } from "@/components/ui/panel";
import { Alert, EmptyState } from "@/components/ui/states";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { NewLeadDialog } from "@/components/leads/new-lead-dialog";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDate } from "@/lib/format";
import { formatMoney, noun } from "@/lib/leads";
import { cn } from "@/lib/cn";

type Props = { workspaceId: string; pipelines: PipelineDto[]; lostReasons: LostReasonDto[]; current: PipelineDto | null; initialLeads: LeadDto[]; wonLeads: LeadDto[]; lostLeads: LeadDto[]; truncated: boolean; canEdit: boolean; canCreate: boolean; canSetValue: boolean };
const COLUMN_CAP = 50; // cards rendered per column before "Show more" (keeps drag smooth without virtualization)
const byRank = (a: LeadDto, b: LeadDto) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1);

export function PipelineBoard(p: Props) {
  return <ToastProvider><Inner {...p} /></ToastProvider>;
}

const collide: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length ? within : closestCorners(args);
};

function Inner({ workspaceId, pipelines, lostReasons, current, initialLeads, wonLeads, lostLeads, truncated, canEdit, canCreate, canSetValue }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [leads, setLeads] = React.useState(initialLeads);
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [pendingIds, setPendingIds] = React.useState<Set<string>>(new Set());
  const [lostDrop, setLostDrop] = React.useState<{ lead: LeadDto; stage: StageDto; before?: string; after?: string } | null>(null);
  const [newOpen, setNewOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [live, setLive] = React.useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );
  const stages = current?.stages.filter((s) => !s.archived) ?? [];
  const open = stages.filter((s) => s.kind === "open");
  const won = stages.find((s) => s.kind === "won");
  const lost = stages.find((s) => s.kind === "lost");
  const label = noun(current?.kind);
  const cols = new Map(open.map((s) => [s.id, leads.filter((l) => l.stageId === s.id).sort(byRank)]));
  const stageName = (id: string) => stages.find((s) => s.id === id)?.name ?? "stage";

  /** Rank between neighbours for the optimistic position; the server computes the real one and we adopt it from the response. */
  const guessRank = (col: LeadDto[], before?: string, after?: string) => {
    const num = (id?: string) => { const x = col.find((l) => l.id === id); return x ? Number(x.rank) : null; };
    const hi = num(before); const lo = num(after);
    if (hi === null && lo === null) return String((col.length ? Number(col[col.length - 1]!.rank) : 0) + 1_000_000).padStart(12, "0");
    const a = lo ?? 0; const b = hi ?? a + 2_000_000;
    return String(a + Math.floor((b - a) / 2)).padStart(12, "0");
  };

  async function commitMove(lead: LeadDto, to: StageDto, opts: { before?: string; after?: string; lostReasonId?: string }) {
    const snapshot = leads;
    const col = (cols.get(to.id) ?? []).filter((l) => l.id !== lead.id);
    setPendingIds((s) => new Set(s).add(lead.id));
    if (to.kind === "open") setLeads((ls) => ls.map((l) => (l.id === lead.id ? { ...l, stageId: to.id, rank: guessRank(col, opts.before, opts.after) } : l)));
    else setLeads((ls) => ls.filter((l) => l.id !== lead.id)); // closing: the card leaves the open board at once
    const r = await browserApi.call(endpoints.moveLead, { params: { workspaceId, leadId: lead.id }, body: { expectedVersion: lead.version, stageId: to.id, ...(opts.before ? { beforeLeadId: opts.before } : {}), ...(opts.after ? { afterLeadId: opts.after } : {}), ...(opts.lostReasonId ? { lostReasonId: opts.lostReasonId } : {}) } });
    setPendingIds((s) => { const n = new Set(s); n.delete(lead.id); return n; });
    if (!r.ok) {
      setLeads(snapshot); // roll back
      const conflict = r.error.kind === "http" && r.error.code === "version_conflict";
      toast(conflict ? "Someone else changed that card. The board was refreshed." : errorMessage(r.error), "error");
      setLive(`Move failed. ${lead.title} stays in ${stageName(lead.stageId)}.`);
      if (conflict) router.refresh();
      return;
    }
    if (to.kind === "open") setLeads((ls) => ls.map((l) => (l.id === lead.id ? r.data : l)));
    setLive(`${lead.title} moved to ${to.name}.`);
    toast(to.kind === "won" ? `${lead.title} marked as won.` : to.kind === "lost" ? `${lead.title} marked as lost.` : `Moved to ${to.name}.`);
  }

  function request(lead: LeadDto, to: StageDto, pos: { before?: string; after?: string }) {
    if (to.id === lead.stageId && !pos.before && !pos.after) return;
    if (to.kind === "lost") return setLostDrop({ lead, stage: to, ...pos });
    void commitMove(lead, to, pos);
  }

  function onDragEnd(e: DragEndEvent) {
    setDragId(null);
    const lead = leads.find((l) => l.id === e.active.id);
    const stage = stages.find((s) => s.id === e.over?.id);
    if (!lead || !stage || !canEdit) return;
    const rect = e.active.rect.current.translated;
    let before: string | undefined; let after: string | undefined;
    if (stage.kind === "open" && rect) {
      const mid = rect.top + rect.height / 2;
      const cards = Array.from(document.querySelectorAll<HTMLElement>(`[data-column="${stage.id}"] [data-card-id]`)).filter((el) => el.dataset.cardId !== lead.id);
      const next = cards.find((el) => el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2 > mid);
      if (next) before = next.dataset.cardId; else if (cards.length) after = cards[cards.length - 1]!.dataset.cardId;
      const idx = cards.findIndex((el) => el.dataset.cardId === before);
      if (before && idx > 0) after = cards[idx - 1]!.dataset.cardId;
    }
    request(lead, stage, { before, after });
  }

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${leads.find((l) => l.id === active.id)?.title ?? "card"}.`,
    onDragOver: ({ over }) => (over ? `Over ${stageName(String(over.id))}.` : "Not over a stage."),
    onDragEnd: ({ over }) => (over ? `Dropped on ${stageName(String(over.id))}.` : "Drop cancelled."),
    onDragCancel: () => "Move cancelled.",
  };

  if (!current) return (
    <>
      <PageHeader title="Pipeline" />
      <EmptyState icon={Kanban} title="No pipeline yet" description="An owner or admin needs to create a pipeline in Settings before leads can be tracked." />
    </>
  );
  const dragged = leads.find((l) => l.id === dragId) ?? null;
  const total = leads.length;

  return (
    <>
      <PageHeader title="Pipeline" description={`${total} open ${noun(current.kind, true).toLowerCase()} in ${current.name}.`}
        actions={<div className="flex items-center gap-2">
          {pipelines.length > 1 && <Select aria-label="Pipeline" wrapperClassName="w-auto" value={current.id} onChange={(e) => router.push(`/w/${workspaceId}/pipeline?pipeline=${e.target.value}`)}>{pipelines.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
          {canCreate && <Button variant="primary" onClick={() => setNewOpen(true)}><Plus className="size-4" aria-hidden />New {label.toLowerCase()}</Button>}
        </div>} />
      {truncated && <Alert tone="warning" className="mb-3">Showing the first 500 open {noun(current.kind, true).toLowerCase()}. Use the list to see the rest.</Alert>}
      <p className="sr-only" role="status" aria-live="polite">{live}</p>
      {!canEdit && <p className="mb-2 text-sm text-fg-muted">You can view the pipeline but not move cards.</p>}

      <DndContext sensors={sensors} collisionDetection={collide} accessibility={{ announcements }} onDragStart={(e: DragStartEvent) => setDragId(String(e.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setDragId(null)}>
        <div className="-mx-4 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8" role="region" aria-label="Pipeline board" tabIndex={0}>
          <div className="flex min-h-[60vh] gap-3">
            {open.map((s) => {
              const col = cols.get(s.id) ?? [];
              const shown = expanded.has(s.id) ? col : col.slice(0, COLUMN_CAP);
              return (
                <Column key={s.id} stage={s} count={col.length} total={col.reduce((n, l) => (l.valueMinor !== null && l.currency === (current.defaultCurrency) ? n + l.valueMinor : n), 0)} currency={current.defaultCurrency} dragging={dragId !== null}>
                  {shown.map((l) => <Card key={l.id} lead={l} stages={stages} workspaceId={workspaceId} canEdit={canEdit} pending={pendingIds.has(l.id)} onMove={(to) => request(l, to, {})} hidden={dragId === l.id} />)}
                  {col.length > shown.length && <Button variant="ghost" size="sm" onClick={() => setExpanded((x) => new Set(x).add(s.id))}>Show {col.length - shown.length} more</Button>}
                  {col.length === 0 && <p className="px-2 py-6 text-center text-xs text-fg-subtle">{dragId ? "Drop here" : "Nothing here"}</p>}
                </Column>
              );
            })}
            <div className="flex w-56 shrink-0 flex-col gap-3">
              {won && <Terminal stage={won} workspaceId={workspaceId} outcome="won" closed={wonLeads} icon={<Trophy className="size-4" aria-hidden />} dragging={dragId !== null} />}
              {lost && <Terminal stage={lost} workspaceId={workspaceId} outcome="lost" closed={lostLeads} icon={<XCircle className="size-4" aria-hidden />} dragging={dragId !== null} />}
            </div>
          </div>
        </div>
        <DragOverlay dropAnimation={null}>{dragged ? <CardBody lead={dragged} workspaceId={workspaceId} overlay /> : null}</DragOverlay>
      </DndContext>

      <Dialog open={lostDrop !== null} onOpenChange={(o) => !o && setLostDrop(null)}>
        <DialogContent title="Mark as lost" description="Choose the reason. It is kept in the history.">
          {lostDrop && <LostForm reasons={lostReasons} onCancel={() => setLostDrop(null)} onSubmit={(id) => { const d = lostDrop; setLostDrop(null); void commitMove(d.lead, d.stage, { lostReasonId: id }); }} />}
        </DialogContent>
      </Dialog>
      <NewLeadDialog key={String(newOpen)} open={newOpen} onOpenChange={setNewOpen} workspaceId={workspaceId} pipelines={pipelines} canSetValue={canSetValue} />
    </>
  );
}

function Column({ stage, count, total, currency, dragging, children }: { stage: StageDto; count: number; total: number; currency: string; dragging: boolean; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  return (
    <section ref={setNodeRef} data-column={stage.id} aria-label={`${stage.name}, ${count} cards`} className={cn("flex shrink-0 flex-col rounded-card border bg-subtle transition-[width,colors] duration-150", count === 0 && !dragging ? "w-56" : "w-72", isOver ? "border-accent bg-accent-subtle/40" : "border-line-card", dragging && !isOver && "border-dashed")}>
      <header className="flex items-baseline justify-between gap-2 px-3 pb-1 pt-2.5">
        <h2 className="truncate text-sm font-semibold text-fg">{stage.name}</h2>
        <span className="shrink-0 text-xs tabular-nums text-fg-subtle">{count}</span>
      </header>
      <p className="px-3 pb-2 text-xs tabular-nums text-fg-subtle">{total > 0 ? formatMoney(total, currency) : <span aria-hidden>&nbsp;</span>}</p>
      <div className="flex flex-1 flex-col gap-2 px-2 pb-2">{children}</div>
    </section>
  );
}

/** Won and Lost: a drop target plus the leads closed in the last 30 days (newest first). Closed cards are links; reopening is done on the lead. */
function Terminal({ stage, workspaceId, outcome, closed, icon, dragging }: { stage: StageDto; workspaceId: string; outcome: "won" | "lost"; closed: LeadDto[]; icon: React.ReactNode; dragging: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const shown = closed.slice(0, 5);
  return (
    <section ref={setNodeRef} aria-label={`${stage.name}: drop to mark as ${stage.name.toLowerCase()}`} className={cn("flex min-h-24 flex-1 flex-col gap-1.5 rounded-card border-2 border-dashed p-2.5 text-sm transition-colors duration-150", isOver ? "border-accent bg-accent-subtle text-accent-fg" : dragging ? "border-line-control text-fg-muted" : "border-line text-fg-muted")}>
      <h2 className="flex items-center justify-between gap-1.5 font-semibold text-fg"><span className="inline-flex items-center gap-1.5">{icon}{stage.name}</span><span className="text-xs font-normal tabular-nums text-fg-subtle" title="Closed in the last 30 days">{closed.length}</span></h2>
      {dragging ? <p className="py-2 text-center text-xs">Drop to close</p> : shown.length === 0 ? <p className="py-1 text-xs text-fg-subtle">None in the last 30 days. Drag a card here to close it.</p> : (
        <ul className="flex flex-col gap-1">
          {shown.map((l) => <li key={l.id}><Link href={`/w/${workspaceId}/leads/${l.id}`} className="block truncate rounded-control bg-surface px-2 py-1.5 text-xs text-fg hover:bg-hover">{l.title}</Link></li>)}
        </ul>
      )}
      {!dragging && <Link href={`/w/${workspaceId}/leads?status=${outcome}`} className="mt-auto pt-1 text-xs text-accent-fg underline underline-offset-2">View all {stage.name.toLowerCase()}{closed.length > shown.length ? ` (${closed.length} recent)` : ""}</Link>}
    </section>
  );
}

function CardBody({ lead, workspaceId, overlay, handle }: { lead: LeadDto; workspaceId: string; overlay?: boolean; handle?: React.ReactNode }) {
  return (
    <div className={cn("rounded-card border border-line bg-surface p-2.5 text-sm", overlay && "w-72 rotate-1 shadow-popover")}>
      <div className="flex items-start gap-1">
        {handle}
        <Link href={`/w/${workspaceId}/leads/${lead.id}`} className="min-w-0 flex-1 break-words font-medium text-fg hover:text-accent-fg" tabIndex={overlay ? -1 : 0}>{lead.title}</Link>
      </div>
      <p className="mt-0.5 truncate text-xs text-fg-muted">{lead.primaryContact.name}</p>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        {lead.valueHidden ? <span className="inline-flex items-center gap-1 text-fg-subtle"><Lock className="size-3" aria-hidden />Hidden</span>
          : lead.valueMinor !== null && lead.currency ? <span className="font-medium tabular-nums text-fg">{formatMoney(lead.valueMinor, lead.currency)}</span> : <span className="text-fg-subtle">No value</span>}
        <span className="inline-flex items-center gap-2 text-fg-subtle">
          {lead.expectedCloseDate && <span className="inline-flex items-center gap-1"><CalendarDays className="size-3" aria-hidden />{formatDate(`${lead.expectedCloseDate}T12:00:00Z`, "UTC")}</span>}
          {lead.owner && <Avatar name={lead.owner.name} />}
        </span>
      </div>
    </div>
  );
}

function Card({ lead, stages, workspaceId, canEdit, pending, hidden, onMove }: { lead: LeadDto; stages: StageDto[]; workspaceId: string; canEdit: boolean; pending: boolean; hidden: boolean; onMove: (to: StageDto) => void }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: lead.id, disabled: !canEdit });
  const handle = canEdit ? (
    <>
      <button type="button" ref={setNodeRef as never} {...attributes} {...listeners} aria-label={`Move ${lead.title}. Press space to pick up, arrow keys to choose a stage`} className="-ml-1 mt-0.5 shrink-0 cursor-grab touch-none rounded p-0.5 text-fg-subtle hover:bg-hover active:cursor-grabbing"><GripVertical className="size-4" aria-hidden /></button>
    </>
  ) : undefined;
  return (
    <div data-card-id={lead.id} className={cn("relative transition-opacity duration-150", hidden && "opacity-30", pending && "animate-pulse")} aria-busy={pending}>
      <CardBody lead={lead} workspaceId={workspaceId} handle={handle} />
      {canEdit && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" icon size="sm" className="absolute right-1 top-1 opacity-70 hover:opacity-100 focus-visible:opacity-100" aria-label={`Move ${lead.title} to another stage`}><MoreHorizontal className="size-4" aria-hidden /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end"><DropdownMenuLabel>Move to</DropdownMenuLabel>
            {stages.map((s) => <DropdownMenuItem key={s.id} disabled={s.id === lead.stageId} onSelect={() => onMove(s)}>{s.name}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function LostForm({ reasons, onCancel, onSubmit }: { reasons: LostReasonDto[]; onCancel: () => void; onSubmit: (id: string) => void }) {
  const [id, setId] = React.useState(reasons[0]?.id ?? "");
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (id) onSubmit(id); }}>
      <Field label="Reason">{(p) => <Select {...p} value={id} onChange={(e) => setId(e.target.value)}>{reasons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}</Field>
      <div className="flex justify-end gap-2"><Button type="button" onClick={onCancel}>Cancel</Button><Button type="submit" variant="primary" disabled={!id}>Mark as lost</Button></div>
    </form>
  );
}
