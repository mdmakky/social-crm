import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { EmptyState } from "@/components/ui/states";
import { Panel } from "@/components/ui/panel";
import { AgentPage } from "@/components/ai/agent-page";
import { must, serverApi } from "@/lib/api";

export const metadata: Metadata = { title: "Agent" };

export default async function AgentEditPage({ params }: { params: Promise<{ workspaceId: string; agentId: string }> }) {
  const { workspaceId, agentId } = await params;
  const api = await serverApi();
  const w = must(await api.call(endpoints.getWorkspace, { params: { workspaceId } }));
  return can(w.role, "ai.configure", {}) ? <AgentPage workspaceId={workspaceId} agentId={agentId} /> : (
    <Panel><EmptyState icon={ShieldAlert} title="Only owners and admins can manage AI agents" description="Ask an owner or admin of this workspace if you need an agent changed." /></Panel>
  );
}
