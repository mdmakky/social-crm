import * as React from "react";
import { cn } from "@/lib/cn";
import { VoiceInputButton } from "./voice-input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { voice?: boolean }>(function Textarea({ className, voice, ...props }, ref) {
  const inner = React.useRef<HTMLTextAreaElement | null>(null);
  const setRef = React.useCallback((el: HTMLTextAreaElement | null) => { inner.current = el; if (typeof ref === "function") ref(el); else if (ref) ref.current = el; }, [ref]);
  const area = (
    <textarea
      ref={setRef}
      className={cn("min-h-20 w-full resize-y press rounded-control border border-line bg-surface px-3 py-2 text-base text-fg hover:border-line-strong focus-visible:border-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/20 disabled:cursor-not-allowed disabled:bg-hover disabled:text-fg-disabled aria-[invalid=true]:border-danger pointer-coarse:text-md", className)}
      {...props}
    />
  );
  if (!voice) return area;
  return <div className="flex flex-col gap-1.5">{area}<VoiceInputButton target={inner} disabled={props.disabled || props.readOnly} className="self-end" /></div>;
});

export const Checkbox = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & { label: string }>(function Checkbox({ label, className, id, ...props }, ref) {
  const auto = React.useId();
  const cid = id ?? auto;
  return (
    <label htmlFor={cid} className={cn("inline-flex min-h-6 cursor-pointer items-center gap-2 text-base text-fg pointer-coarse:min-h-11", className)}>
      <input ref={ref} id={cid} type="checkbox" className="size-4 shrink-0 rounded border-line-control accent-[var(--accent)]" {...props} />
      {label}
    </label>
  );
});
