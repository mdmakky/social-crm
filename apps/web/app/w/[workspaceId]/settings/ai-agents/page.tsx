import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { EmptyState } from "@/components/ui/states";
import { SettingsPage } from "@/components/settings/settings-page";
import { Panel } from "@/components/ui/panel";
import { must, serverApi } from "@/lib/api";
import { AgentsSettings } from "./agents-settings";

export const metadata: Metadata = { title: "AI Agents" };

export default async function AiAgentsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const w = must(await api.call(endpoints.getWorkspace, { params: { workspaceId } }));
  return (
    <SettingsPage title="AI Agents" description="Build agents with their own instructions and tools. An agent drafts a reply and proposes actions; it never sends a message, and anything sensitive waits for a person's approval.">
      {can(w.role, "ai.configure", {}) ? (
        <AgentsSettings workspaceId={workspaceId} />
      ) : (
        <Panel>
          <EmptyState icon={ShieldAlert} title="Only owners and admins can manage AI agents" description="Ask an owner or admin of this workspace if you need an agent changed." />
        </Panel>
      )}
    </SettingsPage>
  );
}
