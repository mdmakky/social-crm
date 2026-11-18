"use client";
import * as React from "react";
import { Inbox } from "lucide-react";
import type { ContactStageCounts, StageDto } from "@crm/contracts";
import { cn } from "@/lib/cn";
import { stageHue } from "@/lib/contact-lead";

const n = (x: number) => x.toLocaleString("en");
const dot = (s: Pick<StageDto, "kind" | "position">) => { const h = stageHue(s); return h === "muted" ? "var(--fg-disabled)" : `var(--hue-${h}-dot)`; };

/**
 * One line of stages (design A3): "All" first, then every configured stage with its count, and a thin proportion bar beneath.
 * A tap filters; a second tap on the active stage clears it. Past the width it scrolls sideways (snap, edge fade, active stage centred) and never widens the page.
 */
export function StageStrip({ stages, counts, activeId, enquiries, onSelect, onSelectEnquiries }: { stages: StageDto[]; counts: ContactStageCounts | null; activeId?: string; /** the Enquiries tab is selected */ enquiries?: boolean; onSelect: (id: string | undefined) => void; onSelectEnquiries?: () => void }) {
  const box = React.useRef<HTMLDivElement>(null);
  const [fade, setFade] = React.useState({ l: false, r: false });
  const countOf = (id: string) => counts?.items.find((x) => x.stageId === id)?.count ?? 0;
  const total = counts?.total ?? 0;

  const measure = React.useCallback(() => {
    const el = box.current;
    if (el) setFade({ l: el.scrollLeft > 4, r: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  React.useEffect(() => {
    measure();
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, stages.length]);
  // Keep the active stage in view (also after Back or a saved view). Scrolls the strip only, never the page.
  React.useEffect(() => {
    const el = box.current;
    const b = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!el || !b) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: Math.max(0, b.offsetLeft - (el.clientWidth - b.offsetWidth) / 2), behavior: reduce ? "auto" : "smooth" });
  }, [activeId, enquiries]);

  const mask = fade.l || fade.r ? `linear-gradient(to right, ${fade.l ? "transparent, #000 28px" : "#000, #000"}, ${fade.r ? "#000 calc(100% - 28px), transparent" : "#000, #000"})` : undefined;
  const item = (on: boolean) => cn("press relative inline-flex h-11 shrink-0 snap-start items-center justify-center gap-2 whitespace-nowrap border-r border-line-card px-4 text-base font-medium last:border-r-0 md:h-10", on ? "bg-accent-subtle text-accent-fg shadow-[inset_0_-2px_0_var(--accent)]" : "text-fg-muted hover:bg-hover hover:text-fg");
  const bar = stages.filter((s) => countOf(s.id) > 0);

  return (
    <div className="mb-3">
      <div className="rounded-card border border-line bg-surface">
        <div ref={box} onScroll={measure} data-scroll="allowed" role="group" aria-label="Filter by stage" style={{ scrollSnapType: "x proximity", scrollbarWidth: "none", maskImage: mask, WebkitMaskImage: mask }} className="flex overflow-x-auto overscroll-x-contain rounded-card [&::-webkit-scrollbar]:hidden">
          {onSelectEnquiries && (
            <>
              {/* "Before New": a different fill, an icon and a heavier divider keep Enquiries visibly apart from the stages (people without a phone number have no stage). */}
              <button type="button" className={cn(item(!!enquiries), "gap-1.5 border-r-0", !enquiries && "bg-canvas")} aria-pressed={!!enquiries} onClick={onSelectEnquiries}><Inbox className="size-4 shrink-0" aria-hidden />Enquiries{counts && <>{" "}<span data-testid="enquiry-count" className="tnum font-semibold text-fg">{n(counts.enquiryCount)}</span></>}</button>
              <span aria-hidden className="w-0.5 shrink-0 self-stretch bg-line-strong" />
            </>
          )}
          <button type="button" className={cn(item(!activeId && !enquiries), "min-w-24 flex-1")} aria-pressed={!activeId && !enquiries} onClick={() => onSelect(undefined)}>All{counts && <>{" "}<span className="tnum font-semibold text-fg">{n(total)}</span></>}</button>
          {stages.map((s) => {
            const on = activeId === s.id && !enquiries;
            return (
              <button key={s.id} type="button" title={s.name} className={cn(item(on), "flex-1")} aria-pressed={on} onClick={() => onSelect(on ? undefined : s.id)}>
                <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: dot(s) }} />
                <span className="max-w-[10rem] truncate">{s.name}</span>
                {counts && <>{" "}<span className="tnum font-semibold text-fg">{n(countOf(s.id))}</span></>}
              </button>
            );
          })}
        </div>
      </div>
      {total > 0 && !enquiries && (
        <div aria-hidden className="mt-2 flex h-1 gap-0.5 overflow-hidden rounded-full">
          {bar.map((s) => <span key={s.id} className="min-w-0.5 opacity-75" style={{ flex: countOf(s.id), background: dot(s) }} />)}
        </div>
      )}
    </div>
  );
}
