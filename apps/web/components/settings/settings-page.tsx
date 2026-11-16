import { PageHeader } from "@/components/ui/panel";

/** The one page layout for every settings page: the shared header (title, one-line description, optional actions) and a single vertical rhythm. Width is set by SettingsFrame. */
export function SettingsPage({ title, description, actions, children }: { title: string; description?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      <PageHeader title={title} description={description} actions={actions} />
      <div className="flex flex-col gap-[var(--page-gap)]">{children}</div>
    </>
  );
}
