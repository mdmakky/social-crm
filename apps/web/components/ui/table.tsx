import * as React from "react";
import { cn } from "@/lib/cn";

// The wrapper is `relative` so sr-only children (absolutely positioned) are clipped by this scroll container instead of widening the page.
export function Table({ className, scrollLabel, ...props }: React.TableHTMLAttributes<HTMLTableElement> & { scrollLabel?: string }) {
  // scrollLabel marks a table that is allowed to scroll sideways inside its own region (keyboard focusable and named).
  return (
    <div className="relative overflow-x-auto" {...(scrollLabel ? { tabIndex: 0, role: "region", "aria-label": scrollLabel, "data-scroll": "allowed" } : {})}>
      <table className={cn("w-full border-collapse text-left text-base", className)} {...props} />
    </div>
  );
}
export const THead = (p: React.HTMLAttributes<HTMLTableSectionElement>) => <thead {...p} />;
export const TBody = (p: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody {...p} />;
export const TR = ({ className, ...p }: React.HTMLAttributes<HTMLTableRowElement>) => <tr className={cn("border-b border-line-card transition-colors duration-[var(--dur-fast)] last:border-b-0 hover:bg-row-hover aria-selected:bg-selected", className)} {...p} />;
export const TH = ({ className, ...p }: React.ThHTMLAttributes<HTMLTableCellElement>) => <th scope="col" className={cn("h-9 whitespace-nowrap border-b border-line-card px-4 text-xs font-medium text-fg-subtle", className)} {...p} />;
export const TD = ({ className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) => <td className={cn("h-[var(--row-h)] px-4 align-middle text-fg", className)} {...p} />;
