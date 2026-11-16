import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { SettingsPage } from "@/components/settings/settings-page";
import { dataOf, must, serverApi } from "@/lib/api";
import { PipelineSettings } from "./pipeline-settings";

export const metadata: Metadata = { title: "Pipeline settings" };

export default async function PipelineSettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const p = { workspaceId };
  const [ws, cfg] = await Promise.all([api.call(endpoints.getWorkspace, { params: p }), api.call(endpoints.listPipelines, { params: p })]);
  const w = must(ws);
  return (
    <SettingsPage title="Pipeline settings" description="Pipelines, their stages and the reasons a lead can be lost. Stages are independent of contact lifecycle stages.">
      <PipelineSettings workspaceId={workspaceId} canManage={can(w.role, "schema.manage", {})} initial={dataOf(cfg)} />
    </SettingsPage>
  );
}
