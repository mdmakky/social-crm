"use client";
import * as React from "react";
import { AlertTriangle, Check } from "lucide-react";
import { AI_JOBS, endpoints, type AiJobKey, type AiJobModelDto, type AiProviderDto, type AiUsageDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatMicro } from "@/lib/ai-money";
import { MAX_ENABLED, ModelBrowser, type ModelRow } from "./model-browser";

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

export function JobsPanel({ workspaceId, providers, active, jobs, jobsError, usage, dev, onChanged, onRetry }: {
  dev: boolean; workspaceId: string; providers: AiProviderDto[]; active: AiProviderDto | null; jobs: AiJobModelDto[] | null; jobsError: string | null; usage: AiUsageDto; onChanged: () => Promise<void>; onRetry: () => void;
}) {
  const toast = useToast();
  const [openJob, setOpenJob] = React.useState<AiJobKey | null>(null);
  const [busy, setBusy] = React.useState<AiJobKey | null>(null);
  const [rowError, setRowError] = React.useState<{ job: AiJobKey; text: string } | null>(null);
  const per = usageByJob(usage);
  /** The provider a job's model comes from. Voice and documents need an adapter that can take audio or PDFs: another connected provider (Gemini, Whisper, Anthropic) when the main one cannot. */
  const providerFor = (job: AiJobKey): AiProviderDto | null => {
    const needs = AI_JOBS[job].needs;
    if (needs === "text" || needs === "vision") return active;
    return providers.find((p) => p.configured && p.enabled && p.id !== "openrouter" && p.models.some((m) => (m.capabilities ?? ["text"]).includes(needs))) ?? active;
  };

  async function assign(job: AiJobKey, row: ModelRow): Promise<string | null> {
    const active = providerFor(job);
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

  const head = <PanelHeader title="What AI does for you" description="Each job uses a model that can do it. Change a model only if you want to." />;
  if (jobsError) return <Panel id="ai-jobs" className="scroll-mt-14">{head}<ErrorState title="Could not load the jobs" description={jobsError} onRetry={onRetry} /></Panel>;
  if (!jobs) return <Panel id="ai-jobs" className="scroll-mt-14" role="status" aria-label="Loading jobs">{head}<div className="flex flex-col gap-2 p-4"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div></Panel>;

  return (
    <Panel id="ai-jobs" className="scroll-mt-14">
      {head}
      {!active && !JOB_ORDER.some((j) => providerFor(j)) && <p className="mx-4 mt-3 rounded-control bg-warning-bg px-3 py-2 text-sm text-warning-fg">Connect AI above first. Then each job below can be turned on.</p>}
      <ul aria-label="AI jobs" className="flex flex-col divide-y divide-line-card">
        {JOB_ORDER.map((job) => {
          const dto = jobs.find((x) => x.job === job);
          const fake = !dev && dto?.effective?.provider === "mock";
          const eff = fake ? null : modelInfo(providers, dto?.effective ?? null);
          const st: Status = fake ? { kind: "needs" } : statusOf(dto);
          const u = per[job];
          const label = AI_JOBS[job].label;
          const needsText = AI_JOBS[job].needs === "document" ? "Pick a model that can read documents." : AI_JOBS[job].needs === "transcription" ? "Pick a model that can listen to audio." : "Pick a model.";
          return (
            <li key={job} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5">
              <div className="min-w-0 flex-1 basis-64">
                <h3 className="text-base font-medium text-fg">{label}</h3>
                <p className="mt-0.5 text-sm text-fg-subtle">{st.kind === "working" ? MEANING[job] : st.kind === "problem" ? st.text : `${MEANING[job]} ${needsText}`}</p>
                {eff && <p className="mt-1 text-xs text-fg-muted">Uses {eff.label}{dto?.pinned ? "" : " (picked for you)"}. This month: {u.runs.toLocaleString()} call{u.runs === 1 ? "" : "s"}, ${formatMicro(u.costMicro)}.</p>}
                {rowError?.job === job && <p role="alert" className="mt-1 text-sm text-danger-fg">{rowError.text}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {st.kind === "working" && <Badge tone="success"><Check aria-hidden className="size-3" />On</Badge>}
                {st.kind === "needs" && <Badge tone="warning"><AlertTriangle aria-hidden className="size-3" />Not set up</Badge>}
                {st.kind === "problem" && <Badge tone="danger"><AlertTriangle aria-hidden className="size-3" />Problem</Badge>}
                {dto?.pinned && <Button type="button" size="sm" variant="ghost" loading={busy === job} onClick={() => void automatic(job)} aria-label={`Use automatic for ${label}`}>Use automatic</Button>}
                <Button type="button" size="sm" variant="secondary" disabled={!providerFor(job)} onClick={() => { setRowError(null); setOpenJob(job); }}>{st.kind === "working" ? "Change" : "Set up"}<span className="sr-only"> the model for {label}</span></Button>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-line-card px-4 py-3 text-xs text-fg-subtle">Cost is estimated from the provider&apos;s price list, in USD. Automatic picks the main model, or the first enabled one that can do the job.</p>
      {openJob && providerFor(openJob) && (
        <ModelBrowser open onOpenChange={(o) => { if (!o) setOpenJob(null); }} workspaceId={workspaceId} provider={providerFor(openJob)!} title={`Choose a model: ${AI_JOBS[openJob].label}`} needs={AI_JOBS[openJob].needs}
          current={jobs.find((x) => x.job === openJob)?.effective?.model ?? null} onChoose={(row) => assign(openJob, row)} />
      )}
    </Panel>
  );
}
