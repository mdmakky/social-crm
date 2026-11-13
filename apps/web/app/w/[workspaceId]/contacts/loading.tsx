import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading contacts">
      <div className="mb-5 flex items-center justify-between"><Skeleton className="h-7 w-32" /><Skeleton className="h-8 w-28" /></div>
      <div className="mb-3 flex gap-2"><Skeleton className="h-8 w-64" /><Skeleton className="h-8 w-32" /><Skeleton className="h-8 w-32" /></div>
      <div className="rounded-xl border border-line bg-surface">
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
