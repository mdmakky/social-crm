import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { PageHeader, Panel } from "@/components/ui/panel";
import { ErrorState } from "@/components/ui/states";
import { dataOf, must, serverApi } from "@/lib/api";
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
  return (
    <>
      <PageHeader title="Members" description={`People with access to ${ws.data.name}.`} />
      <Panel>
        {members.data && me.data ? (
          <MembersTable workspaceId={workspaceId} members={members.data} myRole={ws.data.role} myUserId={me.data.id} timeZone={ws.data.timezone} />
        ) : (
          <ErrorState title="Members could not be loaded" description="Reload the page to try again." />
        )}
      </Panel>
    </>
  );
}
