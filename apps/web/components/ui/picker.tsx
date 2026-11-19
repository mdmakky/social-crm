"use client";
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { usePhone } from "@/lib/use-phone";

/**
 * A small panel that opens next to its button on a computer and as a bottom sheet on a phone.
 * Same behaviour in both: focus moves in and is trapped, Escape or a tap outside closes, and focus returns to the button.
 * (Radix dialog under the hood; the desktop overlay is invisible, the panel is placed from the button's position when it opens.)
 */
export function Picker({ open, onOpenChange, anchor, title, description, width = 320, children }: { open: boolean; onOpenChange: (o: boolean) => void; anchor: React.RefObject<HTMLElement | null>; title: string; description?: string; width?: number; children: React.ReactNode }) {
  const phone = usePhone();
  const [pos, setPos] = React.useState<{ left: number; top: number; maxH: number } | null>(null);
  React.useLayoutEffect(() => {
    if (!open || phone) return;
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const maxH = Math.min(440, window.innerHeight - 24);
    const below = window.innerHeight - r.bottom - 12;
    const top = below >= Math.min(maxH, 280) ? r.bottom + 6 : Math.max(12, r.top - 6 - Math.min(maxH, r.top - 18));
    setPos({ left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)), top, maxH: Math.max(160, Math.min(maxH, top === r.bottom + 6 ? below : r.top - 18)) });
  }, [open, phone, anchor, width]);

  if (phone) return <Sheet open={open} onOpenChange={onOpenChange} title={title} description={description}>{children}</Sheet>;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40" />
        <DialogPrimitive.Content
          onCloseAutoFocus={(e) => { e.preventDefault(); anchor.current?.focus(); }}
          style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width, maxHeight: pos?.maxH, visibility: pos ? "visible" : "hidden" }}
          className={cn("pop fixed z-50 overflow-y-auto overscroll-contain rounded-card border border-line bg-surface p-1.5 shadow-popover outline-none")}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{description ?? title}</DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** One choice in a Picker: a title, a one-line explanation, a check when it is the current one. 44 px tall at least. */
export const PickerOption = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { title: string; hint?: string; checked?: boolean }>(function PickerOption({ title, hint, checked, className, ...p }, ref) {
  return (
    <button ref={ref} type="button" aria-pressed={checked} className={cn("press flex min-h-11 w-full items-start gap-2.5 rounded-control px-2.5 py-2 text-left hover:bg-hover focus-visible:bg-hover disabled:cursor-not-allowed disabled:opacity-50", className)} {...p}>
      <span className="min-w-0 flex-1"><span className="block text-base font-medium text-fg">{title}</span>{hint && <span className="mt-0.5 block text-sm leading-snug text-fg-subtle">{hint}</span>}</span>
      {checked && <span aria-hidden className="mt-0.5 text-accent">&#10003;</span>}
    </button>
  );
});
