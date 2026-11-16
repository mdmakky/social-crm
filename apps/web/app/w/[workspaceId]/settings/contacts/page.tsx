import type { Metadata } from "next";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { SettingsPage } from "@/components/settings/settings-page";
import { dataOf, must, serverApi } from "@/lib/api";
import { ContactSettings } from "./contact-settings";

export const metadata: Metadata = { title: "Contact fields" };

export default async function ContactSettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const p = { workspaceId };
  const [ws, stages, tags, fields] = await Promise.all([api.call(endpoints.getWorkspace, { params: p }), api.call(endpoints.listLifecycleStages, { params: p }), api.call(endpoints.listTags, { params: p }), api.call(endpoints.listCustomFields, { params: p })]);
  const w = must(ws);
  return (
    <SettingsPage title="Contact fields" description="Lifecycle stages, custom fields and tags.">
      <ContactSettings workspaceId={workspaceId} canManage={can(w.role, "schema.manage", {})} stages={dataOf(stages) ?? []} tags={dataOf(tags) ?? []} fields={dataOf(fields) ?? []} />
    </SettingsPage>
  );
}
