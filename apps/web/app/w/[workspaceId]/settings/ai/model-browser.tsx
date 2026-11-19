"use client";
import * as React from "react";
import { Check, Search } from "lucide-react";
import { endpoints, type AiCapability, type AiProviderDto, type OpenRouterModelDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatMicro } from "@/lib/ai-money";

export const MAX_ENABLED = 50;
const SHOWN = 150;
/** What a provider keeps per enabled model (the shape PUT /ai/providers/:provider takes in modelPrices). */
export type Picked = Record<string, { inputMicroPer1M: number; outputMicroPer1M: number; capabilities?: AiCapability[]; contextLength?: number; supports?: { tools: boolean; structuredOutput: boolean } }>;

export type ModelRow = { id: string; name: string; maker: string; caps: AiCapability[]; inMicro: number; outMicro: number; entry: Picked[string] };

const entryOf = (m: OpenRouterModelDto): Picked[string] => ({
  inputMicroPer1M: m.inputMicroPer1M, outputMicroPer1M: m.outputMicroPer1M, capabilities: m.capabilities.filter((c) => c !== "text"), ...(m.contextLength ? { contextLength: m.contextLength } : {}), supports: m.supports,
});
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const makerOf = (id: string) => (id.includes("/") ? cap1(id.split("/")[0]!) : "Other");

export const ABILITY: [AiCapability, string][] = [["vision", "Images"], ["document", "Documents"], ["transcription", "Audio"]];
/** Ability tags for a model. Text is implied, so a model with nothing else reads "Text only". */
export function AbilityTags({ caps }: { caps: readonly string[] }) {
  const tags = ABILITY.filter(([c]) => caps.includes(c));
  return <span className="flex flex-wrap gap-1.5">{tags.length === 0 ? <Badge tone="neutral">Text only</Badge> : tags.map(([c, l]) => <Badge key={c} tone="accent">{l}</Badge>)}</span>;
}
export const priceText = (i: number, o: number) => (i === 0 && o === 0 ? "No cost" : `$${formatMicro(i)} in / $${formatMicro(o)} out per 1M`);

/**
 * The model browser for one job. OpenRouter: the live list the server fetched (prices and abilities UNVERIFIED, never checked against the live service). Other providers: their built-in models.
 * Models that cannot do the job are hidden by default; with the box off they are shown but cannot be picked.
 */
export function ModelBrowser({ open, onOpenChange, ...rest }: { open: boolean; onOpenChange: (o: boolean) => void } & Omit<BodyProps, "onClose">) {
  return <Dialog open={open} onOpenChange={onOpenChange}>{open && <Body {...rest} onClose={() => onOpenChange(false)} />}</Dialog>;
}

type BodyProps = {
  workspaceId: string; provider: AiProviderDto; title: string; needs: AiCapability; current: string | null;
  /** Make the model usable and assign it. Returns an error message, or null when done. */
  onChoose: (row: ModelRow) => Promise<string | null>; onClose: () => void;
};

