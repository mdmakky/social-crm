"use client";
import * as React from "react";
import Link from "next/link";
import { ListChecks, Plus, RefreshCw, Tag, Trash2, UserPlus, Workflow, X, Bot, Sparkles, Trophy } from "lucide-react";
import { AUTOMATION_ACTION_TYPES, AUTOMATION_TRIGGERS, endpoints, type AutomationRuleDto, type AutomationRunDto, type AutomationTrigger } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/form-controls";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, ErrorState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { actionText, cap, lower, presets, sentenceOf, toRows, type Member } from "./automation-model";
import { useLookups } from "./use-lookups";

const STATUS_TONE = { pending: "accent", awaiting_approval: "warning", running: "accent", succeeded: "success", failed: "danger", cancelled: "neutral", skipped: "neutral" } as const;
const STATUS_LABEL = { pending: "Queued", awaiting_approval: "Waiting for your approval", running: "Running", succeeded: "Done", failed: "Failed", cancelled: "Rejected", skipped: "Skipped" } as const;
const PRESET_ICON = { task: ListChecks, tag: Tag, assign: UserPlus, ai: Bot, facebook: Sparkles, won: Trophy } as const;

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
  const lk = useLookups(workspaceId);

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

  const editor = (suffix: string) => `/w/${workspaceId}/settings/ai/automations/${suffix}`;

  return (
    <div className="space-y-[var(--page-gap)]">
      <p className="max-w-2xl text-base text-fg-muted">Automations do routine work for you. When something happens, for example a new lead arrives, they can create a follow-up task, add a tag or assign an owner. You choose whether each one asks you first.</p>

      {killSwitch ? (
        <Alert tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span><strong>Automations are paused.</strong> Nothing new runs, waiting runs stay put and approvals are blocked until you resume.</span>
            <Button size="sm" loading={busy === "kill"} onClick={() => void act("kill", () => browserApi.call(endpoints.updateAutomationSettings, { params, body: { killSwitch: false } }), "Automations resumed")}>Resume automations</Button>
          </div>
        </Alert>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-subtle px-3 py-2 text-sm text-fg-muted">
          <span><strong className="font-medium text-fg">Automations are on.</strong> If something goes wrong, you can pause every automation at once.</span>
          <Button size="sm" loading={busy === "kill"} onClick={() => void act("kill", () => browserApi.call(endpoints.updateAutomationSettings, { params, body: { killSwitch: true } }), "Automations paused")}>Pause all automations</Button>
        </div>
      )}

      <Panel>
        <PanelHeader title="Your automations" description="Each one says what starts it and what it does." actions={<Button asChild variant="primary" size="sm"><Link href={editor("new")}><Plus />New automation</Link></Button>} />
        {rules.length === 0 ? (
          <div className="px-4 py-6">
            <div className="mb-4 flex items-center gap-2 text-fg"><Workflow className="size-4 text-fg-subtle" aria-hidden /><h3 className="text-base font-semibold">No automations yet</h3></div>
            <p className="mb-4 max-w-xl text-sm text-fg-muted">Start from one of these, then change anything you like. Nothing runs until you turn it on, and each one can ask you first.</p>
            <ul className="grid gap-3 sm:grid-cols-2">
              {presets(members).map((p) => (
                <li key={p.id}>
                  <Link href={editor(`new?start=${p.id}`)} className="press flex h-full w-full items-start gap-3 rounded-card border border-line bg-surface p-3 text-left hover:border-line-strong hover:bg-subtle">
                    <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-hover text-fg-muted">{React.createElement(PRESET_ICON[p.id as keyof typeof PRESET_ICON] ?? Workflow, { className: "size-4", "aria-hidden": true })}</span>
                    <span className="min-w-0"><span className="block text-base font-medium text-fg">{p.title}</span><span className="block text-sm text-fg-muted">{p.text}</span></span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-4"><Button asChild><Link href={editor("new")}>Start from scratch</Link></Button></div>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {rules.map((r) => {
              const parsed = toRows(r.conditions);
              return (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-fg">{r.name}<Badge tone={r.requiresApproval ? "warning" : "neutral"}>{r.requiresApproval ? "Asks you first" : "Runs on its own"}</Badge></p>
                    <p className="mt-0.5 text-sm text-fg-muted">{sentenceOf(r.triggerType, parsed, r.actions, members, lk)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox label="On" checked={r.enabled} disabled={busy === `rule-${r.id}`} aria-label={`Turn on ${r.name}`} onChange={(e) => void act(`rule-${r.id}`, () => browserApi.call(endpoints.updateAutomationRule, { params: { ...params, ruleId: r.id }, body: { enabled: e.target.checked } }), e.target.checked ? "Automation turned on" : "Automation turned off")} />
                    <Button asChild size="sm"><Link href={editor(r.id)} aria-label={`Edit ${r.name}`}>Edit</Link></Button>
                    <Button size="sm" variant="ghost" icon aria-label={`Delete ${r.name}`} loading={busy === `del-${r.id}`} onClick={() => { if (window.confirm(`Delete “${r.name}”? What it already did stays in Activity.`)) void act(`del-${r.id}`, () => browserApi.call(endpoints.deleteAutomationRule, { params: { ...params, ruleId: r.id } }), "Automation deleted"); }}><Trash2 /></Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="Activity" description="What your automations did, newest first. Updates every few seconds." actions={<Button size="sm" variant="ghost" icon aria-label="Refresh activity" onClick={() => void load(true)}><RefreshCw /></Button>} />
        {runs.length === 0 ? (
          <div className="px-4 py-8 text-center"><h3 className="text-base font-semibold text-fg">Nothing has run yet</h3><p className="mx-auto mt-1 max-w-sm text-sm text-fg-muted">When an automation that is turned on is triggered, you will see it here, and approve it if it asks first.</p></div>
        ) : (
          <ul className="divide-y divide-line">
            {runs.map((r) => (
              <li key={r.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-fg">{r.ruleName}<Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge></p>
                    <p className="text-sm text-fg-muted">{cap(lower(AUTOMATION_TRIGGERS[r.triggerType as AutomationTrigger]?.label ?? r.triggerType))} · {formatDateTime(r.createdAt, timeZone)}{r.attempts > 1 ? ` · attempt ${r.attempts}` : ""}</p>
                    <p className="text-sm text-fg-muted">{cap(r.actions.map((a) => actionText(a, members, lk)).join(", then "))}.</p>
                  </div>
                  {r.status === "awaiting_approval" && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="primary" disabled={killSwitch} loading={busy === `ok-${r.id}`} aria-label={`Approve run of ${r.ruleName}`} onClick={() => void act(`ok-${r.id}`, () => browserApi.call(endpoints.approveAutomationRun, { params: { ...params, runId: r.id } }), "Approved. It will run now.")}>Approve</Button>
                      <Button size="sm" loading={busy === `no-${r.id}`} aria-label={`Reject run of ${r.ruleName}`} onClick={() => void act(`no-${r.id}`, () => browserApi.call(endpoints.rejectAutomationRun, { params: { ...params, runId: r.id } }), "Rejected. It will not run.")}><X />Reject</Button>
                    </div>
                  )}
                </div>
                {r.error && r.status !== "cancelled" && <p role="note" className="mt-1 text-sm text-danger-fg">{r.error}{r.status === "pending" && r.nextAttemptAt ? ` Retrying at ${formatDateTime(r.nextAttemptAt, timeZone)}.` : ""}</p>}
                {r.steps.length > 0 && (
                  <details className="mt-1 text-sm text-fg-muted">
                    <summary className="cursor-pointer select-none">Details ({r.steps.length} {r.steps.length === 1 ? "step" : "steps"})</summary>
                    <ol className="mt-1 space-y-0.5">
                      {r.steps.map((s) => <li key={s.id}>Attempt {s.attempt}, step {s.idx + 1}: {AUTOMATION_ACTION_TYPES[s.actionType as keyof typeof AUTOMATION_ACTION_TYPES] ?? s.actionType}, {s.status}{s.error ? ` (${s.error})` : ""}</li>)}
                    </ol>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {nextCursor && <div className="border-t border-line px-4 py-2"><Button size="sm" loading={busy === "more"} onClick={() => void loadMore()}>Load older activity</Button></div>}
      </Panel>
    </div>
  );
}
