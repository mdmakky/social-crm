import { cn } from "@/lib/cn";

/** Single tab/segment style for every tab row (task views, settings sections, future inbox views). */
export const tabClass = (on: boolean) =>
  cn("-mb-px inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-base font-medium transition-colors pointer-coarse:min-h-11", on ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg");
export const tabListClass = "mb-4 flex gap-1 overflow-x-auto border-b border-line-card";
