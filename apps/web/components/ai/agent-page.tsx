"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowLeft, BarChart3, Bot, BookOpen, Check, ChevronDown, ChevronRight, Clock, Eye, FileText, Flag, ListChecks, Lock, MessageSquare, Mic, Play, Search, Sparkles, Users, Wrench, X } from "lucide-react";
import { endpoints, type AgentDto, type AgentRunResult, type AgentRunRow, type AgentToolDto, type AiProviderDto, type ContactSummary } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { notifyAiChanged } from "@/components/ai/hub-status";
import { cn } from "@/lib/cn";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatMicro } from "@/lib/ai-money";

type Mode = "off" | "auto" | "approval";
type Form = { name: string; description: string; instructions: string; personality: string; language: string; responseStyle: string; model: string; temperature: number; grants: Record<string, Mode> };
const emptyForm = (): Form => ({ name: "", description: "", instructions: "", personality: "", language: "auto", responseStyle: "concise", model: "", temperature: 0.4, grants: {} });

const STYLES = [["concise", "Concise", "Short answers, one or two sentences."], ["detailed", "Detailed", "Full explanations, step by step."], ["formal", "Formal", "Polite and businesslike."], ["friendly", "Friendly", "Relaxed and personal."]] as const;
const TONES = ["Warm", "Direct", "Formal", "Playful"];
const LANGS = [["auto", "Match the customer"], ["en", "English"], ["bn", "বাংলা (Bangla)"], ["pt-BR", "Português (Brasil)"]] as const;
const MODES: { id: Mode; label: string }[] = [{ id: "off", label: "Off" }, { id: "approval", label: "Ask me" }, { id: "auto", label: "Auto" }];

type ToolUi = { title: string; text: string; group: string; icon: React.ComponentType<{ className?: string }> };
const TOOL_UI: Record<string, ToolUi> = {
  "crm.find_contact": { title: "Look up a lead", text: "Finds people by name, email or phone. Up to 5 matches.", group: "Leads", icon: Search },
  "crm.add_note": { title: "Add an internal note", text: "Writes a note on the lead. The customer never sees it.", group: "Leads", icon: FileText },
  "crm.create_task": { title: "Create a follow-up task", text: "Adds a task on the lead, with an optional due time and priority.", group: "Leads", icon: ListChecks },
  "crm.add_tag": { title: "Add a tag", text: "Tags the lead. The tag is created if it does not exist.", group: "Leads", icon: Flag },
  "crm.assign_owner": { title: "Assign to a teammate", text: "Hands the lead to a workspace member.", group: "Leads", icon: Users },
  "knowledge.search": { title: "Search your knowledge", text: "Looks up FAQs, policies and product info. Up to 5 snippets with their source.", group: "Knowledge", icon: BookOpen },
  "media.describe_image": { title: "Look at an image", text: "Describes a photo the customer sent. Counts against the AI budget.", group: "Files", icon: Eye },
  "media.extract_text": { title: "Read text from an image or PDF", text: "Reads a document or a photo of one (OCR). Counts against the AI budget.", group: "Files", icon: FileText },
  "media.transcribe": { title: "Listen to a voice message", text: "Turns an audio message into text. Counts against the AI budget.", group: "Files", icon: Mic },
};
const toolUi = (t: AgentToolDto): ToolUi => TOOL_UI[t.name] ?? { title: t.name, text: t.description, group: "Other", icon: Wrench };
const OUTCOME: Record<string, { label: string; tone: "ok" | "warn" | "bad" }> = {
  would_execute: { label: "Would do it", tone: "ok" }, would_pend: { label: "Would wait for you", tone: "warn" }, executed: { label: "Done", tone: "ok" }, pending: { label: "Waits for you", tone: "warn" }, failed: { label: "Failed", tone: "bad" }, rejected: { label: "Rejected", tone: "bad" },
};

const STEPS = [
  { name: "Basics", sub: "Name and purpose", title: "Let's set up your agent", text: "Start from a template, or fill in the basics yourself.", icon: Sparkles },
  { name: "How it talks", sub: "Instructions and tone", title: "How should it talk?", text: "Tell the agent how to behave. This is the most important part.", icon: MessageSquare },
  { name: "What it can do", sub: "Tools and permissions", title: "What can it do?", text: "Give it only what it needs. You stay in control of anything that changes your data.", icon: Wrench },
  { name: "Test and start", sub: "Try it, then switch it on", title: "Try it, then switch it on", text: "Pretend to be a customer. Nothing is sent unless you turn off the dry run.", icon: Play },
] as const;

const TEMPLATES: { id: string; name: string; text: string; hue: string; icon: React.ComponentType<{ className?: string }>; f: Partial<Form> & { name: string } }[] = [
  { id: "support", name: "Customer support", text: "Answers questions from your knowledge, creates a task when it cannot.", hue: "bg-accent-subtle text-accent-fg", icon: MessageSquare, f: { name: "Support helper", description: "Answers customer questions and hands off what it cannot solve", instructions: "You help customers of our shop.\nAnswer from the knowledge base first. If you are not sure, say so and create a follow-up task for the team.\nNever promise a refund or a delivery date.", personality: "Warm", grants: { "knowledge.search": "auto", "crm.find_contact": "auto", "crm.add_note": "approval", "crm.create_task": "approval" } } },
  { id: "sales", name: "Sales assistant", text: "Qualifies new enquiries and tags them for the team.", hue: "bg-success-bg text-success-fg", icon: BarChart3, f: { name: "Sales helper", description: "Qualifies enquiries and prepares a hand-off", instructions: "You talk to people who ask about prices or products.\nFind out what they need, how many, and by when. Add a note with the answers and tag the lead.", personality: "Direct", grants: { "crm.find_contact": "auto", "knowledge.search": "auto", "crm.add_note": "approval", "crm.add_tag": "approval" } } },
  { id: "orders", name: "Order status", text: "Checks the order and reads photos of receipts.", hue: "bg-warning-bg text-warning-fg", icon: ListChecks, f: { name: "Order helper", description: "Helps customers with the status of their order", instructions: "Ask for the order number or a photo of the receipt. Read it and answer from the knowledge base.", personality: "Formal", grants: { "media.extract_text": "auto", "media.describe_image": "auto", "knowledge.search": "auto", "crm.create_task": "approval" } } },
];

