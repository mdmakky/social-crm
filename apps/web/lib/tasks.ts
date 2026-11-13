import type { TaskEvent, TaskListQuery, TaskPriority, TaskStatus } from "@crm/contracts";
import { formatDateTime } from "./format";

export const STATUS_LABEL: Record<TaskStatus, string> = { open: "Open", in_progress: "In progress", done: "Done", cancelled: "Cancelled" };
export const PRIORITY_LABEL: Record<TaskPriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
export const PRIORITY_HUE: Record<TaskPriority, 1 | 2 | 3 | 4 | 5 | 6 | "muted"> = { low: "muted", normal: "muted", high: 3, urgent: 6 };
export const PRIORITY_TONE: Record<TaskPriority, "neutral" | "accent" | "warning" | "danger"> = { low: "neutral", normal: "neutral", high: "warning", urgent: "danger" };

export const VIEWS = [
  { key: "open", label: "Open" },
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "upcoming", label: "Upcoming" },
  { key: "no_date", label: "No date" },
  { key: "completed", label: "Completed" },
] as const;
export type ViewKey = (typeof VIEWS)[number]["key"];

/** The Open tab is the server view "all" plus a status filter of open and in progress. */
export const ACTIVE_FILTER = "open,in_progress";

/** datetime-local value (browser time zone) for an ISO instant, and back. */
export const toLocalInput = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (v: string): string | null => (v ? new Date(v).toISOString() : null);

const who = (p: unknown) => (p && typeof p === "object" && "name" in p ? String((p as { name: unknown }).name) : null);
const day = (v: unknown, tz: string) => (typeof v === "string" ? formatDateTime(v, tz) : null);

/** One plain-English line per history entry. */
export function eventText(e: TaskEvent, tz: string): string {
  const actor = e.actor?.name || "Someone";
  const d = e.data as Record<string, unknown>;
  switch (e.kind) {
    case "created": return `${actor} created the task`;
    case "updated": return `${actor} edited the ${Array.isArray(d.fields) ? (d.fields as string[]).join(" and ") : "task"}`;
    case "completed": return `${actor} marked the task done`;
    case "reopened": return `${actor} reopened the task`;
    case "status_changed": return `${actor} changed the status from ${STATUS_LABEL[d.from as TaskStatus] ?? String(d.from)} to ${STATUS_LABEL[d.to as TaskStatus] ?? String(d.to)}`;
    case "assignee_changed": return who(d.to) ? `${actor} assigned the task to ${who(d.to)}` : `${actor} removed the assignee`;
    case "due_date_changed": return day(d.to, tz) ? `${actor} set the due date to ${day(d.to, tz)}` : `${actor} removed the due date`;
    case "priority_changed": return `${actor} changed the priority from ${PRIORITY_LABEL[d.from as TaskPriority] ?? String(d.from)} to ${PRIORITY_LABEL[d.to as TaskPriority] ?? String(d.to)}`;
    case "contact_changed": return who(d.to) ? `${actor} linked the task to ${who(d.to)}` : `${actor} removed the contact link`;
    case "deleted": return `${actor} deleted the task`;
  }
}

export type SortKey = "due:asc" | "due:desc" | "priority:desc" | "priority:asc" | "created:desc" | "updated:desc";
export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "due:asc", label: "Due date, soonest first" },
  { value: "due:desc", label: "Due date, latest first" },
  { value: "priority:desc", label: "Priority, highest first" },
  { value: "priority:asc", label: "Priority, lowest first" },
  { value: "created:desc", label: "Newest first" },
  { value: "updated:desc", label: "Recently updated" },
];
/** Status dropdown values. "" means the default for the tab: open and in progress. */
export const STATUS_OPTIONS = [
  { value: "", label: "Open and in progress" },
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
  { value: "any", label: "Any status" },
] as const;

export type TaskFilters = { view: ViewKey; assignee?: string; status?: string; priority?: string; search?: string; contactId?: string; contactName?: string; sort: SortKey; dueFrom?: string; dueTo?: string };
export const DEFAULT_FILTERS: TaskFilters = { view: "open", sort: "due:asc" };

const isView = (v: string | undefined): v is ViewKey => VIEWS.some((x) => x.key === v);
const isSort = (v: string | undefined): v is SortKey => SORT_OPTIONS.some((x) => x.value === v);

export function parseFilters(sp: Record<string, string | string[] | undefined>): TaskFilters {
  const g = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : undefined);
  const view = isView(g("view")) ? (g("view") as ViewKey) : "open";
  const sort = isSort(g("sort")) ? (g("sort") as SortKey) : view === "completed" ? "updated:desc" : "due:asc";
  return { view, sort, assignee: g("assignee"), status: g("status"), priority: g("priority"), search: g("q"), contactId: g("contactId"), contactName: g("contactName"), dueFrom: g("dueFrom"), dueTo: g("dueTo") };
}
export function toSearchParams(f: TaskFilters): URLSearchParams {
  const p = new URLSearchParams();
  const base = f.view === "completed" ? "updated:desc" : "due:asc";
  if (f.view !== "open") p.set("view", f.view);
  if (f.sort !== base) p.set("sort", f.sort);
  for (const [k, v] of [["assignee", f.assignee], ["status", f.status], ["priority", f.priority], ["q", f.search], ["contactId", f.contactId], ["contactName", f.contactId ? f.contactName : undefined], ["dueFrom", f.dueFrom], ["dueTo", f.dueTo]] as const) if (v) p.set(k, v);
  return p;
}
/** Filters that change what the tab counts show. */
export const summaryQuery = (f: TaskFilters, tz: string) => ({ assignee: f.assignee, contactId: f.contactId, tz });

export function toApiQuery(f: TaskFilters, tz: string, limit = 25): TaskListQuery {
  const [sort, dir] = f.sort.split(":") as ["due" | "priority" | "created" | "updated", "asc" | "desc"];
  const status = f.view === "completed" ? undefined : f.status === "any" ? undefined : f.status ? (f.status as never) : f.view === "open" ? (ACTIVE_FILTER as never) : undefined;
  return {
    view: f.view === "open" ? undefined : f.view,
    status,
    priority: (f.priority || undefined) as never,
    assignee: f.assignee || undefined,
    contactId: f.contactId || undefined,
    search: f.search?.trim() || undefined,
    dueFrom: f.dueFrom ? new Date(`${f.dueFrom}T00:00:00`).toISOString() : undefined,
    dueTo: f.dueTo ? new Date(`${f.dueTo}T23:59:59.999`).toISOString() : undefined,
    sort, dir, tz, limit,
  };
}
