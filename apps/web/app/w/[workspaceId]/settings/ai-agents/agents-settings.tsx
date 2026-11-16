"use client";
import * as React from "react";
import { Bot, Play, Plus } from "lucide-react";
import { endpoints, type AgentActionDto, type AgentDto, type AgentRunResult, type AgentRunRow, type AgentToolDto, type AiProviderDto, type ContactSummary } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Checkbox, Textarea } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatMicro } from "@/lib/ai-money";

type Mode = "off" | "auto" | "approval";
type Form = { name: string; description: string; instructions: string; personality: string; language: string; responseStyle: string; model: string; temperature: string; grants: Record<string, Mode> };
const STYLES = ["concise", "detailed", "formal", "friendly"];
const emptyForm = (): Form => ({ name: "", description: "", instructions: "", personality: "", language: "auto", responseStyle: "concise", model: "", temperature: "0.4", grants: {} });
const STATUS_TONE = { draft: "neutral", active: "success", archived: "stone" } as const;
const SENS_TONE = { read: "neutral", write: "warning", sensitive: "danger" } as const;
const OUTCOME: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" | "accent" }> = {
  would_execute: { label: "Would execute", tone: "accent" }, would_pend: { label: "Would wait for approval", tone: "accent" }, executed: { label: "Executed", tone: "success" },
  pending: { label: "Pending approval", tone: "warning" }, failed: { label: "Failed", tone: "danger" }, rejected: { label: "Rejected", tone: "danger" },
};

/**
 * Settings, AI Agents (Phase 6 slice 2). Everything the model answers is a DRAFT; actions run only as the agent's grants allow, and sensitive ones wait here for approval.
 * The mock provider labels its output; real providers are UNVERIFIED.
 */
export function AgentsSettings({ workspaceId }: { workspaceId: string }) {
  return <ToastProvider><Inner workspaceId={workspaceId} /></ToastProvider>;
}

type Data = { agents: AgentDto[]; activeCount: number; maxActive: number; tools: AgentToolDto[]; models: { id: string; label: string; provider: string }[]; contacts: ContactSummary[] };

