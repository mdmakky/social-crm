import { redirect } from "next/navigation";

/** The kanban board is gone (D170). Old bookmarks and links land on Contacts. */
export default async function PipelineRedirect({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  redirect(`/w/${workspaceId}/contacts`);
}
