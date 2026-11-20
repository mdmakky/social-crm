import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { PreferencesForm } from "@/components/notifications/preferences-form";
import { SettingsPage } from "@/components/settings/settings-page";
import { must, serverApi } from "@/lib/api";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationPreferencesPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const prefs = must(await api.call(endpoints.getNotificationPreferences, { params: { workspaceId } }));
  return (
    <SettingsPage title="Notifications" description="Choose which alerts reach you in the bell. These settings are personal to you.">
      <PreferencesForm workspaceId={workspaceId} initial={prefs} />
    </SettingsPage>
  );
}
