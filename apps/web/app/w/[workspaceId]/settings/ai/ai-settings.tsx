"use client";
import * as React from "react";
import { BarChart3, Sparkles } from "lucide-react";
import { endpoints, type AiBudgetDto, type AiPromptDto, type AiProviderDto, type AiUsageDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/overlays";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Checkbox, Textarea } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { tabClass } from "@/components/ui/tabs";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatMicro, parseMicro } from "@/lib/ai-money";
import { CapabilitiesPanel, MediaPlayground } from "./media-panels";
import { OpenRouterModels, type Picked } from "./openrouter-models";

type Data = { providers: AiProviderDto[]; prompts: AiPromptDto[]; budget: AiBudgetDto; usage: AiUsageDto };

/**
 * Settings, AI (Phase 6 slice 1). The provider key goes into a password field, is sent once over the same-origin proxy and cleared; the server never returns it (only the last four characters).
 * Real providers are UNVERIFIED (no recorded request to a live service); the mock provider is offline and says so wherever it is used.
 */
const SECTIONS = [{ id: "ai-provider", label: "Provider" }, { id: "ai-prompts", label: "Prompts" }, { id: "ai-budget", label: "Budget and usage" }, { id: "ai-capabilities", label: "Capabilities" }, { id: "ai-playground", label: "Media playground" }];

export function AiSettings({ workspaceId }: { workspaceId: string }) {
  return <ToastProvider><Inner workspaceId={workspaceId} /></ToastProvider>;
}

function Inner({ workspaceId }: { workspaceId: string }) {
  const params = { workspaceId };
  const [data, setData] = React.useState<Data | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const [p, pr, b, u] = await Promise.all([
      browserApi.call(endpoints.listAiProviders, { params: { workspaceId } }), browserApi.call(endpoints.listAiPrompts, { params: { workspaceId } }),
      browserApi.call(endpoints.getAiBudget, { params: { workspaceId } }), browserApi.call(endpoints.getAiUsage, { params: { workspaceId }, query: { days: 30 } }),
    ]);
    const bad = [p, pr, b, u].find((r) => !r.ok);
    if (bad && !bad.ok) { setLoadError(errorMessage(bad.error)); return; }
    if (p.ok && pr.ok && b.ok && u.ok) { setLoadError(null); setData({ providers: p.data.items, prompts: pr.data.items, budget: b.data, usage: u.data }); }
  }, [workspaceId]);
  React.useEffect(() => { void load(); }, [load]); // eslint-disable-line react-hooks/set-state-in-effect

  if (loadError) return <ErrorState title="Could not load AI settings" description={loadError} onRetry={() => { setLoadError(null); void load(); }} />;
  if (!data) return <div className="flex flex-col gap-4" role="status" aria-label="Loading AI settings"><Skeleton className="h-48" /><Skeleton className="h-40" /><Skeleton className="h-32" /></div>;
  return (
    <div className="flex flex-col gap-[var(--page-gap)]">
      {/* In-page index: the AI page is long, so each part has an anchor and the index stays in view while scrolling. */}
      <nav aria-label="On this page" data-scroll="allowed" className="sticky top-0 z-10 -mx-1 flex gap-1.5 overflow-x-auto bg-canvas/95 px-1 py-2 backdrop-blur">
        {SECTIONS.map((s) => <a key={s.id} href={`#${s.id}`} className={tabClass(false)}>{s.label}</a>)}
      </nav>
      <section id="ai-provider" aria-label="Provider" className="scroll-mt-14"><ProviderPanel params={params} providers={data.providers} onSaved={load} /></section>
      <section id="ai-prompts" aria-label="Prompts" className="scroll-mt-14"><PromptPanel params={params} prompts={data.prompts} onSaved={load} /></section>
      <section id="ai-budget" aria-label="Budget" className="scroll-mt-14 flex flex-col gap-[var(--page-gap)]"><BudgetPanel params={params} budget={data.budget} usage={data.usage} onSaved={load} /><UsagePanel usage={data.usage} /></section>
      <section id="ai-capabilities" aria-label="Capabilities" className="scroll-mt-14"><CapabilitiesPanel workspaceId={workspaceId} providers={data.providers} /></section>
      <section id="ai-playground" aria-label="Media playground" className="scroll-mt-14"><MediaPlayground workspaceId={workspaceId} /></section>
    </div>
  );
}

type P = { params: { workspaceId: string } };

