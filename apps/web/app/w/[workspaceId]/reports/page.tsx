import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { dataOf, must, serverApi } from "@/lib/api";
import { ReportsView } from "./reports-view";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const p = { workspaceId };
  must(await api.call(endpoints.getWorkspace, { params: p }));
  const [cfg, report] = await Promise.all([api.call(endpoints.listPipelines, { params: p }), api.call(endpoints.leadReport, { params: p, query: {} })]);
  return <ReportsView workspaceId={workspaceId} pipelines={(dataOf(cfg)?.pipelines ?? []).filter((x) => !x.archived)} initial={dataOf(report)} />;
}
