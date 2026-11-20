import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading lead settings">
      <Skeleton className="mb-2 h-7 w-40" />
      <Skeleton className="mb-6 h-4 w-64" />
      <Skeleton className="mb-4 h-10 w-72" />
      <div className="rounded-card border border-line bg-surface p-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="mb-3 h-8 w-full" />)}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
