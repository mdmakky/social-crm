import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { SettingsPage } from "@/components/settings/settings-page";
import { Alert } from "@/components/ui/states";
import { must, serverApi } from "@/lib/api";
import { PreviewPanel } from "./preview-panel";

export const metadata: Metadata = { title: "Preview web chat" };

export default async function WebChatPreviewPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const w = must(await api.call(endpoints.getWorkspace, { params: { workspaceId } }));
  return (
    <SettingsPage title="Preview web chat" description="Try your chat on a sample page before you add it to your site.">
      {can(w.role, "integration.manage", {}) ? <PreviewPanel workspaceId={workspaceId} /> : <Alert tone="info">Only owners and admins can preview web chat.</Alert>}
    </SettingsPage>
  );
}
