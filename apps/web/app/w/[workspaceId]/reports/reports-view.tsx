"use client";
import * as React from "react";
import { PieChart as PieIcon } from "lucide-react";
import { endpoints, type LeadReport, type PipelineDto } from "@crm/contracts";
import { Select } from "@/components/ui/input";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { Skeleton } from "@/components/ui/skeleton";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatMoney } from "@/lib/leads";

type Money = { currency: string; minor: number }[] | null;
const PERIODS = [["30", "Last 30 days"], ["90", "Last 90 days"], ["365", "Last 12 months"]] as const;
const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

/** Per-currency amounts; null means the caller may not see lead values, shown as a dash with an explanation elsewhere. */
const Amount = ({ v }: { v: Money }) => (v === null ? <span className="text-fg-subtle" aria-label="Not available">—</span> : v.length === 0 ? <span className="text-fg-subtle">—</span> : <span className="tabular-nums">{v.map((m) => formatMoney(m.minor, m.currency)).join(" · ")}</span>);

export function ReportsView({ workspaceId, pipelines, initial }: { workspaceId: string; pipelines: PipelineDto[]; initial: LeadReport | null }) {
  const [report, setReport] = React.useState<LeadReport | null>(initial);
  const [pipelineId, setPipelineId] = React.useState(initial?.pipelineId ?? "");
  const [period, setPeriod] = React.useState("90");
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">(initial ? "idle" : "error");
  const [err, setErr] = React.useState<string | null>(null);
  const first = React.useRef(true);
  const seq = React.useRef(0);

  const load = React.useCallback(async () => {
    const mine = ++seq.current;
    setStatus("loading");
    const r = await browserApi.call(endpoints.leadReport, { params: { workspaceId }, query: { ...(pipelineId ? { pipelineId } : {}), from: day(Number(period)), to: day(0) } });
    if (mine !== seq.current) return;
    if (!r.ok) { setErr(errorMessage(r.error)); setStatus("error"); return; }
    setReport(r.data); setStatus("idle"); setErr(null);
  }, [workspaceId, pipelineId, period]);
  React.useEffect(() => { if (first.current) { first.current = false; return; } void load(); }, [load]);

  if (pipelines.length === 0) return <><PageHeader title="Reports" /><Panel><EmptyState icon={PieIcon} title="No pipeline yet" description="Reports appear once a pipeline exists and leads are tracked in it." /></Panel></>;
  const maxStage = Math.max(1, ...(report?.stages.map((s) => s.count) ?? [1]));
  const maxClose = Math.max(1, ...(report?.closing.map((b) => b.count) ?? [1]));

  return (
    <>
      <PageHeader title="Reports" description="How leads are moving through your pipeline." actions={
        <div className="flex gap-2">
          {pipelines.length > 1 && <Select aria-label="Pipeline" wrapperClassName="w-auto" value={pipelineId} onChange={(e) => setPipelineId(e.target.value)}>{pipelines.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
          <Select aria-label="Period" wrapperClassName="w-auto" value={period} onChange={(e) => setPeriod(e.target.value)}>{PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        </div>} />
      {status === "error" && <Panel><ErrorState description={err ?? undefined} onRetry={() => void load()} /></Panel>}
      {!report && status !== "error" && <Skeleton className="h-64 w-full" />}
      {report && status !== "error" && (
        <div className={status === "loading" ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={status === "loading"}>
          {!report.valuesVisible && <Alert tone="info" className="mb-4">Lead values are only shown to owners and admins. You can see counts and rates.</Alert>}
          <dl className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ["Open", String(report.openTotal.count), <Amount key="v" v={report.openTotal.values} />],
              ["Won", String(report.won.count), <Amount key="v" v={report.won.values} />],
              ["Lost", String(report.lost.count), <Amount key="v" v={report.lost.values} />],
              ["Win rate", report.conversion.winRate === null ? "—" : `${Math.round(report.conversion.winRate * 100)}%`, <span key="v" className="text-fg-subtle">{report.conversion.avgDaysToWin === null ? "No wins in period" : `${report.conversion.avgDaysToWin} days to win on average`}</span>],
            ].map(([label, big, sub]) => (
              <Panel key={String(label)} className="p-4"><dt className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{label}</dt><dd className="mt-1 text-2xl font-semibold tabular-nums text-fg">{big}</dd><dd className="mt-0.5 text-sm text-fg-muted">{sub}</dd></Panel>
            ))}
          </dl>
          <p className="mb-3 text-xs text-fg-subtle">Won, lost and win rate cover {report.period.from} to {report.period.to}. Created in that period: {report.conversion.created}. Amounts are per currency and never converted.</p>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel>
              <PanelHeader title="Stage distribution" description="Open leads now, and how many entered each stage in the period." />
              <ul className="divide-y divide-line" aria-label="Stage distribution">
                {report.stages.map((s) => (
                  <li key={s.stageId} className="px-4 py-2.5">
                    <div className="flex items-baseline justify-between gap-2 text-sm"><span className="font-medium">{s.name}</span><span className="tabular-nums text-fg-muted">{s.count} · {Math.round(s.share * 100)}% · <Amount v={s.values} /></span></div>
                    <div className="mt-1.5 h-1.5 rounded-full bg-hover" aria-hidden><div className="h-full rounded-full bg-accent transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${(s.count / maxStage) * 100}%` }} /></div>
                    <p className="mt-1 text-xs text-fg-subtle">{s.entered} entered in period</p>
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel>
              <PanelHeader title="Expected closing" description="Open leads by expected close date." />
              <ul className="divide-y divide-line" aria-label="Expected closing">
                {report.closing.map((b) => (
                  <li key={b.bucket} className="px-4 py-2.5">
                    <div className="flex items-baseline justify-between gap-2 text-sm"><span className={b.bucket === "overdue" && b.count > 0 ? "font-medium text-danger-fg" : "font-medium"}>{b.label}</span><span className="tabular-nums text-fg-muted">{b.count} · <Amount v={b.values} /></span></div>
                    <div className="mt-1.5 h-1.5 rounded-full bg-hover" aria-hidden><div className={`h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${b.bucket === "overdue" ? "bg-danger" : "bg-accent"}`} style={{ width: `${(b.count / maxClose) * 100}%` }} /></div>
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel className="lg:col-span-2">
              <PanelHeader title="Why leads were lost" description="Reasons recorded in the period." />
              {report.lost.reasons.length === 0 ? <p className="p-4 text-sm text-fg-muted">Nothing lost in this period.</p> : (
                <ul className="divide-y divide-line">{report.lost.reasons.map((x) => <li key={x.reasonId} className="flex justify-between gap-2 px-4 py-2.5 text-sm"><span>{x.name}</span><span className="tabular-nums text-fg-muted">{x.count}</span></li>)}</ul>
              )}
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}
