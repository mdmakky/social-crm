import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading settings" className="max-w-2xl">
      <Skeleton className="mb-2 h-7 w-32" />
      <Skeleton className="mb-6 h-4 w-60" />
      {[0, 1].map((i) => (
        <div key={i} className="mb-4 rounded-card border border-line bg-surface p-4">
          <Skeleton className="mb-4 h-5 w-28" />
          <Skeleton className="mb-3 h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
