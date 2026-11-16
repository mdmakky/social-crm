import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { SettingsPage } from "@/components/settings/settings-page";
import { Alert } from "@/components/ui/states";
import { dataOf, must, serverApi } from "@/lib/api";
import { CapiPanel } from "./capi-panel";
import { MetaIntegrations } from "./meta-integrations";

export const metadata: Metadata = { title: "Integrations" };

export default async function IntegrationsPage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<{ meta?: string; channel?: string }> }) {
  const { workspaceId } = await params;
  const { meta, channel } = await searchParams;
  const api = await serverApi();
  const w = must(await api.call(endpoints.getWorkspace, { params: { workspaceId } }));
  const page = (children: React.ReactNode) => <SettingsPage title="Integrations" description="Connect the channels your customers write to you on.">{children}</SettingsPage>;
  if (!can(w.role, "integration.view", {})) return page(<Alert tone="info">You don&apos;t have access to integrations in this workspace.</Alert>);
  const state = dataOf(await api.call(endpoints.getMetaIntegration, { params: { workspaceId } }));
  return page(<><MetaIntegrations workspaceId={workspaceId} canManage={can(w.role, "integration.manage", {})} initial={state} result={meta} channel={channel} />{can(w.role, "capi.view", {}) && <CapiPanel workspaceId={workspaceId} canManage={can(w.role, "capi.manage", {})} />}</>);
}
