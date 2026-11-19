"use client";
import * as React from "react";
import { AlertTriangle, Check, ChevronsUpDown } from "lucide-react";
import { AI_JOBS, endpoints, type AiJobKey, type AiJobModelDto, type AiProviderDto, type AiUsageDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatMicro } from "@/lib/ai-money";
import { AbilityTags, MAX_ENABLED, ModelBrowser, priceText, type ModelRow } from "./model-browser";

export const JOB_ORDER = Object.keys(AI_JOBS) as AiJobKey[];
const MEANING: Record<AiJobKey, string> = {
  reply: "A draft the person edits and sends. The AI never sends it.",
  agent: "Used by AI agents and the automation step that drafts a note. Nothing is sent without approval.",
  vision: "Describes photos and screenshots a customer sends.",
  document: "Reads PDFs and scanned documents added to Knowledge.",
  transcription: "Turns a voice message into text.",
};
/** usage.byDay capability -> job (apps/api/src/ai: reply_suggestion, agent, media.ts: vision, ocr, transcription). */
const JOB_OF: Record<string, AiJobKey> = { reply_suggestion: "reply", agent: "agent", vision: "vision", ocr: "document", transcription: "transcription" };

/** Calls and cost per job since the start of this month (UTC). */
export function usageByJob(usage: AiUsageDto): Record<AiJobKey, { runs: number; costMicro: number }> {
  const out = Object.fromEntries(JOB_ORDER.map((j) => [j, { runs: 0, costMicro: 0 }])) as Record<AiJobKey, { runs: number; costMicro: number }>;
  const start = usage.month.start.slice(0, 10);
  for (const d of usage.byDay) { const j = JOB_OF[d.capability]; if (j && d.day.slice(0, 10) >= start) { out[j].runs += d.runs; out[j].costMicro += d.costMicro; } }
  return out;
}

export function modelInfo(providers: AiProviderDto[], e: { provider: string; model: string } | null) {
  if (!e) return null;
  const p = providers.find((x) => x.id === e.provider);
  const m = p?.models.find((x) => x.id === e.model);
  return { label: m?.label ?? e.model, caps: m?.capabilities ?? p?.modelPrices[e.model]?.capabilities ?? ["text"], inMicro: m?.inputMicroPer1M ?? p?.modelPrices[e.model]?.inputMicroPer1M ?? 0, outMicro: m?.outputMicroPer1M ?? p?.modelPrices[e.model]?.outputMicroPer1M ?? 0, mock: !!p?.mock };
}

type Status = { kind: "working" } | { kind: "needs" } | { kind: "problem"; text: string };
export const statusOf = (j: AiJobModelDto | undefined): Status => (!j ? { kind: "needs" } : j.problem ? { kind: "problem", text: j.problem } : j.effective ? { kind: "working" } : { kind: "needs" });

