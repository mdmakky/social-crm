import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { EmptyState } from "@/components/ui/states";
import { Panel } from "@/components/ui/panel";
import { dataOf, must, serverApi } from "@/lib/api";
import { AutomationEditor } from "../../../automations/automation-editor";

export const metadata: Metadata = { title: "Edit automation" };

export default async function EditAutomationPage({ params }: { params: Promise<{ workspaceId: string; ruleId: string }> }) {
  const { workspaceId, ruleId } = await params;
  const api = await serverApi();
  const p = { workspaceId };
  const [ws, members] = await Promise.all([api.call(endpoints.getWorkspace, { params: p }), api.call(endpoints.listMembers, { params: p })]);
  const w = must(ws);
  if (!can(w.role, "workflow.manage", {})) return <Panel><EmptyState icon={ShieldAlert} title="Only owners and admins can manage automations" description="Ask an owner or admin of this workspace if you need an automation changed." /></Panel>;
  const rules = dataOf(await api.call(endpoints.listAutomationRules, { params: p })) ?? [];
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) notFound();
  return <AutomationEditor workspaceId={workspaceId} timeZone={w.timezone} rule={rule} members={(dataOf(members) ?? []).filter((m) => m.status === "active").map((m) => ({ id: m.userId, name: m.name }))} />;
}
