import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { MeResponse, WorkspaceDetail } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { apiGet } from "@/lib/api";
import { AccountPanel } from "./account-panel";
import { WorkspaceForm } from "./workspace-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [ws, me] = await Promise.all([apiGet<WorkspaceDetail>(`/v1/workspaces/${workspaceId}`), apiGet<MeResponse>("/v1/me")]);
  const w = ws.data;
  if (!w) notFound();
  return (
    <>
      <PageHeader title="Settings" description="Workspace and account preferences." />
      <div className="grid max-w-2xl gap-4">
        <Panel>
          <PanelHeader title="Workspace" description={can(w.role, "workspace.settings", {}) ? "Visible to everyone who works here." : "Only owners and admins can change these."} />
          <WorkspaceForm workspaceId={workspaceId} name={w.name} timezone={w.timezone} readOnly={!can(w.role, "workspace.settings", {})} />
        </Panel>
        <Panel>
          <PanelHeader title="Your account" />
          <AccountPanel name={me.data?.name ?? ""} email={me.data?.email ?? ""} />
        </Panel>
      </div>
    </>
  );
}
