"use client";
import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/cn";

/** A panel whose body folds away. The whole header is the toggle (a stretched button), while the title stays a real heading. Opens by default, or when the URL hash is its id. */
export function FoldPanel({ id, icon: Icon, title, summary, defaultOpen, children }: { id: string; icon: React.ComponentType<{ className?: string }>; title: string; summary?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(() => !!defaultOpen || (typeof window !== "undefined" && window.location.hash === `#${id}`));
  const body = `${id}-body`;
  return (
    <Panel id={id} className="scroll-mt-14">
      <div className={cn("relative flex items-center gap-3 px-4 py-3", open && "border-b border-line-card")}>
        <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-hover text-fg-muted"><Icon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-fg">{title}</h2>
          {summary && <p className="truncate text-sm text-fg-subtle">{summary}</p>}
        </div>
        <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-fg-subtle transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]", open && "rotate-180")} />
        <button type="button" aria-expanded={open} aria-controls={body} aria-label={`${open ? "Collapse" : "Expand"} ${title}`} onClick={() => setOpen((v) => !v)} className="press absolute inset-0 rounded-card hover:bg-hover/40 pointer-coarse:min-h-11" />
      </div>
      {open && <div id={body}>{children}</div>}
    </Panel>
  );
}
