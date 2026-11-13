"use client";
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Menu, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
      <a href="#main" className="sr-only z-50 rounded-md bg-surface px-3 py-2 text-base font-medium text-fg shadow-popover focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to content</a>
      <div className="flex h-dvh bg-canvas">
        {/* Rail at md, full sidebar at lg and up */}
        <aside className="hidden w-14 shrink-0 flex-col border-r border-line bg-surface md:flex lg:w-[var(--sidebar-w)]">
          <div className="hidden h-[var(--topbar-h)] items-center px-3 lg:flex"><Logo /></div>
          <div className="flex h-[var(--topbar-h)] items-center justify-center px-2 lg:hidden"><Logo compact /></div>
          <div className="px-2 lg:hidden"><WorkspaceSwitcher current={workspace} all={workspaces} compact /></div>
          <div className="hidden px-2 lg:block"><WorkspaceSwitcher current={workspace} all={workspaces} /></div>
          <div className="hidden min-h-0 flex-1 lg:flex lg:flex-col"><SidebarNav workspaceId={workspace.id} role={workspace.role} /></div>
          <div className="flex min-h-0 flex-1 flex-col lg:hidden"><SidebarNav workspaceId={workspace.id} role={workspace.role} compact /></div>
        </aside>

        <DialogPrimitive.Root open={drawer} onOpenChange={setDrawer}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-fg/30 md:hidden" />
            <DialogPrimitive.Content aria-label="Navigation" className="pop fixed inset-y-0 left-0 z-50 flex w-[min(300px,85vw)] flex-col bg-surface shadow-popover md:hidden">
              <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">Workspace navigation</DialogPrimitive.Description>
              <div className="flex h-[var(--topbar-h)] items-center justify-between px-3">
                <Logo />
                <DialogPrimitive.Close asChild><Button variant="ghost" icon aria-label="Close navigation"><X /></Button></DialogPrimitive.Close>
              </div>
              <div className="px-2"><WorkspaceSwitcher current={workspace} all={workspaces} /></div>
              <SidebarNav workspaceId={workspace.id} role={workspace.role} onNavigate={() => setDrawer(false)} />
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-[var(--topbar-h)] shrink-0 items-center gap-2 border-b border-line bg-surface px-3 md:px-6">
            <Button variant="ghost" icon aria-label="Open navigation" className="md:hidden" onClick={() => setDrawer(true)}><Menu /></Button>
            <Logo className="min-w-0 flex-1 md:hidden" />
            <Button variant="secondary" className="hidden w-full max-w-sm justify-start gap-2 font-normal text-fg-subtle sm:inline-flex md:w-72" onClick={() => setPalette(true)}>
              <Search aria-hidden /><span className="flex-1 text-left">Search or jump to</span><Kbd>{mod === "⌘" ? "⌘K" : "Ctrl K"}</Kbd>
            </Button>
            <Button variant="ghost" icon aria-label="Open command menu" className="sm:hidden" onClick={() => setPalette(true)}><Search /></Button>
            <div className="hidden flex-1 md:block" />
            <NotificationBell workspaceId={workspace.id} />
            <UserMenu user={user} workspaceId={workspace.id} />
          </header>
          <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
            <div className="mx-auto w-full max-w-[var(--content-max)] px-4 py-5 md:px-6 md:py-6">{children}</div>
          </main>
        </div>
      </div>
      <CommandMenu open={palette} onOpenChange={setPalette} workspace={workspace} workspaces={workspaces} role={workspace.role} />
    </TooltipProvider>
  );
}
