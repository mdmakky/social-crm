import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CheckSquare, History } from "lucide-react";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Panel } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/states";
import { dataOf, must, serverApi } from "@/lib/api";
import { describeAudit } from "@/lib/audit-text";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/leads";

export const metadata: Metadata = { title: "Home" };
const PRIORITY_TONE = { urgent: "danger", high: "warning", normal: "neutral", low: "neutral" } as const;
const STAGE_HUES = ["bg-hue-5-dot", "bg-hue-1-dot", "bg-hue-2-dot", "bg-hue-3-dot", "bg-hue-4-dot", "bg-hue-6-dot"] as const;
const sum = (v: { currency: string; minor: number }[] | null | undefined) => (v && v.length ? v.map((m) => formatMoney(m.minor, m.currency)).join(" · ") : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
    api.call(endpoints.listTasks, { params: p, query: { assignee: "me", sort: "due", limit: 7, tz: ws.timezone } }),
    canLeads ? api.call(endpoints.leadReport, { params: p, query: {} }) : null,
    canAudit ? api.call(endpoints.auditLog, { params: p, query: { limit: 8 } }) : null,
  ]);
  const base = `/w/${workspaceId}`;
  const s = dataOf(summary);
  const r = report ? dataOf(report) : null;
  const myTasks = dataOf(tasks)?.items ?? [];
  const feed = audit ? dataOf(audit)?.items ?? [] : [];
  const noContacts = (dataOf(contacts)?.total ?? 0) === 0;
  const stages = (r?.stages ?? []).filter((x) => x.count > 0);
  const total = stages.reduce((n, x) => n + x.count, 0);

  const lead = !s ? "Welcome back." : s.overdue > 0 ? `${plural(s.overdue, "task")} ${s.overdue === 1 ? "is" : "are"} overdue${s.today ? `, and ${s.today} due today` : ""}.` : s.today > 0 ? `${plural(s.today, "task")} due today.` : "You are up to date.";

  return (
    <>
      <PageHeader title={ws.name} description={`${plural(ws.memberCount, "member")} · ${ws.timezone} · Created ${formatDate(ws.createdAt, ws.timezone)}`} />

      <p className="mb-4 text-md font-medium tracking-title text-fg">
        <span className={s && s.overdue > 0 ? "text-danger-fg" : undefined}>{lead}</span>{" "}
        <span className="text-fg-subtle">{plural(dataOf(contacts)?.total ?? 0, "contact")}{r ? `, ${`${r.openTotal.count} still open`}${r.valuesVisible && sum(r.openTotal.values) ? ` worth ${sum(r.openTotal.values)}` : ""}` : ""}.</span>
      </p>

      {canLeads && r && total > 0 && (
        <Panel aria-label="Contacts by stage" className="mb-4 p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-base font-semibold text-fg">Open contacts by stage</h2>
            <Link href={`${base}/contacts`} className="inline-flex items-center gap-1 text-sm font-medium text-accent-fg hover:underline pointer-coarse:min-h-11">Open contacts <ArrowRight className="size-3.5" aria-hidden /></Link>
          </div>
          <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={stages.map((x) => `${x.name}: ${x.count}`).join(", ")}>
            {stages.map((x, i) => <span key={x.stageId} className={`${STAGE_HUES[i % STAGE_HUES.length]} h-full transition-[flex-grow] duration-[var(--dur-slow)] ease-[var(--ease-out)]`} style={{ flexGrow: x.count }} />)}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-base">
            {stages.map((x, i) => (
              <li key={x.stageId}>
                <Link href={`${base}/contacts?stageId=${x.stageId}`} className="inline-flex items-center gap-1.5 hover:underline pointer-coarse:min-h-11">
                  <span aria-hidden className={`size-1.5 rounded-full ${STAGE_HUES[i % STAGE_HUES.length]}`} />
                  <span className="text-fg">{x.name}</span><span className="tnum text-fg-subtle">{x.count}{r.valuesVisible && sum(x.values) ? ` · ${sum(x.values)}` : ""}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-5">
        <Panel className="p-4 lg:col-span-3" aria-labelledby="home-tasks">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 id="home-tasks" className="text-base font-semibold text-fg">Your next tasks</h2>
            <Link href={`${base}/tasks`} className="inline-flex items-center gap-1 text-sm font-medium text-accent-fg hover:underline pointer-coarse:min-h-11">All tasks <ArrowRight className="size-3.5" aria-hidden /></Link>
          </div>
          {myTasks.length === 0 ? (
            <EmptyState icon={CheckSquare} title="Nothing assigned to you" description={noContacts ? "Add your first contact, then create follow-ups for it." : "Tasks assigned to you appear here, soonest first."} action={noContacts ? <Link href={`${base}/contacts`} className="text-sm font-medium text-accent-fg hover:underline">Go to contacts</Link> : undefined} />
          ) : (
            <ul className="-mx-2">
              {myTasks.map((t) => {
                const overdue = !!t.dueAt && new Date(t.dueAt) < new Date();
                return (
                  <li key={t.id}>
                    <Link href={`${base}/tasks`} className="press flex items-center gap-3 rounded-control px-2 py-2 hover:bg-hover">
                      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${t.priority === "urgent" ? "bg-danger" : t.priority === "high" ? "bg-hue-3-dot" : "bg-fg-disabled"}`} />
                      <span className="min-w-0 flex-1"><span className="block truncate font-medium text-fg">{t.title}</span><span className="block truncate text-sm text-fg-subtle">{t.contact?.name ?? "No contact"}</span></span>
                      <span className={overdue ? "tnum shrink-0 text-sm font-medium text-danger-fg" : "tnum shrink-0 text-sm text-fg-muted"}>{t.dueAt ? `${overdue ? "Overdue · " : ""}${formatDateTime(t.dueAt, ws.timezone)}` : "No date"}</span>
                      <Badge tone={PRIORITY_TONE[t.priority]} className="hidden capitalize sm:inline-flex">{t.priority}</Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel className="p-4 lg:col-span-2" aria-labelledby="home-activity">
          <h2 id="home-activity" className="mb-1 text-base font-semibold text-fg">Recent activity</h2>
          {!canAudit ? (
            <EmptyState icon={History} title="Activity is for owners and admins" description="Ask an owner or admin if you need to see what changed." />
          ) : feed.length === 0 ? (
            <EmptyState icon={History} title="No activity yet" description="Changes to the workspace and its members appear here." />
          ) : (
            <ul>
              {feed.map((e) => (
                <li key={e.id} className="flex items-start gap-2.5 py-2">
                  <Avatar name={e.actorName ?? "System"} size="sm" className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-base text-fg">{describeAudit(e)}</p>
                    <p className="tnum text-sm text-fg-subtle"><time dateTime={e.createdAt}>{formatDateTime(e.createdAt, ws.timezone)}</time></p>
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
