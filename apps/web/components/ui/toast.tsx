"use client";
import * as React from "react";
import { CheckCircle2, AlertTriangle, X } from "lucide-react";
import { cn } from "@/lib/cn";

type Tone = "success" | "error";
type Item = { id: number; text: string; tone: Tone };
const Ctx = React.createContext<(text: string, tone?: Tone) => void>(() => {});
export const useToast = () => React.useContext(Ctx);

/** Polite live region: success toasts are announced without stealing focus; errors use role=alert. Auto-dismiss after 5 s (errors 8 s). */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<Item[]>([]);
  const n = React.useRef(0);
  const push = React.useCallback((text: string, tone: Tone = "success") => {
    const id = ++n.current;
    setItems((x) => [...x.slice(-3), { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), tone === "error" ? 8000 : 5000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
        {items.map((i) => (
          <div key={i.id} role={i.tone === "error" ? "alert" : "status"} className={cn("pop pointer-events-auto flex max-w-md items-start gap-2 rounded-lg border bg-surface px-3 py-2 text-base shadow-popover", i.tone === "error" ? "border-danger-bg text-danger-fg" : "border-line text-fg")}>
            {i.tone === "error" ? <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-fg" aria-hidden />}
            <span>{i.text}</span>
            <button type="button" aria-label="Dismiss" className="-mr-1 ml-1 rounded p-0.5 text-fg-subtle hover:bg-hover" onClick={() => setItems((x) => x.filter((y) => y.id !== i.id))}><X className="size-3.5" aria-hidden /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
