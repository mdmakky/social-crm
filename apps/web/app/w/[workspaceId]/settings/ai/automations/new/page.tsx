import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { EmptyState } from "@/components/ui/states";
import { Panel } from "@/components/ui/panel";
import { dataOf, must, serverApi } from "@/lib/api";
import { AutomationEditor } from "../../../automations/automation-editor";

export const metadata: Metadata = { title: "New automation" };

export default async function NewAutomationPage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<{ start?: string }> }) {
  const { workspaceId } = await params;
  const { start } = await searchParams;
  const api = await serverApi();
  const p = { workspaceId };
  const [ws, members] = await Promise.all([api.call(endpoints.getWorkspace, { params: p }), api.call(endpoints.listMembers, { params: p })]);
  const w = must(ws);
  return can(w.role, "workflow.manage", {}) ? (
    <AutomationEditor workspaceId={workspaceId} timeZone={w.timezone} rule={null} start={start} members={(dataOf(members) ?? []).filter((m) => m.status === "active").map((m) => ({ id: m.userId, name: m.name }))} />
  ) : (
    <Panel><EmptyState icon={ShieldAlert} title="Only owners and admins can manage automations" description="Ask an owner or admin of this workspace if you need an automation changed." /></Panel>
  );
}