function Body({ workspaceId, provider, title, needs, current, onChoose, onClose }: BodyProps) {
  const gateway = provider.id === "openrouter";
  const [state, setState] = React.useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; items: OpenRouterModelDto[]; syncedAt: string; mock: boolean }>(gateway ? { kind: "loading" } : { kind: "ready", items: [], syncedAt: "", mock: false });
  const [text, setText] = React.useState("");
  const [filters, setFilters] = React.useState<AiCapability[]>([]);
  const [sort, setSort] = React.useState<"maker" | "price" | "name">("maker");
  const [hide, setHide] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.listOpenRouterModels, { params: { workspaceId } });
    setState(r.ok ? { kind: "ready", items: r.data.items, syncedAt: r.data.syncedAt, mock: r.data.mock } : { kind: "error", message: errorMessage(r.error) });
  }, [workspaceId]);
  React.useEffect(() => { if (gateway) void load(); }, [gateway, load]); // eslint-disable-line react-hooks/set-state-in-effect

  const used = Object.keys(provider.modelPrices).length;
  const rows = React.useMemo<ModelRow[]>(() => {
    if (state.kind !== "ready") return [];
    if (!gateway) return provider.models.map((m) => ({ id: m.id, name: m.label, maker: provider.label, caps: m.capabilities ?? ["text"], inMicro: m.inputMicroPer1M, outMicro: m.outputMicroPer1M, entry: { inputMicroPer1M: m.inputMicroPer1M, outputMicroPer1M: m.outputMicroPer1M } }));
    const listed = state.items.map((m) => ({ id: m.id, name: m.name, maker: makerOf(m.id), caps: m.capabilities, inMicro: m.inputMicroPer1M, outMicro: m.outputMicroPer1M, entry: entryOf(m) }));
    const ids = new Set(listed.map((r) => r.id));
    // Models already enabled stay visible even when the live list no longer carries them.
    const extra = provider.models.filter((m) => !ids.has(m.id)).map((m) => ({ id: m.id, name: m.label, maker: makerOf(m.id), caps: m.capabilities ?? ["text" as const], inMicro: m.inputMicroPer1M, outMicro: m.outputMicroPer1M, entry: provider.modelPrices[m.id] ?? { inputMicroPer1M: m.inputMicroPer1M, outputMicroPer1M: m.outputMicroPer1M } }));
    return [...listed, ...extra];
  }, [state, gateway, provider]);

  const q = text.trim().toLowerCase();
  const matched = rows.filter((r) => (!q || `${r.id} ${r.name} ${r.maker}`.toLowerCase().includes(q)) && filters.every((f) => r_has(r, f)));
  const able = matched.filter((r) => r_has(r, needs));
  const hidden = hide ? matched.length - able.length : 0;
  const shownAll = (hide ? able : matched).slice().sort(sort === "price" ? (a, b) => a.inMicro + a.outMicro - (b.inMicro + b.outMicro) || a.name.localeCompare(b.name) : sort === "name" ? (a, b) => a.name.localeCompare(b.name) : (a, b) => a.maker.localeCompare(b.maker) || a.name.localeCompare(b.name));
  const shown = shownAll.slice(0, SHOWN);
  const groups = sort === "maker" ? [...new Set(shown.map((r) => r.maker))].map((m) => [m, shown.filter((r) => r.maker === m)] as const) : [["", shown] as const];

  async function choose(row: ModelRow) {
    setError(null); setBusy(row.id);
    const msg = await onChoose(row);
    setBusy(null);
    if (msg) setError(msg); else onClose();
  }
  const toggle = (c: AiCapability) => setFilters((f) => (f.includes(c) ? f.filter((x) => x !== c) : [...f, c]));
  const line = `Showing ${hide ? able.length : matched.length} of ${matched.length}${hidden > 0 ? `, ${hidden} hidden` : ""}.`;

  return (
    <DialogContent title={title} description="Choosing a model turns it on for this workspace and uses it for this job. Prices are indicative, in USD." className="md:max-w-2xl max-md:h-dvh max-md:max-h-none max-md:rounded-none">
      <div className="flex flex-col gap-3">
        {state.kind === "loading" && <div role="status" aria-label="Loading models" className="flex flex-col gap-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
        {state.kind === "error" && <ErrorState title="Could not load models" description={state.message} onRetry={() => { setState({ kind: "loading" }); void load(); }} />}
        {state.kind === "ready" && (
          <>
            {state.mock && <Alert tone="warning">MOCK list: a fixed offline list, not OpenRouter&apos;s real models.</Alert>}
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
              <Input type="search" aria-label="Search models" placeholder="Search by name or maker" autoComplete="off" className="pl-8" value={text} onChange={(e) => setText(e.target.value)} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by ability">
                {ABILITY.map(([c, l]) => <Button key={c} type="button" size="sm" variant={filters.includes(c) ? "primary" : "secondary"} aria-pressed={filters.includes(c)} onClick={() => toggle(c)}>{l}</Button>)}
              </div>
              <label className="ml-auto flex items-center gap-2 text-sm text-fg-muted">Sort
                <Select aria-label="Sort models" wrapperClassName="w-44" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                  <option value="maker">By maker</option><option value="price">Price, low to high</option><option value="name">Name</option>
                </Select>
              </label>
            </div>
            <Checkbox label="Hide models that cannot do this job" checked={hide} onChange={(e) => setHide(e.target.checked)} />
            <p className="text-sm text-fg-muted" role="status" aria-live="polite">{line}{shownAll.length > SHOWN ? ` Only the first ${SHOWN} are listed: refine the search.` : ""}</p>
            {error && <Alert tone="error">{error}</Alert>}
            {shown.length === 0
              ? <EmptyState icon={Search} title="No models match" description="Change the search, or turn a filter off." />
              : (
                <div className="flex flex-col gap-1 md:max-h-[42dvh] md:overflow-y-auto" role="group" aria-label="Models">
                  {groups.map(([maker, list]) => (
                    <div key={maker || "all"} className="flex flex-col gap-1">
                      {maker && <h3 className="sticky top-0 bg-surface py-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{maker}</h3>}
                      {list.map((m) => {
                        const can = r_has(m, needs);
                        const on = current === m.id;
                        const full = gateway && !provider.modelPrices[m.id] && used >= MAX_ENABLED;
                        return (
                          <button key={m.id} type="button" aria-pressed={on} disabled={!can || full || busy !== null} onClick={() => void choose(m)}
                            className={cn("press flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-control border px-3 py-2 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:min-h-11", on ? "border-accent bg-accent-subtle" : "border-line-card")}>
                            <span className="min-w-0 flex-1 basis-48">
                              <span className="block break-words text-sm font-medium text-fg">{m.name}</span>
                              <span className="block break-all text-xs text-fg-subtle">{m.id}{!can ? " · cannot do this job" : full ? " · limit of 50 models reached" : ""}</span>
                            </span>
                            <AbilityTags caps={m.caps} />
                            <span className="text-xs text-fg-muted">{priceText(m.inMicro, m.outMicro)}</span>
                            <span className="inline-flex size-5 items-center justify-center">{busy === m.id ? <span role="status" className="text-xs text-fg-muted">Saving</span> : on ? <><Check aria-hidden className="size-4 text-accent" /><span className="sr-only">Selected</span></> : null}</span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            <p className="text-xs text-fg-subtle">
              {gateway ? <>Models in use: {used} of {MAX_ENABLED}. {state.syncedAt ? `List synced ${new Date(state.syncedAt).toLocaleString()}. ` : ""}Prices and abilities are read from OpenRouter&apos;s documented list and not yet tested with a real request.</> : "Prices and abilities come from the built-in list for this provider."}
            </p>
          </>
        )}
      </div>
    </DialogContent>
  );
}

const r_has = (r: ModelRow, c: AiCapability) => c === "text" || r.caps.includes(c);
