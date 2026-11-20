"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BarChart3, CheckCircle2, ExternalLink, Plug, Wallet } from "lucide-react";
import { AI_JOBS, endpoints, type AiBudgetDto, type AiJobModelDto, type AiProviderDto, type AiUsageDto, type OpenRouterModelDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatMicro, parseMicro } from "@/lib/ai-money";
import { JobsPanel, JOB_ORDER } from "./jobs-matrix";
import { CapabilitiesPanel, MediaPlayground } from "./media-panels";
import { MAX_ENABLED, ModelBrowser, type ModelRow } from "./model-browser";

type Data = { providers: AiProviderDto[]; budget: AiBudgetDto; usage: AiUsageDto };

/**
 * Settings, AI, Setup. The provider key goes into a password field, is sent once over the same-origin proxy and cleared; the server never returns it (only the last four characters).
 * Real providers are UNVERIFIED (no recorded request to a live service); the mock provider is offline and says so wherever it is used.
 * The reply wording moved to the Agents tab (Settings, AI, Agents, "Reply suggestion wording").
 */
export function AiSettings({ workspaceId, dev = false }: { workspaceId: string; dev?: boolean }) {
  return <ToastProvider><Inner workspaceId={workspaceId} dev={dev} /></ToastProvider>;
}

function Inner({ workspaceId, dev }: { workspaceId: string; dev: boolean }) {
  const params = { workspaceId };
  const [data, setData] = React.useState<Data | null>(null);
  const [jobs, setJobs] = React.useState<AiJobModelDto[] | null>(null);
  const [jobsError, setJobsError] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const router = useRouter();

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
    router.refresh(); // the header card above the tabs (provider, spend) is rendered by the server
  }, [workspaceId, router]);
  React.useEffect(() => { void load(); }, [load]); // eslint-disable-line react-hooks/set-state-in-effect

  if (loadError) return <ErrorState title="Could not load AI settings" description={loadError} onRetry={() => { setLoadError(null); void load(); }} />;
  if (!data) return <div className="flex flex-col gap-4" role="status" aria-label="Loading AI settings"><Skeleton className="h-48" /><Skeleton className="h-40" /><Skeleton className="h-32" /></div>;
  // Mock is a developer tool: outside developer mode it never counts as a working provider.
  const real = data.providers.filter((p) => dev || !p.mock);
  const mockOn = data.providers.find((p) => p.mock && p.configured && p.enabled) ?? null;
  // Speech-only providers (Gemini) never act as the main provider for replies and notes.
  const chat = real.filter((p) => p.models.some((m) => (m.capabilities ?? ["text"]).includes("text")) || p.id === "openrouter");
  const active = chat.find((p) => p.configured && p.enabled && p.isDefault) ?? chat.find((p) => p.configured && p.enabled) ?? null;
  return (
    <div className="flex max-w-4xl flex-col gap-[var(--page-gap)]">
      {mockOn && dev && <Alert tone="warning">MOCK mode. The mock provider is offline and returns canned text, so every cost shows $0.</Alert>}
      {mockOn && !dev && <MockNotice params={params} onChanged={load} />}
      <ConnectCard params={params} providers={real} onSaved={load} />
      <JobsPanel workspaceId={workspaceId} providers={real} active={active} jobs={jobs} jobsError={jobsError} usage={data.usage} dev={dev} onChanged={load} onRetry={() => { setJobsError(null); void load(); }} />
      <BudgetPanel params={params} budget={data.budget} usage={data.usage} onSaved={load} />
      <WordingPointer workspaceId={workspaceId} />
      <Advanced workspaceId={workspaceId} providers={real} active={active} usage={data.usage} onSaved={load} />
    </div>
  );
}

type P = { params: { workspaceId: string } };

const KEY_LINKS: Record<string, string> = { gemini: "https://aistudio.google.com/apikey", openrouter: "https://openrouter.ai/keys", openai: "https://platform.openai.com/api-keys", anthropic: "https://console.anthropic.com/settings/keys" };

/** A sensible first model for OpenRouter so the owner never has to pick one before connecting: cheapest paid model that takes tools and structured output and has room for a conversation. */
export function pickStarter(items: OpenRouterModelDto[]): OpenRouterModelDto | null {
  const ok = items.filter((m) => m.supports.tools && m.supports.structuredOutput && (m.contextLength ?? 0) >= 32000 && m.inputMicroPer1M + m.outputMicroPer1M > 0 && !m.id.endsWith(":free") && !m.id.includes(":"));
  return ok.sort((a, b) => a.inputMicroPer1M + a.outputMicroPer1M - (b.inputMicroPer1M + b.outputMicroPer1M) || a.id.localeCompare(b.id))[0] ?? null;
}
const entryOfModel = (m: OpenRouterModelDto) => ({ inputMicroPer1M: m.inputMicroPer1M, outputMicroPer1M: m.outputMicroPer1M, capabilities: m.capabilities.filter((c) => c !== "text"), ...(m.contextLength ? { contextLength: m.contextLength } : {}), supports: m.supports });

