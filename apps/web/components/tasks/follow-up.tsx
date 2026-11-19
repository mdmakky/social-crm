"use client";
import * as React from "react";
import { Bell, CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useWorkspacePrefs } from "@/components/shell/workspace-prefs";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const SLOTS = ["09:00", "11:30", "14:00", "17:00"];
export const fmtTime = (h: string, format: "12h" | "24h" = "12h") => {
  const [a, b] = h.split(":").map(Number) as [number, number];
  return format === "24h" ? `${pad(a)}:${pad(b)}` : `${a % 12 || 12}:${pad(b)} ${a < 12 ? "AM" : "PM"}`;
};

/** How long before the due time the assignee is notified. 0 = at the time. */
export const REMIND_OPTIONS = [{ min: 0, label: "At the time" }, { min: 15, label: "15 min before" }, { min: 60, label: "1 hour before" }, { min: 1440, label: "1 day before" }] as const;

/** What the person chose for "what happens next". `undefined` day means nothing chosen yet. `remind` is minutes before the due time, or null for no reminder. */
export type FollowUp = { none: boolean; day?: string; time: string; remind: number | null };
export const emptyFollowUp = (): FollowUp => ({ none: false, time: "11:30", remind: 15 });
export const followUpReady = (f: FollowUp) => f.none || !!f.day;
/** Local `YYYY-MM-DDTHH:mm` for the follow-up, or null when there is none. */
export const followUpLocal = (f: FollowUp) => (f.none || !f.day ? null : `${f.day}T${f.time}`);
/** The instant to notify the assignee for a follow-up due at `dueIso`, or null for no reminder. */
export const followUpRemindAt = (dueIso: string, f: FollowUp) => (f.remind === null ? null : new Date(new Date(dueIso).getTime() - f.remind * 60_000).toISOString());

const chip = (on: boolean) => cn("press inline-flex h-9 items-center rounded-full px-3.5 text-sm font-medium pointer-coarse:h-11", on ? "bg-fg text-surface" : "bg-subtle text-fg hover:bg-hover");
const cell = (on: boolean) => cn("press flex h-9 items-center justify-center rounded-control text-sm font-medium tnum pointer-coarse:h-11", on ? "bg-accent text-on-accent" : "bg-surface text-fg ring-1 ring-inset ring-line hover:bg-hover");
const parts = (h: string) => ({ h12: Number(h.slice(0, 2)) % 12 || 12, m: Number(h.slice(3, 5)), pm: Number(h.slice(0, 2)) >= 12 });
const make = (h12: number, m: number, pm: boolean) => `${pad((h12 % 12) + (pm ? 12 : 0))}:${pad(m)}`;

/** A month grid. Days before today cannot be picked. */
const WEEK_START = { sun: 0, mon: 1, sat: 6 } as const;
function MonthCalendar({ value, today, onPick, weekStart }: { value?: string; today: Date; onPick: (d: string) => void; weekStart: "sat" | "sun" | "mon" }) {
  const start = value ? new Date(`${value}T00:00`) : today;
  const [month, setMonth] = React.useState(() => new Date(start.getFullYear(), start.getMonth(), 1));
  const first = (month.getDay() - WEEK_START[weekStart] + 7) % 7;
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const todayKey = ymd(today);
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2026, 0, 4 + WEEK_START[weekStart] + i).toLocaleDateString(undefined, { weekday: "narrow" }));
  const atFirstMonth = month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth();
  return (
    <div className="mt-2 rounded-card border border-line p-2" data-testid="follow-up-calendar">
      <div className="mb-1 flex items-center justify-between">
        <button type="button" aria-label="Previous month" disabled={atFirstMonth} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="press grid size-9 place-items-center rounded-control hover:bg-hover disabled:opacity-30 pointer-coarse:size-11"><ChevronLeft className="size-4" aria-hidden /></button>
        <span className="text-sm font-semibold" aria-live="polite">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
        <button type="button" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="press grid size-9 place-items-center rounded-control hover:bg-hover pointer-coarse:size-11"><ChevronRight className="size-4" aria-hidden /></button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center">
        {weekdays.map((w, i) => <span key={i} className="py-1 text-xs text-fg-subtle">{w}</span>)}
        {Array.from({ length: first }, (_, i) => <span key={`b${i}`} />)}
        {Array.from({ length: count }, (_, i) => {
          const d = new Date(month.getFullYear(), month.getMonth(), i + 1);
          const key = ymd(d);
          const past = key < todayKey;
          const on = key === value;
          return <button key={key} type="button" disabled={past} aria-label={d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })} aria-pressed={on} onClick={() => onPick(key)} className={cn("press h-9 rounded-control text-sm tnum pointer-coarse:h-11", on ? "bg-accent font-semibold text-on-accent" : "hover:bg-hover", key === todayKey && !on && "ring-1 ring-inset ring-line-strong", past && "text-fg-subtle/40 hover:bg-transparent")}>{i + 1}</button>;
        })}
      </div>
    </div>
  );
}

