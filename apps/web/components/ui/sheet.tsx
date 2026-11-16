"use client";
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * Bottom sheet for phones: filters, pickers, the More menu. Built on the Radix dialog, so focus is trapped, Escape and a tap on the scrim close it,
 * and focus returns to the trigger. It scrolls inside (never the page behind) and clears the home indicator.
 */
export function Sheet({ open, onOpenChange, title, description, children, className }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: React.ReactNode; className?: string }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="scrim fixed inset-0 z-40 bg-fg/25" />
        <DialogPrimitive.Content className={cn("sheet fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[min(88dvh,44rem)] w-full max-w-lg flex-col rounded-t-[var(--radius-sheet)] bg-surface shadow-popover outline-none", className)}>
          <span aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong" />
          <div className="flex items-start justify-between gap-3 px-4 pb-1 pt-2">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-md font-semibold text-fg">{title}</DialogPrimitive.Title>
              {description ? <DialogPrimitive.Description className="mt-0.5 text-sm text-fg-subtle">{description}</DialogPrimitive.Description> : <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close asChild><Button variant="ghost" icon aria-label="Close" className="-mr-2 shrink-0"><X /></Button></DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-1">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
