import { Skeleton } from "@/components/ui/skeleton";

/** Default loading state: a page header and one panel of rows. Home and Settings have their own shapes. */
export default function Loading() {
  return (
    <div role="status" aria-label="Loading">
      <Skeleton className="mb-2 h-7 w-48" />
      <Skeleton className="mb-6 h-4 w-72" />
      <div className="grid items-start gap-4 lg:grid-cols-5">
        <div className="rounded-xl border border-line bg-surface p-4 lg:col-span-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-line py-3 last:border-b-0">
              <Skeleton className="size-4 rounded-full" />
              <div className="flex-1"><Skeleton className="mb-1.5 h-4 w-48" /><Skeleton className="h-3 w-32" /></div>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-line bg-surface p-4 lg:col-span-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-line py-3 last:border-b-0">
              <Skeleton className="size-6 rounded-full" />
              <Skeleton className="h-4 w-40" />
            </div>
          ))}
        </div>
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
