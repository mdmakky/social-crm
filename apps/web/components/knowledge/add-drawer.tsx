"use client";
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/** Side panel on wide screens, a tall bottom sheet on phones. Radix dialog: focus is trapped, Escape and the scrim close it. */
export function Drawer({ open, onOpenChange, title, children, footer }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="scrim fixed inset-0 z-40 bg-fg/30" />
        <DialogPrimitive.Content aria-describedby={undefined} className={cn("fixed z-50 flex flex-col bg-surface shadow-popover outline-none", "inset-x-0 bottom-0 h-[min(94dvh,52rem)] rounded-t-3xl sheet", "md:inset-y-0 md:left-auto md:right-0 md:h-auto md:w-[34rem] md:rounded-l-3xl md:rounded-tr-none")}>
          <div className="flex items-center gap-2 px-4 pb-2 pt-4 md:px-6 md:pt-5">
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-xl font-bold tracking-title text-fg">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild><Button variant="ghost" icon aria-label="Close" className="pointer-coarse:size-11"><X /></Button></DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 md:px-6">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2.5 border-t border-line bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6 md:pb-4 max-sm:[&>button]:flex-1">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
