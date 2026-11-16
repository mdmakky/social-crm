import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading inbox" className="bleed flex h-[28rem] max-md:rounded-none max-md:border-0 overflow-hidden rounded-card border border-line bg-surface">
      <div className="w-full border-r border-line md:w-[300px] lg:w-[340px]">
        <div className="border-b border-line p-3"><Skeleton className="mb-2 h-5 w-20" /><Skeleton className="h-8 w-full" /></div>
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="flex gap-2.5 border-b border-line-card px-3 py-3"><Skeleton className="size-8 rounded-full" /><div className="flex-1"><Skeleton className="mb-1.5 h-4 w-32" /><Skeleton className="h-3 w-48" /></div></div>)}
      </div>
    </div>
  );
}
