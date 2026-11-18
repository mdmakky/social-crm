"use client";
import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { endpoints, type ContactSummary, type LostReasonDto, type PipelineDto, type StageDto } from "@crm/contracts";
import { Status } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { Dialog, DialogActions, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/overlays";
import { Alert } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { CODE_TEXT, orderedStages, defaultPipeline, shownStage, stageHue, stagesForContact } from "@/lib/contact-lead";

const n = (x: number) => x.toLocaleString("en");

export function StageBadge({ pipelines, c }: { pipelines: PipelineDto[]; c: Pick<ContactSummary, "lead"> }) {
  const s = shownStage(pipelines, c.lead ?? null);
  return s ? <Status hue={stageHue(s)}>{s.name}</Status> : <span className="text-fg-disabled">—</span>;
}

/** Quick stage change: the stage itself is the button. Open and won stages apply at once; lost asks for a reason first. Arrow keys and Enter work (Radix menu). */
export function StageMenu({ c, pipelines, lostReasons, workspaceId, onChanged }: { c: ContactSummary; pipelines: PipelineDto[]; lostReasons: LostReasonDto[]; workspaceId: string; onChanged: () => void }) {
  const toast = useToast();
  const [ask, setAsk] = React.useState<StageDto | null>(null);
  const [busy, setBusy] = React.useState(false);
  const stages = stagesForContact(pipelines, c);
  const cur = shownStage(pipelines, c.lead ?? null);
  if (!cur || stages.length === 0) return <StageBadge pipelines={pipelines} c={c} />;

  async function pick(s: StageDto) {
    if (s.id === cur!.id && !cur!.virtual) return;
    if (s.kind === "lost") return setAsk(s);
    setBusy(true);
    const r = await browserApi.call(endpoints.bulkContactStage, { params: { workspaceId }, body: { contactIds: [c.id], stageId: s.id } });
    setBusy(false);
    const res = r.ok ? r.data.results[0] : null;
    if (res?.ok) { toast(`${c.name} is now ${s.name}.`); onChanged(); }
    else toast(r.ok ? `Could not change the stage: ${CODE_TEXT[res?.code ?? ""] ?? "something went wrong"}.` : errorMessage(r.error), "error");
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" disabled={busy} aria-label={`Stage of ${c.name}: ${cur.name}. Change stage`} className="press -mx-1.5 inline-flex min-h-6 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover disabled:opacity-60 pointer-coarse:min-h-11">
            <Status hue={stageHue(cur)}>{cur.name}</Status>
            <ChevronDown className="size-3 text-fg-subtle" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {stages.map((s) => (
            <DropdownMenuItem key={s.id} onSelect={() => void pick(s)} aria-current={s.id === cur.id ? "true" : undefined}>
              <span className="min-w-0 flex-1">{s.name}</span>
              {s.id === cur.id && <Check className="size-4" aria-hidden />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {ask && <StageDialog ids={[c.id]} pipelines={pipelines} lostReasons={lostReasons} workspaceId={workspaceId} initialStageId={ask.id} onClose={() => setAsk(null)} onDone={onChanged} />}
    </>
  );
}

/** Applies a stage to one or many contacts (the same call for both). A contact without a lead gets its lead created. Failures are listed, never swallowed. */
export function StageDialog({ ids, pipelines, lostReasons, workspaceId, initialStageId, onClose, onDone }: { ids: string[]; pipelines: PipelineDto[]; lostReasons: LostReasonDto[]; workspaceId: string; initialStageId?: string; onClose: () => void; onDone: (moved: string[]) => void }) {
  const toast = useToast();
  const stages = orderedStages(defaultPipeline(pipelines));
  const [stageId, setStageId] = React.useState(initialStageId ?? "");
  const [reasonId, setReasonId] = React.useState(lostReasons[0]?.id ?? "");
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const target = stages.find((s) => s.id === stageId);
  const many = ids.length > 1;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true); setProblem(null);
    const r = await browserApi.call(endpoints.bulkContactStage, { params: { workspaceId }, body: { contactIds: ids, stageId: target.id, ...(target.kind === "lost" ? { lostReasonId: reasonId } : {}) } });
    setBusy(false);
    if (!r.ok) { setProblem(errorMessage(r.error)); return; }
    const done = r.data.results.filter((x) => x.ok).map((x) => x.id);
    const failed = r.data.results.filter((x) => !x.ok);
    if (failed.length === 0) { toast(`${n(done.length)} ${done.length === 1 ? "contact" : "contacts"} moved to ${target.name}.`); onDone(done); onClose(); return; }
    const byCode = new Map<string, number>();
    for (const x of failed) byCode.set(x.code, (byCode.get(x.code) ?? 0) + 1);
    setProblem(`${n(done.length)} moved to ${target.name}. ${n(failed.length)} not moved: ${[...byCode].map(([c, k]) => `${k} ${CODE_TEXT[c] ?? "could not be moved"}`).join(", ")}.`);
    onDone(done);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={many ? `Change stage of ${n(ids.length)} contacts` : "Change stage"} description="Each contact moves as if you had moved it yourself. History, automations and ad events follow.">
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <Field label="New stage">{(p) => <Select {...p} value={stageId} onChange={(e) => setStageId(e.target.value)}><option value="">Choose a stage</option>{stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
          {target?.kind === "lost" && <Field label="Why was it lost?">{(p) => <Select {...p} value={reasonId} onChange={(e) => setReasonId(e.target.value)}>{lostReasons.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>}
          {problem && <Alert tone="warning">{problem}</Alert>}
          <DialogActions><Button type="button" onClick={onClose}>{problem ? "Close" : "Cancel"}</Button><Button type="submit" variant="primary" disabled={!target || busy || (target.kind === "lost" && !reasonId)}>{busy ? "Moving…" : `Move ${n(ids.length)} ${ids.length === 1 ? "contact" : "contacts"}`}</Button></DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}
