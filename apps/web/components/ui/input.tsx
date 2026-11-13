import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

const control =
  "w-full rounded-control border border-line-control bg-surface px-2.5 text-base text-fg transition-colors duration-150 hover:border-fg-subtle focus-visible:border-accent disabled:cursor-not-allowed disabled:bg-hover disabled:text-fg-disabled aria-[invalid=true]:border-danger h-[var(--control-h)] pointer-coarse:h-[var(--control-h-touch)] pointer-coarse:text-md";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(control, className)} {...props} />;
});

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement> & { wrapperClassName?: string }>(function Select({ className, wrapperClassName, children, ...props }, ref) {
  return (
    <div className={cn("relative", wrapperClassName)}>
      <select ref={ref} className={cn(control, "appearance-none pr-8", className)} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
    </div>
  );
});
