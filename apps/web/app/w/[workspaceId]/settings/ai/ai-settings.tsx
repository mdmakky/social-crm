"use client";
import * as React from "react";
import Link from "next/link";
import { BarChart3, Plug, Wallet } from "lucide-react";
import { AI_JOBS, endpoints, type AiBudgetDto, type AiJobModelDto, type AiProviderDto, type AiUsageDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatMicro, parseMicro } from "@/lib/ai-money";
import { JobsPanel, JOB_ORDER, SetupSummary } from "./jobs-matrix";
import { CapabilitiesPanel, MediaPlayground } from "./media-panels";
import { MAX_ENABLED, ModelBrowser, type ModelRow } from "./model-browser";

type Data = { providers: AiProviderDto[]; budget: AiBudgetDto; usage: AiUsageDto };

/**
 * Settings, AI, Setup. The provider key goes into a password field, is sent once over the same-origin proxy and cleared; the server never returns it (only the last four characters).
 * Real providers are UNVERIFIED (no recorded request to a live service); the mock provider is offline and says so wherever it is used.
 * The reply wording moved to the Agents tab (Settings, AI, Agents, "Reply suggestion wording").
 */
export function AiSettings({ workspaceId }: { workspaceId: string }) {
  return <ToastProvider><Inner workspaceId={workspaceId} /></ToastProvider>;
}

function Inner({ workspaceId }: { workspaceId: string }) {
  const params = { workspaceId };
  const [data, setData] = React.useState<Data | null>(null);
  const [jobs, setJobs] = React.useState<AiJobModelDto[] | null>(null);
  const [jobsError, setJobsError] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const [p, b, u, j] = await Promise.all([
      browserApi.call(endpoints.listAiProviders, { params: { workspaceId } }), browserApi.call(endpoints.getAiBudget, { params: { workspaceId } }),
      browserApi.call(endpoints.getAiUsage, { params: { workspaceId }, query: { days: 30 } }), browserApi.call(endpoints.listAiJobModels, { params: { workspaceId } }),
    ]);
    // The jobs list fails on its own (its section shows the error); everything else is the page.
    if (j.ok) { setJobs(j.data.items); setJobsError(null); } else setJobsError(errorMessage(j.error));
    const bad = [p, b, u].find((r) => !r.ok);
    if (bad && !bad.ok) { setLoadError(errorMessage(bad.error)); return; }
    if (p.ok && b.ok && u.ok) { setLoadError(null); setData({ providers: p.data.items, budget: b.data, usage: u.data }); }
  }, [workspaceId]);
  React.useEffect(() => { void load(); }, [load]); // eslint-disable-line react-hooks/set-state-in-effect

  if (loadError) return <ErrorState title="Could not load AI settings" description={loadError} onRetry={() => { setLoadError(null); void load(); }} />;
  if (!data) return <div className="flex flex-col gap-4" role="status" aria-label="Loading AI settings"><Skeleton className="h-48" /><Skeleton className="h-40" /><Skeleton className="h-32" /></div>;
  const active = data.providers.find((p) => p.configured && p.enabled && p.isDefault) ?? data.providers.find((p) => p.configured && p.enabled) ?? null;
  const connected = data.providers.some((p) => p.configured);
  return (
    <div className="flex flex-col gap-[var(--page-gap)]">
      {active?.mock && <Alert tone="warning">MOCK mode. The connected provider is offline and returns canned text, so every cost shows $0.</Alert>}
      <div className="grid items-start gap-[var(--page-gap)] 2xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-[var(--page-gap)] 2xl:order-1">
          {!connected && <ConnectionPanel params={params} providers={data.providers} highlight onSaved={load} />}
          <JobsPanel workspaceId={workspaceId} providers={data.providers} active={active} jobs={jobs} jobsError={jobsError} usage={data.usage} onChanged={load} onRetry={() => { setJobsError(null); void load(); }} />
          {connected && <ConnectionPanel params={params} providers={data.providers} highlight={false} onSaved={load} />}
          <BudgetPanel params={params} budget={data.budget} usage={data.usage} onSaved={load} />
          <UsagePanel usage={data.usage} />
          <WordingPointer workspaceId={workspaceId} />
          <Advanced workspaceId={workspaceId} providers={data.providers} active={active} onSaved={load} />
        </div>
        <div className="order-last 2xl:order-2"><SetupSummary providers={data.providers} active={active} jobs={jobs} usage={data.usage} /></div>
      </div>
    </div>
  );
}

