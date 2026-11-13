import { SettingsTabs } from "./settings-tabs";

export default async function SettingsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return (
    <>
      <SettingsTabs workspaceId={workspaceId} />
      {children}
    </>
  );
}
