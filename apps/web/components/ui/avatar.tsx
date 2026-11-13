import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/initials";
import { hueOf } from "./badge";

const SIZES = { xs: "size-5 text-[9px]", sm: "size-6 text-[10px]", md: "size-7 text-[11px]", lg: "size-8 text-xs", xl: "size-11 text-md" } as const;
const TINT = { 1: "bg-hue-1-bg text-hue-1-fg", 2: "bg-hue-2-bg text-hue-2-fg", 3: "bg-hue-3-bg text-hue-3-fg", 4: "bg-hue-4-bg text-hue-4-fg", 5: "bg-hue-5-bg text-hue-5-fg", 6: "bg-hue-6-bg text-hue-6-fg" } as const;

/** Tinted by name so people are recognizable at a glance. Initials in the same hue's dark ink. */
export function Avatar({ name, src, size = "md", className }: { name: string; src?: string | null; size?: keyof typeof SIZES; className?: string }) {
  return (
    <AvatarPrimitive.Root className={cn("inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-semibold", TINT[hueOf(name)], SIZES[size], className)}>
      {src && <AvatarPrimitive.Image src={src} alt="" className="size-full object-cover" />}
      {/* Initials are decorative; drawn with CSS so they are not part of any control's text content. */}
      <AvatarPrimitive.Fallback aria-hidden data-initials={initials(name)} className="after:content-[attr(data-initials)]" />
    </AvatarPrimitive.Root>
  );
}