export function JobsPanel({ workspaceId, providers, active, jobs, jobsError, usage, onChanged, onRetry }: {
  workspaceId: string; providers: AiProviderDto[]; active: AiProviderDto | null; jobs: AiJobModelDto[] | null; jobsError: string | null; usage: AiUsageDto; onChanged: () => Promise<void>; onRetry: () => void;
}) {
  const toast = useToast();
  const [openJob, setOpenJob] = React.useState<AiJobKey | null>(null);
  const [busy, setBusy] = React.useState<AiJobKey | null>(null);
  const [rowError, setRowError] = React.useState<{ job: AiJobKey; text: string } | null>(null);
  const per = usageByJob(usage);

  async function assign(job: AiJobKey, row: ModelRow): Promise<string | null> {
    if (!active) return "Connect a provider first.";
    const enable = active.id === "openrouter" && !active.modelPrices[row.id];
    const setDefault = (job === "reply" || job === "agent") && !active.defaultModel;
    if (enable || setDefault) {
      if (enable && Object.keys(active.modelPrices).length >= MAX_ENABLED) return `You already use ${MAX_ENABLED} models. Remove one in Advanced, then choose this one.`;
      const r = await browserApi.call(endpoints.setAiProvider, { params: { workspaceId, provider: active.id }, body: { ...(enable ? { modelPrices: { ...active.modelPrices, [row.id]: row.entry } } : {}), ...(setDefault ? { defaultModel: row.id } : {}) } });
      if (!r.ok) return errorMessage(r.error);
    }
    const j = await browserApi.call(endpoints.setAiJobModel, { params: { workspaceId, job }, body: { provider: active.id, model: row.id } });
    if (!j.ok) return errorMessage(j.error);
    toast(`${AI_JOBS[job].label}: model saved`, "success");
    await onChanged();
    return null;
  }
  async function automatic(job: AiJobKey) {
    setRowError(null); setBusy(job);
    const r = await browserApi.call(endpoints.clearAiJobModel, { params: { workspaceId, job } });
    setBusy(null);
    if (!r.ok) { setRowError({ job, text: errorMessage(r.error) }); return; }
    toast(`${AI_JOBS[job].label}: back to automatic`, "success");
    await onChanged();
  }

  const head = <PanelHeader title="Model for each job" description="Pick which model does which job. A model that cannot do a job is not offered for it." />;
  if (jobsError) return <Panel id="ai-jobs" className="scroll-mt-14">{head}<ErrorState title="Could not load the jobs" description={jobsError} onRetry={onRetry} /></Panel>;
  if (!jobs) return <Panel id="ai-jobs" className="scroll-mt-14" role="status" aria-label="Loading jobs">{head}<div className="flex flex-col gap-2 p-4"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div></Panel>;

  return (
    <Panel id="ai-jobs" className="scroll-mt-14">
      {head}
      {!active && <p className="mx-4 mt-3 rounded-control bg-warning-bg px-3 py-2 text-sm text-warning-fg">Connect a provider first. Then each job below can get a model.</p>}
      <ul aria-label="AI jobs" className="flex flex-col divide-y divide-line-card">
        {JOB_ORDER.map((job) => {
          const dto = jobs.find((x) => x.job === job);
          const eff = modelInfo(providers, dto?.effective ?? null);
          const st = statusOf(dto);
          const u = per[job];
          const label = AI_JOBS[job].label;
          const shownModel = !active ? "Connect a provider first" : eff ? eff.label : "Choose a model";
          return (
            <li key={job} className="grid gap-3 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,0.8fr)] lg:items-start">
              <div className="min-w-0">
                <h3 className="text-base font-medium text-fg">{label}</h3>
                <p className="mt-0.5 text-sm text-fg-subtle">{MEANING[job]}</p>
                <p className="mt-1 text-xs text-fg-muted">This month: {u.runs.toLocaleString()} call{u.runs === 1 ? "" : "s"}, ${formatMicro(u.costMicro)}</p>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Button type="button" variant="secondary" disabled={!active} onClick={() => { setRowError(null); setOpenJob(job); }} className="h-auto min-h-[var(--control-h)] w-full justify-between whitespace-normal py-1.5 text-left">
                  <span className="min-w-0 break-words">{shownModel}</span>
                  <span className="flex shrink-0 items-center gap-1.5">{dto?.effective?.automatic && <Badge tone="neutral">Automatic</Badge>}<ChevronsUpDown aria-hidden className="size-3.5 text-fg-subtle" /></span>
                  <span className="sr-only">. Change the model for {label}</span>
                </Button>
                {eff && <><AbilityTags caps={eff.caps} /><p className="text-xs text-fg-muted">{eff.mock ? "No cost (MOCK)" : `${priceText(eff.inMicro, eff.outMicro)} (indicative)`}</p></>}
              </div>
              <div className="flex flex-col items-start gap-2">
                {st.kind === "working" && <Badge tone="success"><Check aria-hidden className="size-3" />Working</Badge>}
                {st.kind === "needs" && <Badge tone="warning"><AlertTriangle aria-hidden className="size-3" />Needs a model</Badge>}
                {st.kind === "problem" && <p className="flex items-start gap-1.5 text-sm text-danger-fg"><AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" /><span><span className="font-medium">Problem.</span> {st.text}</span></p>}
                {dto?.pinned && <Button type="button" size="sm" variant="ghost" loading={busy === job} onClick={() => void automatic(job)} aria-label={`Use automatic for ${label}`}>Use automatic</Button>}
                {rowError?.job === job && <p role="alert" className="text-sm text-danger-fg">{rowError.text}</p>}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-line-card px-4 py-3 text-xs text-fg-subtle">Prices are indicative, in USD per 1 million tokens. Automatic picks the default provider&apos;s model, or the first enabled model that can do the job.</p>
      {openJob && active && (
        <ModelBrowser open onOpenChange={(o) => { if (!o) setOpenJob(null); }} workspaceId={workspaceId} provider={active} title={`Choose a model: ${AI_JOBS[openJob].label}`} needs={AI_JOBS[openJob].needs}
          current={jobs.find((x) => x.job === openJob)?.effective?.model ?? null} onChoose={(row) => assign(openJob, row)} />
      )}
    </Panel>
  );
}

/** Slim summary beside the jobs: what each job uses, and spend against the limit. */
export function SetupSummary({ providers, active, jobs, usage }: { providers: AiProviderDto[]; active: AiProviderDto | null; jobs: AiJobModelDto[] | null; usage: AiUsageDto }) {
  const m = usage.month;
  const pct = m.capMicro ? Math.min(100, Math.round((m.usedMicro / m.capMicro) * 100)) : null;
  return (
    <Panel aria-labelledby="setup-summary" className="flex flex-col gap-3 p-4 2xl:sticky 2xl:top-14">
      <div className="flex items-center justify-between gap-2"><h2 id="setup-summary" className="text-base font-semibold text-fg">What this setup does</h2>{active?.mock && <Badge tone="warning">MOCK</Badge>}</div>
      <ul className="flex flex-col gap-2">
        {JOB_ORDER.map((job) => {
          const dto = jobs?.find((x) => x.job === job);
          const eff = modelInfo(providers, dto?.effective ?? null);
          const ok = statusOf(dto).kind === "working";
          return (
            <li key={job} className="flex items-start gap-2 text-sm">
              {ok ? <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success-fg" /> : <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-fg" />}
              <span className="min-w-0"><span className="block text-fg">{AI_JOBS[job].label}</span><span className="block break-words text-xs text-fg-subtle">{eff ? eff.label : "No model yet"}<span className="sr-only">{ok ? ", working" : ", needs attention"}</span></span></span>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-line-card pt-3 text-sm">
        <p className="flex justify-between gap-2"><span className="text-fg-muted">Used this month</span><b className="font-medium text-fg">${formatMicro(m.usedMicro)}{m.capMicro !== null ? ` of $${formatMicro(m.capMicro)}` : ""}</b></p>
        {pct !== null && <div role="img" aria-label={`${pct} percent of the monthly limit used`} className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover"><div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} /></div>}
        <p className="mt-2 text-xs text-fg-subtle">{m.capMicro === null ? "No monthly limit set. " : ""}The month is UTC.</p>
      </div>
    </Panel>
  );
}
