"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ROLE_LABEL } from "@/lib/format";
import { Kbd } from "@/components/ui/kbd";
import { TooltipProvider } from "@/components/ui/overlays";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { BottomNav, useTyping } from "./bottom-nav";
import { CommandMenu } from "./command-menu";
import { Logo } from "./logo";
import { SidebarNav } from "./sidebar-nav";
import type { ShellUser, ShellWorkspace } from "./types";
import { WorkspacePrefsProvider, type WorkspacePrefs } from "./workspace-prefs";
import { UserMenu } from "./user-menu";
import { WorkspaceSwitcher } from "./workspace-switcher";

export function AppShell({ workspace, workspaces, user, prefs, children }: { workspace: ShellWorkspace; workspaces: ShellWorkspace[]; user: ShellUser; prefs: WorkspacePrefs; children: React.ReactNode }) {
  const pathname = usePathname();
  const typing = useTyping();
  // The conversation is a full-screen task on a phone (its own back button and sticky composer): the bar steps aside there and while typing.
  const bnOn = !typing && !/^\/w\/[^/]+\/inbox\/[^/]+$/.test(pathname);
  const [palette, setPalette] = React.useState(false);

  React.useEffect(() => {
    document.cookie = `crm_last_ws=${workspace.id}; path=/; max-age=31536000; samesite=lax`;
  }, [workspace.id]);
  const mod = React.useSyncExternalStore(
    () => () => {},
    () => (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"),
    () => "Ctrl",
  );
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <TooltipProvider>
      <WorkspacePrefsProvider value={prefs}>
      <a href="#main" className="sr-only z-50 rounded-control bg-surface px-3 py-2 text-base font-medium text-fg shadow-popover focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:min-h-6 focus:min-w-6">Skip to content</a>
      <div data-bn={bnOn ? "on" : "off"} className="flex h-dvh bg-canvas">
        {/* White sidebar at lg, icon rail at md, drawer below. */}
        <aside className="hidden w-16 shrink-0 flex-col border-r border-line bg-surface md:flex lg:w-[var(--sidebar-w)]">
          <div className="hidden px-3 pb-1 pt-3.5 lg:block"><WorkspaceSwitcher current={workspace} all={workspaces} /></div>
          <div className="flex flex-col items-center gap-1 px-2 pb-1 pt-3 lg:hidden"><WorkspaceSwitcher current={workspace} all={workspaces} compact /></div>
          <div className="hidden min-h-0 flex-1 lg:flex lg:flex-col"><SidebarNav workspaceId={workspace.id} role={workspace.role} /></div>
          <div className="flex min-h-0 flex-1 flex-col lg:hidden"><SidebarNav workspaceId={workspace.id} role={workspace.role} compact /></div>
          <div className="hidden items-center gap-2.5 border-t border-line px-4 py-3 lg:flex">
            <Avatar name={user.name} size="md" />
            <span className="min-w-0 leading-tight"><span className="block truncate text-base font-semibold text-fg">{user.name}</span><span className="block truncate text-xs text-fg-subtle">{ROLE_LABEL[workspace.role]}</span></span>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="shrink-0 border-b border-line bg-surface/90 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]" style={{ height: "var(--topbar-total)" }}>
          <div className="mx-auto flex h-[var(--topbar-h)] w-full max-w-[var(--content-max)] items-center gap-2 px-3 md:px-[var(--page-gutter)]">
            <Link href={`/w/${workspace.id}`} aria-label="Social CRM home" className="press -ml-1 flex min-h-11 min-w-0 flex-1 items-center rounded-lg px-1 md:hidden"><Logo /></Link>
            <button type="button" onClick={() => setPalette(true)} className="press hidden h-8 w-full max-w-sm items-center gap-2 rounded-lg border border-transparent bg-canvas px-3 text-base text-fg-subtle hover:border-line-strong hover:bg-surface pointer-coarse:h-11 sm:flex md:w-96">
              <Search className="size-3.5" aria-hidden /><span className="flex-1 text-left">Search or jump to</span><Kbd>{mod === "⌘" ? "⌘K" : "Ctrl K"}</Kbd>
            </button>
            <Button variant="ghost" icon aria-label="Open command menu" className="sm:hidden" onClick={() => setPalette(true)}><Search /></Button>
            <div className="hidden flex-1 md:block" />
            <NotificationBell workspaceId={workspace.id} />
            <UserMenu user={user} workspaceId={workspace.id} />
          </div>
          </header>
          <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
            <div className="page-in mx-auto w-full max-w-[var(--content-max)] px-4 py-5 md:px-[var(--page-gutter)] md:py-7 max-md:pl-[max(1rem,env(safe-area-inset-left))] max-md:pr-[max(1rem,env(safe-area-inset-right))]">{children}</div>
          </main>
          <BottomNav workspace={workspace} workspaces={workspaces} user={user} show={bnOn} />
        </div>
      </div>
      <CommandMenu open={palette} onOpenChange={setPalette} workspace={workspace} workspaces={workspaces} role={workspace.role} />
      </WorkspacePrefsProvider>
    </TooltipProvider>
  );
}
