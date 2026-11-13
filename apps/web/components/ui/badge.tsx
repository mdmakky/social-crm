import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

/** Soft tinted label. Default is a pill (states, stages); `square` is the smaller tag shape. Hue tones are the six identity hues. */
const badge = cva("inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium", {
  variants: {
    tone: {
      neutral: "bg-hover text-fg-muted",
      accent: "bg-accent-subtle text-accent-fg",
      success: "bg-success-bg text-success-fg",
      warning: "bg-warning-bg text-warning-fg",
      danger: "bg-danger-bg text-danger-fg",
      stone: "bg-[#ECEBF1] text-[#4B4A5C]",
      "hue-1": "bg-hue-1-bg text-hue-1-fg", "hue-2": "bg-hue-2-bg text-hue-2-fg", "hue-3": "bg-hue-3-bg text-hue-3-fg",
      "hue-4": "bg-hue-4-bg text-hue-4-fg", "hue-5": "bg-hue-5-bg text-hue-5-fg", "hue-6": "bg-hue-6-bg text-hue-6-fg",
    },
    shape: { pill: "h-5 rounded-full px-2", square: "h-5 rounded-md px-1.5" },
  },
  defaultVariants: { tone: "neutral", shape: "pill" },
});

export function Badge({ tone, shape, className, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone, shape }), className)} {...props} />;
}

/** A status with a colored dot and plain text, for places a filled pill would be too loud. */
export function Status({ hue, children, className }: { hue: 1 | 2 | 3 | 4 | 5 | 6 | "muted"; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-base text-fg", className)}>
      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: hue === "muted" ? "var(--fg-disabled)" : `var(--hue-${hue}-dot)` }} />
      {children}
    </span>
  );
}
/** Stable hue for a string, so the same person or stage always gets the same color. */
export const hueOf = (key: string): 1 | 2 | 3 | 4 | 5 | 6 => ((Array.from(key).reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6;
