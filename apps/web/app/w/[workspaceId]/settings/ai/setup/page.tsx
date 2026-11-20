import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { EmptyState } from "@/components/ui/states";
import { Panel } from "@/components/ui/panel";
import { must, serverApi } from "@/lib/api";
import { AiSettings } from "../ai-settings";

export const metadata: Metadata = { title: "AI setup" };

export default async function AiSetupPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const w = must(await api.call(endpoints.getWorkspace, { params: { workspaceId } }));
  return can(w.role, "ai.configure", {}) ? <AiSettings workspaceId={workspaceId} dev={process.env.AI_DEV_MODE === "1"} /> : (
    <Panel><EmptyState icon={ShieldAlert} title="Only owners and admins can manage AI" description="Ask an owner or admin to change them." /></Panel>
  );
}
