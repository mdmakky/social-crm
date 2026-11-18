import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { must, serverApi } from "@/lib/api";
import { AiOverview } from "./overview";

export const metadata: Metadata = { title: "AI and automation" };

export default async function AiOverviewPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const w = must(await api.call(endpoints.getWorkspace, { params: { workspaceId } }));
  const canAi = can(w.role, "ai.configure", {}), canWorkflow = can(w.role, "workflow.manage", {});
  // Roles that can neither manage AI nor automations only have Knowledge to read.
  if (!canAi && !canWorkflow) redirect(`/w/${workspaceId}/settings/ai/knowledge`);
  return <AiOverview workspaceId={workspaceId} canAi={canAi} canWorkflow={canWorkflow} />;
}
