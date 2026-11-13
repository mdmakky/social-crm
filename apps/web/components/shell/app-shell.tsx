"use client";
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Menu, Search, X } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ROLE_LABEL } from "@/lib/format";
import { Kbd } from "@/components/ui/kbd";
import { TooltipProvider } from "@/components/ui/overlays";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { CommandMenu } from "./command-menu";
import { Logo } from "./logo";
import { SidebarNav } from "./sidebar-nav";
import type { ShellUser, ShellWorkspace } from "./types";
import { UserMenu } from "./user-menu";
import { WorkspaceSwitcher } from "./workspace-switcher";

export function AppShell({ workspace, workspaces, user, children }: { workspace: ShellWorkspace; workspaces: ShellWorkspace[]; user: ShellUser; children: React.ReactNode }) {
  const [drawer, setDrawer] = React.useState(false);
  const [palette, setPalette] = React.useState(false);

  React.useEffect(() => {
    document.cookie = `crm_last_ws=${workspace.id}; path=/; max-age=31536000; samesite=lax`;
  }, [workspace.id]);
  // The drawer is a small-screen pattern: close it when the viewport grows to the rail layout so nothing stays inert.
  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => mq.matches && setDrawer(false);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
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
      <a href="#main" className="sr-only z-50 rounded-control bg-surface px-3 py-2 text-base font-medium text-fg shadow-popover focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:min-h-6 focus:min-w-6">Skip to content</a>
      <div className="flex h-dvh bg-canvas">
        {/* White sidebar at lg, icon rail at md, drawer below. */}
        <aside className="hidden w-14 shrink-0 flex-col border-r border-line bg-surface md:flex lg:w-[var(--sidebar-w)]">
          <div className="hidden px-3 pb-1 pt-3.5 lg:block"><WorkspaceSwitcher current={workspace} all={workspaces} /></div>
          <div className="flex flex-col items-center gap-1 px-2 pb-1 pt-3 lg:hidden"><WorkspaceSwitcher current={workspace} all={workspaces} compact /></div>
          <div className="hidden min-h-0 flex-1 lg:flex lg:flex-col"><SidebarNav workspaceId={workspace.id} role={workspace.role} /></div>
          <div className="flex min-h-0 flex-1 flex-col lg:hidden"><SidebarNav workspaceId={workspace.id} role={workspace.role} compact /></div>
          <div className="hidden items-center gap-2.5 border-t border-line px-4 py-3 lg:flex">
            <Avatar name={user.name} size="md" />
            <span className="min-w-0 leading-tight"><span className="block truncate text-base font-semibold text-fg">{user.name}</span><span className="block truncate text-xs text-fg-subtle">{ROLE_LABEL[workspace.role]}</span></span>
          </div>
        </aside>

        <DialogPrimitive.Root open={drawer} onOpenChange={setDrawer}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="scrim fixed inset-0 z-40 bg-fg/25 md:hidden" />
            <DialogPrimitive.Content aria-label="Navigation" className="drawer fixed inset-y-0 left-0 z-50 flex w-[min(300px,85vw)] flex-col bg-surface shadow-popover md:hidden">
              <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">Workspace navigation</DialogPrimitive.Description>
              <div className="flex h-[var(--topbar-h)] items-center justify-between px-3">
                <Logo />
                <DialogPrimitive.Close asChild><Button variant="ghost" icon aria-label="Close navigation"><X /></Button></DialogPrimitive.Close>
              </div>
              <div className="px-3"><WorkspaceSwitcher current={workspace} all={workspaces} /></div>
              <SidebarNav workspaceId={workspace.id} role={workspace.role} onNavigate={() => setDrawer(false)} />
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-[var(--topbar-h)] shrink-0 items-center gap-2 border-b border-line bg-surface/90 px-3 md:px-6">
            <Button variant="ghost" icon aria-label="Open navigation" className="md:hidden" onClick={() => setDrawer(true)}><Menu /></Button>
            <Logo className="min-w-0 flex-1 md:hidden" />
            <button type="button" onClick={() => setPalette(true)} className="press hidden h-8 w-full max-w-sm items-center gap-2 rounded-lg border border-transparent bg-canvas px-3 text-base text-fg-subtle hover:border-line-strong hover:bg-surface sm:flex md:w-96">
              <Search className="size-3.5" aria-hidden /><span className="flex-1 text-left">Search or jump to</span><Kbd>{mod === "⌘" ? "⌘K" : "Ctrl K"}</Kbd>
            </button>
            <Button variant="ghost" icon aria-label="Open command menu" className="sm:hidden" onClick={() => setPalette(true)}><Search /></Button>
            <div className="hidden flex-1 md:block" />
            <NotificationBell workspaceId={workspace.id} />
            <UserMenu user={user} workspaceId={workspace.id} />
          </header>
          <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
            <div className="page-in mx-auto w-full max-w-[var(--content-max)] px-4 py-6 md:px-[var(--page-gutter)] md:py-7">{children}</div>
          </main>
        </div>
      </div>
      <CommandMenu open={palette} onOpenChange={setPalette} workspace={workspace} workspaces={workspaces} role={workspace.role} />
    </TooltipProvider>
  );
}
