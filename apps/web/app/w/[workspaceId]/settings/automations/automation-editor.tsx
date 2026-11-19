"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, ChevronDown, Plus, X } from "lucide-react";
import { AUTOMATION_TRIGGERS, endpoints, type AutomationAction, type AutomationRuleDto, type AutomationTrigger } from "@crm/contracts";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/overlays";
import { Panel } from "@/components/ui/panel";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { cn } from "@/lib/cn";
import { sourceLabel } from "@/lib/contacts";
import { formatDateTime } from "@/lib/format";
import { ACTION_HINT, ACTION_LABEL, ACTION_ORDER, BLANK, FIELDS, TRIGGER_HINT, conditionText, fromRows, lower, optionsFor, presets, ruleToDraft, suggestName, toRows, type Draft, type FieldDef, type Lookups, type Member, type Row } from "./automation-model";
import { useLookups } from "./use-lookups";

type MenuOpt = { value: string; label: string; hint?: string };
const TONE = {
  when: "bg-accent-subtle text-accent-fg ring-accent/25 hover:ring-accent/50",
  filter: "bg-surface text-fg ring-line-strong hover:ring-accent/50",
  do: "bg-hue-2-bg text-hue-2-fg ring-hue-2-dot/30 hover:ring-hue-2-dot/60",
} as const;
const CHIP = "press inline-flex h-9 max-w-full items-center gap-1.5 rounded-control px-3 align-middle text-md font-semibold ring-1 ring-inset active:scale-[0.98]";

