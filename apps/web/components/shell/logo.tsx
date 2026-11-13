import { MessagesSquare } from "lucide-react";
import { cn } from "@/lib/cn";

export function Logo({ compact, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="inline-flex size-6 items-center justify-center rounded-md bg-accent text-on-accent"><MessagesSquare className="size-3.5" aria-hidden /></span>
      {!compact && <span className="text-base font-semibold tracking-title text-fg">Social CRM</span>}
    </span>
  );
}
