import { AUTOMATION_TRIGGERS, type AutomationAction, type AutomationRuleDto, type AutomationTrigger, type ConditionInput } from "@crm/contracts";
import { SOURCE_LABEL } from "@/lib/contacts";

export type Member = { id: string; name: string };
export type Opt = { value: string; label: string };
/** Everything a person can pick by name instead of typing an id. */
export type Lookups = { stages: Opt[]; pipelineStages: Opt[]; pipelines: Opt[]; agents: Opt[]; tags: string[] };
export const NO_LOOKUPS: Lookups = { stages: [], pipelineStages: [], pipelines: [], agents: [], tags: [] };

export type FieldKind = "text" | "source" | "stage" | "pipelineStage" | "pipeline" | "member" | "outcome";
export type FieldDef = { field: string; label: string; kind: FieldKind };
/** Plain names for the facts a trigger carries. The stored field names (and so the API) are unchanged. */
export const FIELDS: Record<AutomationTrigger, FieldDef[]> = {
  "contact.created": [{ field: "source", label: "Source", kind: "source" }, { field: "contactName", label: "Lead name", kind: "text" }, { field: "lifecycleStageId", label: "Lifecycle stage", kind: "stage" }, { field: "ownerUserId", label: "Owner", kind: "member" }],
  "lead.stage_changed": [{ field: "toStageId", label: "Moved to stage", kind: "pipelineStage" }, { field: "fromStageId", label: "Moved from stage", kind: "pipelineStage" }, { field: "outcome", label: "Outcome", kind: "outcome" }, { field: "pipelineId", label: "Pipeline", kind: "pipeline" }, { field: "leadTitle", label: "Lead title", kind: "text" }],
  "contact.owner_assigned": [{ field: "ownerUserId", label: "New owner", kind: "member" }, { field: "previousOwnerUserId", label: "Previous owner", kind: "member" }, { field: "contactName", label: "Lead name", kind: "text" }],
  "lead.owner_assigned": [{ field: "ownerUserId", label: "New owner", kind: "member" }, { field: "previousOwnerUserId", label: "Previous owner", kind: "member" }, { field: "leadTitle", label: "Lead title", kind: "text" }],
};
export const TRIGGER_HINT: Record<AutomationTrigger, string> = {
  "contact.created": "Runs once for every new lead, however it arrives.",
  "lead.stage_changed": "Runs each time a lead record moves to a different stage.",
  "contact.owner_assigned": "Runs when someone becomes the owner of a lead.",
  "lead.owner_assigned": "Runs when someone becomes the owner of a lead record.",
};
export const OPS = { equals: "is", in: "is one of", contains: "contains" } as const;
export const OUTCOMES: Opt[] = [{ value: "open", label: "Open" }, { value: "won", label: "Won" }, { value: "lost", label: "Lost" }];
export const ACTION_LABEL: Record<AutomationAction["type"], string> = { create_task: "create a follow-up task", add_tag: "add a tag", assign_owner: "assign an owner", run_ai_agent: "ask an AI agent to draft a note" };
export const ACTION_HINT: Record<AutomationAction["type"], string> = { create_task: "A task for you or a teammate, with an optional due time", add_tag: "Label the lead so you can find it later", assign_owner: "Make a teammate responsible for the lead", run_ai_agent: "The agent only drafts a note. Nothing is sent." };
export const ACTION_ORDER: AutomationAction["type"][] = ["create_task", "add_tag", "assign_owner", "run_ai_agent"];

export type Row = { field: string; op: keyof typeof OPS; value: string };
export type Parsed = { mode: "and" | "or"; rows: Row[] };
/** The builder edits one flat list joined by all/any. Anything deeper is kept untouched (shown read-only). */
export function toRows(c: ConditionInput): Parsed | null {
  const leaf = (x: ConditionInput): Row | null => (x.op === "equals" && typeof x.value === "string" ? { field: x.field, op: "equals", value: x.value } : x.op === "in" && x.values.every((v) => typeof v === "string") ? { field: x.field, op: "in", value: x.values.join(", ") } : x.op === "contains" ? { field: x.field, op: "contains", value: x.value } : null);
  if (c.op === "and" || c.op === "or") {
    const rows = c.conditions.map(leaf);
    return rows.every((r): r is Row => !!r) ? { mode: c.op, rows } : null;
  }
  const r = leaf(c);
  return r ? { mode: "and", rows: [r] } : null;
}
export const fromRows = (mode: "and" | "or", rows: Row[]): ConditionInput => ({
  op: mode,
  conditions: rows.filter((r) => r.field && r.value.trim()).map((r): ConditionInput => (r.op === "in" ? { op: "in", field: r.field, values: r.value.split(",").map((v) => v.trim()).filter(Boolean) } : { op: r.op, field: r.field, value: r.value.trim() })),
});

export function optionsFor(kind: FieldKind, lk: Lookups, members: Member[]): Opt[] | null {
  switch (kind) {
    case "source": return Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label }));
    case "stage": return lk.stages;
    case "pipelineStage": return lk.pipelineStages;
    case "pipeline": return lk.pipelines;
    case "member": return members.map((m) => ({ value: m.id, label: m.name }));
    case "outcome": return OUTCOMES;
    default: return null;
  }
}

export const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const dueText = (h?: number) => (!h ? "" : h % 24 === 0 && h >= 24 ? `${h / 24} ${h / 24 === 1 ? "day" : "days"}` : `${h} ${h === 1 ? "hour" : "hours"}`);

