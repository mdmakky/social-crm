"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

export function SettingsTabs({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const tabs = [{ href: `/w/${workspaceId}/settings`, label: "General" }, { href: `/w/${workspaceId}/settings/contacts`, label: "Contacts" }];
  return (
    <nav aria-label="Settings sections" className="mb-5 flex gap-1 border-b border-line">
      {tabs.map((t) => {
        const active = pathname === t.href;
        return (
          <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined} className={cn("-mb-px border-b-2 px-3 py-2 text-base font-medium", active ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg")}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
