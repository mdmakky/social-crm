"use client";
import * as React from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

export const TooltipProvider = ({ children }: { children: React.ReactNode }) => <TooltipPrimitive.Provider delayDuration={300}>{children}</TooltipPrimitive.Provider>;

export function Tooltip({ label, children, side = "right" }: { label: string; children: React.ReactElement; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} sideOffset={6} className="pop z-50 max-w-60 rounded-control bg-fg px-2 py-1 text-xs font-medium text-surface">
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const DropdownMenu = Dropdown.Root;
export const DropdownMenuTrigger = Dropdown.Trigger;

export function DropdownMenuContent({ className, align = "start", ...props }: React.ComponentProps<typeof Dropdown.Content>) {
  return (
    <Dropdown.Portal>
      <Dropdown.Content align={align} sideOffset={6} collisionPadding={8} className={cn("pop z-50 min-w-52 max-w-[calc(100vw-16px)] rounded-card border border-line bg-surface p-1 shadow-popover origin-[var(--radix-dropdown-menu-content-transform-origin)]", className)} {...props} />
    </Dropdown.Portal>
  );
}
export function DropdownMenuItem({ className, danger, ...props }: React.ComponentProps<typeof Dropdown.Item> & { danger?: boolean }) {
  return (
    <Dropdown.Item
      className={cn("flex cursor-default select-none items-center gap-2 rounded-control px-2 py-1.5 text-base focus-visible:outline-offset-[-2px] data-[disabled]:opacity-50 data-[highlighted]:bg-hover pointer-coarse:py-2.5 [&_svg]:size-4 [&_svg]:text-fg-subtle", danger ? "text-danger-fg" : "text-fg", className)}
      {...props}
    />
  );
}
export const DropdownMenuLabel = ({ className, ...p }: React.ComponentProps<typeof Dropdown.Label>) => <Dropdown.Label className={cn("px-2 py-1 text-xs font-medium text-fg-subtle", className)} {...p} />;
export const DropdownMenuSeparator = ({ className, ...p }: React.ComponentProps<typeof Dropdown.Separator>) => <Dropdown.Separator className={cn("my-1 h-px bg-line", className)} {...p} />;

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ title, description, children, className }: { title: string; description?: string; children: React.ReactNode; className?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="scrim fixed inset-0 z-40 bg-fg/25" />
      <DialogPrimitive.Content onOpenAutoFocus={(e) => { const first = (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-dialog-body] select, [data-dialog-body] input, [data-dialog-body] button:not([disabled])"); if (first) { e.preventDefault(); first.focus(); } }} className={cn("pop fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-card border border-line bg-surface p-5 shadow-popover max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:max-h-[92dvh] max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0 max-md:pb-0 max-md:[animation:sheet-up_var(--dur-slow)_var(--ease-out)]", className)}>
        <div className="flex items-start justify-between gap-4">
          <DialogPrimitive.Title className="text-md font-semibold text-fg">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" icon size="sm" aria-label="Close"><X /></Button>
          </DialogPrimitive.Close>
        </div>
        {description ? <DialogPrimitive.Description className="mt-1 text-sm text-fg-muted">{description}</DialogPrimitive.Description> : <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>}
        <div data-dialog-body className="mt-4 max-md:pb-[max(1.25rem,env(safe-area-inset-bottom))]">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** Cancel/Save row of a dialog. Below md it sticks to the bottom of the scrolling sheet, full-width buttons, so the actions stay reachable on a long form. */
export function DialogActions({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("dialog-actions flex justify-end gap-2", className)} {...props} />;
}
