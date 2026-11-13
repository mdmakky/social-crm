import type { Metadata } from "next";
import Link from "next/link";
import { Settings } from "lucide-react";
import { endpoints } from "@crm/contracts";
import { NotificationList } from "@/components/notifications/notification-list";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/panel";
import { dataOf, must, serverApi } from "@/lib/api";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const p = { workspaceId };
  const [ws, page] = await Promise.all([api.call(endpoints.getWorkspace, { params: p }), api.call(endpoints.listNotifications, { params: p, query: { limit: 20 } })]);
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Assignments and updates that need your attention."
        actions={<Button asChild variant="secondary"><Link href={`/w/${workspaceId}/settings/notifications`}><Settings aria-hidden />Preferences</Link></Button>}
      />
      <NotificationList workspaceId={workspaceId} timeZone={must(ws).timezone} initial={dataOf(page)} />
    </>
  );
}