type Data = { tools: AgentToolDto[]; models: { id: string; label: string; provider: string; supports?: { tools: boolean; structuredOutput: boolean } }[]; defaultKey: string | null; contacts: ContactSummary[] };

function formOf(a: AgentDto | null): Form {
  const v = a?.versions.find((x) => x.id === a.activeVersionId) ?? a?.versions[0];
  if (!a || !v) return emptyForm();
  return { name: a.name, description: a.description, instructions: v.instructions, personality: v.personality, language: v.language, responseStyle: v.responseStyle, model: v.model ? `${v.provider ?? ""}|${v.model}` : "", temperature: v.temperature, grants: Object.fromEntries(v.toolGrants.map((g) => [g.tool, g.mode as Mode])) };
}

/** Everything about one agent on its own page: a short guided flow for a new agent, the same four steps (all reachable) when editing. Everything the model answers is a DRAFT. */
export function AgentPage({ workspaceId, agentId }: { workspaceId: string; agentId: string | null }) {
  return <ToastProvider><Inner workspaceId={workspaceId} agentId={agentId} /></ToastProvider>;
}

function Inner({ workspaceId, agentId }: { workspaceId: string; agentId: string | null }) {
  const params = { workspaceId };
  const toast = useToast();
  const [data, setData] = React.useState<Data | null>(null);
  const [agent, setAgent] = React.useState<AgentDto | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [f, setF] = React.useState<Form>(emptyForm);
  const [base, setBase] = React.useState<Form>(emptyForm);
  const [step, setStep] = React.useState(0);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const dirty = JSON.stringify(f) !== JSON.stringify(base);

  const load = React.useCallback(async () => {
    const [t, p, c, a] = await Promise.all([
      browserApi.call(endpoints.listAiTools, { params: { workspaceId } }), browserApi.call(endpoints.listAiProviders, { params: { workspaceId } }),
      browserApi.call(endpoints.listContacts, { params: { workspaceId }, query: { kind: "all", limit: 50 } }),
      agentId ? browserApi.call(endpoints.getAiAgent, { params: { workspaceId, agentId } }) : Promise.resolve(null),
    ]);
    const bad = [t, p, c, a].find((r) => r && !r.ok);
    if (bad && !bad.ok) { setLoadError(errorMessage(bad.error)); return; }
    if (t.ok && p.ok && c.ok && (a === null || a.ok)) {
      setLoadError(null);
      setData({ tools: t.data.items, contacts: c.data.items, models: p.data.items.filter((x: AiProviderDto) => x.configured && x.enabled).flatMap((x: AiProviderDto) => x.models.map((m) => ({ id: m.id, label: `${m.label} (${x.label})`, provider: x.id, supports: m.supports }))), defaultKey: ((d) => (d?.defaultModel ? `${d.id}|${d.defaultModel}` : null))(p.data.items.find((x: AiProviderDto) => x.configured && x.enabled && x.isDefault)) });
      if (a?.ok) { setAgent(a.data); const fm = formOf(a.data); setF(fm); setBase(fm); }
    }
  }, [workspaceId, agentId]);
  React.useEffect(() => { void load(); }, [load]); // eslint-disable-line react-hooks/set-state-in-effect

  React.useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const checks = [
    { ok: f.name.trim().length > 0, text: "Give it a name" },
    { ok: f.instructions.trim().length >= 20, text: "Write instructions (at least a sentence)" },
    { ok: agent !== null && !dirty, text: "Save it", soft: true },
  ];
  const canActivate = checks[0]!.ok && checks[1]!.ok;

  /** One save: a new agent is created as a draft; an existing one gets a new version. Returns the saved agent. */
  async function save(quiet = false): Promise<AgentDto | null> {
    setError(null);
    if (!f.name.trim()) { setError("Give the agent a name."); setStep(0); return null; }
    if (!f.instructions.trim()) { setError("Write the agent's instructions."); setStep(1); return null; }
    const [provider, model] = f.model ? f.model.split("|") : [null, null];
    const def = { instructions: f.instructions, personality: f.personality, language: f.language.trim() || "auto", responseStyle: f.responseStyle.trim() || "concise", provider: provider ?? null, model: model ?? null, temperature: f.temperature, toolGrants: Object.entries(f.grants).filter(([, m]) => m !== "off").map(([tool, mode]) => ({ tool, mode: mode as "auto" | "approval" })) };
    setBusy("save");
    let r;
    if (agent) {
      if (f.name !== agent.name || f.description !== agent.description) { const u = await browserApi.call(endpoints.updateAiAgent, { params: { ...params, agentId: agent.id }, body: { name: f.name, description: f.description } }); if (!u.ok) { setBusy(null); setError(errorMessage(u.error)); return null; } }
      r = await browserApi.call(endpoints.createAiAgentVersion, { params: { ...params, agentId: agent.id }, body: def });
    } else r = await browserApi.call(endpoints.createAiAgent, { params, body: { ...def, name: f.name, description: f.description } });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return null; }
    if (!agent) window.history.replaceState(null, "", `/w/${workspaceId}/agents/${r.data.id}`);
    setAgent(r.data); setBase(f);
    if (!quiet) toast(agent ? `Saved as version ${r.data.latestVersion}. Activate it to use it.` : "Agent created as a draft", "success");
    notifyAiChanged();
    return r.data;
  }

  async function lifecycle(kind: "activate" | "archive", versionId?: string) {
    let a = agent;
    if (kind === "activate" && (dirty || !a)) a = await save(true);
    if (!a) return;
    setError(null); setBusy(kind + (versionId ?? ""));
    const r = kind === "activate" ? await browserApi.call(endpoints.activateAiAgent, { params: { ...params, agentId: a.id }, body: { versionId } }) : await browserApi.call(endpoints.archiveAiAgent, { params: { ...params, agentId: a.id } });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    toast(kind === "archive" ? "Agent archived" : `Version ${r.data.activeVersion} is live`, "success");
    setAgent(r.data); if (kind === "activate" && versionId) { const fm = formOf(r.data); setF(fm); setBase(fm); }
    notifyAiChanged();
  }

  if (loadError) return <ErrorState title="Could not load this agent" description={loadError} onRetry={() => { setLoadError(null); void load(); }} />;
  if (!data) return <div role="status" aria-label="Loading agent" className="flex flex-col gap-4"><Skeleton className="h-10 w-64" /><Skeleton className="h-96" /></div>;

  const s = STEPS[step]!;
  const live = agent?.status === "active";
  const last = step === STEPS.length - 1;
  const hasTools = Object.values(f.grants).some((m) => m !== "off");
  return (
    <div className="mx-auto w-full max-w-[78rem]">
      <div className="mb-4 flex items-center gap-3">
        <Link href={`/w/${workspaceId}/settings/ai/agents`} aria-label="Back to agents" className="press -ml-2 inline-flex size-11 items-center justify-center rounded-control text-fg-muted hover:bg-hover lg:hidden"><ArrowLeft className="size-5" aria-hidden /></Link>
        <nav aria-label="Breadcrumb" className="hidden min-w-0 flex-1 items-center gap-2 text-base text-fg-subtle lg:flex"><Link href={`/w/${workspaceId}/settings/ai/agents`} className="inline-flex min-h-11 items-center text-fg-muted hover:underline">Agents</Link><ChevronRight className="size-4" aria-hidden /><span className="truncate font-semibold text-fg">{f.name || "New agent"}</span></nav>
        <p className="min-w-0 flex-1 truncate text-md font-semibold text-fg lg:hidden">{f.name || "New agent"}</p>
        <Badge tone={live ? "success" : "neutral"}>{live ? `Active · v${agent?.activeVersion}` : agent ? `Draft · v${agent.latestVersion}` : "Draft"}</Badge>
      </div>
      <div className="mb-4 flex items-center gap-3 lg:hidden"><span className="text-xs font-semibold text-fg-subtle">Step {step + 1} of 4</span><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-hover"><div className="h-full rounded-full bg-accent transition-[width] duration-[var(--dur-slow)]" style={{ width: `${(step + 1) * 25}%` }} /></div></div>

      <div className="grid gap-8 lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,1fr)_18.5rem]">
        <nav aria-label="Steps" className="hidden self-start pt-2 lg:sticky lg:top-6 lg:block">
          {STEPS.map((x, i) => (
            <button key={x.name} type="button" onClick={() => setStep(i)} aria-current={i === step ? "step" : undefined} className={cn("relative flex w-full items-start gap-3.5 pb-7 text-left last:pb-0", i === step ? "text-fg" : i < step ? "text-fg-muted" : "text-fg-subtle hover:text-fg-muted")}>
              <span className={cn("relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold transition-all duration-[var(--dur-base)]", i < step ? "border-accent bg-accent text-on-accent" : i === step ? "border-accent bg-surface text-accent-fg ring-4 ring-accent/15" : "border-line-control bg-surface")}>{i < step ? <Check className="size-4" aria-hidden /> : i + 1}</span>
              {i < STEPS.length - 1 && <span aria-hidden className={cn("absolute left-[15px] top-9 -bottom-0.5 w-0.5 rounded", i < step ? "bg-accent" : "bg-line")} />}
              <span className="pt-0.5"><span className="block text-base font-semibold">{x.name}</span><span className="block text-xs text-fg-subtle">{x.sub}</span></span>
            </button>
          ))}
        </nav>

        <main className="min-w-0 rise rounded-card bg-surface px-4 py-5 shadow-sheet sm:px-8 sm:py-8 max-lg:rounded-none max-lg:shadow-none" key={step}>
          <header className="mb-7 flex items-center gap-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-accent-subtle text-accent-fg"><s.icon className="size-6" aria-hidden /></span>
            <div className="min-w-0"><h1 className="text-xl font-bold tracking-title text-fg sm:text-2xl">{s.title}</h1><p className="mt-1 text-base text-fg-muted">{s.text}</p></div>
          </header>
          {error && <Alert tone="error" className="mb-5">{error}</Alert>}
          {step === 0 && <StepBasics f={f} set={set} />}
          {step === 1 && <StepTalk f={f} set={set} />}
          {step === 2 && <StepTools f={f} set={set} data={data} hasTools={hasTools} />}
          {step === 3 && <StepTest workspaceId={workspaceId} agent={agent} data={data} dirty={dirty} canActivate={canActivate} checks={checks} onSave={() => save(true)} onActivate={(v) => void lifecycle("activate", v)} onArchive={() => void lifecycle("archive")} busy={busy} />}
        </main>

        <aside aria-label="Preview" className="hidden self-start xl:sticky xl:top-6 xl:block"><Preview f={f} data={data} /></aside>
      </div>

      <div className="sticky bottom-0 z-20 -mx-4 mt-6 border-t border-line bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:-mx-6 sm:px-6 lg:mx-0 lg:rounded-card lg:border lg:shadow-sheet">
        <div className="mx-auto flex max-w-[78rem] items-center gap-3">
          <Button size="lg" disabled={step === 0} onClick={() => setStep(step - 1)} className="max-lg:flex-1 pointer-coarse:h-12">Back</Button>
          <div aria-hidden className="mx-auto hidden items-center gap-2 lg:flex">{STEPS.map((_, i) => <i key={i} className={cn("h-2 rounded-full transition-all duration-[var(--dur-base)]", i === step ? "w-6 bg-accent" : i < step ? "w-2 bg-accent" : "w-2 bg-line-control")} />)}</div>
          <div className="flex flex-1 items-center justify-end gap-3 lg:flex-none">
            <button type="button" onClick={() => void save()} disabled={busy !== null || !dirty} className="hidden min-h-11 rounded px-2 text-base font-medium text-fg-muted underline underline-offset-4 hover:text-fg disabled:no-underline disabled:opacity-50 lg:inline">{busy === "save" ? "Saving…" : dirty || !agent ? "Save draft" : "Saved"}</button>
            {last ? <Button variant="primary" size="lg" loading={busy?.startsWith("activate") || busy === "save"} disabled={live && !dirty || !canActivate} onClick={() => void lifecycle("activate")} className="max-lg:flex-1 pointer-coarse:h-12">{live && !dirty ? "Active" : dirty && live ? "Save and activate" : "Activate"}</Button>
              : <Button variant="primary" size="lg" onClick={() => setStep(step + 1)} className="max-lg:flex-1 pointer-coarse:h-12">Next<ChevronRight aria-hidden /></Button>}
          </div>
        </div>
      </div>
    </div>
  );
}

