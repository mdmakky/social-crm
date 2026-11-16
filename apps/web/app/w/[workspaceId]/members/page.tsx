import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { SettingsPage } from "@/components/settings/settings-page";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { ErrorState } from "@/components/ui/states";
import { dataOf, must, serverApi } from "@/lib/api";
import { InvitationsList, InviteButton } from "./invitations";
import { MembersTable } from "./members-table";

export const metadata: Metadata = { title: "Members" };

export default async function MembersPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const [wsRes, membersRes, meRes] = await Promise.all([
    api.call(endpoints.getWorkspace, { params: { workspaceId } }),
    api.call(endpoints.listMembers, { params: { workspaceId } }),
    api.call(endpoints.me),
  ]);
  const ws = { data: must(wsRes) };
  const members = { data: dataOf(membersRes) };
  const me = { data: dataOf(meRes) };
  const canInvite = can(ws.data.role, "member.invite", {});
  const invitations = canInvite ? dataOf(await api.call(endpoints.listInvitations, { params: { workspaceId } })) : null;
  return (
    <SettingsPage title="Members" description={`People with access to ${ws.data.name}.`} actions={canInvite ? <InviteButton workspaceId={workspaceId} myRole={ws.data.role} /> : undefined}>
      <Panel>
        {members.data && me.data ? (
          <MembersTable workspaceId={workspaceId} members={members.data} myRole={ws.data.role} myUserId={me.data.id} timeZone={ws.data.timezone} />
        ) : (
          <ErrorState title="Members could not be loaded" description="Reload the page to try again." />
        )}
      </Panel>
      {canInvite && (
        <Panel>
          <PanelHeader title="Invitations" description="Links stay valid for 7 days." />
          <InvitationsList workspaceId={workspaceId} invitations={invitations} myRole={ws.data.role} timeZone={ws.data.timezone} />
        </Panel>
      )}
    </SettingsPage>
  );
}
