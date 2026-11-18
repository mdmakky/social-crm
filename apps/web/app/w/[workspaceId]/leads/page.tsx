import { redirect } from "next/navigation";
import { leadsQueryToContacts } from "@/lib/contact-lead";

/** Leads and Contacts are one list now (D260). Old links land on Contacts; the filters that exist there (stage, search, owner, source) come along. */
export default async function LeadsRedirect({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId } = await params;
  const qs = leadsQueryToContacts(await searchParams);
  redirect(`/w/${workspaceId}/contacts${qs ? `?${qs}` : ""}`);
}
