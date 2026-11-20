import type { Metadata } from "next";
import Link from "next/link";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { SettingsPage } from "@/components/settings/settings-page";
import { dataOf, must, serverApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { PipelineSettings } from "../pipelines/pipeline-settings";
import { FieldsAndTags } from "./fields-and-tags";

export const metadata: Metadata = { title: "Lead settings" };

const TABS = ["stages", "fields", "tags"] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = { stages: "Stages", fields: "Fields", tags: "Tags" };

export default async function LeadSettingsPage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { workspaceId } = await params;
  const { tab: raw } = await searchParams;
  const tab: Tab = TABS.find((t) => t === raw) ?? "stages";
  const api = await serverApi();
  const p = { workspaceId };
  const [ws, pipes, tags, fields] = await Promise.all([api.call(endpoints.getWorkspace, { params: p }), api.call(endpoints.listPipelines, { params: p }), api.call(endpoints.listTags, { params: p }), api.call(endpoints.listCustomFields, { params: p })]);
  const w = must(ws);
  const pipelines = dataOf(pipes);
  const canManage = can(w.role, "schema.manage", {});
  const stageCount = (pipelines?.pipelines ?? []).filter((x) => !x.archived).flatMap((x) => x.stages).filter((s) => !s.archived).length;
  const counts: Record<Tab, number> = { stages: stageCount, fields: (dataOf(fields) ?? []).filter((f) => !f.archived).length, tags: (dataOf(tags) ?? []).length };
  return (
    <SettingsPage title="Lead settings" description="Stages, fields and tags for your leads.">
      <nav aria-label="Lead settings tabs" data-scroll="allowed" className="-mx-1 -mb-2 flex gap-0.5 overflow-x-auto border-b border-line px-1">
        {TABS.map((t) => {
          const on = t === tab;
          return (
            <Link key={t} href={`/w/${workspaceId}/settings/leads?tab=${t}`} replace={false} aria-current={on ? "page" : undefined} className={cn("press relative inline-flex h-10 shrink-0 items-center gap-1.5 px-3 text-base font-medium pointer-coarse:h-11", on ? "text-fg" : "text-fg-subtle hover:text-fg")}>
              {LABEL[t]}
              <span className="tnum rounded-full bg-hover px-1.5 text-xs font-semibold text-fg-muted">{counts[t]}</span>
              <span aria-hidden className={cn("absolute inset-x-3 -bottom-px h-0.5 origin-left rounded bg-accent transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]", on ? "scale-x-100" : "scale-x-0")} />
            </Link>
          );
        })}
      </nav>
      {tab === "stages" ? <PipelineSettings workspaceId={workspaceId} canManage={canManage} initial={pipelines} /> : <FieldsAndTags key={tab} tab={tab} workspaceId={workspaceId} canManage={canManage} tags={dataOf(tags) ?? []} fields={dataOf(fields) ?? []} />}
    </SettingsPage>
  );
}