type P = { params: { workspaceId: string } };

function ConnectionPanel({ params, providers, highlight, onSaved }: P & { providers: AiProviderDto[]; highlight: boolean; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const initial = providers.find((x) => x.isDefault) ?? providers.find((x) => x.configured) ?? providers[0]!;
  const [id, setId] = React.useState(initial.id);
  const current = providers.find((x) => x.id === id)!;
  const fill = (x: AiProviderDto) => ({ baseUrl: x.baseUrl ?? "", enabled: x.configured ? x.enabled : true, isDefault: x.configured ? x.isDefault : !providers.some((o) => o.isDefault), key: "", start: null as ModelRow | null });
  const [form, setForm] = React.useState(() => fill(initial));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [keyError, setKeyError] = React.useState<string | null>(null);
  const [browse, setBrowse] = React.useState(false);
  const gateway = id === "openrouter";
  const needsStart = gateway && Object.keys(current.modelPrices).length === 0;

  function choose(next: string) {
    setId(next); setError(null); setKeyError(null);
    setForm(fill(providers.find((x) => x.id === next)!));
  }
  async function save() {
    setError(null); setKeyError(null);
    if (!current.mock && !current.configured && form.key.trim().length < 8) { setKeyError("Paste the provider's API key."); return; }
    if (form.key && /\s/.test(form.key.trim())) { setKeyError("Paste the whole key, with no spaces."); return; }
    if (needsStart && !form.start) { setError("Choose a starting model for OpenRouter first. You can change it for each job afterwards."); return; }
    setBusy(true);
    const r = await browserApi.call(endpoints.setAiProvider, { params: { ...params, provider: id }, body: {
      ...(needsStart && form.start ? { modelPrices: { [form.start.id]: form.start.entry }, defaultModel: form.start.id } : {}),
      ...(form.key.trim() ? { apiKey: form.key.trim() } : {}), ...(current.customBaseUrl ? { baseUrl: form.baseUrl.trim() || null } : {}),
      enabled: form.enabled, isDefault: form.isDefault && form.enabled,
    } });
    setBusy(false);
    setForm((f) => ({ ...f, key: "" })); // the key is gone from the page as soon as the server answered
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    toast("AI provider saved", "success");
    await onSaved();
  }

  return (
    <Panel id="ai-provider" className={cn("scroll-mt-14", highlight && "ring-2 ring-accent/40")}>
      <PanelHeader title="Connection" description="Where your AI requests are sent." actions={current.mock
        ? <Badge tone="warning">MOCK</Badge>
        : <Badge tone="warning">Not yet tested with a real request</Badge>} />
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex flex-col gap-4 p-4" noValidate>
        {highlight && <p className="text-sm font-medium text-accent-fg">Start here: choose a provider{providers.some((p) => !p.mock) ? ", add its key" : ""}, then pick a model for each job above.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Provider">{(p) => (
            <Select {...p} value={id} disabled={busy} onChange={(e) => choose(e.target.value)}>
              {providers.map((x) => <option key={x.id} value={x.id}>{x.label}{x.isDefault ? " (default)" : x.configured ? " (connected)" : ""}</option>)}
            </Select>
          )}</Field>
          {!current.mock && (
            <Field label="API key" error={keyError} hint={current.configured && current.keyLast4 ? `A key ending in ${current.keyLast4} is stored. Leave this empty to keep it. A new key replaces it.` : "Stored encrypted. It is never shown again; only its last four characters are."}>{(p) => (
              <Input {...p} type="password" autoComplete="off" spellCheck={false} value={form.key} disabled={busy} onChange={(e) => setForm({ ...form, key: e.target.value })} />
            )}</Field>
          )}
          {current.customBaseUrl && (
            <Field label="Base URL (optional)" hint="OpenAI-compatible servers only. Public https." className="sm:col-span-2">{(p) => (
              <Input {...p} inputMode="url" autoComplete="off" placeholder="https://api.openai.com/v1" value={form.baseUrl} disabled={busy} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
            )}</Field>
          )}
          {needsStart && (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-sm font-medium text-fg">Starting model</span>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="secondary" disabled={busy} onClick={() => setBrowse(true)}>{form.start ? "Change starting model" : "Choose a starting model"}</Button>
                <span className="min-w-0 break-all text-sm text-fg-muted">{form.start ? form.start.name : "None yet"}</span>
              </div>
              <p className="text-xs text-fg-subtle">OpenRouter needs one model to start. Afterwards each job gets its own.</p>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="inline-flex items-center gap-2 text-sm text-fg"><Switch label="Enabled" checked={form.enabled} disabled={busy} onCheckedChange={(v) => setForm({ ...form, enabled: v, isDefault: v && form.isDefault })} />Enabled</span>
          <Checkbox label="Use as the default provider" checked={form.isDefault && form.enabled} disabled={busy || !form.enabled} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} />
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <div><Button type="submit" variant="primary" loading={busy}><Plug className="size-4" aria-hidden />{current.configured ? "Save provider" : "Connect provider"}</Button></div>
      </form>
      {browse && <ModelBrowser open onOpenChange={setBrowse} workspaceId={params.workspaceId} provider={current} title="Choose a starting model" needs="text" current={form.start?.id ?? null} onChoose={async (row) => { setForm((f) => ({ ...f, start: row })); return null; }} />}
    </Panel>
  );
}

function WordingPointer({ workspaceId }: { workspaceId: string }) {
  return (
    <Panel className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0"><h2 className="text-base font-semibold text-fg">Reply wording</h2><p className="mt-0.5 text-sm text-fg-subtle">The instructions for reply suggestions now live with the agents.</p></div>
      <Button asChild><Link href={`/w/${workspaceId}/settings/ai/agents#reply-wording`}>Open reply wording in Agents</Link></Button>
    </Panel>
  );
}

function Advanced({ workspaceId, providers, active, onSaved }: { workspaceId: string; providers: AiProviderDto[]; active: AiProviderDto | null; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const prices = active?.id === "openrouter" ? active.modelPrices : null;
  const ids = prices ? Object.keys(prices) : [];
  async function remove(id: string) {
    if (!active || !prices) return;
    setError(null); setBusy(id);
    const { [id]: _drop, ...rest } = prices;
    const next = active.defaultModel === id ? Object.keys(rest)[0] : undefined;
    const r = await browserApi.call(endpoints.setAiProvider, { params: { workspaceId, provider: active.id }, body: { modelPrices: rest, ...(next ? { defaultModel: next } : {}) } });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    toast("Model removed", "success");
    await onSaved();
  }
  return (
    <section aria-labelledby="ai-advanced" className="flex flex-col gap-[var(--page-gap)]">
      <div><h2 id="ai-advanced" className="text-base font-semibold text-fg">Advanced</h2><p className="text-sm text-fg-subtle">What each model can do, the models you have turned on, and a place to test a file.</p></div>
      {prices && (
        <Panel>
          <PanelHeader title="Models in use" description={`${ids.length} of ${MAX_ENABLED}. Choosing a model for a job turns it on here.`} />
          <div className="flex flex-col gap-2 p-4">
            {error && <Alert tone="error">{error}</Alert>}
            {ids.length === 0 ? <p className="text-sm text-fg-muted">No models turned on yet.</p> : (
              <ul aria-label="Models in use" className="flex flex-col gap-2">
                {ids.map((m) => (
                  <li key={m} className="flex flex-wrap items-center gap-2 rounded-control border border-line-card px-3 py-2">
                    <span className="min-w-0 flex-1 basis-56 break-all text-sm text-fg">{m}{active?.defaultModel === m && <span className="ml-2 align-middle"><Badge tone="success">Default</Badge></span>}</span>
                    <Button type="button" variant="ghost" size="sm" loading={busy === m} disabled={ids.length === 1} aria-label={`Remove ${m}`} onClick={() => void remove(m)}>Remove</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      )}
      <CapabilitiesPanel workspaceId={workspaceId} providers={providers} />
      <MediaPlayground workspaceId={workspaceId} />
    </section>
  );
}

function BudgetPanel({ params, budget, usage, onSaved }: P & { budget: AiBudgetDto; usage: AiUsageDto; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [cap, setCap] = React.useState(budget.monthlyCapMicro === null ? "" : formatMicro(budget.monthlyCapMicro));
  const [hard, setHard] = React.useState(budget.hardStop);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function save() {
    setErr(null);
    const micro = cap.trim() === "" ? null : parseMicro(cap);
    if (cap.trim() !== "" && micro === null) { setErr("Enter an amount like 25 or 12.50."); return; }
    setBusy(true);
    const r = await browserApi.call(endpoints.setAiBudget, { params, body: { monthlyCapMicro: micro, hardStop: hard } });
    setBusy(false);
    if (!r.ok) { setErr(errorMessage(r.error)); return; }
    toast("Budget saved", "success");
    await onSaved();
  }
  const m = usage.month;
  return (
    <Panel id="ai-budget" className="scroll-mt-14">
      <PanelHeader title="Monthly budget" description="A limit in USD for all AI calls. The month is UTC. The hard stop blocks calls once it is reached." />
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex flex-col gap-3 p-4" noValidate>
        <Field label="Monthly limit (USD)" error={err} hint="Leave empty for no limit.">{(p) => <Input {...p} inputMode="decimal" autoComplete="off" className="max-w-48" value={cap} disabled={busy} onChange={(e) => setCap(e.target.value)} />}</Field>
        <Checkbox label="Hard stop: block AI calls when the limit is reached" checked={hard} disabled={busy} onChange={(e) => setHard(e.target.checked)} />
        <p className="text-sm text-fg-muted" role="status">
          Used this month: <strong className="font-medium text-fg">{formatMicro(m.usedMicro)}</strong>{m.capMicro !== null ? ` of ${formatMicro(m.capMicro)}` : " (no limit)"}.{" "}
          {m.blocked && <Badge tone="danger">Limit reached: AI calls are blocked</Badge>}
        </p>
        <div><Button type="submit" variant="primary" loading={busy}><Wallet className="size-4" aria-hidden />Save budget</Button></div>
      </form>
    </Panel>
  );
}

const JOB_OF_CAP: Record<string, (typeof JOB_ORDER)[number]> = { reply_suggestion: "reply", agent: "agent", vision: "vision", ocr: "document", transcription: "transcription" };

function UsagePanel({ usage }: { usage: AiUsageDto }) {
  const m = usage.month;
  const per = JOB_ORDER.map((job) => {
    const rows = usage.byDay.filter((d) => JOB_OF_CAP[d.capability] === job);
    return { job, runs: rows.reduce((n, d) => n + d.runs, 0), errors: rows.reduce((n, d) => n + d.errors, 0), blocked: rows.reduce((n, d) => n + d.blocked, 0), cost: rows.reduce((n, d) => n + d.costMicro, 0) };
  });
  const top = Math.max(1, ...per.map((x) => x.cost));
  const errors = usage.byDay.reduce((n, d) => n + d.errors, 0), blocked = usage.byDay.reduce((n, d) => n + d.blocked, 0);
  return (
    <Panel id="ai-usage" className="scroll-mt-14">
      <PanelHeader title="Usage" description="Last 30 days. Counts and costs only." />
      <div className="flex flex-col gap-3 p-4">
        <p className="text-sm text-fg-muted">This month: {m.runs} calls, {m.inputTokens.toLocaleString()} tokens in, {m.outputTokens.toLocaleString()} out{m.blockedRuns > 0 ? `, ${m.blockedRuns} blocked by the budget` : ""}.</p>
        {usage.byDay.length === 0 ? <EmptyState icon={BarChart3} title="No AI calls yet" description="Calls appear here when someone uses Suggest reply in the inbox or an agent runs." /> : (
          <>
            <ul aria-label="Usage by job" className="flex flex-col gap-2">
              {per.map((x) => (
                <li key={x.job} className="grid items-center gap-x-3 gap-y-1 sm:grid-cols-[12rem_minmax(0,1fr)_11rem]">
                  <span className="text-sm text-fg">{AI_JOBS[x.job].label}</span>
                  <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-hover"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.round((x.cost / top) * 100)}%` }} /></div>
                  <span className="text-sm text-fg-muted sm:text-right">{x.runs} call{x.runs === 1 ? "" : "s"}, ${formatMicro(x.cost)}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-fg-subtle">{errors} error{errors === 1 ? "" : "s"}, {blocked} blocked.</p>
            <Table scrollLabel="AI usage by day">
              <THead><TR><TH>Day</TH><TH>Feature</TH><TH>Calls</TH><TH>Errors</TH><TH>Blocked</TH><TH>Tokens in / out</TH><TH>Cost (USD)</TH></TR></THead>
              <TBody>
                {usage.byDay.map((d) => (
                  <TR key={`${d.day}-${d.capability}`}>
                    <TD>{d.day}</TD><TD>{d.capability === "reply_suggestion" ? "Reply suggestion" : d.capability}</TD><TD>{d.runs}</TD><TD>{d.errors}</TD><TD>{d.blocked}</TD>
                    <TD>{d.inputTokens.toLocaleString()} / {d.outputTokens.toLocaleString()}</TD><TD>{formatMicro(d.costMicro)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </>
        )}
      </div>
    </Panel>
  );
}
