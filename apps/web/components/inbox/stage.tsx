"use client";
import * as React from "react";
import { cn } from "@/lib/cn";
import { ChevronDown, Plus } from "lucide-react";
import { endpoints, type LeadDto, type LostReasonDto, type PipelineDto, type StageDto } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, DialogActions } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { useStageValueGate } from "@/components/contacts/stage-value";
import { browserApi, errorMessage } from "@/lib/client-api";

type Phase = "loading" | "ready" | "error";

/** Open stages first in pipeline order, then won, then lost. Archived stages never appear. */
export const orderedStages = (p: PipelineDto): StageDto[] => {
  const rank = { open: 0, won: 1, lost: 2 } as const;
  return p.stages.filter((s) => !s.archived).sort((a, b) => rank[a.kind] - rank[b.kind] || a.position - b.position);
};

/**
 * The contact's current lead and its pipeline, so a conversation can show and change the lead stage.
 * Picks the newest open lead, else the newest lead. Moves are optimistic with rollback and one Undo.
 */
export function useContactLead(workspaceId: string, contactId: string | null, contactName: string) {
  const toast = useToast();
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [lead, setLead] = React.useState<LeadDto | null>(null);
  const [pipelines, setPipelines] = React.useState<PipelineDto[]>([]);
  const [lostReasons, setLostReasons] = React.useState<LostReasonDto[]>([]);
  const [busy, setBusy] = React.useState(false);
  const { gate, dialog: valueDialog } = useStageValueGate(workspaceId);
  const leadRef = React.useRef<LeadDto | null>(null);
  React.useEffect(() => { leadRef.current = lead; }, [lead]);

  React.useEffect(() => {
    if (!contactId) return;
    let live = true;
    void (async () => {
      const [l, p] = await Promise.all([
        browserApi.call(endpoints.listLeads, { params: { workspaceId }, query: { contactId, sort: "updated", dir: "desc", limit: 20 } }),
        browserApi.call(endpoints.listPipelines, { params: { workspaceId } }),
      ]);
      if (!live) return;
      if (!l.ok || !p.ok) { setPhase("error"); return; }
      setPipelines(p.data.pipelines.filter((x) => !x.archived));
      setLostReasons(p.data.lostReasons.filter((r) => !r.archived));
      setLead(l.data.items.find((x) => x.outcome === "open") ?? l.data.items[0] ?? null);
      setPhase("ready");
    })();
    return () => { live = false; };
  }, [workspaceId, contactId]);

  const pipeline = pipelines.find((x) => x.id === lead?.pipelineId) ?? null;
  const stage = pipeline?.stages.find((s) => s.id === lead?.stageId) ?? null;

  async function move(to: StageDto, lostReasonId?: string, undoable = true) {
    const cur = leadRef.current;
    const from = pipelines.find((x) => x.id === cur?.pipelineId)?.stages.find((s) => s.id === cur?.stageId);
    if (!cur || !from || to.id === cur.stageId || busy) return;
    setBusy(true);
    const choice = contactId ? await gate({ id: contactId, name: contactName }, to) : {}; // may ask for a deal value an ad rule needs
    if (choice.cancel) { setBusy(false); return; }
    setLead({ ...cur, stageId: to.id, outcome: to.kind }); // optimistic
    const r = await browserApi.call(endpoints.moveLead, { params: { workspaceId, leadId: cur.id }, body: { expectedVersion: cur.version, stageId: to.id, ...(lostReasonId ? { lostReasonId } : {}), ...(choice.value ?? {}) } });
    setBusy(false);
    if (!r.ok) {
      setLead(cur);
      toast(r.error.kind === "http" && r.error.code === "version_conflict" ? "Someone else changed this lead. Try again." : errorMessage(r.error), "error");
      return;
    }
    setLead(r.data);
    const text = to.kind === "won" ? "Lead marked won" : to.kind === "lost" ? "Lead marked lost" : `Lead moved to ${to.name}`;
    toast(text, "success", undoable ? { label: "Undo", onClick: () => void move(from, undefined, false) } : undefined);
  }

  async function create() {
    if (!contactId) return;
    const p = pipelines.find((x) => x.isDefault) ?? pipelines[0];
    if (!p) return;
    setBusy(true);
    const r = await browserApi.call(endpoints.createLead, { params: { workspaceId }, body: { title: contactName, primaryContactId: contactId!, pipelineId: p.id } });
    setBusy(false);
    if (!r.ok) { toast(errorMessage(r.error), "error"); return; }
    setLead(r.data);
    toast("Lead created");
  }

  return { phase, lead, pipeline, stage, lostReasons, busy, move, create, canCreate: pipelines.length > 0, valueDialog };
}
export type ContactLead = ReturnType<typeof useContactLead>;

