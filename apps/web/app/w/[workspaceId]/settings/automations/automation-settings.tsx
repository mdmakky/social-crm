"use client";
import * as React from "react";
import { Plus, RefreshCw, Trash2, Workflow, X } from "lucide-react";
import { AUTOMATION_ACTION_TYPES, AUTOMATION_TRIGGERS, endpoints, type AutomationAction, type AutomationRuleDto, type AutomationRunDto, type AutomationTrigger, type ConditionInput } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogContent, DialogActions } from "@/components/ui/overlays";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";

type Member = { id: string; name: string };
const FIELDS: Record<AutomationTrigger, { field: string; label: string }[]> = {
  "contact.created": [{ field: "source", label: "Source" }, { field: "contactName", label: "Contact name" }, { field: "lifecycleStageId", label: "Lifecycle stage id" }, { field: "ownerUserId", label: "Owner id" }],
  "lead.stage_changed": [{ field: "toStageId", label: "New stage id" }, { field: "fromStageId", label: "Previous stage id" }, { field: "outcome", label: "Outcome (open, won, lost)" }, { field: "pipelineId", label: "Pipeline id" }, { field: "leadTitle", label: "Lead title" }],
  "contact.owner_assigned": [{ field: "ownerUserId", label: "New owner id" }, { field: "previousOwnerUserId", label: "Previous owner id" }, { field: "contactName", label: "Contact name" }],
  "lead.owner_assigned": [{ field: "ownerUserId", label: "New owner id" }, { field: "previousOwnerUserId", label: "Previous owner id" }, { field: "leadTitle", label: "Lead title" }],
};
const OPS = { equals: "is", in: "is one of", contains: "contains" } as const;
const STATUS_TONE = { pending: "accent", awaiting_approval: "warning", running: "accent", succeeded: "success", failed: "danger", cancelled: "neutral", skipped: "neutral" } as const;
const STATUS_LABEL = { pending: "Queued", awaiting_approval: "Needs approval", running: "Running", succeeded: "Succeeded", failed: "Failed", cancelled: "Rejected", skipped: "Skipped" } as const;

type Row = { field: string; op: keyof typeof OPS; value: string };
/** The builder edits one flat list joined by all/any. Anything deeper is kept untouched (shown read-only). */
function toRows(c: ConditionInput): { mode: "and" | "or"; rows: Row[] } | null {
  const leaf = (x: ConditionInput): Row | null => (x.op === "equals" && typeof x.value === "string" ? { field: x.field, op: "equals", value: x.value } : x.op === "in" && x.values.every((v) => typeof v === "string") ? { field: x.field, op: "in", value: x.values.join(", ") } : x.op === "contains" ? { field: x.field, op: "contains", value: x.value } : null);
  if (c.op === "and" || c.op === "or") {
    const rows = c.conditions.map(leaf);
    return rows.every((r): r is Row => !!r) ? { mode: c.op, rows } : null;
  }
  const r = leaf(c);
  return r ? { mode: "and", rows: [r] } : null;
}
const fromRows = (mode: "and" | "or", rows: Row[]): ConditionInput => ({
  op: mode,
  conditions: rows.filter((r) => r.field && r.value.trim()).map((r): ConditionInput => (r.op === "in" ? { op: "in", field: r.field, values: r.value.split(",").map((v) => v.trim()).filter(Boolean) } : { op: r.op, field: r.field, value: r.value.trim() })),
});
const describeAction = (a: AutomationAction, members: Member[]) => (a.type === "create_task" ? `Create task "${a.title}"` : a.type === "add_tag" ? `Add tag "${a.tagName}"` : a.type === "run_ai_agent" ? "Run an AI agent (draft note and proposed actions, nothing sent)" : `Assign owner ${members.find((m) => m.id === a.ownerUserId)?.name ?? "(unknown member)"}`);

