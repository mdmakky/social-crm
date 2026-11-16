import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { EmptyState } from "@/components/ui/states";
import { SettingsPage } from "@/components/settings/settings-page";
import { Panel } from "@/components/ui/panel";
import { must, serverApi } from "@/lib/api";
import { AiSettings } from "./ai-settings";

export const metadata: Metadata = { title: "AI" };

export default async function AiPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const w = must(await api.call(endpoints.getWorkspace, { params: { workspaceId } }));
  return (
    <SettingsPage title="AI" description="Provider, prompts and budget. AI only writes drafts.">
      {can(w.role, "ai.configure", {}) ? (
        <AiSettings workspaceId={workspaceId} />
      ) : (
        <Panel>
          <EmptyState icon={ShieldAlert} title="Only owners and admins can manage AI" description="Ask an owner or admin to change them." />
        </Panel>
      )}
    </SettingsPage>
  );
}
