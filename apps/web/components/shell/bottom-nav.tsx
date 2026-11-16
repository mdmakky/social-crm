"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Check, LogOut, MoreHorizontal, Plus } from "lucide-react";
import type { Role } from "@crm/core/permissions";
import { Avatar } from "@/components/ui/avatar";
import { Sheet } from "@/components/ui/sheet";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { ROLE_LABEL } from "@/lib/format";
import { href, isActivePath, mobileTabs, moreNav } from "@/lib/nav";
import type { ShellUser, ShellWorkspace } from "./types";

/** True while a text field has focus: the on-screen keyboard is up, and the bar would only eat the little height left above it. */
export function useTyping() {
  const [typing, setTyping] = React.useState(false);
  React.useEffect(() => {
    const isText = (el: EventTarget | null) => el instanceof HTMLElement && (el.matches("textarea,select,[contenteditable=true]") || (el instanceof HTMLInputElement && !/^(checkbox|radio|button|submit|range|file|color)$/.test(el.type)));
    const on = (e: FocusEvent) => { if (isText(e.target)) setTyping(true); };
    const off = () => setTyping(false);
    document.addEventListener("focusin", on);
    document.addEventListener("focusout", off);
    return () => { document.removeEventListener("focusin", on); document.removeEventListener("focusout", off); };
  }, []);
  return typing;
}

const tabClass = (on: boolean) => cn("press relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium", on ? "text-fg" : "text-fg-subtle");
const pill = (on: boolean) => cn("flex h-7 w-14 items-center justify-center rounded-full transition-colors duration-[var(--dur-base)]", on ? "bg-accent-subtle text-accent" : "");

/** Phone navigation: four daily places plus More. A flex child of the shell column (not position:fixed), so it can never cover content. */
export function BottomNav({ workspace, workspaces, user, show }: { workspace: ShellWorkspace; workspaces: ShellWorkspace[]; user: ShellUser; show: boolean }) {
  const pathname = usePathname();
  const [more, setMore] = React.useState(false);
  const tabs = mobileTabs(workspace.role);
  const rest = moreNav(workspace.role);
  // The sheet is a phone pattern: close it when the viewport grows to the rail layout so the page is never left inert behind it.
  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => mq.matches && setMore(false);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  // Home is reached from the logo and listed first in the sheet, but being on it should not light up More.
  const moreActive = rest.some((g) => g.items.some((i) => i.path !== "" && isActivePath(pathname, href(workspace.id, i), i)));
  return (
    <>
      <nav aria-label="Primary" className={cn("flex shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] md:hidden", !show && "hidden")} style={{ height: "var(--bottomnav-h)" }}>
        {tabs.map((t) => {
          const to = href(workspace.id, t);
          const on = isActivePath(pathname, to, t);
          return (
            <Link key={t.key} href={to} aria-current={on ? "page" : undefined} className={tabClass(on)}>
              <span className={pill(on)}><t.icon className="size-5 stroke-[1.75]" aria-hidden /></span>{t.label}
            </Link>
          );
        })}
        <button type="button" onClick={() => setMore(true)} aria-haspopup="dialog" aria-expanded={more} className={tabClass(moreActive || more)}>
          <span className={pill(moreActive || more)}><MoreHorizontal className="size-5 stroke-[1.75]" aria-hidden /></span>More
        </button>
      </nav>
      <MoreSheet open={more} onOpenChange={setMore} workspace={workspace} workspaces={workspaces} user={user} groups={rest} />
    </>
  );
}

function MoreSheet({ open, onOpenChange, workspace, workspaces, user, groups }: { open: boolean; onOpenChange: (o: boolean) => void; workspace: ShellWorkspace; workspaces: ShellWorkspace[]; user: ShellUser; groups: ReturnType<typeof moreNav> }) {
  const pathname = usePathname();
  const router = useRouter();
  const row = "press flex min-h-12 items-center gap-3 rounded-lg px-2 text-base font-medium text-fg active:bg-hover";
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="More" description={workspace.name}>
      <div className="space-y-4">
        {groups.map((g, gi) => (
          <nav key={gi} aria-label={g.label ?? "Home"}>
            {g.label && <p className="px-2 pb-1 pt-1 text-xs font-semibold text-fg-subtle">{g.label}</p>}
            <div className="grid grid-cols-2 gap-x-1 gap-y-0.5">
            {g.items.map((i) => {
              const to = href(workspace.id, i);
              const on = isActivePath(pathname, to, i);
              return (
                <Link key={i.key} href={to} onClick={() => onOpenChange(false)} aria-current={on ? "page" : undefined} className={cn(row, on && "bg-hover")}>
                  <i.icon className={cn("size-5 stroke-[1.75]", on ? "text-accent" : "text-fg-subtle")} aria-hidden />{i.label}
                </Link>
              );
            })}
            </div>
          </nav>
        ))}
        <section aria-label="Switch workspace" className="space-y-0.5 border-t border-line pt-3">
          <p className="px-2 pb-1 text-xs font-semibold text-fg-subtle">Switch workspace</p>
          {workspaces.map((w) => (
            <Link key={w.id} href={`/w/${w.id}`} onClick={() => onOpenChange(false)} aria-current={w.id === workspace.id ? "true" : undefined} className={row}>
              <Avatar name={w.name} size="sm" className="rounded" /><span className="min-w-0 flex-1 truncate">{w.name}</span>
              <span className="text-xs font-normal text-fg-subtle">{ROLE_LABEL[w.role as Role]}</span>{w.id === workspace.id && <Check className="size-4 text-accent" aria-label="Current workspace" />}
            </Link>
          ))}
          <Link href="/onboarding?new=1" onClick={() => onOpenChange(false)} className={row}><Plus className="size-5 stroke-[1.75] text-fg-subtle" aria-hidden />Create workspace</Link>
        </section>
        <section aria-label="Account" className="border-t border-line pt-3">
          <div className="flex items-center gap-3 px-2 pb-2"><Avatar name={user.name} size="md" /><span className="min-w-0"><span className="block truncate text-base font-medium text-fg">{user.name}</span><span className="block truncate text-xs text-fg-subtle">{user.email}</span></span></div>
          <button type="button" className={cn(row, "w-full text-left")} onClick={async () => { await authClient.signOut(); router.replace("/login"); }}><LogOut className="size-5 stroke-[1.75] text-fg-subtle" aria-hidden />Sign out</button>
        </section>
      </div>
    </Sheet>
  );
}
