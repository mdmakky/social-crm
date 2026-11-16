import { BarChart3, PieChart, CheckSquare, Contact, Home, Inbox, Kanban, Settings } from "lucide-react";
import type { ComponentType } from "react";
import { can, type Action, type Role } from "@crm/core/permissions";

export type NavItem = {
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Path segment under /w/{id}. Omitted items are not built yet. */
  path?: string;
  requires?: Action;
};
export type NavGroup = { label?: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  { items: [{ key: "home", label: "Home", icon: Home, path: "" }] },
  {
    label: "Customers",
    items: [
      { key: "inbox", label: "Inbox", icon: Inbox, path: "inbox", requires: "conversation.view" },
      { key: "contacts", label: "Contacts", icon: Contact, path: "contacts" },
      // --- track:tasks ---
      { key: "tasks", label: "Tasks", icon: CheckSquare, path: "tasks" },
      { key: "leads", label: "Leads", icon: BarChart3, path: "leads", requires: "lead.view" },
      { key: "pipeline", label: "Pipeline", icon: Kanban, path: "pipeline", requires: "lead.view" },
      { key: "reports", label: "Reports", icon: PieChart, path: "reports", requires: "lead.view" },
    ],
  },
  // Integrations, Members and Audit log live only inside Settings (see components/settings/settings-nav.ts).
  { items: [{ key: "settings", label: "Settings", icon: Settings, path: "settings" }] },
];

const allowed = (role: Role, i: NavItem) => !i.requires || can(role, i.requires, {});

/** Navigation is permission-aware: items the role cannot use are not shown at all. */
export function visibleNav(role: Role): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => allowed(role, i)) })).filter((g) => g.items.length > 0);
}
/** Every item is built; kept as the name callers use. */
export const builtNav = visibleNav;

export const href = (workspaceId: string, item: NavItem) => `/w/${workspaceId}${item.path ? `/${item.path}` : ""}`;
export const titleFor = (pathname: string, workspaceId: string): string => {
  const rest = pathname.replace(`/w/${workspaceId}`, "").replace(/^\//, "");
  return NAV.flatMap((g) => g.items).find((i) => i.path !== undefined && i.path === rest.split("/")[0])?.label ?? "Home";
};

/** Phone bottom bar: the four places used all day, in thumb order. Everything else lives in the More sheet. Permission-aware like the rest of the nav. */
export const MOBILE_TABS = ["inbox", "contacts", "leads", "tasks"] as const;
export function mobileTabs(role: Role): NavItem[] {
  const built = builtNav(role).flatMap((g) => g.items);
  return MOBILE_TABS.map((k) => built.find((i) => i.key === k)).filter((i): i is NavItem => !!i);
}
/** Built features the role can use that are not in the bottom bar, grouped (Home first, unlabeled). */
export function moreNav(role: Role): NavGroup[] {
  const tabs = new Set<string>(MOBILE_TABS);
  return builtNav(role).map((g) => ({ ...g, items: g.items.filter((i) => !tabs.has(i.key)) })).filter((g) => g.items.length > 0);
}
export const isActivePath = (pathname: string, to: string, item: NavItem) => (item.path === "" ? pathname === to : pathname === to || pathname.startsWith(`${to}/`));
