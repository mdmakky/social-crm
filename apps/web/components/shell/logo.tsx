import Image from "next/image";
import { cn } from "@/lib/cn";

/** Brand mark (public/brand/logo-mark.png, source in docs/design/brand) plus the product name. */
export function Logo({ compact, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Image src="/brand/logo-mark.png" alt="" width={24} height={24} className="size-6 shrink-0" priority />
      {!compact && <span className="text-base font-semibold tracking-title text-fg">Social CRM</span>}
    </span>
  );
}