/** A word in the sentence that opens a short menu of plain choices. */
function MenuChip({ role, value, options, onChange, tone = "filter", placeholder = "Choose…" }: { role: string; value: string; options: MenuOpt[]; onChange: (v: string) => void; tone?: keyof typeof TONE; placeholder?: string }) {
  const shown = options.find((o) => o.value === value)?.label ?? (value || placeholder);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`${role}: ${shown}`} className={cn(CHIP, TONE[tone], "data-[state=open]:ring-2 data-[state=open]:ring-accent")}>
          <span className="truncate">{shown}</span><ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-72 min-w-56 overflow-y-auto">
        {options.length === 0 && <p className="px-2 py-1.5 text-sm text-fg-muted">Nothing to choose yet.</p>}
        {options.map((o) => (
          <DropdownMenuItem key={o.value} onSelect={() => onChange(o.value)}>
            <span className="min-w-0 flex-1"><span className="block">{o.label}</span>{o.hint && <span className="block text-xs text-fg-subtle">{o.hint}</span>}</span>
            {o.value === value && <Check className="text-accent" aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A word in the sentence you type into. It grows with its text. */
function InlineInput({ value, onChange, label, placeholder, quotes, type = "text", list, min }: { value: string; onChange: (v: string) => void; label: string; placeholder: string; quotes?: boolean; type?: string; list?: string; min?: number }) {
  return (
    <span className="inline-flex h-9 max-w-full items-center rounded-control bg-surface px-3 align-middle text-md font-semibold text-fg ring-1 ring-inset ring-line-strong focus-within:ring-2 focus-within:ring-accent">
      {quotes && <span aria-hidden className="text-fg-subtle">“</span>}
      <input aria-label={label} type={type} min={min} list={list} value={value} placeholder={placeholder} autoComplete="off" onChange={(e) => onChange(e.target.value)} className="min-w-[3ch] max-w-[60vw] bg-transparent outline-none [field-sizing:content] placeholder:font-normal placeholder:text-fg-subtle focus-visible:outline-none" />
      {quotes && <span aria-hidden className="text-fg-subtle">”</span>}
    </span>
  );
}
const W = ({ children }: { children: React.ReactNode }) => <span className="text-fg-muted">{children}</span>;
const Remove = ({ label, onClick }: { label: string; onClick: () => void }) => <button type="button" aria-label={label} onClick={onClick} className="press inline-flex size-6 items-center justify-center rounded-full align-middle text-fg-subtle opacity-70 hover:bg-surface hover:text-fg hover:opacity-100"><X className="size-3.5" aria-hidden /></button>;

/** "Due in [1] [days]": stored as hours, as the API expects. */
function DueIn({ index, hours, onChange }: { index: number; hours?: number; onChange: (h: number | undefined) => void }) {
  const [unit, setUnit] = React.useState<"hours" | "days">(hours && hours >= 24 && hours % 24 === 0 ? "days" : "hours");
  const shown = hours === undefined ? "" : String(unit === "days" ? hours / 24 : hours);
  const set = (n: string, u: "hours" | "days") => onChange(n === "" ? undefined : Math.min(8760, Math.max(1, Math.round(Number(n)) * (u === "days" ? 24 : 1))));
  const one = shown === "1";
  return (
    <span className="whitespace-nowrap"><W>due in</W> <InlineInput type="number" min={1} value={shown} placeholder="0" label={`Step ${index + 1} due in`} onChange={(v) => set(v, unit)} />{" "}
      <MenuChip role={`Step ${index + 1} due unit`} value={unit} options={[{ value: "hours", label: one ? "hour" : "hours" }, { value: "days", label: one ? "day" : "days" }]} onChange={(u) => { setUnit(u as "hours" | "days"); if (shown !== "") set(shown, u as "hours" | "days"); }} />
    </span>
  );
}

/** The sample lead the preview runs the automation against. */
const SAMPLE = { name: "Nusrat Jahan", title: "Full home renovation" };
/** The sample lead arrives from the source the first source filter asks for, so a fresh recipe shows what it does when it matches. */
const sampleSource = (rows: Row[]) => rows.find((r) => r.field === "source" && r.op === "equals" && r.value)?.value ?? "instagram";
function matches(r: Row, def: FieldDef | undefined, source: string): boolean | null {
  const v = r.value.trim().toLowerCase();
  if (!def || !v) return null;
  const test = (have: string) => (r.op === "contains" ? have.includes(v) : r.op === "in" ? v.split(",").map((x) => x.trim()).includes(have) : have === v);
  if (def.field === "source") return test(source);
  if (def.field === "contactName") return test(SAMPLE.name.toLowerCase());
  if (def.field === "leadTitle") return test(SAMPLE.title.toLowerCase());
  if (def.field === "outcome") return test("open");
  return null; // stages, owners and pipelines depend on the real lead
}

type Step = { ok: boolean; title: string; sub?: string };
function previewSteps(d: Draft, members: Member[], lk: Lookups, tz: string): Step[] {
  const now = new Date();
  const sample = SAMPLE.name;
  const start: Record<AutomationTrigger, string> = { "contact.created": `A lead is created: ${sample} (${SAMPLE.title})`, "lead.stage_changed": `${sample} moves to another stage`, "contact.owner_assigned": `${sample} gets an owner`, "lead.owner_assigned": `A lead record for ${sample} gets an owner` };
  const steps: Step[] = [{ ok: true, title: start[d.trigger], sub: formatDateTime(now.toISOString(), tz) }];
  const rows = d.rows.filter((r) => r.value.trim());
  let ok = true;
  if (rows.length) {
    const defs = FIELDS[d.trigger];
    const res = rows.map((r) => matches(r, defs.find((f) => f.field === r.field), sampleSource(d.rows)));
    ok = d.mode === "and" ? res.every((x) => x !== false) : res.some((x) => x !== false);
    const unknown = res.some((x) => x === null);
    steps.push({ ok, title: `Checks: ${conditionText({ mode: d.mode, rows }, d.trigger, members, lk)}`, sub: ok ? (unknown ? "Depends on the real lead; shown as a match here." : `${sample} matches.`) : `${sample} does not match, so nothing happens.` });
  }
  if (!ok) return steps;
  if (d.requiresApproval) steps.push({ ok: true, title: "Waits for your approval", sub: "It shows in Activity with Approve and Reject." });
  for (const a of d.actions) {
    if (a.type === "create_task") steps.push({ ok: true, title: `Creates the task “${a.title || "…"}”`, sub: a.dueInHours ? `Due ${formatDateTime(new Date(now.getTime() + a.dueInHours * 3_600_000).toISOString(), tz)}` : "No due time" });
    else if (a.type === "add_tag") steps.push({ ok: true, title: `Adds the tag “${a.tagName || "…"}” to ${sample}` });
    else if (a.type === "assign_owner") steps.push({ ok: true, title: `Makes ${members.find((m) => m.id === a.ownerUserId)?.name ?? "a teammate"} the owner of ${sample}` });
    else steps.push({ ok: true, title: `Asks ${lk.agents.find((g) => g.value === a.agentId)?.label ?? "an AI agent"} to draft a note about ${sample}`, sub: "Nothing is sent. A person approves anything it proposes." });
  }
  return steps;
}

export function AutomationEditor({ workspaceId, timeZone, members, rule, start }: { workspaceId: string; timeZone: string; members: Member[]; rule: AutomationRuleDto | null; start?: string }) {
  const router = useRouter();
  const toast = useToast();
  const lk = useLookups(workspaceId);
  const listHref = `/w/${workspaceId}/settings/ai/automations`;
  const initial: Draft = rule ? ruleToDraft(rule) : presets(members).find((p) => p.id === start)?.draft ?? BLANK;
  const hasRaw = !!rule && !toRows(rule.conditions);
  const [name, setName] = React.useState(initial.name);
  const [touched, setTouched] = React.useState(!!rule || !!initial.name);
  const [trigger, setTrigger] = React.useState<AutomationTrigger>(initial.trigger);
  const [mode, setMode] = React.useState<"and" | "or">(initial.mode);
  const [rows, setRows] = React.useState<Row[]>(initial.rows);
  const [actions, setActions] = React.useState<AutomationAction[]>(initial.actions);
  const [requiresApproval, setRequiresApproval] = React.useState(initial.requiresApproval);
  const [enabled, setEnabled] = React.useState(initial.enabled);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fields = FIELDS[trigger];
  const shownName = touched ? name : suggestName({ trigger, actions, rows });
  const setAction = (i: number, a: AutomationAction) => setActions((cur) => cur.map((x, j) => (j === i ? a : x)));
  const setRow = (i: number, patch: Partial<Row>) => setRows((c) => c.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const blank = (type: AutomationAction["type"]): AutomationAction => (type === "add_tag" ? { type, tagName: "" } : type === "assign_owner" ? { type, ownerUserId: members[0]?.id ?? "" } : type === "run_ai_agent" ? { type, agentId: lk.agents[0]?.value ?? "" } : { type: "create_task", title: "" });
  const draft: Draft = { name: shownName, trigger, mode, rows, actions, requiresApproval, enabled };
  const steps = previewSteps(draft, members, lk, timeZone);
  const hasAi = actions.some((a) => a.type === "run_ai_agent");

  async function save() {
    setError(null);
    setSaving(true);
    const body = { name: shownName.trim(), triggerType: trigger, ...(!hasRaw ? { conditions: fromRows(mode, rows) } : {}), actions, requiresApproval, enabled };
    const res = rule ? await browserApi.call(endpoints.updateAutomationRule, { params: { workspaceId, ruleId: rule.id }, body }) : await browserApi.call(endpoints.createAutomationRule, { params: { workspaceId }, body });
    setSaving(false);
    if (!res.ok) return setError(errorMessage(res.error));
    toast(rule ? "Changes saved" : enabled ? "Automation created and turned on" : "Automation created. It is off until you turn it on.");
    router.push(listHref);
    router.refresh();
  }

  return (
    <div className="pb-4">
      <Link href={listHref} className="press mb-2 inline-flex items-center gap-1.5 rounded-control text-sm font-medium text-fg-muted hover:text-fg"><ArrowLeft className="size-4" aria-hidden />Automations</Link>
      <h2 className="text-xl font-semibold tracking-title text-fg">{rule ? "Edit automation" : "New automation"}</h2>
      <p className="mt-0.5 text-base text-fg-subtle">Describe it in one sentence. Click any highlighted word to change it.</p>

      <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Panel className="overflow-hidden">
          <section aria-labelledby="ae-sentence" className="bg-accent-subtle/40 px-5 pb-5 pt-7 md:px-9">
            <h3 id="ae-sentence" className="sr-only">What this automation does</h3>
            <div className="text-lg font-medium leading-[3.25rem] text-fg">
              <W>When</W>{" "}
              <MenuChip tone="when" role="When this happens" value={trigger} options={(Object.keys(AUTOMATION_TRIGGERS) as AutomationTrigger[]).map((t) => ({ value: t, label: lower(AUTOMATION_TRIGGERS[t].label), hint: TRIGGER_HINT[t] }))} onChange={(v) => { setTrigger(v as AutomationTrigger); setRows([]); }} />{" "}
              {hasRaw && <><W>and it matches your advanced conditions</W>{" "}</>}
              {!hasRaw && rows.map((r, i) => {
                const def = fields.find((f) => f.field === r.field);
                const opts = def ? optionsFor(def.kind, lk, members) : null;
                const pick = !!opts && opts.length > 0 && r.op === "equals";
                return (
                  <React.Fragment key={i}>
                    {i === 0 ? <W>and</W> : <MenuChip role="How filters combine" value={mode} options={[{ value: "and", label: "and", hint: "All of the filters must match" }, { value: "or", label: "or", hint: "Any one filter is enough" }]} onChange={(v) => setMode(v as "and" | "or")} />}{" "}
                    <MenuChip role={`Filter ${i + 1} field`} value={r.field} options={[...(def ? [] : [{ value: r.field, label: r.field }]), ...fields.map((f) => ({ value: f.field, label: f.label }))]} onChange={(f) => { const d = fields.find((x) => x.field === f); setRow(i, { field: f, op: d && optionsFor(d.kind, lk, members)?.length ? "equals" : "contains", value: "" }); }} />{" "}
                    {pick ? (
                      <><W>is</W> <MenuChip role={`Filter ${i + 1} value`} value={r.value} options={opts} onChange={(v) => setRow(i, { value: v })} /></>
                    ) : r.op === "in" ? (
                      <><W>is one of</W> <InlineInput label={`Filter ${i + 1} value`} value={r.value} placeholder="a, b, c" onChange={(v) => setRow(i, { value: v })} /></>
                    ) : (
                      <><MenuChip role={`Filter ${i + 1} match`} value={r.op} options={[{ value: "contains", label: "contains" }, { value: "equals", label: "is exactly" }]} onChange={(v) => setRow(i, { op: v as Row["op"] })} />{" "}<InlineInput quotes label={`Filter ${i + 1} value`} value={r.value} placeholder="some words" onChange={(v) => setRow(i, { value: v })} /></>
                    )}
                    <Remove label={`Remove filter ${i + 1}`} onClick={() => setRows((c) => c.filter((_, j) => j !== i))} />{" "}
                  </React.Fragment>
                );
              })}
              <W>,</W>{" "}
              {actions.map((a, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <><W>then</W>{" "}</>}
                  <MenuChip tone="do" role={`Step ${i + 1}`} value={a.type} options={ACTION_ORDER.map((t) => ({ value: t, label: ACTION_LABEL[t], hint: ACTION_HINT[t] }))} onChange={(t) => setAction(i, blank(t as AutomationAction["type"]))} />{" "}
                  {a.type === "create_task" && <><InlineInput quotes label={`Step ${i + 1} task title`} value={a.title} placeholder="Task title" onChange={(v) => setAction(i, { ...a, title: v })} />{" "}<DueIn index={i} hours={a.dueInHours} onChange={(h) => setAction(i, { ...a, dueInHours: h })} /></>}
                  {a.type === "add_tag" && <><InlineInput quotes label={`Step ${i + 1} tag name`} value={a.tagName} placeholder="Tag name" list="ae-tags" onChange={(v) => setAction(i, { ...a, tagName: v })} /><datalist id="ae-tags">{lk.tags.map((t) => <option key={t} value={t} />)}</datalist></>}
                  {a.type === "assign_owner" && <MenuChip role={`Step ${i + 1} owner`} value={a.ownerUserId} options={members.map((m) => ({ value: m.id, label: m.name }))} onChange={(v) => setAction(i, { ...a, ownerUserId: v })} />}
                  {a.type === "run_ai_agent" && (lk.agents.length === 0 ? <W>(there is no active AI agent yet: turn one on in the Agents tab)</W> : <MenuChip role={`Step ${i + 1} AI agent`} value={a.agentId} options={lk.agents.map((g) => ({ value: g.value, label: g.label }))} onChange={(v) => setAction(i, { ...a, agentId: v })} placeholder="Choose an agent" />)}
                  {actions.length > 1 && <Remove label={`Remove step ${i + 1}`} onClick={() => setActions((c) => c.filter((_, j) => j !== i))} />}{" "}
                </React.Fragment>
              ))}
              <W>.</W>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {!hasRaw && <Button size="sm" disabled={rows.length >= 5} onClick={() => setRows((c) => [...c, { field: fields[0]!.field, op: "equals", value: "" }])}><Plus />Add a filter</Button>}
              <Button size="sm" disabled={actions.length >= 5} onClick={() => setActions((c) => [...c, blank("create_task")])}><Plus />Add another step</Button>
            </div>
            <p className="mt-3 text-sm text-fg-muted">{rows.length >= 5 ? "You can add up to 5 filters." : actions.length >= 5 ? "You can add up to 5 steps. They run in order." : actions.length > 1 ? "Steps run in order, one after the other." : rows.length === 0 ? "No filter: it applies every time. Add a filter to narrow it, for example only leads from Instagram." : ""}</p>
          </section>

          <div className="divide-y divide-line-card px-5 md:px-9">
            <section className="grid gap-3 py-5">
              <div><p id="ae-run" className="text-base font-semibold text-fg">How it runs</p><p className="mt-0.5 text-sm text-fg-subtle">{requiresApproval ? "Each time this happens, it waits in Activity until you approve or reject it." : "Each time this happens, it does its work right away with no approval. Best for small, safe jobs."}{hasAi ? " The AI agent only drafts a note. It never sends a message to anyone." : ""}</p></div>
              <div role="radiogroup" aria-labelledby="ae-run" className="inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-card bg-hover p-1">
                {([[true, "Ask me first (recommended)"], [false, "Run on its own"]] as const).map(([v, label]) => (
                  <button key={label} type="button" role="radio" aria-checked={requiresApproval === v} onClick={() => setRequiresApproval(v)} className={cn("press h-9 rounded-control px-4 text-base font-medium", requiresApproval === v ? "bg-surface text-fg shadow-control" : "text-fg-muted hover:text-fg")}>{label}</button>
                ))}
              </div>
            </section>
            <section className="grid gap-3 py-5">
              <div><label htmlFor="ae-name" className="text-base font-semibold text-fg">Name</label><p className="mt-0.5 text-sm text-fg-subtle">Shown in your list and in Activity.</p></div>
              <Input id="ae-name" className="max-w-lg" value={shownName} maxLength={120} placeholder="For example, Follow up on new leads" onChange={(e) => { setName(e.target.value); setTouched(true); }} />
            </section>
            <section className="grid gap-3 py-5">
              <div><p id="ae-on" className="text-base font-semibold text-fg">{rule ? "Turned on" : "Turn it on"}</p><p className="mt-0.5 text-sm text-fg-subtle">When it is off, nothing runs and nothing waits for you.</p></div>
              <div><Switch checked={enabled} onCheckedChange={setEnabled} label={rule ? "Turned on" : "Turn it on"} /></div>
            </section>
          </div>
        </Panel>

        <Panel aria-labelledby="ae-prev" className="p-5 xl:sticky xl:top-4">
          <h3 id="ae-prev" className="text-md font-semibold text-fg">Preview</h3>
          <p className="mt-1 text-sm text-fg-muted">What will happen for a sample lead:</p>
          <div className="mt-3 flex items-center gap-2.5 rounded-card bg-subtle px-3 py-2.5"><Avatar name={SAMPLE.name} size="lg" /><span className="min-w-0 leading-tight"><b className="block font-semibold text-fg">{SAMPLE.name}</b><span className="text-sm text-fg-muted">{SAMPLE.title} · {sourceLabel(sampleSource(rows))}</span></span></div>
          <ol className="mt-5 space-y-0" aria-label="Steps">
            {steps.map((s, i) => (
              <li key={i} className="relative pb-5 pl-10 last:pb-0">
                <span aria-hidden className={cn("absolute left-0 top-0 inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold text-on-accent ring-4", s.ok ? "bg-accent ring-accent-subtle" : "bg-fg-disabled ring-hover")}>{i + 1}</span>
                {i < steps.length - 1 && <span aria-hidden className="absolute bottom-1 left-[0.6875rem] top-7 w-0.5 rounded-full bg-line" />}
                <b className="block text-base font-semibold leading-snug text-fg">{s.title}</b>
                {s.sub && <span className="block text-sm text-fg-muted">{s.sub}</span>}
              </li>
            ))}
          </ol>
          <p className="mt-5 text-sm text-fg-subtle">This is only a sample. Nothing is created until a real lead triggers it.</p>
        </Panel>
      </div>

      {error && <p role="alert" className="mt-4 rounded-control bg-danger-bg px-3 py-2 text-sm text-danger-fg">{error}</p>}
      <div className="sticky bottom-0 z-10 -mx-4 mt-6 flex items-center justify-between gap-3 border-t border-line bg-surface/95 px-4 py-3 md:-mx-[var(--page-gutter)] md:px-[var(--page-gutter)]">
        <span className="text-sm text-fg-muted">{rule ? "Changes apply to future runs only." : enabled ? "Saving turns this automation on." : "Saving keeps this automation off."}</span>
        <div className="flex gap-2"><Button asChild><Link href={listHref}>Cancel</Link></Button><Button variant="primary" loading={saving} disabled={!shownName.trim()} onClick={() => void save()}>{rule ? "Save changes" : "Create automation"}</Button></div>
      </div>
    </div>
  );
}
