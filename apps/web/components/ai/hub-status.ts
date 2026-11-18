"use client";
import * as React from "react";
import { endpoints } from "@crm/contracts";
import { browserApi } from "@/lib/client-api";

/** Broadcast so the hub header and the Overview refetch after an approval, a rule change or an agent test (same pattern as the inbox). */
export const AI_CHANGED = "crm-ai-changed";
export const notifyAiChanged = () => window.dispatchEvent(new Event(AI_CHANGED));

export type HubStatus = {
  provider: { label: string; mock: boolean; configured: boolean } | null;
  usage: { usedMicro: number; capMicro: number | null } | null;
  approvals: number | null;
  rules: { running: number; paused: number; killSwitch: boolean } | null;
};
const EMPTY: HubStatus = { provider: null, usage: null, approvals: null, rules: null };

/** What the strip above the tabs shows. Each part is fetched only if the role may use it; a failed part stays empty instead of blocking the others. */
export function useHubStatus(workspaceId: string, canAi: boolean, canWorkflow: boolean) {
  const [status, setStatus] = React.useState<HubStatus>(EMPTY);
  const [loaded, setLoaded] = React.useState(false);
  const load = React.useCallback(async () => {
    const p = { workspaceId };
    const [prov, usage, acts, runs, rules, settings] = await Promise.all([
      canAi ? browserApi.call(endpoints.listAiProviders, { params: p }) : null,
      canAi ? browserApi.call(endpoints.getAiUsage, { params: p, query: { days: 30 } }) : null,
      canAi ? browserApi.call(endpoints.listAiAgentActions, { params: p, query: { status: "pending", limit: 100 } }) : null,
      canWorkflow ? browserApi.call(endpoints.listAutomationRuns, { params: p, query: { status: "awaiting_approval", limit: 100 } }) : null,
      canWorkflow ? browserApi.call(endpoints.listAutomationRules, { params: p }) : null,
      canWorkflow ? browserApi.call(endpoints.getAutomationSettings, { params: p }) : null,
    ]);
    const d = prov?.ok ? prov.data.items.find((x) => x.isDefault && x.configured && x.enabled) ?? null : null;
    const pending = (acts?.ok ? acts.data.items.length : 0) + (runs?.ok ? runs.data.items.length : 0);
    setStatus({
      provider: prov?.ok ? (d ? { label: d.label, mock: d.mock, configured: true } : { label: "Not connected", mock: false, configured: false }) : null,
      usage: usage?.ok ? { usedMicro: usage.data.month.usedMicro, capMicro: usage.data.month.capMicro } : null,
      approvals: acts?.ok || runs?.ok ? pending : null,
      rules: rules?.ok ? { running: rules.data.filter((r) => r.enabled).length, paused: rules.data.filter((r) => !r.enabled).length, killSwitch: settings?.ok ? settings.data.killSwitch : false } : null,
    });
    setLoaded(true);
  }, [workspaceId, canAi, canWorkflow]);
  React.useEffect(() => {
    void load(); // eslint-disable-line react-hooks/set-state-in-effect
    window.addEventListener(AI_CHANGED, load);
    return () => window.removeEventListener(AI_CHANGED, load);
  }, [load]);
  return { status, loaded };
}
