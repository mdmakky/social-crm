import { redirect } from "next/navigation";

/** The kanban board is gone (D170). Old bookmarks and links land on the Leads list. */
export default async function PipelineRedirect({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  redirect(`/w/${workspaceId}/leads`);
}
