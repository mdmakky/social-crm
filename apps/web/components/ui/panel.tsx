import * as React from "react";
import { cn } from "@/lib/cn";

/** The primary surface: white, rounded, soft shadow, no border. Use for the 2 or 3 main surfaces of a page; never nest one inside another. */
export function Panel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-panel className={cn("rounded-card bg-surface shadow-sheet", className)} {...props} />;
}

export function PanelHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line-card px-4 py-3">
      <div>
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-fg-subtle">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-[var(--page-gap)] flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-title text-fg">{title}</h1>
        {description && <p className="mt-0.5 text-base text-fg-subtle">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
