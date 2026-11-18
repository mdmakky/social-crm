import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { dataOf, must, serverApi } from "@/lib/api";
import { ContactDetailView } from "./contact-detail";

export const metadata: Metadata = { title: "Contact" };

export default async function ContactPage({ params }: { params: Promise<{ workspaceId: string; contactId: string }> }) {
  const { workspaceId, contactId } = await params;
  const api = await serverApi();
  const p = { workspaceId };
  const pc = { workspaceId, contactId };
  // Stage, value and owner are fetched in parallel with the rest; the result is only used when the role may view leads.
  const leadP = Promise.all([api.call(endpoints.getContactLead, { params: pc }), api.call(endpoints.listPipelines, { params: p })]);
  const [ws, me, contact, notes, activity, tasks, tags, stages, members, fields, methods] = await Promise.all([
    api.call(endpoints.getWorkspace, { params: p }),
    api.call(endpoints.me),
    api.call(endpoints.getContact, { params: pc }),
    api.call(endpoints.listNotes, { params: pc }),
    api.call(endpoints.listActivity, { params: pc, query: { limit: 20 } }),
    api.call(endpoints.listContactTasks, { params: pc }),
    api.call(endpoints.listTags, { params: p }),
    api.call(endpoints.listLifecycleStages, { params: p }),
    api.call(endpoints.listMembers, { params: p }),
    api.call(endpoints.listCustomFields, { params: p }),
    api.call(endpoints.listContactMethods, { params: pc }),
  ]);
  const workspace = must(ws);
  const detail = must(contact);
  const canLeads = can(workspace.role, "lead.view", {});
  const leads = canLeads ? await leadP : null;
  return (
    <ContactDetailView
      workspaceId={workspaceId}
      role={workspace.role}
      timeZone={workspace.timezone}
      myUserId={must(me).id}
      contact={detail}
      notes={dataOf(notes) ?? []}
      methods={dataOf(methods)?.items ?? null}
      activity={dataOf(activity) ?? { items: [], nextCursor: null }}
      tasks={dataOf(tasks) ?? []}
      leadInfo={leads ? { lead: dataOf(leads[0])?.lead ?? null, loaded: !!dataOf(leads[0]), pipelines: (dataOf(leads[1])?.pipelines ?? []).filter((x) => !x.archived), lostReasons: (dataOf(leads[1])?.lostReasons ?? []).filter((r) => !r.archived) } : null}
      allTags={dataOf(tags) ?? []}
      stages={dataOf(stages) ?? []}
      members={dataOf(members) ?? []}
      fields={(dataOf(fields) ?? []).filter((f) => !f.archived)}
      perms={{ lead: can(workspace.role, "lead.edit", {}), setValue: can(workspace.role, "lead.value.edit", {}), edit: can(workspace.role, "contact.edit", {}), delete: can(workspace.role, "contact.delete", {}), consent: can(workspace.role, "consent.edit", {}) }}
    />
  );
}
