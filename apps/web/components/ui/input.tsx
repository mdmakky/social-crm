import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

// Controls are quiet at rest (hairline, no fill), confirm on hover, and show an accent ring on focus. The ring replaces the global outline here so it never clips.
const control =
  "press w-full rounded-control border border-line bg-surface px-2.5 text-base text-fg hover:border-line-strong focus-visible:border-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/20 disabled:cursor-not-allowed disabled:bg-hover disabled:text-fg-disabled aria-[invalid=true]:border-danger h-[var(--control-h)] pointer-coarse:h-[var(--control-h-touch)] pointer-coarse:text-md";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(control, className)} {...props} />;
});

/** `quiet` is the toolbar filter style: no box at rest, a wash on hover; `active` marks a non-default filter with the accent tint. */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement> & { wrapperClassName?: string; quiet?: boolean; active?: boolean }>(function Select({ className, wrapperClassName, quiet, active, children, ...props }, ref) {
  return (
    <div className={cn("relative", wrapperClassName)}>
      <select ref={ref} className={cn(control, "appearance-none pr-7", quiet && "border-transparent bg-transparent text-fg-muted shadow-none hover:border-transparent hover:bg-hover hover:text-fg", quiet && active && "bg-hover font-medium text-fg", className)} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
    </div>
  );
});
