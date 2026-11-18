import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading AI and automation" className="flex flex-col gap-4">
      {[0, 1].map((i) => (
        <div key={i} className="rounded-card bg-surface p-4 shadow-sheet">
          <Skeleton className="mb-3 h-5 w-32" />
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
