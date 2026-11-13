import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { dataOf, must, serverApi } from "@/lib/api";
import { parseFilters, summaryQuery, toApiQuery } from "@/lib/tasks";
import { TasksView } from "./tasks-view";

export const metadata: Metadata = { title: "Tasks" };

export default async function TasksPage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId } = await params;
  const filters = parseFilters(await searchParams);
  const api = await serverApi();
  const p = { workspaceId };
  const wsRes = await api.call(endpoints.getWorkspace, { params: p });
  const workspace = must(wsRes);
  const tz = workspace.timezone;
  const [me, first, summary, members] = await Promise.all([
    api.call(endpoints.me),
    api.call(endpoints.listTasks, { params: p, query: toApiQuery(filters, tz) }),
    api.call(endpoints.taskSummary, { params: p, query: summaryQuery(filters, tz) }),
    api.call(endpoints.listMembers, { params: p }),
  ]);
  return (
    <TasksView
      workspaceId={workspaceId}
      timeZone={tz}
      role={workspace.role}
      myUserId={must(me).id}
      initial={dataOf(first)}
      initialSummary={dataOf(summary)}
      initialFilters={filters}
      members={dataOf(members) ?? []}
      canCreate={can(workspace.role, "task.edit", { isOwn: true })}
    />
  );
}
