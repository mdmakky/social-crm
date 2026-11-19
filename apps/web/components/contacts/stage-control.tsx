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
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { usePhone } from "@/lib/use-phone";
import { browserApi, errorMessage } from "@/lib/client-api";
import { useStageValueGate } from "@/components/contacts/stage-value";
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
  const [sheet, setSheet] = React.useState(false);
  const phone = usePhone();
  const { gate, dialog } = useStageValueGate(workspaceId);
  const stages = stagesForContact(pipelines, c);
  const cur = shownStage(pipelines, c.lead ?? null);
  if (!cur || stages.length === 0) return <StageBadge pipelines={pipelines} c={c} />;

  async function pick(s: StageDto) {
    if (s.id === cur!.id && !cur!.virtual) return;
    if (s.kind === "lost") return setAsk(s); // the lost dialog asks for the reason, then checks for a deal value itself
    setBusy(true);
    const choice = await gate(c, s);
    if (choice.cancel) { setBusy(false); return; }
    // With a value the move goes through the lead endpoint, so the value and the stage are saved together and the ad event carries the value.
    const r = choice.value
      ? await browserApi.call(endpoints.putContactLead, { params: { workspaceId, contactId: c.id }, body: { ...(c.lead ? { expectedVersion: c.lead.version } : {}), stageId: s.id, ...choice.value } })
      : await browserApi.call(endpoints.bulkContactStage, { params: { workspaceId }, body: { contactIds: [c.id], stageId: s.id } });
    setBusy(false);
    if (!r.ok) { toast(r.error.kind === "http" && r.error.code === "version_conflict" ? "Someone else changed this lead. Try again." : errorMessage(r.error), "error"); return; }
    const res = "results" in r.data ? r.data.results[0] : { ok: true, code: "ok" };
    const skipped = "results" in r.data && r.data.results[0]?.noValue ? " No deal value, so the ad event was skipped." : "";
    if (res?.ok) { toast(`${c.name} is now ${s.name}.${skipped}`); onChanged(); }
    else toast(`Could not change the stage: ${CODE_TEXT[res?.code ?? ""] ?? "something went wrong"}.`, "error");
  }

  const trigger = (extra: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" disabled={busy} aria-label={`Stage of ${c.name}: ${cur.name}. Change stage`} className="press -mx-1.5 inline-flex min-h-6 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover disabled:opacity-60 pointer-coarse:min-h-11" {...extra}>
      <Status hue={stageHue(cur)} className="min-w-0"><span className="max-w-[9rem] truncate">{cur.name}</span></Status>
      <ChevronDown className="size-3 shrink-0 text-fg-subtle" aria-hidden />
    </button>
  );
  // On a phone the same menu is a bottom sheet with 48 px rows.
  if (phone) {
    return (
      <>
        {trigger({ onClick: () => setSheet(true), "aria-haspopup": "dialog" })}
        <Sheet open={sheet} onOpenChange={setSheet} title="Change stage" description={c.name}>
          <ul className="flex flex-col pb-2">
            {stages.map((s) => (
              <li key={s.id}>
                <button type="button" aria-current={s.id === cur.id ? "true" : undefined} onClick={() => { setSheet(false); void pick(s); }} className="press flex min-h-12 w-full items-center gap-3 rounded-control px-2 text-left text-md text-fg active:bg-hover">
                  <Status hue={stageHue(s)} className="min-w-0 flex-1 text-md"><span className="truncate">{s.name}</span></Status>
                  {s.id === cur.id && <Check className="size-5 text-accent" aria-hidden />}
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
        {ask && <StageDialog ids={[c.id]} one={c} pipelines={pipelines} lostReasons={lostReasons} workspaceId={workspaceId} initialStageId={ask.id} onClose={() => setAsk(null)} onDone={onChanged} />}
        {dialog}
      </>
    );
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
      {ask && <StageDialog ids={[c.id]} one={c} pipelines={pipelines} lostReasons={lostReasons} workspaceId={workspaceId} initialStageId={ask.id} onClose={() => setAsk(null)} onDone={onChanged} />}
      {dialog}
    </>
  );
}

/** Applies a stage to one or many contacts (the same call for both). A contact without a lead gets its lead created. Failures are listed, never swallowed. */
export function StageDialog({ ids, one, pipelines, lostReasons, workspaceId, initialStageId, onClose, onDone }: { ids: string[]; /** The one lead being moved (when ids has one entry): lets the dialog ask for a deal value first. Bulk moves never ask. */ one?: Pick<ContactSummary, "id" | "name" | "lead">; pipelines: PipelineDto[]; lostReasons: LostReasonDto[]; workspaceId: string; initialStageId?: string; onClose: () => void; onDone: (moved: string[]) => void }) {
  const toast = useToast();
  const stages = orderedStages(defaultPipeline(pipelines));
  const [stageId, setStageId] = React.useState(initialStageId ?? "");
  const [reasonId, setReasonId] = React.useState(lostReasons[0]?.id ?? "");
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const target = stages.find((s) => s.id === stageId);
  const many = ids.length > 1;
  const { gate, dialog } = useStageValueGate(workspaceId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true); setProblem(null);
    const choice = !many && one ? await gate(one, target) : {};
    if (choice.cancel) { setBusy(false); return; }
    const lost = target.kind === "lost" ? { lostReasonId: reasonId } : {};
    const r = choice.value && one
      ? await browserApi.call(endpoints.putContactLead, { params: { workspaceId, contactId: one.id }, body: { ...(one.lead ? { expectedVersion: one.lead.version } : {}), stageId: target.id, ...lost, ...choice.value } })
      : await browserApi.call(endpoints.bulkContactStage, { params: { workspaceId }, body: { contactIds: ids, stageId: target.id, ...lost } });
    setBusy(false);
    if (!r.ok) { setProblem(r.error.kind === "http" && r.error.code === "version_conflict" ? "Someone else changed this lead. Close this and try again." : errorMessage(r.error)); return; }
    const results = "results" in r.data ? r.data.results : [{ id: ids[0]!, ok: true, code: "ok" }];
    const done = results.filter((x) => x.ok).map((x) => x.id);
    const failed = results.filter((x) => !x.ok);
    // A bulk move never asks for a value: leads whose ad rule wanted one were still moved, and that event was recorded as skipped. Say so, and how to fix it.
    const skipped = "results" in r.data ? r.data.results.filter((x) => x.noValue).length : 0;
    const skipNote = skipped > 0 ? ` ${n(skipped)} had no deal value, so ${skipped === 1 ? "its" : "their"} ad event was skipped. Open the lead and add a value to send it next time.` : "";
    if (failed.length === 0) { toast(`${n(done.length)} ${done.length === 1 ? "lead" : "leads"} moved to ${target.name}.${skipNote}`); onDone(done); onClose(); return; }
    const byCode = new Map<string, number>();
    for (const x of failed) byCode.set(x.code, (byCode.get(x.code) ?? 0) + 1);
    setProblem(`${n(done.length)} moved to ${target.name}. ${n(failed.length)} not moved: ${[...byCode].map(([c, k]) => `${k} ${CODE_TEXT[c] ?? "could not be moved"}`).join(", ")}.${skipNote}`);
    onDone(done);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={many ? `Change stage of ${n(ids.length)} leads` : "Change stage"} description="Each lead moves as if you had moved it yourself. History, automations and ad events follow.">
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <Field label="New stage">{(p) => <Select {...p} value={stageId} onChange={(e) => setStageId(e.target.value)}><option value="">Choose a stage</option>{stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
          {target?.kind === "lost" && <Field label="Why was it lost?">{(p) => <Select {...p} value={reasonId} onChange={(e) => setReasonId(e.target.value)}>{lostReasons.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>}
          {problem && <Alert tone="warning">{problem}</Alert>}
          <DialogActions><Button type="button" onClick={onClose}>{problem ? "Close" : "Cancel"}</Button><Button type="submit" variant="primary" disabled={!target || busy || (target.kind === "lost" && !reasonId)}>{busy ? "Moving…" : `Move ${n(ids.length)} ${ids.length === 1 ? "lead" : "leads"}`}</Button></DialogActions>
        </form>
        {dialog}
      </DialogContent>
    </Dialog>
  );
}
