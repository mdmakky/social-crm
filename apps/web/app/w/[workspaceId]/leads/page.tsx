import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { dataOf, must, serverApi } from "@/lib/api";
import { parseFilters, toCountsQuery, toListQuery } from "@/lib/lead-filters";
import { LeadsView } from "./leads-view";

export const metadata: Metadata = { title: "Leads" };

export default async function LeadsPage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId } = await params;
  const raw = await searchParams;
  const sp = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])));
  const api = await serverApi();
  const p = { workspaceId };
  const workspace = must(await api.call(endpoints.getWorkspace, { params: p }));
  const [me, cfg, members] = await Promise.all([api.call(endpoints.me), api.call(endpoints.listPipelines, { params: p }), api.call(endpoints.listMembers, { params: p })]);
  const pipelines = dataOf(cfg)?.pipelines ?? [];
  const f = parseFilters(sp, pipelines);
  const [first, counts] = await Promise.all([
    api.call(endpoints.listLeads, { params: p, query: toListQuery(f, pipelines) }),
    api.call(endpoints.leadStageCounts, { params: p, query: toCountsQuery(f, pipelines) }),
  ]);
  return (
    <LeadsView
      workspaceId={workspaceId}
      myUserId={must(me).id}
      pipelines={pipelines}
      lostReasons={(dataOf(cfg)?.lostReasons ?? []).filter((r) => !r.archived)}
      initial={dataOf(first)}
      initialCounts={dataOf(counts)}
      members={(dataOf(members) ?? []).filter((m) => m.status === "active")}
      canCreate={can(workspace.role, "lead.edit", {})}
      canSetValue={can(workspace.role, "lead.value.edit", {})}
      canViewValue={can(workspace.role, "lead.value.view", {})}
    />
  );
}
