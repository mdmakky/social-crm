import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { dataOf, must, serverApi } from "@/lib/api";
import { LeadDetail } from "./lead-detail";

export const metadata: Metadata = { title: "Lead" };

export default async function LeadPage({ params }: { params: Promise<{ workspaceId: string; leadId: string }> }) {
  const { workspaceId, leadId } = await params;
  const api = await serverApi();
  const p = { workspaceId };
  const lp = { workspaceId, leadId };
  const workspace = must(await api.call(endpoints.getWorkspace, { params: p }));
  const lead = must(await api.call(endpoints.getLead, { params: lp }));
  const isAdmin = can(workspace.role, "lead.delete", {});
  const [me, pipelines, activities, transitions, members, grants] = await Promise.all([
    api.call(endpoints.me),
    api.call(endpoints.listPipelines, { params: p }),
    api.call(endpoints.listLeadActivities, { params: lp }),
    api.call(endpoints.listLeadTransitions, { params: lp }),
    api.call(endpoints.listMembers, { params: p }),
    isAdmin ? api.call(endpoints.listLeadValueGrants, { params: lp }) : Promise.resolve(null),
  ]);
  const cfg = dataOf(pipelines);
  return (
    <LeadDetail
      workspaceId={workspaceId}
      timeZone={workspace.timezone}
      role={workspace.role}
      myUserId={must(me).id}
      initial={lead}
      pipelines={cfg?.pipelines ?? []}
      lostReasons={cfg?.lostReasons ?? []}
      activities={dataOf(activities)?.items ?? []}
      transitions={dataOf(transitions)?.items ?? []}
      members={(dataOf(members) ?? []).filter((m) => m.status === "active")}
      grants={grants ? (dataOf(grants)?.items ?? []) : null}
      canEdit={can(workspace.role, "lead.edit", {})}
      canDelete={isAdmin}
      canReopen={can(workspace.role, "lead.reopen", {})}
    />
  );
}
