import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { PreferencesForm } from "@/components/notifications/preferences-form";
import { SettingsPage } from "@/components/settings/settings-page";
import { must, serverApi } from "@/lib/api";

export const metadata: Metadata = { title: "Notification preferences" };

export default async function NotificationPreferencesPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const prefs = must(await api.call(endpoints.getNotificationPreferences, { params: { workspaceId } }));
  return (
    <SettingsPage title="Notification preferences" description="Choose which in-app notifications you receive in this workspace. These settings are personal.">
      <PreferencesForm workspaceId={workspaceId} initial={prefs} />
    </SettingsPage>
  );
}
