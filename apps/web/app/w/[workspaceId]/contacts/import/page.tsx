import type { Metadata } from "next";
import Link from "next/link";
import { Lock } from "lucide-react";
import { endpoints } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { Button } from "@/components/ui/button";
import { PageHeader, Panel } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/states";
import { must, serverApi } from "@/lib/api";
import { ImportWizard } from "./import-wizard";

export const metadata: Metadata = { title: "Import contacts" };

export default async function ImportPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const ws = must(await (await serverApi()).call(endpoints.getWorkspace, { params: { workspaceId } }));
  if (!can(ws.role, "data.import", {})) {
    return (
      <>
        <PageHeader title="Import contacts" />
        <Panel><EmptyState icon={Lock} title="Only owners and admins can import contacts" description="Ask an owner or admin to import the file, or add contacts one at a time." action={<Button asChild><Link href={`/w/${workspaceId}/contacts`}>Back to contacts</Link></Button>} /></Panel>
      </>
    );
  }
  return (
    <>
      <PageHeader title="Import contacts" description="Bring contacts in from a CSV file. You review everything before anything is saved." />
      <ImportWizard workspaceId={workspaceId} />
    </>
  );
}
