import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { SettingsPage } from "@/components/settings/settings-page";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { dataOf, must, serverApi } from "@/lib/api";
import { AccountPanel } from "./account-panel";
import { WorkspaceForm } from "./workspace-form";

export const metadata: Metadata = { title: "Settings" };

export default async function GeneralSettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const [wsRes, meRes] = await Promise.all([api.call(endpoints.getWorkspace, { params: { workspaceId } }), api.call(endpoints.me)]);
  const w = must(wsRes);
  const me = { data: dataOf(meRes) };
  return (
    <SettingsPage title="General" description="Workspace name, time zone and your account.">
        <Panel>
          <PanelHeader title="Workspace" description={can(w.role, "workspace.settings", {}) ? "Visible to everyone who works here." : "Only owners and admins can change these."} />
          <WorkspaceForm workspaceId={workspaceId} name={w.name} timezone={w.timezone} readOnly={!can(w.role, "workspace.settings", {})} />
        </Panel>
        <Panel>
          <PanelHeader title="Your account" />
          <AccountPanel name={me.data?.name ?? ""} email={me.data?.email ?? ""} />
        </Panel>
    </SettingsPage>
  );
}
