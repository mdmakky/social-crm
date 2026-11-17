import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { SettingsPage } from "@/components/settings/settings-page";
import { Alert } from "@/components/ui/states";
import { must, serverApi } from "@/lib/api";
import { WebChatPanel } from "./web-chat-panel";

export const metadata: Metadata = { title: "Web chat" };

export default async function WebChatPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const w = must(await api.call(endpoints.getWorkspace, { params: { workspaceId } }));
  return (
    <SettingsPage title="Web chat" description="A chat box for your website. Visitors write, you answer in the Inbox.">
      {can(w.role, "integration.manage", {}) ? <WebChatPanel workspaceId={workspaceId} /> : <Alert tone="info">Only owners and admins can manage web chat.</Alert>}
    </SettingsPage>
  );
}
