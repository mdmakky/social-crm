import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading leads">
      <div className="mb-5 flex items-center justify-between"><Skeleton className="h-7 w-32" /><Skeleton className="h-8 w-28" /></div>
      <Skeleton className="mb-3 h-11 w-full rounded-card md:h-10" />
      <div className="mb-3 flex gap-2"><Skeleton className="h-11 flex-1 md:h-8 md:w-80 md:flex-none" /><Skeleton className="h-11 w-24 md:h-8 md:w-28" /><Skeleton className="hidden h-8 w-28 md:block" /></div>
      <div className="rounded-card border border-line bg-surface">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex-1"><Skeleton className="mb-1.5 h-4 w-40" /><Skeleton className="h-3 w-56" /></div>
            <Skeleton className="hidden h-5 w-20 rounded-full md:block" />
            <Skeleton className="hidden h-4 w-24 md:block" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