const Label = ({ id, children, right }: { id: string; children: React.ReactNode; right?: React.ReactNode }) => <div className="mb-2 flex items-baseline justify-between gap-2"><label htmlFor={id} className="text-md font-semibold text-fg">{children}</label>{right}</div>;
const Hint = ({ children }: { children: React.ReactNode }) => <p className="mt-1.5 text-sm text-fg-subtle">{children}</p>;
const field = "h-[3.25rem] rounded-xl border-[1.5px] border-line bg-subtle px-4 text-md focus-visible:bg-surface";

function StepBasics({ f, set }: { f: Form; set: (p: Partial<Form>) => void }) {
  return (
    <div className="flex flex-col gap-6">
      <div role="group" aria-label="Templates" className="grid gap-3 sm:grid-cols-3">
        {TEMPLATES.map((t) => {
          const on = f.name === t.f.name;
          return (
            <button key={t.id} type="button" aria-pressed={on} onClick={() => set(t.f)} className={cn("press relative flex flex-col gap-1 rounded-2xl border-[1.5px] p-4 text-left transition-[border-color,background-color,transform] duration-[var(--dur-base)] hover:-translate-y-0.5 max-sm:flex-row max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3", on ? "border-accent bg-accent-subtle/40" : "border-line hover:border-line-strong")}>
              <span className={cn("mb-2 flex size-10 items-center justify-center rounded-xl max-sm:mb-0", t.hue)}><t.icon className="size-5" aria-hidden /></span>
              <span className="text-md font-semibold text-fg max-sm:flex-1">{t.name}</span>
              <span className="text-sm text-fg-subtle max-sm:basis-full max-sm:pl-[3.25rem]">{t.text}</span>
              {on && <span className="absolute right-3 top-3 flex size-6 items-center justify-center rounded-full bg-accent text-on-accent"><Check className="size-3.5" aria-hidden /></span>}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3 text-sm text-fg-subtle"><span className="h-px flex-1 bg-line" />or start blank<span className="h-px flex-1 bg-line" /></div>
      <div><Label id="agent-name">Name</Label><Input id="agent-name" className={field} value={f.name} maxLength={80} placeholder="e.g. Support helper" onChange={(e) => set({ name: e.target.value })} autoComplete="off" /><Hint>What your team will call it. Customers do not see this.</Hint></div>
      <div><Label id="agent-role">Role</Label><Input id="agent-role" className={field} value={f.description} maxLength={300} placeholder="e.g. Answers questions about delivery and returns" onChange={(e) => set({ description: e.target.value })} autoComplete="off" /><Hint>One line about what this agent is for. It shows in the list of agents.</Hint></div>
    </div>
  );
}

function StepTalk({ f, set }: { f: Form; set: (p: Partial<Form>) => void }) {
  const [tips, setTips] = React.useState(false);
  const knownLang = LANGS.some(([k]) => k === f.language);
  const knownStyle = STYLES.some(([k]) => k === f.responseStyle);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Label id="agent-instr" right={<span className={cn("tnum text-sm", f.instructions.length > 6000 ? "font-semibold text-danger-fg" : "text-fg-subtle")}>{f.instructions.length.toLocaleString("en-US")} / 6,000 characters</span>}>Instructions</Label>
        <Textarea voice id="agent-instr" rows={8} maxLength={6000} value={f.instructions} onChange={(e) => set({ instructions: e.target.value })} placeholder="You help customers of our shop. Answer from the knowledge base first…" className="min-h-48 rounded-xl border-[1.5px] bg-subtle px-4 py-3.5 text-md focus-visible:bg-surface" />
        <button type="button" aria-expanded={tips} onClick={() => setTips((t) => !t)} className="mt-1 inline-flex min-h-11 items-center gap-2 rounded font-semibold text-accent-fg"><Sparkles className="size-4" aria-hidden />What makes good instructions?</button>
        {tips && <ul className="list-disc rounded-xl bg-accent-subtle/50 py-3.5 pl-9 pr-4 text-base leading-relaxed text-fg-muted"><li>Say who it is talking to and what it should answer.</li><li>Say what it should do when it is not sure.</li><li>Say what it must never promise, like refunds or dates.</li></ul>}
      </div>
      <div>
        <p id="tone-label" className="mb-2 text-md font-semibold text-fg">Personality</p>
        <div role="group" aria-labelledby="tone-label" className="flex flex-wrap gap-2">
          {TONES.map((t) => <button key={t} type="button" aria-pressed={f.personality === t} onClick={() => set({ personality: f.personality === t ? "" : t })} className={cn("press h-11 rounded-full border-[1.5px] px-4 text-base font-medium", f.personality === t ? "border-accent bg-accent text-on-accent" : "border-line hover:bg-hover")}>{t}</button>)}
        </div>
        <Input aria-label="Describe the personality in your own words" className={cn(field, "mt-3")} value={TONES.includes(f.personality) ? "" : f.personality} maxLength={500} placeholder="Or describe it, for example warm and direct" onChange={(e) => set({ personality: e.target.value })} />
        <Hint>Optional. Sets the tone of every reply.</Hint>
      </div>
      <div>
        <Label id="agent-lang">Language</Label>
        <Select id="agent-lang" className={field} value={knownLang ? f.language : "other"} onChange={(e) => set({ language: e.target.value === "other" ? "" : e.target.value })}>
          {LANGS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}<option value="other">Other…</option>
        </Select>
        {!knownLang && <Input aria-label="Language tag" className={cn(field, "mt-2")} value={f.language} maxLength={20} placeholder="A tag like fr or es-MX" onChange={(e) => set({ language: e.target.value })} />}
        <Hint>“Match the customer” answers in the language they write in.</Hint>
      </div>
      <div>
        <p id="style-label" className="mb-2 text-md font-semibold text-fg">Answer length and style</p>
        <Segmented ariaLabelledBy="style-label" options={[...STYLES.map(([k, v]) => ({ id: k as string, label: v })), { id: "custom", label: "Custom" }]} value={knownStyle ? f.responseStyle : "custom"} onChange={(v) => set({ responseStyle: v === "custom" ? "" : v })} />
        {!knownStyle ? <Input aria-label="Custom style" className={cn(field, "mt-2")} value={f.responseStyle} maxLength={60} placeholder="Describe the style" onChange={(e) => set({ responseStyle: e.target.value })} /> : <Hint>{STYLES.find((x) => x[0] === f.responseStyle)![2]}</Hint>}
      </div>
    </div>
  );
}

/** A segmented control with a thumb that glides to the chosen option. */
function Segmented({ options, value, onChange, ariaLabel, ariaLabelledBy, tone, disabled }: { options: { id: string; label: string; disabled?: boolean }[]; value: string; onChange: (v: string) => void; ariaLabel?: string; ariaLabelledBy?: string; tone?: "ok" | "warn"; disabled?: boolean }) {
  const idx = Math.max(0, options.findIndex((o) => o.id === value));
  return (
    <div role="group" aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} className="relative grid rounded-xl bg-hover p-[3px]" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      <i aria-hidden className="absolute bottom-[3px] left-[3px] top-[3px] rounded-[9px] bg-surface shadow-control transition-transform duration-[var(--dur-slow)] ease-[var(--ease-out)]" style={{ width: `calc((100% - 6px) / ${options.length})`, transform: `translateX(${idx * 100}%)` }} />
      {options.map((o) => <button key={o.id} type="button" aria-pressed={value === o.id} disabled={disabled || o.disabled} onClick={() => onChange(o.id)} className={cn("relative z-10 h-11 rounded-[9px] px-2 text-base font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40", value === o.id ? (tone === "ok" ? "text-success-fg" : tone === "warn" ? "text-warning-fg" : "text-fg") : "text-fg-muted")}>{o.label}</button>)}
    </div>
  );
}

function ModelCaps({ data, model, hasTools }: { data: Data; model: string; hasTools: boolean }) {
  const key = model || data.defaultKey;
  const m = key ? data.models.find((x) => `${x.provider}|${x.id}` === key) : undefined;
  const tools = m?.supports?.tools === true, structured = m?.supports?.structuredOutput === true;
  const native = hasTools && tools;
  return (
    <div className="flex flex-col gap-1.5" data-testid="model-caps">
      <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
        <span className="font-medium text-fg">This model will use:</span>
        <Badge tone={native ? "success" : "neutral"}>{native ? "Native tool calls" : "JSON tool protocol"}</Badge>
        <Badge tone={!native && structured ? "success" : "neutral"}>{!native && structured ? "Structured output" : "Prompt-based JSON"}</Badge>
      </div>
      <p className="text-sm text-fg-subtle">
        {!m ? "Choose a model, or connect a provider, to see this." : native ? "The model calls tools through the provider's tool-call format. Grants, approvals and the 3-action limit apply exactly as before."
          : hasTools && !tools ? "This model does not advertise tool calling, so the agent asks it for a JSON answer and validates it. Grants and approvals are unchanged."
          : structured ? "No tools are turned on, so the reply is requested as structured JSON and still validated." : "The agent asks for a JSON answer in the prompt and validates it. Capabilities are only known for OpenRouter models."}
      </p>
    </div>
  );
}

function StepTools({ f, set, data, hasTools }: { f: Form; set: (p: Partial<Form>) => void; data: Data; hasTools: boolean }) {
  const groups: { name: string; items: AgentToolDto[] }[] = [];
  for (const t of data.tools) { const g = toolUi(t).group; const x = groups.find((y) => y.name === g); if (x) x.items.push(t); else groups.push({ name: g, items: [t] }); }
  const GROUP_ICON: Record<string, React.ComponentType<{ className?: string }>> = { Leads: Users, Knowledge: BookOpen, Files: FileText, Other: Wrench };
  return (
    <div>
      <p className="text-base text-fg-muted"><b className="text-fg">Off</b> it cannot use it. <b className="text-fg">Ask me</b> it proposes, you approve. <b className="text-fg">Auto</b> it does it by itself (only for tools that are safe to run alone).</p>
      {groups.map((g) => {
        const GI = GROUP_ICON[g.name] ?? Wrench;
        return (
          <section key={g.name} aria-label={g.name}>
            <h2 className="mb-1 mt-7 flex items-center gap-2 text-sm font-bold text-fg-subtle"><GI className="size-4" aria-hidden />{g.name}</h2>
            <ul>
              {g.items.map((t) => {
                const u = toolUi(t);
                const sens = t.sensitivity === "sensitive";
                const m: Mode = f.grants[t.name] ?? "off";
                return (
                  <li key={t.name} className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-x-4 gap-y-3 border-t border-line-card py-4 first:border-t-0 sm:grid-cols-[2.75rem_minmax(0,1fr)_14rem]">
                    <span className={cn("flex size-11 items-center justify-center rounded-xl transition-colors", m !== "off" ? "bg-accent-subtle text-accent-fg" : "bg-hover text-fg-subtle")}><u.icon className="size-5" aria-hidden /></span>
                    <div className="min-w-0"><p className="text-md font-semibold text-fg">{u.title}</p><p className="mt-0.5 text-sm text-fg-subtle">{u.text}</p>{sens && <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-semibold text-danger-fg"><Lock className="size-3.5" aria-hidden />Always asks a person first (sensitive)</p>}</div>
                    <div className="max-sm:col-span-2"><Segmented ariaLabel={`Mode for ${t.name}`} tone={m === "auto" ? "ok" : m === "approval" ? "warn" : undefined} value={m} onChange={(v) => set({ grants: { ...f.grants, [t.name]: v as Mode } })} options={MODES.map((o) => ({ id: o.id, label: o.label, disabled: sens && o.id === "auto" }))} /></div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <details className="group mt-7 border-t border-line">
        <summary className="flex min-h-14 cursor-pointer list-none items-center gap-2.5 font-semibold text-fg [&::-webkit-details-marker]:hidden"><Wrench className="size-4" aria-hidden />Advanced: model and creativity<ChevronDown className="ml-auto size-4 transition-transform group-open:rotate-180" aria-hidden /></summary>
        <div className="flex flex-col gap-5 pb-2 pt-3">
          <div><Label id="agent-model">Model</Label>
            <Select id="agent-model" className={field} value={f.model} onChange={(e) => set({ model: e.target.value })}>
              <option value="">Workspace default</option>
              {data.models.map((m) => <option key={`${m.provider}|${m.id}`} value={`${m.provider}|${m.id}`}>{m.label}</option>)}
            </Select>
            <Hint>Leave on the workspace default unless you know you need another.</Hint>
          </div>
          <ModelCaps data={data} model={f.model} hasTools={hasTools} />
          <div>
            <Label id="agent-temp" right={<span className="tnum text-sm font-semibold text-fg">{f.temperature.toFixed(2)}</span>}>Creativity</Label>
            <input id="agent-temp" type="range" min={0} max={1} step={0.05} value={f.temperature} onChange={(e) => set({ temperature: Number(e.target.value) })} className="h-11 w-full accent-[var(--accent)]" />
            <div className="flex justify-between text-sm text-fg-subtle"><span>Predictable</span><span>Creative</span></div>
          </div>
        </div>
      </details>
    </div>
  );
}

function StepTest({ workspaceId, agent, data, dirty, canActivate, checks, onSave, onActivate, onArchive, busy }: { workspaceId: string; agent: AgentDto | null; data: Data; dirty: boolean; canActivate: boolean; checks: { ok: boolean; text: string; soft?: boolean }[]; onSave: () => Promise<AgentDto | null>; onActivate: (versionId: string) => void; onArchive: () => void; busy: string | null }) {
  const toast = useToast();
  const [input, setInput] = React.useState("");
  const [contactId, setContactId] = React.useState("");
  const [dryRun, setDryRun] = React.useState(true);
  const [run, setRun] = React.useState<{ input: string; res: AgentRunResult } | null>(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function test() {
    if (!input.trim()) { setError("Write a customer message to test with."); return; }
    setError(null); setRunning(true);
    let a = agent;
    if (!a || dirty) { a = await onSave(); if (!a) { setRunning(false); return; } toast("Saved first: the test uses the saved version.", "success"); }
    const r = await browserApi.call(endpoints.testAiAgent, { params: { workspaceId, agentId: a.id }, body: { input, dryRun, ...(contactId ? { contactId } : {}) } });
    setRunning(false);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    setRun({ input, res: r.data });
    if (!dryRun) notifyAiChanged();
  }
  const res = run?.res;
  return (
    <div>
      <div>
        <label htmlFor="test-input" className="mb-2 block text-md font-semibold text-fg">Pretend the customer writes</label>
        <Textarea id="test-input" rows={2} maxLength={4000} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Hi, can I return the blue jacket?" className="min-h-[4.5rem] rounded-xl border-[1.5px] bg-subtle px-4 py-3 text-md focus-visible:bg-surface" />
      </div>
      <div className="mt-4"><label htmlFor="test-lead" className="mb-2 block text-md font-semibold text-fg">Lead <span className="font-normal text-fg-subtle">(needed for tools that change a lead)</span></label>
        <Select id="test-lead" className={field} value={contactId} onChange={(e) => setContactId(e.target.value)}><option value="">No lead</option>{data.contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <label className="flex min-h-12 cursor-pointer items-center gap-3"><input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="size-5 accent-[var(--accent)]" /><span><b className="block text-base font-semibold text-fg">Dry run (change nothing)</b><span className="block text-sm text-fg-subtle">Nothing is sent or changed</span></span></label>
        <Button variant="primary" size="lg" loading={running} onClick={() => void test()} className="max-sm:w-full pointer-coarse:h-12"><Play aria-hidden />{res ? "Run again" : "Run test"}</Button>
      </div>
      {!dryRun && <Alert tone="warning" className="mt-3">Live test: write tools will really run. Sensitive ones wait for approval.</Alert>}
      {(dirty || !agent) && <p className="mt-2 text-sm text-fg-subtle">The test runs the saved version, so your changes are saved as a new version first.</p>}
      {error && <Alert tone="error" className="mt-3">{error}</Alert>}
      {(running || res) && (
        <div className="mt-5 flex flex-col gap-3 rounded-2xl bg-subtle p-4 sm:p-5" aria-live="polite">
          {run && <div className="flex items-end gap-2.5"><span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-xs font-bold text-accent-fg">You</span><p className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-surface px-4 py-2.5 text-md shadow-control">{run.input}</p></div>}
          {running && !res ? <div className="flex justify-end"><span role="status" className="rounded-2xl bg-accent px-4 py-3 text-on-accent">Running…</span></div> : res && (
            <>
              <div className="flex items-end justify-end gap-2.5">
                <p className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-md text-on-accent">{res.reply || "(empty)"}</p>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent"><Bot className="size-4" aria-hidden /></span>
              </div>
              <div className="flex flex-wrap items-center gap-2 pl-10"><span className="text-sm font-semibold text-fg">Reply draft (never sent)</span>{res.mock && <Badge tone="warning">MOCK</Badge>}{res.malformed && <Badge tone="danger">Not valid JSON: shown as text, no actions</Badge>}{res.dryRun && <Badge tone="accent">dry run</Badge>}</div>
              {res.actions.length === 0 ? <p className="pl-10 text-sm text-fg-muted">The agent proposed no actions.</p> : (
                <ul className="flex flex-col gap-2 sm:pl-10">
                  {res.actions.map((a, i) => {
                    const o = OUTCOME[a.status]!;
                    return (
                      <li key={i} className="rounded-xl bg-surface px-3.5 py-2.5 text-base shadow-control">
                        <div className="flex flex-wrap items-center gap-2">{o.tone === "ok" ? <Check className="size-4 text-success-fg" aria-hidden /> : o.tone === "warn" ? <Clock className="size-4 text-warning-fg" aria-hidden /> : <X className="size-4 text-danger-fg" aria-hidden />}<span className="font-medium">{a.tool || "(invalid action)"}</span><span className={cn("ml-auto font-semibold", o.tone === "ok" ? "text-success-fg" : o.tone === "warn" ? "text-warning-fg" : "text-danger-fg")}>{o.label}</span>{a.detail && <span className="basis-full text-sm text-fg-muted">{a.detail}</span>}</div>
                        {Object.keys(a.args).length > 0 && <code className="mt-1 block break-all text-xs text-fg-muted">{JSON.stringify(a.args)}</code>}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="pl-10 text-xs text-fg-subtle">Version {res.agentVersion} · {res.model}{res.via ? ` · ${res.via === "native_tools" ? "native tool calls" : res.via === "json_schema" ? "structured output" : "JSON in text"}` : ""} · {res.usage.inputTokens} in / {res.usage.outputTokens} out tokens · cost {formatMicro(res.usage.costMicro)} USD</p>
            </>
          )}
        </div>
      )}
      <h2 className="mb-2 mt-8 text-md font-semibold text-fg">Before it goes live</h2>
      <div className="flex flex-wrap gap-2">{checks.map((c) => <span key={c.text} className={cn("inline-flex min-h-9 items-center gap-2 rounded-full px-3.5 text-sm font-medium", c.ok ? "bg-success-bg text-success-fg" : "bg-hover text-fg-muted")}>{c.ok ? <Check className="size-3.5" aria-hidden /> : <i className="size-3.5 rounded-full border-2 border-line-control" />}{c.text}{c.soft && !c.ok ? " (recommended)" : ""}</span>)}</div>
      {canActivate && <p className="mt-4 flex items-center gap-3 rounded-2xl bg-success-bg p-4 font-semibold text-success-fg"><Check className="size-5" aria-hidden />All set. You can activate it.</p>}
      {agent && <Versions agent={agent} busy={busy} onActivate={onActivate} />}
      {agent && <Runs workspaceId={workspaceId} agent={agent} />}
      {agent && agent.status !== "archived" && <div className="mt-8"><Button variant="ghost" loading={busy === "archive"} onClick={onArchive}>Archive this agent</Button></div>}
    </div>
  );
}

function Versions({ agent, busy, onActivate }: { agent: AgentDto; busy: string | null; onActivate: (id: string) => void }) {
  return (
    <section aria-labelledby="ver-h" className="mt-8">
      <h2 id="ver-h" className="mb-1 text-md font-semibold text-fg">Versions</h2>
      <p className="mb-2 text-sm text-fg-subtle">Versions are never edited. To roll back, activate an older one.</p>
      <ul>
        {agent.versions.map((v) => {
          const live = v.id === agent.activeVersionId && agent.status === "active";
          return (
            <li key={v.id} className="flex flex-wrap items-center gap-3 border-t border-line-card py-3 first:border-t-0">
              <span className="w-10 font-bold">v{v.version}</span>
              <div className="min-w-0 flex-1 text-sm text-fg-muted">{new Date(v.createdAt).toLocaleString()} · {v.toolGrants.length} tool{v.toolGrants.length === 1 ? "" : "s"}</div>
              {live ? <Badge tone="success">live</Badge> : <Button loading={busy === `activate${v.id}`} onClick={() => onActivate(v.id)} aria-label={`${v.version === agent.latestVersion ? "Activate" : "Roll back to"} version ${v.version}`} className="pointer-coarse:h-11">{v.version === agent.latestVersion ? "Activate" : "Roll back to this"}</Button>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Runs({ workspaceId, agent }: { workspaceId: string; agent: AgentDto }) {
  const [rows, setRows] = React.useState<AgentRunRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.listAiAgentRuns, { params: { workspaceId, agentId: agent.id }, query: { limit: 10 } });
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    setError(null); setRows(r.data.items);
  }, [workspaceId, agent.id]);
  React.useEffect(() => { void load(); }, [load, agent.latestVersion]); // eslint-disable-line react-hooks/set-state-in-effect
  return (
    <section aria-labelledby="runs-h" className="mt-8">
      <div className="mb-1 flex items-center justify-between"><h2 id="runs-h" className="text-md font-semibold text-fg">Recent runs</h2><Button size="sm" onClick={() => void load()}>Refresh</Button></div>
      <p className="mb-2 text-sm text-fg-subtle">Status, tokens, cost and speed. No text is stored.</p>
      {error ? <ErrorState title="Could not load runs" description={error} onRetry={() => void load()} /> : !rows ? <div role="status" aria-label="Loading runs"><Skeleton className="h-16" /></div> : rows.length === 0 ? <EmptyState title="No runs yet" description="Run a test to see usage here." /> : (
        <ul className="text-sm">{rows.map((x) => <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-card py-2.5 first:border-t-0"><span className="text-fg-muted">{new Date(x.createdAt).toLocaleString()}</span><Badge tone={x.status === "ok" ? "success" : "danger"}>{x.status === "ok" ? "ok" : x.errorCode ?? x.status}</Badge><span>v{x.agentVersion}</span><span className="text-fg-muted">{x.model}</span><span className="tnum ml-auto text-fg-muted">{x.inputTokens + x.outputTokens} tokens · {formatMicro(x.costMicro)} USD · {x.latencyMs} ms</span></li>)}</ul>
      )}
    </section>
  );
}

function Preview({ f, data }: { f: Form; data: Data }) {
  const on = data.tools.filter((t) => (f.grants[t.name] ?? "off") !== "off");
  const ini = f.name.trim()[0]?.toUpperCase();
  const lang = LANGS.find(([k]) => k === f.language)?.[1] ?? f.language;
  const style = STYLES.find(([k]) => k === f.responseStyle)?.[1] ?? f.responseStyle;
  return (
    <div className="rounded-card bg-surface p-6 shadow-sheet">
      <div className={cn("mb-4 flex size-[4.25rem] items-center justify-center rounded-[1.4rem] text-3xl font-extrabold", ini ? "bg-accent-subtle text-accent-fg" : "border-2 border-dashed border-line-control bg-hover text-fg-subtle")}>{ini ?? <Bot className="size-7" aria-hidden />}</div>
      <p className="break-words text-lg font-bold text-fg">{f.name || "Your new agent"}</p>
      <p className="mb-3.5 mt-1 break-words text-base text-fg-muted">{f.description || "Say what it is for and it shows up here."}</p>
      <div className="mb-5 flex flex-wrap gap-1.5">{[lang, style, f.personality].filter(Boolean).map((x) => <span key={x} className="rounded-full bg-hover px-3 py-1 text-xs font-medium text-fg-muted">{x}</span>)}</div>
      <h2 className="mb-2 text-xs font-bold text-fg-subtle">Can do</h2>
      {on.length === 0 ? <p className="text-sm text-fg-subtle">No tools yet. It can only reply.</p> : <ul className="flex flex-col gap-2 text-sm">{on.map((t) => <li key={t.name} className="flex items-center gap-2.5"><i aria-hidden className={cn("size-2 shrink-0 rounded-full", f.grants[t.name] === "auto" ? "bg-success" : "bg-warning")} />{toolUi(t).title}<em className="ml-auto text-xs not-italic text-fg-subtle">{f.grants[t.name] === "auto" ? "Auto" : "Asks you"}</em></li>)}</ul>}
    </div>
  );
}
