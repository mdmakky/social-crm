import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading contact">
      <div className="mb-5 flex items-center gap-3"><Skeleton className="size-12 rounded-full" /><div><Skeleton className="mb-2 h-6 w-48" /><Skeleton className="h-4 w-64" /></div></div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="grid gap-4 lg:col-span-2">
          {[0, 1].map((i) => <div key={i} className="rounded-card border border-line bg-surface p-4"><Skeleton className="mb-4 h-5 w-24" /><Skeleton className="mb-3 h-8 w-full" /><Skeleton className="h-8 w-full" /></div>)}
        </div>
        <div className="rounded-card border border-line bg-surface p-4"><Skeleton className="mb-4 h-5 w-20" /><Skeleton className="h-16 w-full" /></div>
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
