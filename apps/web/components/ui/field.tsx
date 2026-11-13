import * as React from "react";
import { cn } from "@/lib/cn";

type ControlProps = { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean };

export function Field({ label, hint, error, className, children }: { label: string; hint?: string; error?: string | null; className?: string; children: (p: ControlProps) => React.ReactNode }) {
  const id = React.useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = error ? errId : hint ? hintId : undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-fg">{label}</label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && !error && <p id={hintId} className="text-xs text-fg-subtle">{hint}</p>}
      {error && <p id={errId} role="alert" className="text-xs text-danger-fg">{error}</p>}
    </div>
  );
}
