import { endpoints } from "@crm/contracts";
import { must, serverApi } from "@/lib/api";
import { SettingsFrame } from "./settings-frame";

/** Server wrapper: looks up the caller's role so the navigation can be permission-aware. Used by the settings layout and by the Integrations, Members and Audit log layouts. */
export async function SettingsShell({ workspaceId, children }: { workspaceId: string; children: React.ReactNode }) {
  const api = await serverApi();
  const w = must(await api.call(endpoints.getWorkspace, { params: { workspaceId } }));
  return <SettingsFrame workspaceId={workspaceId} role={w.role}>{children}</SettingsFrame>;
}
