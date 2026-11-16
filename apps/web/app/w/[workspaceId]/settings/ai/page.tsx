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
    <SettingsPage title="AI" description="Connect an AI provider, set a spending limit, and shape the reply suggestions your team sees in the inbox. AI only writes drafts: a person always edits and sends.">
      {can(w.role, "ai.configure", {}) ? (
        <AiSettings workspaceId={workspaceId} />
      ) : (
        <Panel>
          <EmptyState icon={ShieldAlert} title="Only owners and admins can manage AI" description="Ask an owner or admin of this workspace if you need AI settings changed." />
        </Panel>
      )}
    </SettingsPage>
  );
}
