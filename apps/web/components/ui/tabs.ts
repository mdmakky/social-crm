import { cn } from "@/lib/cn";

/** Pill chips for view switchers (task views, notification filters, segments). One style everywhere; the active chip is ink, not accent, so colour stays rare. */
export const tabClass = (on: boolean) =>
  cn("press inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-base font-medium pointer-coarse:h-11 active:scale-[0.97]", on ? "border-fg bg-fg text-surface" : "border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg");
export const tabListClass = "mb-4 flex gap-1.5 overflow-x-auto pb-1";
