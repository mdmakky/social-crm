"use client";
import * as React from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/cn";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const SLOTS = ["09:00", "11:30", "14:00", "17:00"];
export const fmtTime = (h: string) => {
  const [a, b] = h.split(":").map(Number) as [number, number];
  return `${a % 12 || 12}:${pad(b)} ${a < 12 ? "AM" : "PM"}`;
};

/** What the person chose for "what happens next". `undefined` day means nothing chosen yet. */
export type FollowUp = { none: boolean; day?: string; time: string };
export const emptyFollowUp = (): FollowUp => ({ none: false, time: "11:30" });
export const followUpReady = (f: FollowUp) => f.none || !!f.day;
/** Local `YYYY-MM-DDTHH:mm` for the follow-up, or null when there is none. */
export const followUpLocal = (f: FollowUp) => (f.none || !f.day ? null : `${f.day}T${f.time}`);

const chip = (on: boolean) => cn("press inline-flex h-9 items-center rounded-full px-3.5 text-sm font-medium pointer-coarse:h-11", on ? "bg-fg text-surface" : "bg-subtle text-fg hover:bg-hover");

/** Day strip plus time chips. Flat on purpose: no card, just a divider above. */
export function FollowUpPicker({ value, onChange, disabled }: { value: FollowUp; onChange: (v: FollowUp) => void; disabled?: boolean }) {
  const [today] = React.useState(() => new Date());
  const days = React.useMemo(() => Array.from({ length: 7 }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + i)), [today]);
  const off = value.none || disabled;
  const custom = value.day && !days.some((d) => ymd(d) === value.day);
  const set = (p: Partial<FollowUp>) => onChange({ ...value, none: false, ...p });
  return (
    <fieldset className="min-w-0 border-0 p-0" disabled={disabled}>
      <div className="mb-2 flex items-center justify-between">
        <legend className="p-0 text-sm font-semibold text-fg">Next follow-up</legend>
        <button type="button" aria-pressed={value.none} onClick={() => onChange(value.none ? emptyFollowUp() : { ...value, none: true, day: undefined })} className={cn("press rounded px-1 text-sm underline-offset-4 pointer-coarse:min-h-11", value.none ? "font-semibold text-fg" : "text-fg-muted underline hover:text-fg")}>
          {value.none ? "No follow-up ✓" : "No follow-up"}
        </button>
      </div>
      <div role="group" aria-label="Day" className={cn("-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-8 sm:overflow-visible sm:px-0", off && "pointer-events-none opacity-40")} data-scroll="allowed">
        {days.map((d, i) => {
          const on = value.day === ymd(d);
          return (
            <button key={ymd(d)} type="button" aria-pressed={on} onClick={() => set({ day: ymd(d) })} className={cn("press flex h-16 w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-control sm:w-auto", on ? "bg-accent text-on-accent" : "hover:bg-hover")}>
              <span className={cn("text-xs", on ? "text-on-accent/80" : "text-fg-subtle")}>{i === 0 ? "Today" : d.toLocaleDateString(undefined, { weekday: "short" })}</span>
              <span className="tnum text-lg font-semibold">{d.getDate()}</span>
            </button>
          );
        })}
        <label className={cn("press relative flex h-16 w-14 shrink-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-control sm:w-auto", custom ? "bg-accent text-on-accent" : "hover:bg-hover")}>
          <span className={cn("text-xs", custom ? "text-on-accent/80" : "text-fg-subtle")}>{custom ? new Date(`${value.day}T00:00`).toLocaleDateString(undefined, { month: "short" }) : "More"}</span>
          {custom ? <span className="tnum text-lg font-semibold">{new Date(`${value.day}T00:00`).getDate()}</span> : <CalendarDays className="size-5" aria-hidden />}
          <input type="date" aria-label="Pick another date" min={ymd(today)} value={custom ? value.day : ""} onChange={(e) => e.target.value && set({ day: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" />
        </label>
      </div>
      <div role="group" aria-label="Time" className={cn("mt-2 flex flex-wrap items-center gap-1.5", off && "pointer-events-none opacity-40")}>
        {SLOTS.map((s) => <button key={s} type="button" aria-pressed={value.time === s} onClick={() => set({ time: s })} className={chip(value.time === s)}>{fmtTime(s)}</button>)}
        <input type="time" aria-label="Custom time" value={SLOTS.includes(value.time) ? "" : value.time} onChange={(e) => e.target.value && set({ time: e.target.value })} className={cn(chip(!SLOTS.includes(value.time)), "w-32 border-0 bg-subtle px-3", !SLOTS.includes(value.time) && "bg-fg text-surface")} />
      </div>
      <p className="mt-3 text-sm text-fg-muted" aria-live="polite">
        {value.none ? "This task will finish without a follow-up." : value.day ? `A follow-up task will be created for ${new Date(`${value.day}T${value.time}`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${fmtTime(value.time)}.` : "Pick a day, or choose “No follow-up”, to finish this task."}
      </p>
    </fieldset>
  );
}
