import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CheckCircle2, Circle, History } from "lucide-react";
import type { AuditPage, WorkspaceDetail } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/states";
import { apiGet } from "@/lib/api";
import { formatDate, formatDateTime, ROLE_LABEL } from "@/lib/format";
import { describeAudit } from "@/lib/audit-text";

export const metadata: Metadata = { title: "Home" };

const STEPS = [
  { title: "Create your workspace", done: true, note: "Done" },
  { title: "Invite your team", done: false, note: "Coming soon" },
  { title: "Connect Messenger or Instagram", done: false, note: "Coming soon" },
  { title: "Import or add your contacts", done: false, note: "Coming soon" },
];

export default async function Home({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const ws = (await apiGet<WorkspaceDetail>(`/v1/workspaces/${workspaceId}`)).data;
  if (!ws) notFound();
  const canSeeAudit = can(ws.role, "audit.view", {});
  const audit = canSeeAudit ? (await apiGet<AuditPage>(`/v1/workspaces/${workspaceId}/audit-log?limit=6`)).data : null;

  return (
    <>
      <PageHeader title={ws.name} description={`${ws.memberCount} ${ws.memberCount === 1 ? "member" : "members"} · ${ws.timezone} · Created ${formatDate(ws.createdAt, ws.timezone)}`} actions={<Badge tone="accent">{ROLE_LABEL[ws.role]}</Badge>} />
      <div className="grid items-start gap-4 lg:grid-cols-5">
        <Panel className="lg:col-span-3">
          <PanelHeader title="Getting started" description="The first things to set up in a new workspace." />
          <ul>
            {STEPS.map((s) => (
              <li key={s.title} className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0">
                {s.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-fg" aria-hidden /> : <Circle className="mt-0.5 size-4 shrink-0 text-fg-disabled" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <p className={s.done ? "text-base font-medium text-fg" : "text-base font-medium text-fg-muted"}>{s.title}</p>
                  <p className="text-sm text-fg-subtle">{s.note}</p>
                </div>
                <span className="sr-only">{s.done ? "Completed" : "Not available yet"}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel className="lg:col-span-2">
          <PanelHeader title="Recent activity" />
          {!canSeeAudit ? (
            <EmptyState icon={History} title="Activity is for owners and admins" description="Ask an owner or admin if you need to see what changed in this workspace." />
          ) : !audit || audit.items.length === 0 ? (
            <EmptyState icon={History} title="No activity yet" description="Changes to the workspace and its members will appear here." />
          ) : (
            <ul>
              {audit.items.map((e) => (
                <li key={e.id} className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0">
                  <Avatar name={e.actorName ?? "System"} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-base text-fg">{describeAudit(e)}</p>
                    <p className="tnum text-xs text-fg-subtle"><time dateTime={e.createdAt}>{formatDateTime(e.createdAt, ws.timezone)}</time></p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
