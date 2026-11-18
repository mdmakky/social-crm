import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { AiHub } from "@/components/ai/ai-hub";
import { SettingsPage } from "@/components/settings/settings-page";
import { must, serverApi } from "@/lib/api";

export default async function AiLayout({ children, params }: { children: React.ReactNode; params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const w = must(await api.call(endpoints.getWorkspace, { params: { workspaceId } }));
  return (
    <SettingsPage title="AI and automation" description="What your assistant and your rules do, in one place. AI only writes drafts and proposes actions: a person always decides.">
      <AiHub workspaceId={workspaceId} canAi={can(w.role, "ai.configure", {})} canWorkflow={can(w.role, "workflow.manage", {})}>{children}</AiHub>
    </SettingsPage>
  );
}
