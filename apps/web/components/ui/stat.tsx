import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

/** One headline number. Pass href to make the whole tile a link to the list behind it. */
export function Stat({ label, value, note, href, tone }: { label: string; value: React.ReactNode; note?: React.ReactNode; href?: string; tone?: "danger" }) {
  const body = (
    <>
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className={cn("tnum mt-1 text-2xl font-semibold tracking-title", tone === "danger" ? "text-danger-fg" : "text-fg")}>{value}</dd>
      {note && <dd className="mt-0.5 text-xs text-fg-subtle">{note}</dd>}
    </>
  );
  const cls = "block rounded-card border border-line-card bg-surface px-4 py-3";
  return href ? <Link href={href} className={cn(cls, "transition-colors hover:bg-row-hover")}><dl>{body}</dl></Link> : <dl className={cls}>{body}</dl>;
}

export const StatGrid = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("mb-[var(--page-gap)] grid grid-cols-2 gap-3 lg:grid-cols-4", className)} {...p} />;
