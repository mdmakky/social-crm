"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { tabClass, tabListClass } from "@/components/ui/tabs";

export function SettingsTabs({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const tabs = [{ href: `/w/${workspaceId}/settings`, label: "General" }, { href: `/w/${workspaceId}/settings/contacts`, label: "Contacts" }, { href: `/w/${workspaceId}/settings/pipelines`, label: "Pipelines" }, { href: `/w/${workspaceId}/settings/notifications`, label: "Notifications" }, { href: `/w/${workspaceId}/settings/automations`, label: "Automations" }, { href: `/w/${workspaceId}/settings/ai`, label: "AI" }, { href: `/w/${workspaceId}/settings/ai-agents`, label: "AI Agents" },{ href: `/w/${workspaceId}/settings/knowledge`, label: "Knowledge" }];
  return (
    <nav aria-label="Settings sections" data-scroll="allowed" className={tabListClass}>
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} aria-current={pathname === t.href ? "page" : undefined} className={tabClass(pathname === t.href)}>{t.label}</Link>
      ))}
    </nav>
  );
}
