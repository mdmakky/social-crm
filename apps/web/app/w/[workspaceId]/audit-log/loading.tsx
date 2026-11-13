import { Skeleton } from "@/components/ui/skeleton";

/** Table-shaped loading state for list pages. */
export default function Loading() {
  return (
    <div role="status" aria-label="Loading">
      <Skeleton className="mb-2 h-7 w-40" />
      <Skeleton className="mb-6 h-4 w-72" />
      <div className="rounded-card border border-line bg-surface">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex-1"><Skeleton className="mb-1.5 h-4 w-44" /><Skeleton className="h-3 w-56" /></div>
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
