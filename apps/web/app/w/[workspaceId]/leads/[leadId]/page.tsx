import { notFound, redirect } from "next/navigation";
import { endpoints } from "@crm/contracts";
import { dataOf, serverApi } from "@/lib/api";

/** A lead link (notifications, old bookmarks) opens the contact it belongs to (D260). */
export default async function LeadRedirect({ params }: { params: Promise<{ workspaceId: string; leadId: string }> }) {
  const { workspaceId, leadId } = await params;
  const api = await serverApi();
  const lead = dataOf(await api.call(endpoints.getLead, { params: { workspaceId, leadId } }));
  if (!lead) notFound();
  redirect(`/w/${workspaceId}/contacts/${lead.primaryContact.id}`);
}
