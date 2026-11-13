import type { Metadata } from "next";
import { endpoints, type LeadDto } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { dataOf, must, serverApi } from "@/lib/api";
import { PipelineBoard } from "./pipeline-board";

export const metadata: Metadata = { title: "Pipeline" };
const BOARD_CAP = 500;

export default async function PipelinePage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<{ pipeline?: string }> }) {
  const { workspaceId } = await params;
  const { pipeline: wanted } = await searchParams;
  const api = await serverApi();
  const p = { workspaceId };
  const workspace = must(await api.call(endpoints.getWorkspace, { params: p }));
  const cfg = dataOf(await api.call(endpoints.listPipelines, { params: p }));
  const pipelines = cfg?.pipelines ?? [];
  const live = pipelines.filter((x) => !x.archived);
  const current = live.find((x) => x.id === wanted) ?? live.find((x) => x.isDefault) ?? live[0];
  const leads: LeadDto[] = [];
  let truncated = false;
  if (current) {
    let cursor: string | undefined;
    for (let i = 0; i < BOARD_CAP / 100; i++) {
      const r = dataOf(await api.call(endpoints.listLeads, { params: p, query: { pipelineId: current.id, outcome: "open", limit: 100, sort: "created", dir: "asc", ...(cursor ? { cursor } : {}) } }));
      if (!r) break;
      leads.push(...r.items);
      cursor = r.nextCursor ?? undefined;
      if (!cursor) break;
      if (i === BOARD_CAP / 100 - 1) truncated = true;
    }
  }
  return (
    <PipelineBoard
      key={current?.id}
      workspaceId={workspaceId}
      pipelines={live}
      lostReasons={(cfg?.lostReasons ?? []).filter((r) => !r.archived)}
      current={current ?? null}
      initialLeads={leads}
      truncated={truncated}
      canEdit={can(workspace.role, "lead.edit", {})}
      canCreate={can(workspace.role, "lead.edit", {})}
      canSetValue={can(workspace.role, "lead.value.edit", {})}
    />
  );
}
