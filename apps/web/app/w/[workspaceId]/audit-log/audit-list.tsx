"use client";
import * as React from "react";
import { ScrollText } from "lucide-react";
import { endpoints, type AuditPage } from "@crm/contracts";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Alert, EmptyState } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";
import { describeAudit } from "@/lib/audit-text";
import { formatDateTime } from "@/lib/format";

export function AuditList({ workspaceId, timeZone, initial }: { workspaceId: string; timeZone: string; initial: AuditPage }) {
  const [items, setItems] = React.useState(initial.items);
  const [cursor, setCursor] = React.useState(initial.nextCursor);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function more() {
    if (!cursor) return;
    setBusy(true);
    setError(null);
    const res = await browserApi.call(endpoints.auditLog, { params: { workspaceId }, query: { limit: 25, cursor } });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.error));
    setItems((cur) => [...cur, ...res.data.items]);
    setCursor(res.data.nextCursor);
  }

  if (items.length === 0) return <EmptyState icon={ScrollText} title="No entries yet" description="Workspace and member changes will be recorded here." />;
  return (
    <>
      <ul>
        {items.map((e) => (
          <li key={e.id} className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0">
            <Avatar name={e.actorName ?? "System"} size="sm" />
            <p className="min-w-0 flex-1 text-base text-fg">{describeAudit(e)}</p>
            <time dateTime={e.createdAt} className="tnum shrink-0 text-sm text-fg-subtle">{formatDateTime(e.createdAt, timeZone)}</time>
          </li>
        ))}
      </ul>
      {(cursor || error) && (
        <div className="flex flex-col items-center gap-2 border-t border-line p-3">
          {error && <Alert tone="error">{error}</Alert>}
          {cursor && <Button onClick={more} loading={busy}>Load older entries</Button>}
        </div>
      )}
    </>
  );
}