/** Hour, minute (5 min steps) and AM/PM buttons. Replaces the browser's own time dropdown, which is awkward on desktop. */
function TimeGrid({ value, onChange, format }: { value: string; onChange: (t: string) => void; format: "12h" | "24h" }) {
  const t = parts(value);
  const h24 = Number(value.slice(0, 2));
  const group = "grid grid-cols-6 gap-1";
  return (
    <div className="mt-2 flex flex-col gap-3 rounded-card border border-line bg-subtle p-3" data-testid="follow-up-time-grid">
      <div><p className="mb-1 text-xs font-semibold">Hour</p><div role="group" aria-label="Hour" className={group}>{format === "24h" ? Array.from({ length: 24 }, (_, i) => i).map((h) => <button key={h} type="button" aria-pressed={h24 === h} onClick={() => onChange(`${pad(h)}:${pad(t.m)}`)} className={cell(h24 === h)}>{pad(h)}</button>) : Array.from({ length: 12 }, (_, i) => i + 1).map((h) => <button key={h} type="button" aria-pressed={t.h12 === h} onClick={() => onChange(make(h, t.m, t.pm))} className={cell(t.h12 === h)}>{h}</button>)}</div></div>
      <div><p className="mb-1 text-xs font-semibold">Minute</p><div role="group" aria-label="Minute" className={group}>{Array.from({ length: 12 }, (_, i) => i * 5).map((m) => <button key={m} type="button" aria-pressed={t.m === m} onClick={() => onChange(`${pad(h24)}:${pad(m)}`)} className={cell(t.m === m)}>{pad(m)}</button>)}</div></div>
      {format === "12h" && <div role="group" aria-label="AM or PM" className="inline-flex gap-1 self-start rounded-control bg-line/60 p-0.5">
        {[false, true].map((pm) => <button key={String(pm)} type="button" aria-pressed={t.pm === pm} onClick={() => onChange(make(t.h12, t.m, pm))} className={cn("press h-8 rounded-[6px] px-4 text-sm font-medium pointer-coarse:h-11", t.pm === pm ? "bg-surface shadow-sm" : "text-fg-muted")}>{pm ? "PM" : "AM"}</button>)}
      </div>}
    </div>
  );
}