const dot = (s: StageDto, i: number) => s.kind === "won" ? "var(--success-fg)" : s.kind === "lost" ? "var(--danger)" : `var(--hue-${(i % 6) + 1}-dot)`;

/** Lead stage control. Read-only chip without edit permission; menu to move; a reason is required to mark lost. */
export function StageControl({ ctl, canEdit, className, block, tile }: { ctl: ContactLead; canEdit: boolean; className?: string; block?: boolean; tile?: boolean }) {
  const [lost, setLost] = React.useState<StageDto | null>(null);
  const [reason, setReason] = React.useState("");
  if (ctl.phase === "loading") return <Skeleton className={block ? "h-8 w-full" : "h-8 w-28"} />;
  if (ctl.phase === "error") return null;
  const stages = ctl.pipeline ? orderedStages(ctl.pipeline) : [];
  const idx = ctl.stage ? stages.findIndex((s) => s.id === ctl.stage!.id) : 0;
  const trigger = tile ? (
    <Button variant="secondary" disabled={ctl.busy} className={cn("h-14 min-w-0 flex-col items-start justify-center gap-0 rounded-xl px-3 pointer-coarse:h-14 md:h-11 md:w-56 md:pointer-coarse:h-14", className)}>
      <span className="text-xs font-normal text-fg-subtle">Stage</span>
      <span className="flex w-full min-w-0 items-center gap-1.5 text-base font-semibold">
        {ctl.stage ? <span aria-hidden className="size-2 shrink-0 rounded-full transition-colors" style={{ background: dot(ctl.stage, idx) }} /> : null}
        <span className="truncate">{ctl.stage ? ctl.stage.name : "No lead"}</span>
        {canEdit && <ChevronDown className="ml-auto shrink-0 text-fg-subtle" aria-hidden />}
      </span>
    </Button>
  ) : (
    <Button variant="secondary" size="sm" disabled={ctl.busy} className={className}>
      {ctl.stage ? <span aria-hidden className="size-2 rounded-full transition-colors" style={{ background: dot(ctl.stage, idx) }} /> : null}
      <span className="font-normal text-fg-subtle max-md:sr-only">Stage</span>{ctl.stage ? ctl.stage.name : "No lead"}
      {canEdit && <ChevronDown className="ml-auto" aria-hidden />}
    </Button>
  );
  if (!canEdit) return <span className="inline-flex h-7 items-center gap-1.5 text-sm text-fg-muted">Stage: {ctl.stage?.name ?? "No lead"}</span>;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent>
          {!ctl.lead ? (
            <DropdownMenuItem disabled={!ctl.canCreate} onSelect={() => void ctl.create()}><Plus aria-hidden />Create lead</DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuLabel>Move lead to stage</DropdownMenuLabel>
              {stages.map((s, i) => (
                <DropdownMenuItem key={s.id} onSelect={() => (s.kind === "lost" ? (setReason(ctl.lostReasons[0]?.id ?? ""), setLost(s)) : void ctl.move(s))} className={s.id === ctl.stage?.id ? "font-semibold" : ""}>
                  <span aria-hidden className="mx-0.5 size-2 shrink-0 rounded-full" style={{ background: dot(s, i) }} />{s.name}
                  {s.id === ctl.stage?.id && <span className="sr-only"> (current)</span>}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={lost !== null} onOpenChange={(o) => { if (!o) setLost(null); }}>
        <DialogContent title="Why was this lead lost?" description="A reason is needed to mark a lead as lost.">
          <div data-dialog-body className="space-y-4">
            <Select aria-label="Lost reason" value={reason} onChange={(e) => setReason(e.target.value)}>
              {ctl.lostReasons.length === 0 && <option value="">No reasons configured</option>}
              {ctl.lostReasons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
            <DialogActions>
              <DialogClose asChild><Button>Cancel</Button></DialogClose>
              <Button variant="danger" disabled={!reason} onClick={() => { const s = lost; setLost(null); if (s) void ctl.move(s, reason); }}>Mark lost</Button>
            </DialogActions>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
