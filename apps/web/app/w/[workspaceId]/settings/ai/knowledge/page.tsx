import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { must, serverApi } from "@/lib/api";
import { KnowledgeSettings } from "../../knowledge/knowledge-settings";

export const metadata: Metadata = { title: "Knowledge" };

export default async function KnowledgePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const w = must(await api.call(endpoints.getWorkspace, { params: { workspaceId } }));
  return <KnowledgeSettings workspaceId={workspaceId} timeZone={w.timezone} canManage={can(w.role, "ai.configure", {})} />;
}
