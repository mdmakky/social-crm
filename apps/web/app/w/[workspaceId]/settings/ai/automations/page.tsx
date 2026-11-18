import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { EmptyState } from "@/components/ui/states";
import { Panel } from "@/components/ui/panel";
import { dataOf, must, serverApi } from "@/lib/api";
import { AutomationSettings } from "../../automations/automation-settings";

export const metadata: Metadata = { title: "Automations" };

export default async function AutomationsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const p = { workspaceId };
  const [ws, members] = await Promise.all([api.call(endpoints.getWorkspace, { params: p }), api.call(endpoints.listMembers, { params: p })]);
  const w = must(ws);
  return can(w.role, "workflow.manage", {}) ? (
    <AutomationSettings workspaceId={workspaceId} timeZone={w.timezone} members={(dataOf(members) ?? []).filter((m) => m.status === "active").map((m) => ({ id: m.userId, name: m.name }))} />
  ) : (
    <Panel><EmptyState icon={ShieldAlert} title="Only owners and admins can manage automations" description="Ask an owner or admin of this workspace if you need a rule changed." /></Panel>
  );
}
