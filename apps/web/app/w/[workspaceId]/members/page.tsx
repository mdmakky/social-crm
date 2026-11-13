import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { Member, WorkspaceDetail } from "@crm/contracts";
import { PageHeader, Panel } from "@/components/ui/panel";
import { ErrorState } from "@/components/ui/states";
import { apiGet } from "@/lib/api";
import { MembersTable } from "./members-table";

export const metadata: Metadata = { title: "Members" };

export default async function MembersPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [ws, members, me] = await Promise.all([
    apiGet<WorkspaceDetail>(`/v1/workspaces/${workspaceId}`),
    apiGet<Member[]>(`/v1/workspaces/${workspaceId}/members`),
    apiGet<{ id: string }>("/v1/me"),
  ]);
  if (!ws.data) notFound();
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
