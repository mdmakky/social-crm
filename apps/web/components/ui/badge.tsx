import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const badge = cva("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium leading-4", {
  variants: {
    tone: {
      neutral: "bg-hover text-fg-muted",
      accent: "bg-accent-subtle text-accent-fg",
      success: "bg-success-bg text-success-fg",
      warning: "bg-warning-bg text-warning-fg",
      danger: "bg-danger-bg text-danger-fg",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ tone, className, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}
