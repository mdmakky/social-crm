"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { LogOut, Plus, Search } from "lucide-react";
import type { Role } from "@crm/core/permissions";
import { authClient } from "@/lib/auth-client";
import { builtNav, href } from "@/lib/nav";
import { Kbd } from "@/components/ui/kbd";
import type { ShellWorkspace } from "./types";

const itemCls = "flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-base text-fg data-[selected=true]:bg-selected data-[selected=true]:ring-1 data-[selected=true]:ring-inset data-[selected=true]:ring-accent [&_svg]:size-4 [&_svg]:text-fg-subtle";
const groupCls = "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-subtle";

export function CommandMenu({ open, onOpenChange, workspace, workspaces, role }: { open: boolean; onOpenChange: (o: boolean) => void; workspace: ShellWorkspace; workspaces: ShellWorkspace[]; role: Role }) {
  const router = useRouter();
  const go = (to: string) => { onOpenChange(false); router.push(to); };
  const groups = builtNav(role);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-fg/30" />
        <DialogPrimitive.Content aria-label="Command menu" className="pop fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-32px)] max-w-lg -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-surface shadow-popover">
          <DialogPrimitive.Title className="sr-only">Command menu</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Search pages and actions, then press Enter.</DialogPrimitive.Description>
          <Command label="Command menu">
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search className="size-4 text-fg-subtle" aria-hidden />
              <Command.Input placeholder="Search pages and actions" className="h-11 flex-1 bg-transparent text-base text-fg outline-none pointer-coarse:text-md" />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-2">
              <Command.Empty className="px-2 py-6 text-center text-sm text-fg-muted">No matching pages or actions.</Command.Empty>
              <Command.Group heading="Go to" className={groupCls}>
                {groups.flatMap((g) => g.items).map((item) => {
                  const Icon = item.icon;
                  return (
                    <Command.Item key={item.key} value={item.label} onSelect={() => go(href(workspace.id, item))} className={itemCls}>
                      <Icon />
                      <span className="flex-1">{item.label}</span>
                    </Command.Item>
                  );
                })}
              </Command.Group>
              {workspaces.length > 1 && (
                <Command.Group heading="Switch workspace" className={groupCls}>
                  {workspaces.filter((w) => w.id !== workspace.id).map((w) => (
                    <Command.Item key={w.id} value={`Switch to ${w.name}`} onSelect={() => go(`/w/${w.id}`)} className={itemCls}>
                      <span className="flex-1">{w.name}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Actions" className={groupCls}>
                <Command.Item value="Create workspace" onSelect={() => go("/onboarding?new=1")} className={itemCls}><Plus /><span>Create workspace</span></Command.Item>
                <Command.Item value="Sign out" onSelect={async () => { onOpenChange(false); await authClient.signOut(); router.replace("/login"); }} className={itemCls}><LogOut /><span>Sign out</span></Command.Item>
              </Command.Group>
            </Command.List>
            <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-xs text-fg-subtle"><span><Kbd>↑</Kbd> <Kbd>↓</Kbd> to move</span><span><Kbd>Enter</Kbd> to open</span></div>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
