import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading notifications">
      <Skeleton className="mb-2 h-7 w-40" />
      <Skeleton className="mb-6 h-4 w-64" />
      <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
