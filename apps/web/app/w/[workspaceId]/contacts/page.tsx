import type { Metadata } from "next";
import { endpoints, ContactListQuery, type ContactStageCountsQuery } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { dataOf, must, serverApi } from "@/lib/api";
import { ContactsView } from "./contacts-view";

export const metadata: Metadata = { title: "Leads" };

const FILTER_KEYS = ["search", "lifecycleStageId", "stageId", "ownerId", "tagIds", "source", "sort", "dir"] as const;

export default async function ContactsPage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const q: Record<string, string> = {};
  for (const k of FILTER_KEYS) if (typeof sp[k] === "string" && sp[k]) q[k] = sp[k] as string;
  const parsed = ContactListQuery.safeParse({ ...q, limit: 25 });
  const query = parsed.success ? parsed.data : { limit: 25 };

  const api = await serverApi();
  const p = { workspaceId };
  const { stageId: _s, sort: _o, dir: _d, cursor: _c, limit: _l, ...shared } = query;
  const [ws, me, first, stages, tags, members, views, fields, pipelines, counts] = await Promise.all([
    api.call(endpoints.getWorkspace, { params: p }),
    api.call(endpoints.me),
    api.call(endpoints.listContacts, { params: p, query }),
    api.call(endpoints.listLifecycleStages, { params: p }),
    api.call(endpoints.listTags, { params: p }),
    api.call(endpoints.listMembers, { params: p }),
    api.call(endpoints.listViews, { params: p }),
    api.call(endpoints.listCustomFields, { params: p }),
    api.call(endpoints.listPipelines, { params: p }),
    api.call(endpoints.contactStageCounts, { params: p, query: shared as ContactStageCountsQuery }),
  ]);
  const workspace = must(ws);
  const role = workspace.role;
  return (
    <ContactsView
      workspaceId={workspaceId}
      timeZone={workspace.timezone}
      myUserId={must(me).id}
      initial={dataOf(first)}
      initialQuery={query}
      pipelines={(dataOf(pipelines)?.pipelines ?? []).filter((x) => !x.archived)}
      lostReasons={(dataOf(pipelines)?.lostReasons ?? []).filter((r) => !r.archived)}
      initialCounts={dataOf(counts)}
      stages={dataOf(stages) ?? []}
      tags={dataOf(tags) ?? []}
      members={dataOf(members) ?? []}
      views={dataOf(views) ?? []}
      fields={(dataOf(fields) ?? []).filter((f) => !f.archived)}
      perms={{ lead: can(role, "lead.edit", {}), removeLeads: can(role, "lead.delete", {}), viewValue: can(role, "lead.value.view", {}), edit: can(role, "contact.edit", {}), import: can(role, "data.import", {}), export: can(role, "data.export", {}), shareViews: can(role, "view.share", {}), schema: can(role, "schema.manage", {}) }}
    />
  );
}
