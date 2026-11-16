import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { InboxShell } from "@/components/inbox/shell";
import { Alert } from "@/components/ui/states";
import { dataOf, must, serverApi } from "@/lib/api";

export default async function InboxLayout({ children, params }: { children: React.ReactNode; params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const [w, me, members] = await Promise.all([api.call(endpoints.getWorkspace, { params: { workspaceId } }), api.call(endpoints.me), api.call(endpoints.listMembers, { params: { workspaceId } })]);
  const ws = must(w);
  const user = must(me);
  if (!can(ws.role, "conversation.view", {})) return <Alert tone="info">You don&apos;t have access to the inbox. Ask an owner to change your role.</Alert>;
  return (
    <InboxShell workspaceId={workspaceId} myUserId={user.id} canReply={can(ws.role, "conversation.reply", {})} canAssignAny={ws.role === "owner" || ws.role === "admin"} canEditLead={can(ws.role, "lead.edit", {})} members={dataOf(members) ?? []}>
      {children}
    </InboxShell>
  );
}
