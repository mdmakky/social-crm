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
  /** Present when the feature is planned but not built: shown disabled with the reason. */
  soon?: string;
};
export type NavGroup = { label?: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  { items: [{ key: "home", label: "Home", icon: Home, path: "" }] },
  {
    label: "Customers",
    items: [
      { key: "inbox", label: "Inbox", icon: Inbox, soon: "Unified inbox arrives with Meta messaging (Phases 3 and 4)." },
      { key: "contacts", label: "Contacts", icon: Contact, soon: "Contacts arrive in Phase 2." },
      { key: "leads", label: "Leads", icon: BarChart3, soon: "Leads arrive in Phase 2." },
      { key: "pipeline", label: "Pipeline", icon: Kanban, soon: "The pipeline board arrives in Phase 2." },
    ],
  },
  {
    label: "Automate",
    items: [
      { key: "automation", label: "Automation", icon: Workflow, requires: "workflow.manage", soon: "Workflows arrive in Phase 5." },
      { key: "ai", label: "AI assistant", icon: Bot, requires: "ai.use", soon: "AI features arrive in Phase 6." },
    ],
  },
  {
    label: "Workspace",
    items: [
      { key: "integrations", label: "Integrations", icon: Plug, requires: "integration.view", soon: "Meta integration arrives in Phase 3." },
      { key: "members", label: "Members", icon: Users, path: "members" },
      { key: "audit", label: "Audit log", icon: ScrollText, path: "audit-log", requires: "audit.view" },
      { key: "settings", label: "Settings", icon: Settings, path: "settings" },
    ],
  },
];

/** Navigation is permission-aware: items the role cannot use are not shown at all. */
export function visibleNav(role: Role): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.requires || can(role, i.requires, {})) })).filter((g) => g.items.length > 0);
}

export const href = (workspaceId: string, item: NavItem) => `/w/${workspaceId}${item.path ? `/${item.path}` : ""}`;
export const titleFor = (pathname: string, workspaceId: string): string => {
  const rest = pathname.replace(`/w/${workspaceId}`, "").replace(/^\//, "");
  return NAV.flatMap((g) => g.items).find((i) => i.path !== undefined && i.path === rest.split("/")[0])?.label ?? "Home";
};
