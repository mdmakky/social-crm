import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/cn";

const SIZES = { xs: "size-5 text-2xs", sm: "size-6 text-2xs", md: "size-8 text-xs", lg: "size-10 text-sm" } as const;

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return ((parts[0]![0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]![0] ?? "" : "")).toUpperCase();
}

export function Avatar({ name, src, size = "md", className }: { name: string; src?: string | null; size?: keyof typeof SIZES; className?: string }) {
  return (
    <AvatarPrimitive.Root className={cn("inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-accent-subtle font-semibold text-accent-fg", SIZES[size], className)}>
      {src && <AvatarPrimitive.Image src={src} alt="" className="size-full object-cover" />}
      {/* Initials are decorative; drawn with CSS so they are not part of any control's text content. */}
      <AvatarPrimitive.Fallback aria-hidden data-initials={initials(name)} className="after:content-[attr(data-initials)]" />
    </AvatarPrimitive.Root>
  );
}
