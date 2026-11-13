"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

export function SettingsTabs({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const tabs = [{ href: `/w/${workspaceId}/settings`, label: "General" }, { href: `/w/${workspaceId}/settings/contacts`, label: "Contacts" }, { href: `/w/${workspaceId}/settings/pipelines`, label: "Pipelines" }, { href: `/w/${workspaceId}/settings/notifications`, label: "Notifications" }];
  return (
    <nav aria-label="Settings sections" data-scroll="allowed" className="mb-5 flex gap-1 overflow-x-auto border-b border-line-card lg:mb-0 lg:w-44 lg:shrink-0 lg:flex-col lg:border-b-0">
      {tabs.map((t) => {
        const active = pathname === t.href;
        return (
          <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined} className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-base font-medium lg:mb-0 lg:rounded-control lg:border-b-0 lg:py-1.5", active ? "border-accent text-fg lg:bg-selected lg:text-accent-fg" : "border-transparent text-fg-muted hover:text-fg lg:hover:bg-hover")}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
