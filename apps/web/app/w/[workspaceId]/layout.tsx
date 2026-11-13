import { notFound, redirect } from "next/navigation";
import type { MeResponse, WorkspaceDetail, WorkspaceSummary } from "@crm/contracts";
import { AppShell } from "@/components/shell/app-shell";
import { apiGet } from "@/lib/api";

export default async function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [me, ws, detail] = await Promise.all([
    apiGet<MeResponse>("/v1/me"),
    apiGet<WorkspaceSummary[]>("/v1/workspaces"),
    apiGet<WorkspaceDetail>(`/v1/workspaces/${workspaceId}`),
  ]);
  if (me.status === 401) redirect(`/login?next=${encodeURIComponent(`/w/${workspaceId}`)}`);
  if (detail.status === 404 || !detail.data) notFound();
  if (!me.data) throw new Error("Could not load your account");
  const current = { id: detail.data.id, name: detail.data.name, slug: detail.data.slug, role: detail.data.role };
  return (
    <AppShell workspace={current} workspaces={ws.data ?? [current]} user={{ id: me.data.id, name: me.data.name, email: me.data.email }}>
      {children}
    </AppShell>
  );
}
