"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Role } from "@crm/core/permissions";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/cn";
import { isSettingsActive, settingsFor, type SettingsItem } from "./settings-nav";

/** One shell for every settings page (including Integrations, Members and Audit log, which keep their own URLs).
 *  xl and up: grouped sub-navigation on the left. Below xl: /settings is the section list, every other page is the detail with a back link. */
export function SettingsFrame({ workspaceId, role, children }: { workspaceId: string; role: Role; children: React.ReactNode }) {
  const pathname = usePathname();
  const isIndex = pathname === `/w/${workspaceId}/settings`;
  const { groups, hidden } = settingsFor(role);
  const to = (i: SettingsItem) => `/w/${workspaceId}/${i.path}`;
  const note = hidden && <p className="mt-4 px-2.5 text-xs text-fg-subtle">More sections are available to owners and admins.</p>;
  return (
    <div className="xl:grid xl:grid-cols-[13rem_minmax(0,1fr)] xl:gap-10">
      <aside className="hidden xl:block">
        <nav aria-label="Settings sections" className="sticky top-0 pb-6">
          <p className="px-2.5 pb-1 text-lg font-semibold tracking-title text-fg">Settings</p>
          {groups.map((g, gi) => (
            <div key={g.label}>
              <p id={`sg-${gi}`} className="px-2.5 pb-1 pt-4 text-xs font-semibold text-fg-subtle">{g.label}</p>
              <ul aria-labelledby={`sg-${gi}`} className="flex flex-col gap-px">
                {g.items.map((i) => {
                  const on = isSettingsActive(pathname, workspaceId, i);
                  return (
                    <li key={i.path}>
                      <Link href={to(i)} aria-current={on ? "page" : undefined} className={cn("press group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-base font-medium", on ? "bg-hover text-fg" : "text-fg-muted hover:bg-canvas hover:text-fg")}>
                        <i.icon className={cn("size-4 shrink-0 stroke-[1.75]", on ? "text-accent" : "text-fg-subtle group-hover:text-fg-muted")} aria-hidden />
                        <span className="truncate">{i.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {note}
        </nav>
      </aside>
      <div className="min-w-0">
        {isIndex && (
          <div className="xl:hidden">
            <div className="mb-[var(--page-gap)]">
              <h1 className="text-xl font-semibold tracking-title text-fg">Settings</h1>
              <p className="mt-0.5 text-base text-fg-subtle">Workspace, CRM data, AI, channels and team.</p>
            </div>
            <nav aria-label="Settings sections" className="space-y-5">
              {groups.map((g, gi) => (
                <section key={g.label} aria-labelledby={`sl-${gi}`}>
                  <h2 id={`sl-${gi}`} className="px-1 pb-1.5 text-xs font-semibold text-fg-subtle">{g.label}</h2>
                  <Panel className="divide-y divide-line-card overflow-hidden">
                    {g.items.map((i) => (
                      <Link key={i.path} href={i.path === "settings" ? `${to(i)}/general` : to(i)} className="press flex min-h-14 items-center gap-3 px-4 py-2 active:bg-hover">
                        <i.icon className="size-5 shrink-0 stroke-[1.75] text-fg-subtle" aria-hidden />
                        <span className="min-w-0 flex-1"><span className="block text-base font-medium text-fg">{i.label}</span><span className="block text-sm text-fg-subtle">{i.description}</span></span>
                        <ChevronRight className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                      </Link>
                    ))}
                  </Panel>
                </section>
              ))}
              {note}
            </nav>
          </div>
        )}
        <div className={cn("max-w-4xl", isIndex && "max-xl:hidden")}>
          {!isIndex && (
            <Link href={`/w/${workspaceId}/settings`} className="press -ml-2 mb-1 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-base font-medium text-fg-muted hover:text-fg xl:hidden">
              <ChevronLeft className="size-4" aria-hidden />Settings
            </Link>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
