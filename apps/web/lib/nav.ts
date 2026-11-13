import { BarChart3, Bot, Contact, Home, Inbox, Kanban, Plug, ScrollText, Settings, Users, Workflow } from "lucide-react";
import type { ComponentType } from "react";
import { can, type Action, type Role } from "@crm/core/permissions";

export type NavItem = {
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Path segment under /w/{id}. Omitted items are not built yet. */
  path?: string;
  requires?: Action;
  /** Planned but not built. Listed under "Coming soon" as plain text, never as a link. */
  soon?: true;
};
export type NavGroup = { label?: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  { items: [{ key: "home", label: "Home", icon: Home, path: "" }] },
  {
    label: "Customers",
    items: [
      { key: "inbox", label: "Inbox", icon: Inbox, soon: true },
      { key: "contacts", label: "Contacts", icon: Contact, path: "contacts" },
      { key: "leads", label: "Leads", icon: BarChart3, soon: true },
      { key: "pipeline", label: "Pipeline", icon: Kanban, soon: true },
    ],
  },
  {
    label: "Automate",
    items: [
      { key: "automation", label: "Automation", icon: Workflow, requires: "workflow.manage", soon: true },
      { key: "ai", label: "AI assistant", icon: Bot, requires: "ai.use", soon: true },
    ],
  },
  {
    label: "Workspace",
    items: [
      { key: "integrations", label: "Integrations", icon: Plug, requires: "integration.view", soon: true },
      { key: "members", label: "Members", icon: Users, path: "members" },
      { key: "audit", label: "Audit log", icon: ScrollText, path: "audit-log", requires: "audit.view" },
      { key: "settings", label: "Settings", icon: Settings, path: "settings" },
    ],
  },
];

const allowed = (role: Role, i: NavItem) => !i.requires || can(role, i.requires, {});

/** Navigation is permission-aware: items the role cannot use are not shown at all. */
export function visibleNav(role: Role): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => allowed(role, i)) })).filter((g) => g.items.length > 0);
}
/** Built features the role can use, grouped. */
export function builtNav(role: Role): NavGroup[] {
  return visibleNav(role).map((g) => ({ ...g, items: g.items.filter((i) => !i.soon) })).filter((g) => g.items.length > 0);
}
/** Planned features the role would be able to use. */
export const plannedItems = (role: Role): NavItem[] => visibleNav(role).flatMap((g) => g.items.filter((i) => i.soon));

export const href = (workspaceId: string, item: NavItem) => `/w/${workspaceId}${item.path ? `/${item.path}` : ""}`;
export const titleFor = (pathname: string, workspaceId: string): string => {
  const rest = pathname.replace(`/w/${workspaceId}`, "").replace(/^\//, "");
  return NAV.flatMap((g) => g.items).find((i) => i.path !== undefined && i.path === rest.split("/")[0])?.label ?? "Home";
};
