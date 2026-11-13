"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { endpoints, type NotificationDto, type NotificationPage } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { NOTIFICATIONS_CHANGED } from "./notification-bell";

/** Where a notification leads, or null when it has no page of its own. */
export function notificationLink(workspaceId: string, n: Pick<NotificationDto, "entityType" | "entityId" | "data">): string | null {
  if (n.entityType === "contact" && n.entityId) return `/w/${workspaceId}/contacts/${n.entityId}`;
  const contactId = n.data.contactId;
  if (n.entityType === "task" && typeof contactId === "string") return `/w/${workspaceId}/contacts/${contactId}`;
  if (n.entityType === "import") return `/w/${workspaceId}/contacts`;
  return null;
}

type Filter = "all" | "unread";
const changed = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));

export function NotificationList({ workspaceId, timeZone, initial }: { workspaceId: string; timeZone: string; initial: NotificationPage | null }) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [items, setItems] = React.useState<NotificationDto[]>(initial?.items ?? []);
  const [cursor, setCursor] = React.useState<string | null>(initial?.nextCursor ?? null);
  const [status, setStatus] = React.useState<"ready" | "loading" | "error">(initial ? "ready" : "error");
  const [moreError, setMoreError] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const requestId = React.useRef(0);

  const load = React.useCallback(
    async (f: Filter) => {
      const mine = ++requestId.current;
      setStatus("loading");
      const r = await browserApi.call(endpoints.listNotifications, { params: { workspaceId }, query: { limit: 20, ...(f === "unread" ? { unread: "true" as const } : {}) } });
      if (mine !== requestId.current) return;
      if (!r.ok) return setStatus("error");
      setItems(r.data.items);
      setCursor(r.data.nextCursor);
      setStatus("ready");
    },
    [workspaceId],
  );

  const pick = (f: Filter) => {
    setFilter(f);
    void load(f);
  };

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    const r = await browserApi.call(endpoints.listNotifications, { params: { workspaceId }, query: { limit: 20, cursor, ...(filter === "unread" ? { unread: "true" as const } : {}) } });
    setLoadingMore(false);
    if (!r.ok) return setMoreError(errorMessage(r.error));
    setItems((cur) => [...cur, ...r.data.items.filter((n) => !cur.some((c) => c.id === n.id))]);
    setCursor(r.data.nextCursor);
  }

  async function setRead(n: NotificationDto, read: boolean) {
    const r = await browserApi.call(endpoints.setNotificationRead, { params: { workspaceId, notificationId: n.id }, body: { read } });
    if (!r.ok) return setMessage(errorMessage(r.error));
    setItems((cur) => cur.map((x) => (x.id === n.id ? r.data : x)));
    setMessage(read ? "Marked as read" : "Marked as unread");
    changed();
  }

  async function markAll() {
    const r = await browserApi.call(endpoints.markAllNotificationsRead, { params: { workspaceId } });
    if (!r.ok) return setMessage(errorMessage(r.error));
    const now = new Date().toISOString();
    setItems((cur) => cur.map((x) => (x.readAt ? x : { ...x, readAt: now })));
    setMessage("All notifications marked as read");
    changed();
  }

  const open = (n: NotificationDto, href: string | null) => {
    if (!n.readAt) void setRead(n, true);
    if (href) router.push(href);
  };
  const hasUnread = items.some((n) => !n.readAt);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Filter notifications" className="flex gap-1">
          {(["all", "unread"] as const).map((f) => (
            <Button key={f} size="sm" variant={filter === f ? "primary" : "secondary"} aria-pressed={filter === f} onClick={() => pick(f)}>{f === "all" ? "All" : "Unread"}</Button>
          ))}
        </div>
        <Button size="sm" onClick={markAll} disabled={!hasUnread}><CheckCheck aria-hidden />Mark all as read</Button>
      </div>
      <span role="status" aria-live="polite" className="sr-only">{message}</span>

      <Panel>
        {status === "loading" ? (
          <div role="status" aria-label="Loading notifications" className="space-y-3 p-4">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : status === "error" ? (
          <ErrorState title="Couldn't load notifications" description="Check your connection and try again." onRetry={() => void load(filter)} />
        ) : items.length === 0 ? (
          <EmptyState icon={Bell} title={filter === "unread" ? "You're all caught up" : "No notifications yet"} description={filter === "unread" ? "No unread notifications." : "When someone assigns you a contact or a task, it shows up here."} />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((n) => {
              const href = notificationLink(workspaceId, n);
              const unread = !n.readAt;
              const inner = (
                <>
                  <span className="mt-1.5 flex w-2 shrink-0 justify-center" aria-hidden>{unread && <span className="size-2 rounded-full bg-accent" />}</span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="flex flex-wrap items-center gap-x-2">
                      {unread && <span className="sr-only">Unread: </span>}
                      <span className={cn("text-base text-fg", unread ? "font-semibold" : "font-normal")}>{n.title}</span>
                      {unread && <span aria-hidden className="rounded-full bg-accent-subtle px-1.5 text-xs font-medium text-accent-fg">New</span>}
                    </span>
                    {n.body && <span className="block text-sm text-fg-muted">{n.body}</span>}
                    <time dateTime={n.createdAt} className="block text-xs text-fg-subtle">{formatDateTime(n.createdAt, timeZone)}</time>
                  </span>
                </>
              );
              const rowCls = cn("flex min-h-11 min-w-0 flex-1 items-start gap-3 rounded-md px-1 py-1 hover:bg-hover pointer-coarse:min-h-11", unread && "border-l-2 border-accent pl-2");
              return (
                <li key={n.id} data-unread={unread} className="flex items-start gap-2 px-3 py-2">
                  {href ? (
                    <Link href={href} className={rowCls} onClick={() => unread && void setRead(n, true)}>{inner}</Link>
                  ) : (
                    <button type="button" className={rowCls} onClick={() => open(n, null)}>{inner}</button>
                  )}
                  <Button size="sm" variant="ghost" className="shrink-0" onClick={() => void setRead(n, unread)} aria-label={`${unread ? "Mark as read" : "Mark as unread"}: ${n.title}`}>
                    {unread ? "Mark read" : "Mark unread"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {status === "ready" && cursor && (
          <div className="border-t border-line p-3 text-center">
            {moreError && <p role="alert" className="mb-2 text-sm text-danger-fg">{moreError}</p>}
            <Button onClick={loadMore} loading={loadingMore}>Load more</Button>
          </div>
        )}
      </Panel>
    </div>
  );
}
