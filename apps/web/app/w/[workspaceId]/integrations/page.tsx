import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { PageHeader } from "@/components/ui/panel";
import { Alert } from "@/components/ui/states";
import { dataOf, must, serverApi } from "@/lib/api";
import { MetaIntegrations } from "./meta-integrations";

export const metadata: Metadata = { title: "Integrations" };

export default async function IntegrationsPage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<{ meta?: string; channel?: string }> }) {
  const { workspaceId } = await params;
  const { meta, channel } = await searchParams;
  const api = await serverApi();
  const w = must(await api.call(endpoints.getWorkspace, { params: { workspaceId } }));
  const header = <PageHeader title="Integrations" description="Connect the channels your customers write to you on." />;
  if (!can(w.role, "integration.view", {})) return <>{header}<Alert tone="info">You don&apos;t have access to integrations in this workspace.</Alert></>;
  const state = dataOf(await api.call(endpoints.getMetaIntegration, { params: { workspaceId } }));
  return <>{header}<MetaIntegrations workspaceId={workspaceId} canManage={can(w.role, "integration.manage", {})} initial={state} result={meta} channel={channel} /></>;
}
