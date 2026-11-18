"use client";
import * as React from "react";
import Link from "next/link";
import { Bell, CheckCircle2, Info } from "lucide-react";
import { endpoints, type AgentActionDto, type AutomationAction, type AutomationRunDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { AI_CHANGED, notifyAiChanged } from "@/components/ai/hub-status";
import { browserApi, errorMessage } from "@/lib/client-api";
import { relTime, useNow } from "@/lib/inbox";

const TOOL: Record<string, string> = { "crm.add_note": "Add a note to the lead", "crm.assign_owner": "Assign an owner", "crm.add_tag": "Add a tag", "crm.create_task": "Create a task", "knowledge.search": "Look something up in Knowledge" };
const toolLabel = (t: string) => TOOL[t] ?? t.replace(/^[a-z]+\./, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
/** A short, readable summary of the arguments (never raw JSON): scalar values only, trimmed. */
const argsText = (args: Record<string, unknown>) => Object.entries(args).filter(([, v]) => typeof v === "string" || typeof v === "number").slice(0, 2).map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v).slice(0, 48)}`).join(" · ");
const describe = (a: AutomationAction) => (a.type === "create_task" ? `Create task “${a.title}”` : a.type === "add_tag" ? `Add tag “${a.tagName}”` : a.type === "assign_owner" ? "Assign an owner" : "Run an AI agent");
const SOURCE = { test: "test run", run: "run by a person", automation: "from a rule" } as const;

type Approval = { kind: "agent"; at: string; a: AgentActionDto } | { kind: "rule"; at: string; r: AutomationRunDto };
type Activity = { id: string; at: string; tone: "ok" | "wait" | "bad"; text: React.ReactNode; note: string };
type Data = { approvals: Approval[]; activity: Activity[]; mock: boolean; killSwitch: boolean };

/** The Overview tab: one queue for everything that waits for a person (agent actions and rule runs), then what just happened. */
export function AiOverview({ workspaceId, canAi, canWorkflow }: { workspaceId: string; canAi: boolean; canWorkflow: boolean }) {
  return <ToastProvider><Inner workspaceId={workspaceId} canAi={canAi} canWorkflow={canWorkflow} /></ToastProvider>;
}

function Inner({ workspaceId, canAi, canWorkflow }: { workspaceId: string; canAi: boolean; canWorkflow: boolean }) {
  const toast = useToast();
  const now = useNow();
  const params = { workspaceId };
  const [data, setData] = React.useState<Data | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const [prov, pend, acts, awaiting, recentRuns, settings, agents] = await Promise.all([
      canAi ? browserApi.call(endpoints.listAiProviders, { params }) : null,
      canAi ? browserApi.call(endpoints.listAiAgentActions, { params, query: { status: "pending", limit: 100 } }) : null,
      canAi ? browserApi.call(endpoints.listAiAgentActions, { params, query: { limit: 12 } }) : null,
      canWorkflow ? browserApi.call(endpoints.listAutomationRuns, { params, query: { status: "awaiting_approval", limit: 100 } }) : null,
      canWorkflow ? browserApi.call(endpoints.listAutomationRuns, { params, query: { limit: 12 } }) : null,
      canWorkflow ? browserApi.call(endpoints.getAutomationSettings, { params }) : null,
      canAi ? browserApi.call(endpoints.listAiAgents, { params }) : null,
    ]);
    const failed = [prov, pend, acts, awaiting, recentRuns, settings, agents].find((r) => r && !r.ok);
    if (failed && !failed.ok) { setError(errorMessage(failed.error)); return; }
    // Recent drafts: the newest runs of up to five agents (the API lists runs per agent).
    const agentRuns = agents?.ok
      ? (await Promise.all(agents.data.items.slice(0, 5).map(async (ag) => { const r = await browserApi.call(endpoints.listAiAgentRuns, { params: { ...params, agentId: ag.id }, query: { limit: 4 } }); return r.ok ? r.data.items.map((x) => ({ ag, x })) : []; }))).flat()
      : [];
    const approvals: Approval[] = [
      ...(pend?.ok ? pend.data.items.map((a) => ({ kind: "agent" as const, at: a.createdAt, a })) : []),
      ...(awaiting?.ok ? awaiting.data.items.map((r) => ({ kind: "rule" as const, at: r.createdAt, r })) : []),
    ].sort((x, y) => y.at.localeCompare(x.at));
    const activity: Activity[] = [
      ...(acts?.ok ? acts.data.items.map((a): Activity => ({ id: `a-${a.id}`, at: a.createdAt, tone: a.status === "pending" ? "wait" : a.status === "executed" ? "ok" : "bad", text: <><b className="font-medium">{a.agentName}</b> {a.status === "pending" ? "proposed" : a.status === "executed" ? "did" : a.status === "rejected" ? "was refused:" : "failed:"} {toolLabel(a.tool)}</>, note: a.status === "pending" ? "Waiting for approval" : a.status === "executed" ? "Done" : a.status === "rejected" ? "Rejected" : "Failed" })) : []),
      ...(recentRuns?.ok ? recentRuns.data.items.map((r): Activity => ({ id: `r-${r.id}`, at: r.createdAt, tone: r.status === "succeeded" ? "ok" : r.status === "failed" ? "bad" : "wait", text: <>Rule <b className="font-medium">{r.ruleName}</b> {r.status === "succeeded" ? "ran" : r.status === "failed" ? "failed" : r.status === "awaiting_approval" ? "is waiting" : r.status}</>, note: r.actions.map(describe).join(", ") })) : []),
      ...agentRuns.map(({ ag, x }): Activity => ({ id: `u-${x.id}`, at: x.createdAt, tone: x.status === "ok" ? "ok" : "bad", text: x.status === "ok" ? <>Reply draft from <b className="font-medium">{ag.name}</b></> : <><b className="font-medium">{ag.name}</b> failed: {x.errorCode ?? x.status}</>, note: x.status === "ok" ? "Draft only, never sent" : "No action was taken" })),
    ].sort((x, y) => y.at.localeCompare(x.at)).slice(0, 8);
    const d = prov?.ok ? prov.data.items.find((x) => x.isDefault && x.configured && x.enabled) : undefined;
    setError(null);
    setData({ approvals, activity, mock: !!d?.mock, killSwitch: settings?.ok ? settings.data.killSwitch : false });
  }, [workspaceId, canAi, canWorkflow]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    void load(); // eslint-disable-line react-hooks/set-state-in-effect
    window.addEventListener(AI_CHANGED, load);
    return () => window.removeEventListener(AI_CHANGED, load);
  }, [load]);

  async function decide(item: Approval, approve: boolean) {
    const id = item.kind === "agent" ? item.a.id : item.r.id;
    setBusy(id);
    if (item.kind === "agent") {
      const r = await browserApi.call(approve ? endpoints.approveAiAgentAction : endpoints.rejectAiAgentAction, { params: { ...params, actionId: id } });
      setBusy(null);
      if (!r.ok) { toast(errorMessage(r.error), "error"); await load(); return; }
      toast(!approve ? "Action rejected" : r.data.status === "executed" ? "Approved and done" : `Action ${r.data.status}${r.data.error ? `: ${r.data.error}` : ""}`, r.data.status === "failed" ? "error" : "success");
    } else {
      const r = await browserApi.call(approve ? endpoints.approveAutomationRun : endpoints.rejectAutomationRun, { params: { ...params, runId: id } });
      setBusy(null);
      if (!r.ok) { toast(errorMessage(r.error), "error"); await load(); return; }
      toast(approve ? "Run approved" : "Run rejected");
    }
    notifyAiChanged();
  }

  if (error && !data) return <ErrorState title="Could not load the overview" description={error} onRetry={() => { setError(null); void load(); }} />;
  if (!data) return <div role="status" aria-label="Loading overview" className="grid gap-4 lg:grid-cols-[3fr_2fr]"><Skeleton className="h-56" /><Skeleton className="h-56" /></div>;
  return (
    <div className="flex flex-col gap-[var(--page-gap)]">
      {data.mock && <Alert tone="info"><Info className="size-4" aria-hidden />Using the mock provider: drafts are canned text and nothing leaves this server. <Link className="font-medium underline" href={`/w/${workspaceId}/settings/ai/setup`}>Connect a real provider in Setup</Link>.</Alert>}
      {data.killSwitch && <Alert tone="warning">All automations are paused. Rule runs and agent actions will not execute until you resume them in <Link className="font-medium underline" href={`/w/${workspaceId}/settings/ai/automations`}>Automations</Link>.</Alert>}
      <div className="grid items-start gap-[var(--page-gap)] lg:grid-cols-[3fr_2fr]">
        <Panel>
          <PanelHeader title="Needs your approval" description="Agents and rules wait here before they change anything." />
          {data.approvals.length === 0 ? <EmptyState icon={CheckCircle2} title="Nothing waiting" description="When an agent or a rule wants to change something, it appears here." /> : (
            <ul className="divide-y divide-line-card">
              {data.approvals.map((it) => {
                const agent = it.kind === "agent";
                const title = agent ? `${toolLabel(it.a.tool)}${argsText(it.a.args) ? ` (${argsText(it.a.args)})` : ""}` : it.r.actions.map(describe).join(", ");
                const note = agent ? `${it.a.agentName} v${it.a.agentVersion} · ${it.a.reason === "sensitive" ? "sensitive tool" : "needs approval"} · ${SOURCE[it.a.source]}` : `Rule “${it.r.ruleName}”`;
                const id = agent ? it.a.id : it.r.id;
                const approveOff = !agent && data.killSwitch;
                return (
                  <li key={id} className="flex flex-wrap items-center gap-x-3 gap-y-2 p-4">
                    <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning-bg text-warning-fg"><Bell className="size-4" /></span>
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="text-base font-medium text-fg"><Badge tone={agent ? "accent" : "neutral"} shape="square" className="mr-1.5 align-[1px]">{agent ? "Agent" : "Rule"}</Badge>{title}</p>
                      <p className="text-sm text-fg-subtle">{note} · <time dateTime={it.at}>{relTime(it.at, now)} ago</time></p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" disabled={busy === id} onClick={() => void decide(it, false)} aria-label={agent ? `Reject ${it.a.tool}` : `Reject run of ${it.r.ruleName}`}>Reject</Button>
                      <Button size="sm" variant="primary" loading={busy === id} disabled={approveOff} title={approveOff ? "All automations are paused" : undefined} onClick={() => void decide(it, true)} aria-label={agent ? `Approve ${it.a.tool}` : `Approve run of ${it.r.ruleName}`}>Approve</Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        <Panel>
          <PanelHeader title="Recent activity" description="Agents and rules, newest first." />
          {data.activity.length === 0 ? <EmptyState title="Nothing yet" description="Runs and proposed actions show up here." /> : (
            <ul className="px-4 pb-2 pt-1">
              {data.activity.map((x) => (
                <li key={x.id} className="flex gap-2.5 border-b border-line-card py-2.5 last:border-b-0">
                  <span aria-hidden className={`mt-2 size-2 shrink-0 rounded-full ${x.tone === "ok" ? "bg-success-fg" : x.tone === "wait" ? "bg-warning-fg" : "bg-danger"}`} />
                  <p className="min-w-0 flex-1 text-base text-fg">{x.text}<span className="block text-sm text-fg-subtle">{x.note} · <time dateTime={x.at}>{relTime(x.at, now)}</time></span></p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
