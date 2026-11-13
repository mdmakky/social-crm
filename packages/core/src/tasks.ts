import { can, type Role } from "./permissions.ts";

export type DueState = "overdue" | "today" | "upcoming" | "none" | "closed";

/** Offset (ms) of `tz` from UTC at the given instant. */
function offsetMs(at: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(at)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(at / 1000) * 1000;
}

/** UTC instant of local midnight for a calendar day in `tz`. Two passes settle the offset across DST changes. */
function localMidnight(y: number, m: number, d: number, tz: string): number {
  const wall = Date.UTC(y, m, d);
  let t = wall;
  for (let i = 0; i < 2; i++) t = wall - offsetMs(t, tz);
  return t;
}

/** [start, end) of the calendar day containing `now` in `tz`. Mirrors the API's "today" view, so a 23 or 25 hour DST day is handled. */
export function dayBounds(now: Date, tz = "UTC"): { start: Date; end: Date } {
  const local = new Date(now.getTime() + offsetMs(now.getTime(), tz));
  const [y, m, d] = [local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()];
  return { start: new Date(localMidnight(y, m, d, tz)), end: new Date(localMidnight(y, m, d + 1, tz)) };
}

/** Same rules as the API views: overdue is strictly before now; due exactly now is today; today is the calendar day in tz (a task due earlier today is "overdue"). */
export function dueState(t: { status: string; dueAt: string | null }, now: Date, tz = "UTC"): DueState {
  if (t.status !== "open" && t.status !== "in_progress") return "closed";
  if (!t.dueAt) return "none";
  const due = new Date(t.dueAt).getTime();
  if (due < now.getTime()) return "overdue";
  return due < dayBounds(now, tz).end.getTime() ? "today" : "upcoming";
}

/** matrix task.edit: owner and admin edit any task; an agent only tasks they created or are assigned to; viewers none. */
export function canEditTask(role: Role, userId: string, t: { assignee?: { id: string } | null; createdBy?: { id: string } | null }): boolean {
  return can(role, "task.edit", { isOwn: t.assignee?.id === userId || t.createdBy?.id === userId });
}
