import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { SettingsPage } from "@/components/settings/settings-page";
import { Alert } from "@/components/ui/states";
import { must, serverApi } from "@/lib/api";
import { CapiPanel } from "./capi-panel";

export const metadata: Metadata = { title: "Ad measurement" };

export default async function AdMeasurementPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const w = must(await api.call(endpoints.getWorkspace, { params: { workspaceId } }));
  return (
    <SettingsPage title="Ad measurement" description="Choose which stage sends which event to Meta. Only leads who agreed to ad measurement are sent.">
      {can(w.role, "capi.view", {}) ? <CapiPanel workspaceId={workspaceId} canManage={can(w.role, "capi.manage", {})} /> : <Alert tone="info">Only owners and admins can manage ad measurement.</Alert>}
    </SettingsPage>
  );
}
