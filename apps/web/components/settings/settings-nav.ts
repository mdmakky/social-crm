import { Bell, BookOpen, Bot, Contact, Kanban, LineChart, MessageSquareText, Plug, ScrollText, SlidersHorizontal, Sparkles, Users, Workflow } from "lucide-react";
import type { ComponentType } from "react";
import { can, type Action, type Role } from "@crm/core/permissions";

export type SettingsItem = {
  label: string;
  description: string;
  /** Path under /w/{id}. Integrations, Members and Audit log keep their own URLs but live only in Settings. */
  path: string;
  icon: ComponentType<{ className?: string }>;
  /** Sections that are entirely admin-only are hidden from roles that cannot use them. Their URLs still explain the restriction. */
  requires?: Action;
};
export type SettingsGroup = { label: string; items: SettingsItem[] };

export const SETTINGS_GROUPS: SettingsGroup[] = [
  { label: "Workspace", items: [
    { label: "General", description: "Workspace name, time zone and your account.", path: "settings", icon: SlidersHorizontal },
    { label: "Notifications", description: "Alerts you receive. Personal to you.", path: "settings/notifications", icon: Bell },
  ] },
  { label: "CRM data", items: [
    { label: "Lead fields", description: "Lifecycle stages, custom fields and tags.", path: "settings/contacts", icon: Contact },
    { label: "Lead stages", description: "Pipelines, stages and lost reasons.", path: "settings/pipelines", icon: Kanban },
  ] },
  { label: "AI and automation", items: [
    { label: "AI", description: "Provider, model, prompts and monthly budget.", path: "settings/ai", icon: Sparkles, requires: "ai.configure" },
    { label: "AI Agents", description: "Agents with their own instructions.", path: "settings/ai-agents", icon: Bot, requires: "ai.configure" },
    { label: "Knowledge", description: "Sources the assistant can use.", path: "settings/knowledge", icon: BookOpen },
    { label: "Automations", description: "Rules that react to CRM changes.", path: "settings/automations", icon: Workflow, requires: "workflow.manage" },
  ] },
  { label: "Channels", items: [
    { label: "Integrations", description: "Messenger, Instagram and WhatsApp.", path: "integrations", icon: Plug, requires: "integration.view" },
    { label: "Web chat", description: "A chat box for your website.", path: "settings/web-chat", icon: MessageSquareText, requires: "integration.manage" },
    { label: "Ad measurement", description: "Send won leads back to Meta.", path: "settings/ad-measurement", icon: LineChart, requires: "capi.view" },
  ] },
  { label: "Team and security", items: [
    { label: "Members", description: "People with access and their roles.", path: "members", icon: Users },
    { label: "Audit log", description: "Who changed what, permanently.", path: "audit-log", icon: ScrollText, requires: "audit.view" },
  ] },
];

/** Permission-aware: returns the groups this role can use and whether anything was hidden. */
export function settingsFor(role: Role): { groups: SettingsGroup[]; hidden: boolean } {
  const all = SETTINGS_GROUPS.flatMap((g) => g.items).length;
  const groups = SETTINGS_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => !i.requires || can(role, i.requires, {})) })).filter((g) => g.items.length > 0);
  return { groups, hidden: groups.flatMap((g) => g.items).length < all };
}

/** General answers on /settings and on /settings/general (the phone list links to the latter so the list screen stays at /settings). */
export function isSettingsActive(pathname: string, workspaceId: string, item: SettingsItem) {
  const to = `/w/${workspaceId}/${item.path}`;
  return item.path === "settings" ? pathname === to || pathname === `${to}/general` : pathname === to || pathname.startsWith(`${to}/`);
}
