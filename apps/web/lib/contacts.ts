import type { ContactColumn, TagColor } from "@crm/contracts";
import { CONTACT_COLUMNS } from "@crm/contracts";

export const COLUMN_LABEL: Record<ContactColumn, string> = { contact: "Contact", lifecycle: "Lifecycle stage", owner: "Owner", tags: "Tags", source: "Source", lastActivity: "Last activity", created: "Created" };
export const DEFAULT_COLUMNS: ContactColumn[] = [...CONTACT_COLUMNS];
export const SORT_FOR_COLUMN: Partial<Record<ContactColumn, "name" | "lastActivity" | "created">> = { contact: "name", lastActivity: "lastActivity", created: "created" };

export const SOURCE_LABEL: Record<string, string> = { manual: "Added manually", import: "CSV import", messenger: "Messenger", instagram: "Instagram", facebook_lead_ad: "Facebook lead ad", web_form: "Web form", referral: "Referral", other: "Other" };
export const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s;
export const TAG_TONE: Record<TagColor, "neutral" | "accent" | "success" | "warning" | "danger"> = { neutral: "neutral", accent: "accent", success: "success", warning: "warning", danger: "danger" };

/** Short relative time for recent events, absolute date after a week. */
export function relativeTime(iso: string, timeZone: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "Yesterday";
  if (d < 7) return `${d} days ago`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: new Date(iso).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric", timeZone }).format(new Date(iso));
}

export function activityText(kind: string, d: Record<string, unknown>, actor: string | null): string {
  const who = actor ?? "System";
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (kind) {
    case "contact.created": return `${who} created this contact`;
    case "contact.imported": return `${who} imported this contact from ${s(d.filename) || "a CSV file"}`;
    case "contact.updated": return `${who} updated ${Array.isArray(d.fields) ? (d.fields as string[]).join(", ") : "the contact"}`;
    case "contact.owner_changed": return d.to ? `${who} assigned this contact to ${s(d.to)}` : `${who} removed the owner`;
    case "contact.lifecycle_changed": return `${who} moved the lifecycle stage from ${s(d.from)} to ${s(d.to)}`;
    case "contact.tag_added": return `${who} added the tag ${s(d.tag)}`;
    case "contact.tag_removed": return `${who} removed the tag ${s(d.tag)}`;
    case "note.added": return `${who} added a note`;
    case "note.deleted": return `${who} deleted a note`;
    case "task.created": return `${who} created the task "${s(d.title)}"`;
    case "task.completed": return `${who} completed the task "${s(d.title)}"`;
    case "task.reopened": return `${who} reopened the task "${s(d.title)}"`;
    // --- track:tasks ---
    case "task.cancelled": return `${who} cancelled the task "${s(d.title)}"`;
    case "task.deleted": return `${who} deleted the task "${s(d.title)}"`;
    case "task.linked": return `${who} linked the task "${s(d.title)}" to this contact`;
    case "task.unlinked": return `${who} moved the task "${s(d.title)}" away from this contact`;
    default: return `${who}: ${kind}`;
  }
}

export const errorFieldMessage = (details: unknown): string | null => {
  if (details && typeof details === "object") return Object.values(details as Record<string, string>).filter((v) => typeof v === "string").join(" ");
  return null;
};
