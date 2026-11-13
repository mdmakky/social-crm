import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CheckSquare, History } from "lucide-react";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { Stat, StatGrid } from "@/components/ui/stat";
import { EmptyState } from "@/components/ui/states";
import { dataOf, must, serverApi } from "@/lib/api";
import { describeAudit } from "@/lib/audit-text";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/leads";

export const metadata: Metadata = { title: "Home" };
const PRIORITY_TONE = { urgent: "danger", high: "warning", normal: "neutral", low: "neutral" } as const;
const sum = (v: { currency: string; minor: number }[] | null | undefined) => (v && v.length ? v.map((m) => formatMoney(m.minor, m.currency)).join(" · ") : "—");

export default async function Home({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const p = { workspaceId };
  const api = await serverApi();
  const ws = must(await api.call(endpoints.getWorkspace, { params: p }));
  const canLeads = can(ws.role, "lead.view", {});
  const canAudit = can(ws.role, "audit.view", {});
  const [contacts, summary, tasks, report, audit] = await Promise.all([
    api.call(endpoints.listContacts, { params: p, query: { limit: 1 } }),
    api.call(endpoints.taskSummary, { params: p, query: { assignee: "me", tz: ws.timezone } }),
    api.call(endpoints.listTasks, { params: p, query: { assignee: "me", sort: "due", limit: 6, tz: ws.timezone } }),
    canLeads ? api.call(endpoints.leadReport, { params: p, query: {} }) : null,
    canAudit ? api.call(endpoints.auditLog, { params: p, query: { limit: 6 } }) : null,
  ]);
  const base = `/w/${workspaceId}`;
  const s = dataOf(summary);
  const r = report ? dataOf(report) : null;
  const myTasks = dataOf(tasks)?.items ?? [];
  const feed = audit ? dataOf(audit)?.items ?? [] : [];
  const noContacts = (dataOf(contacts)?.total ?? 0) === 0;

  return (
    <>
      <PageHeader title={ws.name} description={`${ws.memberCount} ${ws.memberCount === 1 ? "member" : "members"} · ${ws.timezone} · Created ${formatDate(ws.createdAt, ws.timezone)}`} />
      <StatGrid>
        <Stat label="Overdue tasks" value={s?.overdue ?? "—"} note={s ? `${s.today} due today` : undefined} href={`${base}/tasks`} tone={s && s.overdue > 0 ? "danger" : undefined} />
        <Stat label="Contacts" value={dataOf(contacts)?.total ?? "—"} href={`${base}/contacts`} />
        {canLeads && <Stat label="Open deals" value={r?.openTotal.count ?? "—"} note={r?.valuesVisible ? sum(r.openTotal.values) : undefined} href={`${base}/pipeline`} />}
        {canLeads && <Stat label="Win rate" value={r?.conversion.winRate == null ? "—" : `${Math.round(r.conversion.winRate * 100)}%`} note="Last 90 days" href={`${base}/reports`} />}
      </StatGrid>
      <div className="grid items-start gap-4 lg:grid-cols-5">
        <Panel className="lg:col-span-3">
          <PanelHeader title="Your next tasks" actions={<Link href={`${base}/tasks`} className="inline-flex items-center gap-1 text-sm font-medium text-accent-fg hover:underline">All tasks <ArrowRight className="size-3.5" aria-hidden /></Link>} />
          {myTasks.length === 0 ? (
            <EmptyState icon={CheckSquare} title="Nothing assigned to you" description={noContacts ? "Add your first contact, then create follow-ups for it." : "Tasks assigned to you appear here, soonest first."} action={noContacts ? <Link href={`${base}/contacts`} className="text-sm font-medium text-accent-fg hover:underline">Go to contacts</Link> : undefined} />
          ) : (
            <ul>
              {myTasks.map((t) => {
                const overdue = !!t.dueAt && new Date(t.dueAt) < new Date();
                return (
                  <li key={t.id} className="flex items-center gap-3 border-b border-line-card px-4 py-2.5 last:border-b-0">
                    <div className="min-w-0 flex-1">
                      <Link href={`${base}/tasks`} className="block truncate text-base font-medium text-fg hover:underline">{t.title}</Link>
                      <p className="truncate text-xs text-fg-subtle">{t.contact?.name ?? "No contact"}</p>
                    </div>
                    <span className={overdue ? "tnum text-xs font-medium text-danger-fg" : "tnum text-xs text-fg-muted"}>{t.dueAt ? `${overdue ? "Overdue · " : ""}${formatDateTime(t.dueAt, ws.timezone)}` : "No date"}</span>
                    <Badge tone={PRIORITY_TONE[t.priority]} className="hidden capitalize sm:inline-flex">{t.priority}</Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        <Panel className="lg:col-span-2">
          <PanelHeader title="Recent activity" />
          {!canAudit ? (
            <EmptyState icon={History} title="Activity is for owners and admins" description="Ask an owner or admin if you need to see what changed." />
          ) : feed.length === 0 ? (
            <EmptyState icon={History} title="No activity yet" description="Changes to the workspace and its members appear here." />
          ) : (
            <ul>
              {feed.map((e) => (
                <li key={e.id} className="flex items-start gap-3 border-b border-line-card px-4 py-2.5 last:border-b-0">
                  <Avatar name={e.actorName ?? "System"} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-fg">{describeAudit(e)}</p>
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