function ProviderPanel({ params, providers, onSaved }: P & { providers: AiProviderDto[]; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const initial = providers.find((x) => x.isDefault) ?? providers.find((x) => x.configured) ?? providers[0]!;
  const [id, setId] = React.useState(initial.id);
  const current = providers.find((x) => x.id === id)!;
  const fill = (x: AiProviderDto) => ({ model: x.defaultModel ?? x.models[0]?.id ?? "", picked: (x.modelPrices ?? {}) as Picked, baseUrl: x.baseUrl ?? "", enabled: x.configured ? x.enabled : true, isDefault: x.configured ? x.isDefault : !providers.some((o) => o.isDefault), key: "" });
  const [form, setForm] = React.useState(() => fill(initial));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [keyError, setKeyError] = React.useState<string | null>(null);

  function choose(next: string) {
    setId(next); setError(null); setKeyError(null);
    setForm(fill(providers.find((x) => x.id === next)!));
  }
  async function save() {
    setError(null); setKeyError(null);
    if (!current.mock && !current.configured && form.key.trim().length < 8) { setKeyError("Paste the provider's API key."); return; }
    if (form.key && /\s/.test(form.key.trim())) { setKeyError("Paste the whole key, with no spaces."); return; }
    const gateway = id === "openrouter";
    if (gateway && (!Object.keys(form.picked).length || !form.picked[form.model])) { setError("Enable at least one model and choose one of the enabled models as the default."); return; }
    setBusy(true);
    const r = await browserApi.call(endpoints.setAiProvider, { params: { ...params, provider: id }, body: {
      ...(gateway ? { modelPrices: form.picked } : {}),
      ...(form.key.trim() ? { apiKey: form.key.trim() } : {}), ...(current.customBaseUrl ? { baseUrl: form.baseUrl.trim() || null } : {}),
      defaultModel: form.model, enabled: form.enabled, isDefault: form.isDefault && form.enabled,
    } });
    setBusy(false);
    setForm((f) => ({ ...f, key: "" })); // the key is gone from the page as soon as the server answered
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    toast("AI provider saved", "success");
    await onSaved();
  }

  const model = current.models.find((m) => m.id === form.model);
  return (
    <Panel>
      <PanelHeader title="Provider" description="The service and model your drafts come from." actions={current.mock ? <Tooltip label="Canned text. No AI service is called." side="bottom"><span><Badge tone="warning">MOCK</Badge></span></Tooltip> : <Tooltip label="No recorded request to the live service yet. Try one suggestion and check the usage table." side="bottom"><span><Badge tone="warning">Not tested live</Badge></span></Tooltip>} />
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex flex-col gap-4 p-4" noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Provider">{(p) => (
            <Select {...p} value={id} disabled={busy} onChange={(e) => choose(e.target.value)}>
              {providers.map((x) => <option key={x.id} value={x.id}>{x.label}{x.isDefault ? " (default)" : x.configured ? " (connected)" : ""}</option>)}
            </Select>
          )}</Field>
          {id !== "openrouter" && (
            <Field label="Model" hint={model && !current.mock ? `Price per 1M tokens: ${formatMicro(model.inputMicroPer1M)} in, ${formatMicro(model.outputMicroPer1M)} out (USD, indicative)` : undefined}>{(p) => (
              <Select {...p} value={form.model} disabled={busy} onChange={(e) => setForm({ ...form, model: e.target.value })}>
                {current.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </Select>
            )}</Field>
          )}
          {id === "openrouter" && (
            <OpenRouterModels workspaceId={params.workspaceId} picked={form.picked} onPicked={(p) => setForm((f) => ({ ...f, picked: p }))} defaultModel={form.model} onDefault={(m) => setForm((f) => ({ ...f, model: m }))} disabled={busy} />
          )}
          {!current.mock && (
            <Field label="API key" error={keyError} hint={current.configured && current.keyLast4 ? `A key ending in ${current.keyLast4} is stored. Leave this empty to keep it. A new key replaces it.` : "Stored encrypted. It is never shown again; only its last four characters are."} className="sm:col-span-2">{(p) => (
              <Input {...p} type="password" autoComplete="off" spellCheck={false} value={form.key} disabled={busy} onChange={(e) => setForm({ ...form, key: e.target.value })} />
            )}</Field>
          )}
          {current.customBaseUrl && (
            <Field label="Base URL (optional)" hint="OpenAI-compatible servers only. Public https." className="sm:col-span-2">{(p) => (
              <Input {...p} inputMode="url" autoComplete="off" placeholder="https://api.openai.com/v1" value={form.baseUrl} disabled={busy} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
            )}</Field>
          )}
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <Checkbox label="Enabled" checked={form.enabled} disabled={busy} onChange={(e) => setForm({ ...form, enabled: e.target.checked, isDefault: e.target.checked && form.isDefault })} />
          <Checkbox label="Use for reply suggestions (default)" checked={form.isDefault && form.enabled} disabled={busy || !form.enabled} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} />
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <div><Button type="submit" variant="primary" loading={busy}><Sparkles className="size-4" aria-hidden />{current.configured ? "Save provider" : "Connect provider"}</Button></div>
      </form>
    </Panel>
  );
}

function PromptPanel({ params, prompts, onSaved }: P & { prompts: AiPromptDto[]; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const pr = prompts[0]!;
  const activeText = pr.versions.find((v) => v.active)?.template ?? pr.defaultTemplate;
  const [text, setText] = React.useState(activeText);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const changed = text.trim() !== activeText.trim();

  async function publish() {
    setError(null); setBusy("publish");
    const r = await browserApi.call(endpoints.setAiPrompt, { params: { ...params, key: pr.key }, body: { template: text } });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    toast("New prompt version published", "success");
    await onSaved();
  }
  async function activate(version: number) {
    setError(null); setBusy(`v${version}`);
    const r = await browserApi.call(endpoints.activateAiPrompt, { params: { ...params, key: pr.key }, body: { version } });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    setText(r.data.versions.find((v) => v.active)?.template ?? r.data.defaultTemplate);
    toast(version === 0 ? "Built-in prompt is active" : `Version ${version} is active`, "success");
    await onSaved();
  }

  return (
    <Panel>
      <PanelHeader title={`Prompt: ${pr.label}`} description="Sent with every suggestion. Each save is a new version." />
      <div className="flex flex-col gap-4 p-4">
        <form onSubmit={(e) => { e.preventDefault(); void publish(); }} className="flex flex-col gap-3" noValidate>
          <Field label="Prompt template" hint={`Placeholders: ${pr.variables.map((v) => `{{${v}}}`).join(", ")}. Nothing else is allowed.`}>{(p) => (
            <Textarea {...p} rows={8} maxLength={4000} value={text} disabled={busy !== null} onChange={(e) => setText(e.target.value)} />
          )}</Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" loading={busy === "publish"} disabled={!changed || !text.trim()}>Publish as new version</Button>
            <span className="text-sm text-fg-muted">{pr.activeVersion === 0 ? "Using the built-in prompt." : `Version ${pr.activeVersion} is active.`}</span>
          </div>
        </form>
        {error && <Alert tone="error">{error}</Alert>}
        <section aria-labelledby="prompt-versions">
          <h3 id="prompt-versions" className="mb-2 text-sm font-medium text-fg">Versions</h3>
          <ul className="flex flex-col gap-2">
            <li className="flex flex-wrap items-center gap-3 rounded-control border border-line-card px-3 py-2">
              <span className="min-w-0 flex-1 text-sm text-fg">Built-in default</span>
              {pr.activeVersion === 0 ? <Badge tone="success">Active</Badge> : <Button size="sm" onClick={() => void activate(0)} loading={busy === "v0"} aria-label="Use the built-in prompt">Use this</Button>}
            </li>
            {pr.versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-3 rounded-control border border-line-card px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-fg">Version {v.version} <span className="text-fg-muted">· {new Date(v.createdAt).toLocaleDateString()}</span></span>
                {v.active ? <Badge tone="success">Active</Badge> : <Button size="sm" onClick={() => void activate(v.version)} loading={busy === `v${v.version}`} aria-label={`Use version ${v.version}`}>Use this</Button>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Panel>
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
    <Panel>
      <PanelHeader title="Monthly budget" description="Monthly limit (UTC). The hard stop blocks calls once it is reached." />
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex flex-col gap-3 p-4" noValidate>
        <Field label="Monthly limit (USD)" error={err} hint="Leave empty for no limit.">{(p) => <Input {...p} inputMode="decimal" autoComplete="off" className="max-w-48" value={cap} disabled={busy} onChange={(e) => setCap(e.target.value)} />}</Field>
        <Checkbox label="Hard stop: block AI calls when the limit is reached" checked={hard} disabled={busy} onChange={(e) => setHard(e.target.checked)} />
        <p className="text-sm text-fg-muted" role="status">
          Used this month: <strong className="font-medium text-fg">{formatMicro(m.usedMicro)}</strong>{m.capMicro !== null ? ` of ${formatMicro(m.capMicro)}` : " (no limit)"}.{" "}
          {m.blocked && <Badge tone="danger">Limit reached: AI calls are blocked</Badge>}
        </p>
        <div><Button type="submit" variant="primary" loading={busy}>Save budget</Button></div>
      </form>
    </Panel>
  );
}

function UsagePanel({ usage }: { usage: AiUsageDto }) {
  const m = usage.month;
  return (
    <Panel>
      <PanelHeader title="Usage" description="Last 30 days. Counts and costs only." />
      <div className="flex flex-col gap-3 p-4">
        <p className="text-sm text-fg-muted">This month: {m.runs} calls, {m.inputTokens.toLocaleString()} tokens in, {m.outputTokens.toLocaleString()} out{m.blockedRuns > 0 ? `, ${m.blockedRuns} blocked by the budget` : ""}.</p>
        {usage.byDay.length === 0 ? <EmptyState icon={BarChart3} title="No AI calls yet" description="Calls appear here when someone uses Suggest reply in the inbox." /> : (
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
        )}
      </div>
    </Panel>
  );
}
