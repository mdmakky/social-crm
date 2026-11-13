import * as React from "react";
import { cn } from "@/lib/cn";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn("min-h-20 w-full resize-y rounded-md border border-line-strong bg-surface px-2.5 py-2 text-base text-fg transition-colors duration-150 hover:border-fg-subtle disabled:cursor-not-allowed disabled:bg-hover disabled:text-fg-disabled aria-[invalid=true]:border-danger pointer-coarse:text-md", className)}
      {...props}
    />
  );
});

export const Checkbox = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & { label: string }>(function Checkbox({ label, className, id, ...props }, ref) {
  const auto = React.useId();
  const cid = id ?? auto;
  return (
    <label htmlFor={cid} className={cn("inline-flex min-h-6 cursor-pointer items-center gap-2 text-base text-fg pointer-coarse:min-h-11", className)}>
      <input ref={ref} id={cid} type="checkbox" className="size-4 shrink-0 rounded border-line-strong" {...props} />
      {label}
    </label>
  );
});
