import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { SettingsPage } from "@/components/settings/settings-page";
import { dataOf, must, serverApi } from "@/lib/api";
import { GeneralSettings } from "./general-settings";

export const metadata: Metadata = { title: "Settings" };

export default async function GeneralSettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const [wsRes, meRes] = await Promise.all([api.call(endpoints.getWorkspace, { params: { workspaceId } }), api.call(endpoints.me)]);
  const w = must(wsRes);
  const me = dataOf(meRes);
  return (
    <SettingsPage title="General" description="Workspace, region and format, business info and your account.">
      <GeneralSettings workspaceId={workspaceId} workspace={w} me={{ name: me?.name ?? "", email: me?.email ?? "" }} canEdit={can(w.role, "workspace.settings", {})} />
    </SettingsPage>
  );
}