type Test = { kind: "idle" } | { kind: "testing" } | { kind: "ok"; ms: number; model: string; mock: boolean } | { kind: "failed"; message: string };

function ConnectCard({ params, providers, onSaved }: P & { providers: AiProviderDto[]; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const initial = providers.find((x) => x.isDefault && x.configured) ?? providers.find((x) => x.configured) ?? providers[0]!;
  const [id, setId] = React.useState(initial.id);
  const current = providers.find((x) => x.id === id) ?? initial;
  const [key, setKey] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState(current.baseUrl ?? "");
  const [keyError, setKeyError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [test, setTest] = React.useState<Test>({ kind: "idle" });
  const [browse, setBrowse] = React.useState(false);
  const gateway = id === "openrouter";
  const chatCapable = gateway || current.models.some((m) => (m.capabilities ?? ["text"]).includes("text"));

  function choose(next: string) { setId(next); setKey(""); setKeyError(null); setTest({ kind: "idle" }); setBaseUrl(providers.find((x) => x.id === next)?.baseUrl ?? ""); }

  async function connect() {
    setKeyError(null); setTest({ kind: "idle" });
    const k = key.trim();
    if (!current.mock && !current.configured && !current.serverKey && k.length < 8) { setKeyError("Paste the provider's API key."); return; }
    if (k && /\s/.test(k)) { setKeyError("Paste the whole key, with no spaces."); return; }
    setBusy(true);
    // First connect on OpenRouter: pick a starting model for the owner (changeable any time).
    let starter: OpenRouterModelDto | null = null;
    if (gateway && Object.keys(current.modelPrices).length === 0) {
      const l = await browserApi.call(endpoints.listOpenRouterModels, { params });
      starter = l.ok ? pickStarter(l.data.items) : null;
      if (!starter) { setBusy(false); setTest({ kind: "failed", message: l.ok ? "No suitable starting model was found. Choose one with Change model." : errorMessage(l.error) }); return; }
    }
    const r = await browserApi.call(endpoints.setAiProvider, { params: { ...params, provider: id }, body: {
      ...(starter ? { modelPrices: { [starter.id]: entryOfModel(starter) }, defaultModel: starter.id } : {}),
      ...(k ? { apiKey: k } : {}), ...(current.customBaseUrl ? { baseUrl: baseUrl.trim() || null } : {}),
      enabled: true, isDefault: chatCapable,
    } });
    setKey(""); // the key leaves the page as soon as the server answered
    if (!r.ok) { setBusy(false); setTest({ kind: "failed", message: errorMessage(r.error) }); return; }
    await onSaved();
    await runTest();
    setBusy(false);
  }
  async function runTest() {
    setTest({ kind: "testing" });
    const t = await browserApi.call(endpoints.testAiProvider, { params: { ...params, provider: id } });
    if (!t.ok) { setTest({ kind: "failed", message: errorMessage(t.error) }); return; }
    setTest({ kind: "ok", ms: t.data.latencyMs, model: t.data.model, mock: t.data.mock });
    await onSaved();
  }
  async function changeModel(row: ModelRow): Promise<string | null> {
    const r = await browserApi.call(endpoints.setAiProvider, { params: { ...params, provider: id }, body: { modelPrices: { ...current.modelPrices, [row.id]: row.entry }, defaultModel: row.id } });
    if (!r.ok) return errorMessage(r.error);
    toast("Model changed. Test the connection again.", "success");
    setTest({ kind: "idle" });
    await onSaved();
    return null;
  }

  const tested = current.configured && !!current.lastOkAt;
  const badge = test.kind === "testing" ? <Badge tone="neutral">Testing...</Badge>
    : test.kind === "failed" ? <Badge tone="danger">Test failed</Badge>
    : tested || test.kind === "ok" ? <Badge tone="success"><CheckCircle2 aria-hidden className="size-3" />Connected and tested</Badge>
    : current.configured ? <Badge tone="warning">Key saved, not tested yet</Badge> : <Badge tone="neutral">Not connected</Badge>;
  const link = KEY_LINKS[id];
  const model = current.defaultModel ? (current.models.find((m) => m.id === current.defaultModel)?.label ?? current.defaultModel) : null;

  return (
    <Panel id="ai-provider" className="scroll-mt-14">
      <PanelHeader title="Connect AI" description="Paste your provider's key and test it. Replies are always drafts: a person reviews and sends them." actions={badge} />
      <form onSubmit={(e) => { e.preventDefault(); void connect(); }} className="flex flex-col gap-4 p-4" noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Provider">{(p) => (
            <Select {...p} value={id} disabled={busy} onChange={(e) => choose(e.target.value)}>
              {providers.map((x) => <option key={x.id} value={x.id}>{x.label}{x.mock ? " (developer)" : ""}</option>)}
            </Select>
          )}</Field>
          {!current.mock && (
            <Field label="API key" error={keyError} hint={current.configured && current.keyLast4 ? `A key ending in ${current.keyLast4} is stored. Leave this empty to keep it. A new key replaces it.` : current.serverKey ? "This server already has a key for this provider. Leave this empty to use it, or paste your own." : "Stored encrypted. It is never shown again."}>{(p) => (
              <Input {...p} type="password" autoComplete="off" spellCheck={false} value={key} disabled={busy} onChange={(e) => setKey(e.target.value)} />
            )}</Field>
          )}
          {current.customBaseUrl && (
            <Field label="Base URL (optional)" hint="OpenAI-compatible servers only. Public https." className="sm:col-span-2">{(p) => (
              <Input {...p} inputMode="url" autoComplete="off" placeholder="https://api.openai.com/v1" value={baseUrl} disabled={busy} onChange={(e) => setBaseUrl(e.target.value)} />
            )}</Field>
          )}
        </div>
        {link && <p className="text-sm text-fg-muted">No key yet? <a className="inline-flex items-center gap-1 font-medium text-accent-fg underline-offset-2 hover:underline" href={link} target="_blank" rel="noreferrer">Get a key<ExternalLink aria-hidden className="size-3.5" /></a></p>}
        <div role="status" aria-live="polite" className="flex flex-col gap-2">
          {test.kind === "ok" && <Alert tone="success">{test.mock ? "Mock answered offline. This does not prove a real provider works." : `Connected. A real request worked (${(test.ms / 1000).toFixed(1)} s).`}</Alert>}
          {test.kind === "failed" && <Alert tone="error">{test.message}</Alert>}
          {tested && test.kind === "idle" && current.lastOkAt && <p className="text-sm text-fg-muted">A real request last worked on {new Date(current.lastOkAt).toLocaleDateString()}.</p>}
        </div>
        {model && current.configured && (
          <p className="text-sm text-fg-muted">We use <span className="font-medium text-fg">{model}</span> for {chatCapable ? "replies and notes" : "voice messages"}. <button type="button" className="font-medium text-accent-fg underline-offset-2 hover:underline" onClick={() => setBrowse(true)}>Change model</button></p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={busy || test.kind === "testing"}><Plug className="size-4" aria-hidden />{current.configured ? (key.trim() ? "Save key and test" : "Test connection") : "Connect and test"}</Button>
        </div>
      </form>
      {browse && <ModelBrowser open onOpenChange={setBrowse} workspaceId={params.workspaceId} provider={current} title={chatCapable ? "Choose the main model" : "Choose the voice model"} needs={chatCapable ? "text" : "transcription"} current={current.defaultModel} onChoose={changeModel} />}
    </Panel>
  );
}

/** Outside developer mode: the offline mock provider is still switched on in this workspace. It returns canned text, so offer to turn it off. */
function MockNotice({ params, onChanged }: P & { onChanged: () => Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  async function off() {
    setBusy(true); setErr(null);
    const r = await browserApi.call(endpoints.setAiProvider, { params: { ...params, provider: "mock" }, body: { enabled: false, isDefault: false } });
    setBusy(false);
    if (!r.ok) { setErr(errorMessage(r.error)); return; }
    await onChanged();
  }
  return (
    <Alert tone="warning">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>The offline test provider (Mock) is switched on. It returns made-up text, so jobs that fall back to it give fake results. Turn it off for real work.</span>
        <Button type="button" size="sm" loading={busy} onClick={() => void off()}>Turn off Mock</Button>
      </div>
      {err && <p role="alert" className="mt-2 text-sm">{err}</p>}
    </Alert>
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

function Advanced({ workspaceId, providers, active, usage, onSaved }: { workspaceId: string; providers: AiProviderDto[]; active: AiProviderDto | null; usage: AiUsageDto; onSaved: () => Promise<void> }) {
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
      <UsagePanel usage={usage} />
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
