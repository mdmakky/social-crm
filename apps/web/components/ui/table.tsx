import * as React from "react";
import { cn } from "@/lib/cn";

// The wrapper is `relative` so sr-only children (absolutely positioned) are clipped by this scroll container instead of widening the page.
export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="relative overflow-x-auto">
      <table className={cn("w-full border-collapse text-left text-base", className)} {...props} />
    </div>
  );
}
export const THead = (p: React.HTMLAttributes<HTMLTableSectionElement>) => <thead {...p} />;
export const TBody = (p: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody {...p} />;
export const TR = ({ className, ...p }: React.HTMLAttributes<HTMLTableRowElement>) => <tr className={cn("border-b border-line last:border-b-0 hover:bg-subtle", className)} {...p} />;
export const TH = ({ className, ...p }: React.ThHTMLAttributes<HTMLTableCellElement>) => <th scope="col" className={cn("whitespace-nowrap border-b border-line bg-subtle px-4 py-2 text-xs font-medium text-fg-muted first:rounded-tl-xl last:rounded-tr-xl", className)} {...p} />;
export const TD = ({ className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) => <td className={cn("px-4 py-2.5 align-middle text-fg", className)} {...p} />;
