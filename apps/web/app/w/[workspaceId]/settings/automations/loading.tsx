import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading automations" className="max-w-3xl">
      <Skeleton className="mb-2 h-7 w-40" />
      <Skeleton className="mb-6 h-4 w-72" />
      {[0, 1].map((i) => (
        <div key={i} className="mb-4 rounded-card border border-line bg-surface p-4">
          <Skeleton className="mb-3 h-5 w-32" />
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