export function AutomationSettings({ workspaceId, timeZone, members }: { workspaceId: string; timeZone: string; members: Member[] }) {
  const toast = useToast();
  const params = { workspaceId };
  const [state, setState] = React.useState<"loading" | "error" | "ready">("loading");
  const [error, setError] = React.useState("");
  const [rules, setRules] = React.useState<AutomationRuleDto[]>([]);
  const [runs, setRuns] = React.useState<AutomationRunDto[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [killSwitch, setKillSwitch] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<AutomationRuleDto | "new" | null>(null);

  /** `quiet` refreshes (polling, after an action) keep what is on screen when they fail; the first load and "Try again" show the error. */
  const load = React.useCallback(async (quiet = false) => {
    const [r, u, s] = await Promise.all([browserApi.call(endpoints.listAutomationRules, { params }), browserApi.call(endpoints.listAutomationRuns, { params, query: { limit: 25 } }), browserApi.call(endpoints.getAutomationSettings, { params })]);
    const failed = !r.ok ? r : !u.ok ? u : !s.ok ? s : null;
    if (failed || !r.ok || !u.ok || !s.ok) {
      if (!quiet && failed && !failed.ok) { setError(errorMessage(failed.error)); setState("error"); }
      return;
    }
    setRules(r.data); setRuns(u.data.items); setNextCursor(u.data.nextCursor); setKillSwitch(s.data.killSwitch); setState("ready");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);
  React.useEffect(() => {
    const first = setTimeout(() => void load(false), 0); // from a callback, not the effect body (react-hooks/set-state-in-effect)
    const t = setInterval(() => void load(true), 10_000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [load]);

  async function act<T>(key: string, fn: () => Promise<{ ok: true; data: T } | { ok: false; error: Parameters<typeof errorMessage>[0] }>, done: string) {
    setBusy(key);
    const res = await fn();
    setBusy(null);
    if (!res.ok) { toast(errorMessage(res.error), "error"); return false; }
    toast(done);
    await load(true);
    return true;
  }

  async function loadMore() {
    if (!nextCursor) return;
    setBusy("more");
    const r = await browserApi.call(endpoints.listAutomationRuns, { params, query: { limit: 25, cursor: nextCursor } });
    setBusy(null);
    if (!r.ok) return toast(errorMessage(r.error), "error");
    setRuns((cur) => [...cur, ...r.data.items]); setNextCursor(r.data.nextCursor);
  }

  if (state === "loading") return <div role="status" aria-label="Loading automations" className="space-y-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-40 w-full" /><span className="sr-only">Loading…</span></div>;
  if (state === "error") return <Panel><ErrorState title="Could not load automations" description={error} onRetry={() => { setState("loading"); void load(false); }} /></Panel>;

  return (
    <div className="space-y-[var(--page-gap)]">
      {killSwitch ? (
        <Alert tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span><strong>Automations are paused.</strong> No new runs are created, queued runs do not execute, and runs cannot be approved until you resume.</span>
            <Button size="sm" loading={busy === "kill"} onClick={() => void act("kill", () => browserApi.call(endpoints.updateAutomationSettings, { params, body: { killSwitch: false } }), "Automations resumed")}>Resume automations</Button>
          </div>
        </Alert>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-subtle px-3 py-2 text-sm text-fg-muted">
          <span>Automations are running. The kill switch stops all of them at once.</span>
          <Button size="sm" variant="danger" loading={busy === "kill"} onClick={() => void act("kill", () => browserApi.call(endpoints.updateAutomationSettings, { params, body: { killSwitch: true } }), "Automations paused")}>Pause all automations</Button>
        </div>
      )}

      <Panel>
        <PanelHeader title="Rules" description="A rule runs when its trigger happens and its conditions match." actions={<Button variant="primary" size="sm" onClick={() => setEditing("new")}><Plus />New rule</Button>} />
        {rules.length === 0 ? (
          <EmptyState icon={Workflow} title="No rules yet" description="Create a rule, for example: when a contact is created, add a tag and open a follow-up task." action={<Button variant="primary" onClick={() => setEditing("new")}><Plus />New rule</Button>} />
        ) : (
          <ul className="divide-y divide-line">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-fg">{r.name}</p>
                  <p className="text-sm text-fg-muted">{AUTOMATION_TRIGGERS[r.triggerType].label}: {r.actions.map((a) => describeAction(a, members)).join(", ")}</p>
                  <Badge tone={r.requiresApproval ? "warning" : "neutral"} className="mt-1">{r.requiresApproval ? "Needs approval" : "Runs automatically"}</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox label="Enabled" checked={r.enabled} disabled={busy === `rule-${r.id}`} aria-label={`Enable rule ${r.name}`} onChange={(e) => void act(`rule-${r.id}`, () => browserApi.call(endpoints.updateAutomationRule, { params: { ...params, ruleId: r.id }, body: { enabled: e.target.checked } }), e.target.checked ? "Rule enabled" : "Rule disabled")} />
                  <Button size="sm" onClick={() => setEditing(r)} aria-label={`Edit rule ${r.name}`}>Edit</Button>
                  <Button size="sm" variant="ghost" icon aria-label={`Delete rule ${r.name}`} loading={busy === `del-${r.id}`} onClick={() => { if (window.confirm(`Delete the rule "${r.name}"? Its past runs stay in the history.`)) void act(`del-${r.id}`, () => browserApi.call(endpoints.deleteAutomationRule, { params: { ...params, ruleId: r.id } }), "Rule deleted"); }}><Trash2 /></Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="Runs" description="What the rules did, newest first. Updates every few seconds." actions={<Button size="sm" variant="ghost" icon aria-label="Refresh runs" onClick={() => void load(true)}><RefreshCw /></Button>} />
        {runs.length === 0 ? (
          <EmptyState title="No runs yet" description="Runs appear here when an enabled rule matches an event." />
        ) : (
          <ul className="divide-y divide-line">
            {runs.map((r) => (
              <li key={r.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-fg">{r.ruleName}<Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge></p>
                    <p className="text-sm text-fg-muted">{AUTOMATION_TRIGGERS[r.triggerType as AutomationTrigger]?.label ?? r.triggerType} · {formatDateTime(r.createdAt, timeZone)}{r.attempts > 0 ? ` · attempt ${r.attempts}` : ""}</p>
                    <p className="text-sm text-fg-muted">{r.actions.map((a) => describeAction(a, members)).join(", ")}</p>
                  </div>
                  {r.status === "awaiting_approval" && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="primary" disabled={killSwitch} loading={busy === `ok-${r.id}`} aria-label={`Approve run of ${r.ruleName}`} onClick={() => void act(`ok-${r.id}`, () => browserApi.call(endpoints.approveAutomationRun, { params: { ...params, runId: r.id } }), "Run approved")}>Approve</Button>
                      <Button size="sm" loading={busy === `no-${r.id}`} aria-label={`Reject run of ${r.ruleName}`} onClick={() => void act(`no-${r.id}`, () => browserApi.call(endpoints.rejectAutomationRun, { params: { ...params, runId: r.id } }), "Run rejected")}><X />Reject</Button>
                    </div>
                  )}
                </div>
                {r.error && r.status !== "cancelled" && <p role="note" className="mt-1 text-sm text-danger-fg">{r.error}{r.status === "pending" && r.nextAttemptAt ? ` Retrying at ${formatDateTime(r.nextAttemptAt, timeZone)}.` : ""}</p>}
                {r.steps.length > 0 && (
                  <details className="mt-1 text-sm text-fg-muted">
                    <summary className="cursor-pointer select-none">Step log ({r.steps.length})</summary>
                    <ol className="mt-1 space-y-0.5">
                      {r.steps.map((s) => <li key={s.id}>Attempt {s.attempt}, step {s.idx + 1}: {AUTOMATION_ACTION_TYPES[s.actionType as keyof typeof AUTOMATION_ACTION_TYPES] ?? s.actionType}, {s.status}{s.error ? ` (${s.error})` : ""}</li>)}
                    </ol>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {nextCursor && <div className="border-t border-line px-4 py-2"><Button size="sm" loading={busy === "more"} onClick={() => void loadMore()}>Load older runs</Button></div>}
      </Panel>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        {editing !== null && <RuleDialog key={editing === "new" ? "new" : editing.id} workspaceId={workspaceId} rule={editing === "new" ? null : editing} members={members} onSaved={async () => { setEditing(null); await load(true); }} />}
      </Dialog>
    </div>
  );
}

function RuleDialog({ workspaceId, rule, members, onSaved }: { workspaceId: string; rule: AutomationRuleDto | null; members: Member[]; onSaved: () => Promise<void> }) {
  const initial = rule ? toRows(rule.conditions) : { mode: "and" as const, rows: [] as Row[] };
  const [name, setName] = React.useState(rule?.name ?? "");
  const [trigger, setTrigger] = React.useState<AutomationTrigger>(rule?.triggerType ?? "contact.created");
  const [mode, setMode] = React.useState<"and" | "or">(initial?.mode ?? "and");
  const [rows, setRows] = React.useState<Row[]>(initial?.rows ?? []);
  const [actions, setActions] = React.useState<AutomationAction[]>(rule?.actions ?? [{ type: "add_tag", tagName: "" }]);
  const [requiresApproval, setRequiresApproval] = React.useState(rule?.requiresApproval ?? true);
  const [enabled, setEnabled] = React.useState(rule?.enabled ?? false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fields = FIELDS[trigger];
  const setAction = (i: number, a: AutomationAction) => setActions((cur) => cur.map((x, j) => (j === i ? a : x)));
  const [agents, setAgents] = React.useState<{ id: string; name: string }[]>([]);
  React.useEffect(() => { void browserApi.call(endpoints.listAiAgents, { params: { workspaceId } }).then((r) => { if (r.ok) setAgents(r.data.items.filter((a) => a.status === "active").map((a) => ({ id: a.id, name: a.name }))); }); }, [workspaceId]);
  const blank = (type: AutomationAction["type"]): AutomationAction => (type === "add_tag" ? { type, tagName: "" } : type === "assign_owner" ? { type, ownerUserId: members[0]?.id ?? "" } : type === "run_ai_agent" ? { type, agentId: agents[0]?.id ?? "" } : { type: "create_task", title: "" });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const body = { name, triggerType: trigger, ...(initial ? { conditions: fromRows(mode, rows) } : {}), actions, requiresApproval, enabled };
    const res = rule ? await browserApi.call(endpoints.updateAutomationRule, { params: { workspaceId, ruleId: rule.id }, body }) : await browserApi.call(endpoints.createAutomationRule, { params: { workspaceId }, body });
    setSaving(false);
    if (!res.ok) return setError(errorMessage(res.error));
    await onSaved();
  }

  return (
    <DialogContent title={rule ? "Edit rule" : "New rule"} description="When the trigger happens and all conditions match, the actions run (after approval, if required)." className="max-h-[90vh] w-full max-w-2xl overflow-y-auto">
      <form onSubmit={save} className="space-y-4" noValidate>
        <Field label="Name">{(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Welcome new contacts" />}</Field>
        <Field label="When">{(p) => (
          <Select {...p} value={trigger} onChange={(e) => { setTrigger(e.target.value as AutomationTrigger); setRows([]); }}>
            {(Object.keys(AUTOMATION_TRIGGERS) as AutomationTrigger[]).map((t) => <option key={t} value={t}>{AUTOMATION_TRIGGERS[t].label}</option>)}
          </Select>
        )}</Field>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-fg">Only if</legend>
          {!initial ? (
            <p className="text-sm text-fg-muted">This rule has advanced conditions. They are kept as they are.</p>
          ) : (
            <>
              {rows.length === 0 && <p className="text-sm text-fg-muted">No conditions: every {AUTOMATION_TRIGGERS[trigger].label.toLowerCase()} matches.</p>}
              {rows.length > 1 && (
                <Select aria-label="Combine conditions" value={mode} onChange={(e) => setMode(e.target.value as "and" | "or")} wrapperClassName="w-60">
                  <option value="and">All of these match</option>
                  <option value="or">Any of these matches</option>
                </Select>
              )}
              {rows.map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Select aria-label={`Condition ${i + 1} field`} value={r.field} onChange={(e) => setRows((c) => c.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))} wrapperClassName="w-48">
                    {!fields.some((f) => f.field === r.field) && <option value={r.field}>{r.field}</option>}
                    {fields.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
                  </Select>
                  <Select aria-label={`Condition ${i + 1} operator`} value={r.op} onChange={(e) => setRows((c) => c.map((x, j) => (j === i ? { ...x, op: e.target.value as Row["op"] } : x)))} wrapperClassName="w-36">
                    {(Object.keys(OPS) as (keyof typeof OPS)[]).map((o) => <option key={o} value={o}>{OPS[o]}</option>)}
                  </Select>
                  <Input aria-label={`Condition ${i + 1} value`} className="min-w-40 flex-1" value={r.value} placeholder={r.op === "in" ? "a, b, c" : "value"} onChange={(e) => setRows((c) => c.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                  <Button variant="ghost" icon size="sm" aria-label={`Remove condition ${i + 1}`} onClick={() => setRows((c) => c.filter((_, j) => j !== i))}><X /></Button>
                </div>
              ))}
              {rows.length < 5 && <Button size="sm" onClick={() => setRows((c) => [...c, { field: fields[0]!.field, op: "equals", value: "" }])}><Plus />Add condition</Button>}
            </>
          )}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-fg">Then</legend>
          {actions.map((a, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Select aria-label={`Action ${i + 1} type`} value={a.type} onChange={(e) => setAction(i, blank(e.target.value as AutomationAction["type"]))} wrapperClassName="w-56">
                {(Object.keys(AUTOMATION_ACTION_TYPES) as (keyof typeof AUTOMATION_ACTION_TYPES)[]).map((t) => <option key={t} value={t}>{AUTOMATION_ACTION_TYPES[t]}</option>)}
              </Select>
              {a.type === "add_tag" && <Input aria-label={`Action ${i + 1} tag name`} className="min-w-40 flex-1" value={a.tagName} maxLength={50} placeholder="Tag name" onChange={(e) => setAction(i, { ...a, tagName: e.target.value })} />}
              {a.type === "assign_owner" && (
                <Select aria-label={`Action ${i + 1} new owner`} value={a.ownerUserId} onChange={(e) => setAction(i, { ...a, ownerUserId: e.target.value })} wrapperClassName="min-w-40 flex-1">
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              )}
              {a.type === "run_ai_agent" && (
                agents.length === 0
                  ? <span className="text-sm text-fg-muted">No active agent yet. Activate one in AI Agents first.</span>
                  : <Select aria-label={`Action ${i + 1} AI agent`} value={a.agentId} onChange={(e) => setAction(i, { ...a, agentId: e.target.value })} wrapperClassName="min-w-40 flex-1">
                    <option value="">Choose an agent</option>
                    {agents.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </Select>
              )}
              {a.type === "create_task" && (
                <>
                  <Input aria-label={`Action ${i + 1} task title`} className="min-w-40 flex-1" value={a.title} maxLength={200} placeholder="Task title" onChange={(e) => setAction(i, { ...a, title: e.target.value })} />
                  <Input aria-label={`Action ${i + 1} due in hours`} className="w-28" type="number" min={1} max={8760} value={a.dueInHours ?? ""} placeholder="Due in h" onChange={(e) => setAction(i, { ...a, dueInHours: e.target.value ? Number(e.target.value) : undefined })} />
                </>
              )}
              {actions.length > 1 && <Button variant="ghost" icon size="sm" aria-label={`Remove action ${i + 1}`} onClick={() => setActions((c) => c.filter((_, j) => j !== i))}><X /></Button>}
            </div>
          ))}
          {actions.length < 5 && <Button size="sm" onClick={() => setActions((c) => [...c, blank("add_tag")])}><Plus />Add action</Button>}
          <p className="text-xs text-fg-subtle">Actions apply to the contact (for a lead, its primary contact) and run with the permissions of the person who approves, or of the rule's author when approval is off.</p>
        </fieldset>

        <div className="flex flex-col gap-1">
          <Checkbox label="Require approval for every run" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} />
          <Checkbox label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        </div>

        {error && <p role="alert" className="text-sm text-danger-fg">{error}</p>}
        <DialogActions>
          <Button onClick={() => void onSaved()}>Cancel</Button>
          <Button type="submit" variant="primary" loading={saving}>{rule ? "Save rule" : "Create rule"}</Button>
        </DialogActions>
      </form>
    </DialogContent>
  );
}
