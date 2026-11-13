import { SettingsTabs } from "./settings-tabs";

export default async function SettingsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return (
    <div className="lg:flex lg:gap-8">
      <SettingsTabs workspaceId={workspaceId} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