/** Day strip, time chips, optional calendar and time grid, and a "Remind me" choice so a notification really arrives. */
export function FollowUpPicker({ value, onChange, disabled }: { value: FollowUp; onChange: (v: FollowUp) => void; disabled?: boolean }) {
  const { timeFormat, weekStart } = useWorkspacePrefs();
  const ft = (h: string) => fmtTime(h, timeFormat);
  const [today] = React.useState(() => new Date());
  const [showCal, setShowCal] = React.useState(false);
  const [showTime, setShowTime] = React.useState(false);
  const days = React.useMemo(() => Array.from({ length: 7 }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + i)), [today]);
  const off = value.none || disabled;
  const custom = value.day && !days.some((d) => ymd(d) === value.day);
  const customTime = !SLOTS.includes(value.time);
  const set = (p: Partial<FollowUp>) => onChange({ ...value, none: false, ...p });
  const due = value.day ? new Date(`${value.day}T${value.time}`) : null;
  const remindAt = due && value.remind !== null ? new Date(due.getTime() - value.remind * 60_000) : null;
  const fmtD = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return (
    <fieldset className="min-w-0 border-0 p-0" disabled={disabled}>
      <div className="mb-2 flex items-center justify-between">
        <legend className="p-0 text-sm font-semibold text-fg">Next follow-up</legend>
        <button type="button" aria-pressed={value.none} onClick={() => onChange(value.none ? emptyFollowUp() : { ...value, none: true, day: undefined })} className={cn("press rounded px-1 text-sm underline-offset-4 pointer-coarse:min-h-11", value.none ? "font-semibold text-fg" : "text-fg-muted underline hover:text-fg")}>
          {value.none ? "No follow-up ✓" : "No follow-up"}
        </button>
      </div>
      <div className={cn(off && "pointer-events-none opacity-40")}>
        <div role="group" aria-label="Day" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-8 sm:overflow-visible sm:px-0" data-scroll="allowed">
          {days.map((d, i) => {
            const on = value.day === ymd(d);
            return (
              <button key={ymd(d)} type="button" aria-pressed={on} onClick={() => set({ day: ymd(d) })} className={cn("press flex h-16 w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-control sm:w-auto", on ? "bg-accent text-on-accent" : "hover:bg-hover")}>
                <span className={cn("text-xs", on ? "text-on-accent/80" : "text-fg-subtle")}>{i === 0 ? "Today" : d.toLocaleDateString(undefined, { weekday: "short" })}</span>
                <span className="tnum text-lg font-semibold">{d.getDate()}</span>
              </button>
            );
          })}
          <button type="button" aria-expanded={showCal} onClick={() => setShowCal((v) => !v)} className={cn("press flex h-16 w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-control sm:w-auto", custom ? "bg-accent text-on-accent" : "hover:bg-hover")}>
            <span className={cn("text-xs", custom ? "text-on-accent/80" : "text-fg-subtle")}>{custom ? new Date(`${value.day}T00:00`).toLocaleDateString(undefined, { month: "short" }) : "More"}</span>
            {custom ? <span className="tnum text-lg font-semibold">{new Date(`${value.day}T00:00`).getDate()}</span> : <CalendarDays className="size-5" aria-hidden />}
          </button>
        </div>
        {showCal && <MonthCalendar weekStart={weekStart} value={value.day} today={today} onPick={(d) => { set({ day: d }); setShowCal(false); }} />}
        <div role="group" aria-label="Time" className="mt-2 flex flex-wrap items-center gap-1.5">
          {SLOTS.map((s) => <button key={s} type="button" aria-pressed={value.time === s && !showTime} onClick={() => { set({ time: s }); setShowTime(false); }} className={chip(value.time === s && !showTime)}>{ft(s)}</button>)}
          <button type="button" aria-expanded={showTime} onClick={() => setShowTime((v) => !v)} className={chip(showTime || customTime)}>{customTime ? ft(value.time) : "Other time"}</button>
        </div>
        {showTime && <TimeGrid format={timeFormat} value={value.time} onChange={(t) => set({ time: t })} />}
        <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
          <div className="flex items-center gap-2">
            <Switch label="Remind me" checked={value.remind !== null} onCheckedChange={(v) => set({ remind: v ? 15 : null })} />
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold"><Bell className="size-4 text-fg-subtle" aria-hidden />Remind me</span>
          </div>
          {value.remind !== null && (
            <div role="group" aria-label="When to remind" className="flex flex-wrap gap-1.5">
              {REMIND_OPTIONS.map((o) => <button key={o.min} type="button" aria-pressed={value.remind === o.min} onClick={() => set({ remind: o.min })} className={chip(value.remind === o.min)}>{o.label}</button>)}
            </div>
          )}
        </div>
      </div>
      <p className="mt-3 text-sm text-fg-muted" aria-live="polite">
        {value.none ? "This task will finish without a follow-up." : due ? `A follow-up task will be created for ${fmtD(due)}, ${ft(value.time)}.${remindAt ? ` You will get a notification ${fmtD(remindAt)}, ${ft(`${pad(remindAt.getHours())}:${pad(remindAt.getMinutes())}`)}.` : " No reminder."}` : "Pick a day, or choose “No follow-up”, to finish this task."}
      </p>
    </fieldset>
  );
}
