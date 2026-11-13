import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { dataOf, must, serverApi } from "@/lib/api";
import { LeadsView } from "./leads-view";

export const metadata: Metadata = { title: "Leads" };

export default async function LeadsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const p = { workspaceId };
  const workspace = must(await api.call(endpoints.getWorkspace, { params: p }));
  const [me, pipelines, first, members] = await Promise.all([
    api.call(endpoints.me),
    api.call(endpoints.listPipelines, { params: p }),
    api.call(endpoints.listLeads, { params: p, query: { outcome: "open", limit: 50 } }),
    api.call(endpoints.listMembers, { params: p }),
  ]);
  return (
    <LeadsView
      workspaceId={workspaceId}
      myUserId={must(me).id}
      pipelines={dataOf(pipelines)?.pipelines ?? []}
      initial={dataOf(first)}
      members={(dataOf(members) ?? []).filter((m) => m.status === "active")}
      canCreate={can(workspace.role, "lead.edit", {})}
      canSetValue={can(workspace.role, "lead.value.edit", {})}
    />
  );
}