function Inner({ workspaceId }: { workspaceId: string }) {
  const params = { workspaceId };
  const [data, setData] = React.useState<Data | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | "new" | null>(null);
  const [actionsTick, setActionsTick] = React.useState(0);

  const load = React.useCallback(async () => {
    const [l, t, p, c] = await Promise.all([
      browserApi.call(endpoints.listAiAgents, { params: { workspaceId } }), browserApi.call(endpoints.listAiTools, { params: { workspaceId } }),
      browserApi.call(endpoints.listAiProviders, { params: { workspaceId } }), browserApi.call(endpoints.listContacts, { params: { workspaceId }, query: { limit: 50 } }),
    ]);
    const bad = [l, t, p, c].find((r) => !r.ok);
    if (bad && !bad.ok) { setLoadError(errorMessage(bad.error)); return; }
    if (l.ok && t.ok && p.ok && c.ok) {
      setLoadError(null);
      setData({ agents: l.data.items, activeCount: l.data.activeCount, maxActive: l.data.maxActive, tools: t.data.items, contacts: c.data.items, models: p.data.items.filter((x: AiProviderDto) => x.configured && x.enabled).flatMap((x: AiProviderDto) => x.models.map((m) => ({ id: m.id, label: `${m.label} (${x.label})`, provider: x.id }))) });
    }
  }, [workspaceId]);
  React.useEffect(() => { void load(); }, [load]); // eslint-disable-line react-hooks/set-state-in-effect

  if (loadError) return <ErrorState title="Could not load AI agents" description={loadError} onRetry={() => { setLoadError(null); void load(); }} />;
  if (!data) return <div className="flex flex-col gap-4" role="status" aria-label="Loading AI agents"><Skeleton className="h-40" /><Skeleton className="h-32" /></div>;
  const current = data.agents.find((a) => a.id === selected) ?? null;
  return (
    <div className="flex flex-col gap-[var(--page-gap)]">
      <Panel>
        <PanelHeader title="Agents" description={`${data.activeCount} of ${data.maxActive} active agents used.`} actions={<Button variant="primary" onClick={() => setSelected("new")}><Plus className="size-4" aria-hidden />New agent</Button>} />
        {data.agents.length === 0 ? (
          <EmptyState icon={Bot} title="No agents yet" description="Create one, give it instructions and the tools it may use, then test it before activating." action={<Button variant="primary" onClick={() => setSelected("new")}>Create an agent</Button>} />
        ) : (
          <Table scrollLabel="Agents">
            <THead><TR><TH>Name</TH><TH>Status</TH><TH>Version</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
            <TBody>
              {data.agents.map((a) => (
                <TR key={a.id}>
                  <TD className="font-medium">{a.name}{a.description && <span className="block text-xs font-normal text-fg-muted">{a.description}</span>}</TD>
                  <TD><Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge></TD>
                  <TD>{a.activeVersion ? `v${a.activeVersion} live` : "-"} <span className="text-xs text-fg-muted">(latest v{a.latestVersion})</span></TD>
                  <TD><Button size="sm" onClick={() => setSelected(a.id)} aria-label={`Edit ${a.name}`}>Edit</Button></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Panel>
      <PendingPanel params={params} tick={actionsTick} onChanged={() => setActionsTick((x) => x + 1)} />
      {selected && (selected === "new" || current) && (
        <Editor key={selected} params={params} data={data} agent={current} onSaved={async (id) => { await load(); setSelected(id); }} onClose={() => setSelected(null)} onActions={() => setActionsTick((x) => x + 1)} />
      )}
    </div>
  );
}

type P = { params: { workspaceId: string } };

function formOf(a: AgentDto | null): Form {
  const v = a?.versions.find((x) => x.id === a.activeVersionId) ?? a?.versions[0];
  if (!a || !v) return emptyForm();
  return { name: a.name, description: a.description, instructions: v.instructions, personality: v.personality, language: v.language, responseStyle: v.responseStyle, model: v.model ? `${v.provider ?? ""}|${v.model}` : "", temperature: String(v.temperature), grants: Object.fromEntries(v.toolGrants.map((g) => [g.tool, g.mode])) };
}

function Editor({ params, data, agent, onSaved, onClose, onActions }: P & { data: Data; agent: AgentDto | null; onSaved: (id: string) => Promise<void>; onClose: () => void; onActions: () => void }) {
  const toast = useToast();
  const [f, setF] = React.useState<Form>(() => formOf(agent));
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));

  async function save() {
    setError(null);
    const temperature = Number(f.temperature);
    if (!f.name.trim()) { setError("Give the agent a name."); return; }
    if (!f.instructions.trim()) { setError("Write the agent's instructions."); return; }
    if (!(temperature >= 0 && temperature <= 1)) { setError("Creativity must be between 0 and 1."); return; }
    const [provider, model] = f.model ? f.model.split("|") : [null, null];
    const def = {
      instructions: f.instructions, personality: f.personality, language: f.language.trim() || "auto", responseStyle: f.responseStyle.trim() || "concise", provider: provider ?? null, model: model ?? null, temperature,
      toolGrants: Object.entries(f.grants).filter(([, m]) => m !== "off").map(([tool, mode]) => ({ tool, mode: mode as "auto" | "approval" })),
    };
    setBusy("save");
    const r = agent
      ? await (async () => {
        if (f.name !== agent.name || f.description !== agent.description) { const u = await browserApi.call(endpoints.updateAiAgent, { params: { ...params, agentId: agent.id }, body: { name: f.name, description: f.description } }); if (!u.ok) return u; }
        return browserApi.call(endpoints.createAiAgentVersion, { params: { ...params, agentId: agent.id }, body: def });
      })()
      : await browserApi.call(endpoints.createAiAgent, { params, body: { ...def, name: f.name, description: f.description } });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    toast(agent ? `Saved as version ${r.data.latestVersion}. Activate it to use it.` : "Agent created as a draft", "success");
    await onSaved(r.data.id);
  }

  async function lifecycle(kind: "activate" | "archive", versionId?: string) {
    if (!agent) return;
    setError(null); setBusy(kind + (versionId ?? ""));
    const r = kind === "activate"
      ? await browserApi.call(endpoints.activateAiAgent, { params: { ...params, agentId: agent.id }, body: { versionId } })
      : await browserApi.call(endpoints.archiveAiAgent, { params: { ...params, agentId: agent.id } });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    toast(kind === "archive" ? "Agent archived" : `Version ${r.data.activeVersion} is live`, "success");
    await onSaved(agent.id);
  }

  return (
    <>
      <Panel>
        <PanelHeader title={agent ? `Edit: ${agent.name}` : "New agent"} description={agent ? "Saving creates a new version; the live version does not change until you activate one." : "Created as a draft. Test it, then activate it."} actions={<Button size="sm" onClick={onClose}>Close</Button>} />
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex flex-col gap-4 p-4" noValidate>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">{(p) => <Input {...p} value={f.name} maxLength={80} disabled={busy !== null} onChange={(e) => set({ name: e.target.value })} />}</Field>
            <Field label="Role" hint="One line about what this agent is for.">{(p) => <Input {...p} value={f.description} maxLength={300} disabled={busy !== null} onChange={(e) => set({ description: e.target.value })} />}</Field>
          </div>
          <Field label="Instructions" hint={`${f.instructions.length} / 6000 characters`}>{(p) => <Textarea {...p} rows={8} maxLength={6000} value={f.instructions} disabled={busy !== null} onChange={(e) => set({ instructions: e.target.value })} />}</Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Personality" hint="Optional tone, for example warm and direct.">{(p) => <Input {...p} value={f.personality} maxLength={500} disabled={busy !== null} onChange={(e) => set({ personality: e.target.value })} />}</Field>
            <Field label="Language" hint="A tag like en or pt-BR, or auto to match the customer.">{(p) => <Input {...p} value={f.language} maxLength={20} disabled={busy !== null} onChange={(e) => set({ language: e.target.value })} />}</Field>
            <Field label="Response style">{(p) => (
              <Select {...p} value={STYLES.includes(f.responseStyle) ? f.responseStyle : "custom"} disabled={busy !== null} onChange={(e) => set({ responseStyle: e.target.value === "custom" ? "" : e.target.value })}>
                {STYLES.map((s) => <option key={s} value={s}>{s}</option>)}<option value="custom">custom...</option>
              </Select>
            )}</Field>
            <Field label="Model override" hint="Empty uses the workspace default model.">{(p) => (
              <Select {...p} value={f.model} disabled={busy !== null} onChange={(e) => set({ model: e.target.value })}>
                <option value="">Workspace default</option>
                {data.models.map((m) => <option key={`${m.provider}|${m.id}`} value={`${m.provider}|${m.id}`}>{m.label}</option>)}
              </Select>
            )}</Field>
            {!STYLES.includes(f.responseStyle) && <Field label="Custom style">{(p) => <Input {...p} value={f.responseStyle} maxLength={60} disabled={busy !== null} onChange={(e) => set({ responseStyle: e.target.value })} />}</Field>}
            <Field label="Creativity (0 to 1)" hint="Lower is more predictable.">{(p) => <Input {...p} inputMode="decimal" value={f.temperature} disabled={busy !== null} onChange={(e) => set({ temperature: e.target.value })} />}</Field>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-fg">Tools</legend>
            <p className="text-xs text-fg-subtle">An agent can only use the tools you turn on. Sensitive tools always wait for a person, whatever the mode.</p>
            <Table scrollLabel="Tools">
              <THead><TR><TH>Tool</TH><TH>Type</TH><TH>Mode</TH></TR></THead>
              <TBody>
                {data.tools.map((t) => (
                  <TR key={t.name}>
                    <TD><span className="font-medium">{t.name}</span><span className="block text-xs text-fg-muted">{t.description}</span></TD>
                    <TD><Badge tone={SENS_TONE[t.sensitivity]}>{t.sensitivity === "sensitive" ? "sensitive: needs approval" : t.sensitivity}</Badge></TD>
                    <TD>
                      <Select aria-label={`Mode for ${t.name}`} value={f.grants[t.name] ?? "off"} disabled={busy !== null} onChange={(e) => set({ grants: { ...f.grants, [t.name]: e.target.value as Mode } })}>
                        <option value="off">Off</option>
                        {t.sensitivity !== "sensitive" && <option value="auto">Runs automatically</option>}
                        <option value="approval">Needs approval</option>
                      </Select>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </fieldset>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={busy === "save"}>{agent ? "Save as new version" : "Create agent"}</Button>
            {agent && agent.status !== "archived" && <Button loading={busy === "archive"} onClick={() => void lifecycle("archive")}>Archive</Button>}
          </div>
        </form>
      </Panel>
      {agent && <VersionsPanel agent={agent} busy={busy} onActivate={(id) => void lifecycle("activate", id)} />}
      {agent && <TestPanel params={params} agent={agent} contacts={data.contacts} onActions={onActions} />}
      {agent && <RunsPanel params={params} agent={agent} />}
    </>
  );
}

function VersionsPanel({ agent, busy, onActivate }: { agent: AgentDto; busy: string | null; onActivate: (versionId: string) => void }) {
  return (
    <Panel>
      <PanelHeader title="Versions" description="Versions are never edited. To roll back, activate an older one." />
      <Table scrollLabel="Versions">
        <THead><TR><TH>Version</TH><TH>Saved</TH><TH>Tools</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
        <TBody>
          {agent.versions.map((v) => {
            const live = v.id === agent.activeVersionId && agent.status === "active";
            return (
              <TR key={v.id}>
                <TD>v{v.version} {live && <Badge tone="success">live</Badge>}</TD>
                <TD>{new Date(v.createdAt).toLocaleString()}</TD>
                <TD>{v.toolGrants.length}</TD>
                <TD>{!live && <Button size="sm" loading={busy === `activate${v.id}`} onClick={() => onActivate(v.id)} aria-label={`${v.version === agent.latestVersion ? "Activate" : "Roll back to"} version ${v.version}`}>{v.version === agent.latestVersion ? "Activate" : "Roll back to this"}</Button>}</TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </Panel>
  );
}

function TestPanel({ params, agent, contacts, onActions }: P & { agent: AgentDto; contacts: ContactSummary[]; onActions: () => void }) {
  const [input, setInput] = React.useState("");
  const [contactId, setContactId] = React.useState("");
  const [dryRun, setDryRun] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [res, setRes] = React.useState<AgentRunResult | null>(null);

  async function run() {
    if (!input.trim()) { setError("Write a customer message to test with."); return; }
    setError(null); setBusy(true);
    const r = await browserApi.call(endpoints.testAiAgent, { params: { ...params, agentId: agent.id }, body: { input, dryRun, ...(contactId ? { contactId } : {}) } });
    setBusy(false);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    setRes(r.data);
    if (!dryRun) onActions();
  }

  return (
    <Panel>
      <PanelHeader title="Test playground" description="Try the agent on a made-up customer message. In a dry run nothing is changed: write tools only show what they would do." />
      <form onSubmit={(e) => { e.preventDefault(); void run(); }} className="flex flex-col gap-3 p-4" noValidate>
        <Field label="Customer message">{(p) => <Textarea {...p} rows={3} maxLength={4000} value={input} disabled={busy} onChange={(e) => setInput(e.target.value)} />}</Field>
        <Field label="Contact (needed for tools that change a contact)">{(p) => (
          <Select {...p} value={contactId} disabled={busy} onChange={(e) => setContactId(e.target.value)}>
            <option value="">No contact</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        )}</Field>
        <Checkbox label="Dry run (change nothing)" checked={dryRun} disabled={busy} onChange={(e) => setDryRun(e.target.checked)} />
        {!dryRun && <Alert tone="warning">Live test: automatic write tools will really run on the chosen contact, and sensitive ones will be queued for approval below.</Alert>}
        {error && <Alert tone="error">{error}</Alert>}
        <div><Button type="submit" variant="primary" loading={busy}><Play className="size-4" aria-hidden />Run test</Button></div>
      </form>
      {res && (
        <div className="flex flex-col gap-3 border-t border-line-card p-4" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-fg">Reply draft (never sent)</h3>
            {res.mock && <Badge tone="warning">MOCK</Badge>}
            {res.malformed && <Badge tone="danger">Not valid JSON: shown as text, no actions</Badge>}
            {res.dryRun && <Badge tone="accent">dry run</Badge>}
          </div>
          <p className="whitespace-pre-wrap rounded-control bg-hover p-3 text-sm text-fg">{res.reply || "(empty)"}</p>
          <h3 className="text-sm font-semibold text-fg">Actions</h3>
          {res.actions.length === 0 ? <p className="text-sm text-fg-muted">The agent proposed no actions.</p> : (
            <ul className="flex flex-col gap-2">
              {res.actions.map((a, i) => (
                <li key={i} className="rounded-control border border-line-card p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{a.tool || "(invalid action)"}</span><Badge tone={OUTCOME[a.status]!.tone}>{OUTCOME[a.status]!.label}</Badge>{a.detail && <span className="text-xs text-fg-muted">{a.detail}</span>}</div>
                  {Object.keys(a.args).length > 0 && <code className="mt-1 block break-all text-xs text-fg-muted">{JSON.stringify(a.args)}</code>}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-fg-subtle">Version {res.agentVersion} · {res.model} · {res.usage.inputTokens} in / {res.usage.outputTokens} out tokens · cost {formatMicro(res.usage.costMicro)} USD</p>
        </div>
      )}
    </Panel>
  );
}

function RunsPanel({ params, agent }: P & { agent: AgentDto }) {
  const [rows, setRows] = React.useState<AgentRunRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.listAiAgentRuns, { params: { ...params, agentId: agent.id }, query: { limit: 20 } });
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    setError(null); setRows(r.data.items);
  }, [params, agent.id]);
  React.useEffect(() => { void load(); }, [load]); // eslint-disable-line react-hooks/set-state-in-effect
  return (
    <Panel>
      <PanelHeader title="Recent runs" description="Status, tokens, cost and speed of this agent's model calls (no prompts or replies are stored)." actions={<Button size="sm" onClick={() => void load()}>Refresh</Button>} />
      {error ? <ErrorState title="Could not load runs" description={error} onRetry={() => void load()} /> : !rows ? <div role="status" aria-label="Loading runs" className="p-4"><Skeleton className="h-16" /></div> : rows.length === 0 ? <EmptyState title="No runs yet" description="Run a test to see usage here." /> : (
        <Table scrollLabel="Runs">
          <THead><TR><TH>When</TH><TH>Status</TH><TH>Version</TH><TH>Model</TH><TH>Tokens</TH><TH>Cost (USD)</TH><TH>Time</TH></TR></THead>
          <TBody>
            {rows.map((x) => (
              <TR key={x.id}>
                <TD>{new Date(x.createdAt).toLocaleString()}</TD>
                <TD><Badge tone={x.status === "ok" ? "success" : "danger"}>{x.status === "ok" ? "ok" : x.errorCode ?? x.status}</Badge></TD>
                <TD>v{x.agentVersion}</TD><TD>{x.model}</TD><TD>{x.inputTokens + x.outputTokens}</TD><TD>{formatMicro(x.costMicro)}</TD><TD>{x.latencyMs} ms</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Panel>
  );
}

function PendingPanel({ params, tick, onChanged }: P & { tick: number; onChanged: () => void }) {
  const toast = useToast();
  const [items, setItems] = React.useState<AgentActionDto[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.listAiAgentActions, { params, query: { status: "pending" } });
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    setError(null); setItems(r.data.items);
  }, [params]);
  React.useEffect(() => { void load(); }, [load, tick]); // eslint-disable-line react-hooks/set-state-in-effect

  async function decide(a: AgentActionDto, approve: boolean) {
    setBusy(a.id);
    const r = await browserApi.call(approve ? endpoints.approveAiAgentAction : endpoints.rejectAiAgentAction, { params: { ...params, actionId: a.id } });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); await load(); return; }
    toast(!approve ? "Action rejected" : r.data.status === "executed" ? "Action approved and done" : `Action ${r.data.status}${r.data.error ? `: ${r.data.error}` : ""}`, r.data.status === "failed" ? "error" : "success");
    await load(); onChanged();
  }
  return (
    <Panel>
      <PanelHeader title="Pending approvals" description="Actions agents proposed that need a person to approve them. Approving runs the action as you." />
      {error && <div className="p-4 pb-0"><Alert tone="error">{error}</Alert></div>}
      {!items ? <div role="status" aria-label="Loading approvals" className="p-4"><Skeleton className="h-12" /></div> : items.length === 0 ? <EmptyState title="Nothing waiting" description="Proposed actions that need approval appear here." /> : (
        <ul className="divide-y divide-line-card">
          {items.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">{a.tool} <span className="font-normal text-fg-muted">by {a.agentName} v{a.agentVersion}</span></p>
                <code className="block break-all text-xs text-fg-muted">{JSON.stringify(a.args)}</code>
                <p className="text-xs text-fg-subtle">{a.reason === "sensitive" ? "Sensitive tool" : "Needs approval by its grant"} · {a.source}</p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="primary" loading={busy === a.id} onClick={() => void decide(a, true)} aria-label={`Approve ${a.tool}`}>Approve</Button>
                <Button size="sm" disabled={busy === a.id} onClick={() => void decide(a, false)} aria-label={`Reject ${a.tool}`}>Reject</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
