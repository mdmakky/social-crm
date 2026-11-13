import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, Circle, History } from "lucide-react";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/states";
import { dataOf, must, serverApi } from "@/lib/api";
import { formatDate, formatDateTime, ROLE_LABEL } from "@/lib/format";
import { describeAudit } from "@/lib/audit-text";

export const metadata: Metadata = { title: "Home" };

type Step = { title: string; done: boolean; note: string; href?: string };

export default async function Home({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const ws = must(await api.call(endpoints.getWorkspace, { params: { workspaceId } }));
  const contacts = dataOf(await api.call(endpoints.listContacts, { params: { workspaceId }, query: { limit: 1 } }));
  const STEPS: Step[] = [
    { title: "Create your workspace", done: true, note: "Done" },
    { title: "Add your contacts", done: (contacts?.total ?? 0) > 0, note: (contacts?.total ?? 0) > 0 ? `${contacts!.total} ${contacts!.total === 1 ? "contact" : "contacts"}` : "Add them one by one or import a CSV", href: `/w/${workspaceId}/contacts` },
    { title: "Invite your team", done: false, note: "Coming soon" },
    { title: "Connect Messenger or Instagram", done: false, note: "Coming soon" },
  ];
  const canSeeAudit = can(ws.role, "audit.view", {});
  const audit = canSeeAudit ? dataOf(await api.call(endpoints.auditLog, { params: { workspaceId }, query: { limit: 6 } })) : null;

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
                  <p className={s.done ? "text-base font-medium text-fg" : "text-base font-medium text-fg-muted"}>{s.href && !s.done ? <Link href={s.href} className="text-accent-fg underline underline-offset-2">{s.title}</Link> : s.title}</p>
                  <p className="text-sm text-fg-subtle">{s.note}</p>
                </div>
                <span className="sr-only">{s.done ? "Completed" : s.href ? "To do" : "Not available yet"}</span>
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