export function actionText(a: AutomationAction, members: Member[], lk: Lookups): string {
  if (a.type === "create_task") return `create the task “${a.title || "…"}”${a.dueInHours ? ` due in ${dueText(a.dueInHours)}` : ""}`;
  if (a.type === "add_tag") return `add the tag “${a.tagName || "…"}”`;
  if (a.type === "assign_owner") return `make ${members.find((m) => m.id === a.ownerUserId)?.name ?? "a teammate"} the owner`;
  return `ask ${lk.agents.find((g) => g.value === a.agentId)?.label ?? "an AI agent"} to draft a note (nothing is sent)`;
}
export function conditionText(parsed: Parsed | null, trigger: AutomationTrigger, members: Member[], lk: Lookups): string {
  if (!parsed) return "it matches your advanced conditions";
  const parts = parsed.rows.filter((r) => r.value.trim()).map((r) => {
    const def = FIELDS[trigger].find((f) => f.field === r.field);
    const opts = def ? optionsFor(def.kind, lk, members) : null;
    const shown = r.op === "equals" && opts ? opts.find((o) => o.value === r.value)?.label ?? r.value : r.op === "in" ? r.value : `“${r.value}”`;
    return `${lower(def?.label ?? r.field)} ${OPS[r.op]} ${shown}`;
  });
  return parts.join(parsed.mode === "and" ? " and " : " or ");
}
/** "When a lead is created and source is Instagram: add the tag “Hot”, then create the task “Call” due in 1 day." */
export function sentenceOf(trigger: AutomationTrigger, parsed: Parsed | null, actions: AutomationAction[], members: Member[], lk: Lookups): string {
  const cond = conditionText(parsed, trigger, members, lk);
  return `When ${lower(AUTOMATION_TRIGGERS[trigger].label)}${cond ? ` and ${cond}` : ""}: ${actions.map((a) => actionText(a, members, lk)).join(", then ")}.`;
}

export type Draft = { name: string; trigger: AutomationTrigger; mode: "and" | "or"; rows: Row[]; actions: AutomationAction[]; requiresApproval: boolean; enabled: boolean };
export const BLANK: Draft = { name: "", trigger: "contact.created", mode: "and", rows: [], actions: [{ type: "create_task", title: "" }], requiresApproval: true, enabled: true };
export function ruleToDraft(r: AutomationRuleDto): Draft {
  const p = toRows(r.conditions);
  return { name: r.name, trigger: r.triggerType, mode: p?.mode ?? "and", rows: p?.rows ?? [], actions: r.actions, requiresApproval: r.requiresApproval, enabled: r.enabled };
}
/** A short default name from what the automation does, used until the person types their own. */
export function suggestName(d: Pick<Draft, "trigger" | "actions" | "rows">): string {
  const a = d.actions[0];
  if (d.trigger === "contact.created") {
    if (d.rows.some((r) => r.field === "source" && r.value === "instagram") && a?.type === "assign_owner") return "Assign Instagram leads";
    if (a?.type === "create_task") return "Follow up on new leads";
    if (a?.type === "add_tag") return "Tag new leads";
    if (a?.type === "assign_owner") return "Assign new leads";
    if (a?.type === "run_ai_agent") return "AI note for new leads";
  }
  return `${cap(a ? ACTION_LABEL[a.type] : "automation")} when ${lower(AUTOMATION_TRIGGERS[d.trigger].label)}`.slice(0, 120);
}

export type Preset = { id: string; title: string; text: string; draft: Draft };
/** The starting points offered on an empty page: a person picks one, then changes anything. */
export function presets(members: Member[]): Preset[] {
  const owner = members[0];
  return [
    { id: "task", title: "Follow up on every new lead", text: "Creates a task due the next day so no lead is forgotten.", draft: { ...BLANK, name: "Follow up on new leads", actions: [{ type: "create_task", title: "Follow up with the new lead", dueInHours: 24 }] } },
    { id: "tag", title: "Tag every new lead", text: "Adds a tag so you can find them later.", draft: { ...BLANK, name: "Tag new leads", actions: [{ type: "add_tag", tagName: "New lead" }] } },
    ...(owner ? [{ id: "assign", title: "Give Instagram leads to a teammate", text: "Assigns every lead that came from Instagram to one person.", draft: { ...BLANK, name: "Assign Instagram leads", rows: [{ field: "source", op: "equals" as const, value: "instagram" }], actions: [{ type: "assign_owner" as const, ownerUserId: owner.id }] } }] : []),
    { id: "ai", title: "Ask an AI agent to draft a note", text: "The agent reads each new lead and writes a note for you to review. Nothing is sent.", draft: { ...BLANK, name: "AI note for new leads", actions: [{ type: "run_ai_agent", agentId: "" }] } },
    { id: "facebook", title: "Welcome Facebook leads", text: "Tags leads from Facebook lead ads and asks you to call within an hour.", draft: { ...BLANK, name: "Welcome Facebook leads", rows: [{ field: "source", op: "equals", value: "facebook_lead_ad" }], actions: [{ type: "add_tag", tagName: "Facebook" }, { type: "create_task", title: "Call within 1 hour", dueInHours: 1 }] } },
    { id: "won", title: "Ask for a review after a win", text: "When a lead record is won, creates a task to ask for a review.", draft: { ...BLANK, name: "Ask for a review after a win", trigger: "lead.stage_changed", rows: [{ field: "outcome", op: "equals", value: "won" }], actions: [{ type: "create_task", title: "Ask for a review", dueInHours: 72 }] } },
  ];
}
