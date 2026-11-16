import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { SettingsPage } from "@/components/settings/settings-page";
import { dataOf, must, serverApi } from "@/lib/api";
import { PipelineSettings } from "./pipeline-settings";

export const metadata: Metadata = { title: "Lead stages" };

export default async function PipelineSettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const p = { workspaceId };
  const [ws, cfg] = await Promise.all([api.call(endpoints.getWorkspace, { params: p }), api.call(endpoints.listPipelines, { params: p })]);
  const w = must(ws);
  return (
    <SettingsPage title="Lead stages" description="Pipelines, stages and lost reasons.">
      <PipelineSettings workspaceId={workspaceId} canManage={can(w.role, "schema.manage", {})} initial={dataOf(cfg)} />
    </SettingsPage>
  );
}
