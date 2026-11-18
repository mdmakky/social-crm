"use client";
import * as React from "react";
import Link from "next/link";
import { Bot, Plus } from "lucide-react";
import { endpoints, type AgentDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { browserApi, errorMessage } from "@/lib/client-api";

const STATUS_TONE = { draft: "neutral", active: "success", archived: "stone" } as const;

/**
 * Settings, AI Agents: the list. Creating and editing an agent is a page of its own (`/w/:id/agents/new`, `/w/:id/agents/:agentId`).
 * Everything the model answers is a DRAFT; actions run only as the agent's grants allow, and sensitive ones wait for approval.
 */
export function AgentsSettings({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = React.useState<{ agents: AgentDto[]; activeCount: number; maxActive: number } | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    const l = await browserApi.call(endpoints.listAiAgents, { params: { workspaceId } });
    if (!l.ok) { setLoadError(errorMessage(l.error)); return; }
    setLoadError(null);
    setData({ agents: l.data.items, activeCount: l.data.activeCount, maxActive: l.data.maxActive });
  }, [workspaceId]);
  React.useEffect(() => { void load(); }, [load]); // eslint-disable-line react-hooks/set-state-in-effect

  if (loadError) return <ErrorState title="Could not load AI agents" description={loadError} onRetry={() => { setLoadError(null); void load(); }} />;
  if (!data) return <div className="flex flex-col gap-4" role="status" aria-label="Loading AI agents"><Skeleton className="h-40" /></div>;
  const newHref = `/w/${workspaceId}/agents/new`;
  return (
    <Panel>
      <PanelHeader title="Agents" description={`${data.activeCount} of ${data.maxActive} active agents used.`} actions={<Button variant="primary" asChild><Link href={newHref}><Plus className="size-4" aria-hidden />New agent</Link></Button>} />
      {data.agents.length === 0 ? (
        <EmptyState icon={Bot} title="No agents yet" description="Create one, then test it before activating." action={<Button variant="primary" asChild><Link href={newHref}>Create an agent</Link></Button>} />
      ) : (
        <Table scrollLabel="Agents">
          <THead><TR><TH>Name</TH><TH>Status</TH><TH>Version</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
          <TBody>
            {data.agents.map((a) => (
              <TR key={a.id}>
                <TD className="font-medium">{a.name}{a.description && <span className="block text-xs font-normal text-fg-muted">{a.description}</span>}</TD>
                <TD><Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge></TD>
                <TD>{a.activeVersion ? `v${a.activeVersion} live` : "-"} <span className="text-xs text-fg-muted">(latest v{a.latestVersion})</span></TD>
                <TD><Button size="sm" asChild><Link href={`/w/${workspaceId}/agents/${a.id}`} aria-label={`Edit ${a.name}`}>Edit</Link></Button></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Panel>
  );
}
