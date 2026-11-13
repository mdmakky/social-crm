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
  const [ws, me, contact, notes, activity, tasks, tags, stages, members, fields] = await Promise.all([
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
  ]);
  const workspace = must(ws);
  const detail = must(contact);
  return (
    <ContactDetailView
      workspaceId={workspaceId}
      role={workspace.role}
      timeZone={workspace.timezone}
      myUserId={must(me).id}
      contact={detail}
      notes={dataOf(notes) ?? []}
      activity={dataOf(activity) ?? { items: [], nextCursor: null }}
      tasks={dataOf(tasks) ?? []}
      allTags={dataOf(tags) ?? []}
      stages={dataOf(stages) ?? []}
      members={dataOf(members) ?? []}
      fields={(dataOf(fields) ?? []).filter((f) => !f.archived)}
      perms={{ edit: can(workspace.role, "contact.edit", {}), delete: can(workspace.role, "contact.delete", {}) }}
    />
  );
}
