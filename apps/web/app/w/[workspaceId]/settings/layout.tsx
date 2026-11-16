import { SettingsShell } from "@/components/settings/settings-shell";

export default async function SettingsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return <SettingsShell workspaceId={workspaceId}>{children}</SettingsShell>;
}
