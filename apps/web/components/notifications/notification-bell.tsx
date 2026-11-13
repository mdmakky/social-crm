"use client";
import * as React from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { endpoints } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { browserApi } from "@/lib/client-api";

/** Other components dispatch this after changing read state so the bell refreshes without waiting for the poll. */
export const NOTIFICATIONS_CHANGED = "crm:notifications-changed";
const POLL_MS = Number(process.env.NEXT_PUBLIC_NOTIFICATION_POLL_MS) || 30_000;

/** Unread count with polling (interval, tab focus, visibility). Only the newest request may write state, so a slow older response never overwrites a newer one. */
export function useUnreadCount(workspaceId: string) {
  const [count, setCount] = React.useState<number | null>(null);
  const [announcement, setAnnouncement] = React.useState("");
  const latest = React.useRef(0);
  const shown = React.useRef<number | null>(null);

  const refresh = React.useCallback(async () => {
    const mine = ++latest.current;
    const r = await browserApi.call(endpoints.unreadNotificationCount, { params: { workspaceId } });
    if (mine !== latest.current || !r.ok) return;
    const next = r.data.count;
    if (shown.current !== null && shown.current !== next) setAnnouncement(next === 0 ? "No unread notifications" : `${next} unread ${next === 1 ? "notification" : "notifications"}`);
    shown.current = next;
    setCount(next);
  }, [workspaceId]);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    const onChanged = () => void refresh();
    window.addEventListener("focus", onChanged);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(NOTIFICATIONS_CHANGED, onChanged);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onChanged);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(NOTIFICATIONS_CHANGED, onChanged);
    };
  }, [refresh]);

  return { count, announcement };
}

export function NotificationBell({ workspaceId }: { workspaceId: string }) {
  const { count, announcement } = useUnreadCount(workspaceId);
  const label = count ? `Notifications, ${count} unread` : "Notifications";
  return (
    <>
      <Button asChild variant="ghost" icon className="relative">
        <Link href={`/w/${workspaceId}/notifications`} aria-label={label}>
          <Bell aria-hidden />
          {count ? (
            <span aria-hidden data-testid="unread-badge" className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-on-accent">
              {count > 99 ? "99+" : count}
            </span>
          ) : null}
        </Link>
      </Button>
      {/* Polite announcement of unread-count changes after the first load */}
      <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
    </>
  );
}
