import type { Metadata } from "next";
import { Lock } from "lucide-react";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { SettingsPage } from "@/components/settings/settings-page";
import { Panel } from "@/components/ui/panel";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { dataOf, must, serverApi } from "@/lib/api";
import { AuditList } from "./audit-list";

export const metadata: Metadata = { title: "Audit log" };

export default async function AuditLogPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const ws = must(await api.call(endpoints.getWorkspace, { params: { workspaceId } }));
  if (!can(ws.role, "audit.view", {})) {
    return (
      <SettingsPage title="Audit log" description="A permanent record of security and administration changes.">
        <Panel><EmptyState icon={Lock} title="Only owners and admins can view the audit log" description="Ask an owner or admin if you need to know what changed in this workspace." /></Panel>
      </SettingsPage>
    );
  }
  const first = { data: dataOf(await api.call(endpoints.auditLog, { params: { workspaceId }, query: { limit: 25 } })) };
  return (
    <SettingsPage title="Audit log" description="A permanent record of security and administration changes. Entries cannot be edited or deleted.">
      <Panel>
        {first.data ? <AuditList workspaceId={workspaceId} timeZone={ws.timezone} initial={first.data} /> : <ErrorState title="The audit log could not be loaded" description="Reload the page to try again." />}
      </Panel>
    </SettingsPage>
  );
}
