import * as React from "react";
import { cn } from "@/lib/cn";

/** An on/off switch. The visible track is 40x24; the button around it is at least 44 px square on touch screens. `label` is what a screen reader hears. */
export const Switch = React.forwardRef<HTMLButtonElement, Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & { checked: boolean; onCheckedChange: (v: boolean) => void; label: string }>(function Switch({ checked, onCheckedChange, label, className, ...p }, ref) {
  return (
    <button ref={ref} type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onCheckedChange(!checked)} className={cn("press inline-flex min-h-6 min-w-10 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:min-w-11", className)} {...p}>
      <span aria-hidden className={cn("relative block h-6 w-10 rounded-full transition-colors", checked ? "bg-accent" : "bg-line-strong")}>
        <span className={cn("absolute top-0.5 size-5 rounded-full bg-surface shadow-sm transition-[left]", checked ? "left-[1.125rem]" : "left-0.5")} />
      </span>
    </button>
  );
});
