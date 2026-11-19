import { redirect } from "next/navigation";
import { endpoints } from "@crm/contracts";
import { AppShell } from "@/components/shell/app-shell";
import { must, serverApi } from "@/lib/api";

export default async function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const api = await serverApi();
  const [me, ws, detail] = await Promise.all([api.call(endpoints.me), api.call(endpoints.listWorkspaces), api.call(endpoints.getWorkspace, { params: { workspaceId } })]);
  if (!me.ok && me.error.status === 401) redirect(`/login?next=${encodeURIComponent(`/w/${workspaceId}`)}`);
  const d = must(detail);
  const user = must(me);
  const current = { id: d.id, name: d.name, slug: d.slug, role: d.role, logo: d.logo };
  return (
    <AppShell workspace={current} workspaces={ws.ok ? ws.data : [current]} user={{ id: user.id, name: user.name, email: user.email }} prefs={{ timeZone: d.timezone, currency: d.currency, timeFormat: d.timeFormat, weekStart: d.weekStart }}>
      {children}
    </AppShell>
  );
}
