import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export const buttonStyles = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-hover",
        secondary: "border border-line-strong bg-surface text-fg hover:bg-hover active:bg-hover",
        ghost: "text-fg-muted hover:bg-hover hover:text-fg active:bg-hover",
        danger: "bg-danger text-on-accent hover:bg-danger-fg active:bg-danger-fg",
      },
      size: {
        sm: "h-7 px-2.5 text-sm pointer-coarse:h-11 pointer-coarse:px-3.5",
        md: "h-8 px-3 text-base pointer-coarse:h-11 pointer-coarse:px-4",
        lg: "h-10 px-4 text-base pointer-coarse:h-11",
      },
      icon: { true: "px-0", false: "" },
    },
    compoundVariants: [
      { icon: true, size: "sm", className: "w-7 pointer-coarse:w-11 px-0" },
      { icon: true, size: "md", className: "w-8 pointer-coarse:w-11 px-0" },
      { icon: true, size: "lg", className: "w-10 pointer-coarse:w-11 px-0" },
    ],
    defaultVariants: { variant: "secondary", size: "md", icon: false },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonStyles> & { asChild?: boolean; loading?: boolean };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, icon, asChild, loading, disabled, children, type = "button", ...props },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonStyles({ variant, size, icon }), className)}
      {...props}
    >
      {asChild ? children : (
        <>
          {loading && <Loader2 className="spin" aria-hidden />}
          {children}
        </>
      )}
    </Comp>
  );
});
