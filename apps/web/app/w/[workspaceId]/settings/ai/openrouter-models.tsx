"use client";
import * as React from "react";
import { Search } from "lucide-react";
import { endpoints, type OpenRouterModelDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/form-controls";
import { Input } from "@/components/ui/input";
import { Dialog, DialogActions, DialogContent } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatMicro } from "@/lib/ai-money";

export const MAX_ENABLED = 50;
const SHOWN = 100;
/** What the form keeps per enabled model (the shape PUT /ai/providers/openrouter takes). */
export type Picked = Record<string, { inputMicroPer1M: number; outputMicroPer1M: number; capabilities?: ("text" | "vision" | "transcription" | "document")[]; contextLength?: number; supports?: { tools: boolean; structuredOutput: boolean } }>;

const entryOf = (m: OpenRouterModelDto): Picked[string] => ({
  inputMicroPer1M: m.inputMicroPer1M, outputMicroPer1M: m.outputMicroPer1M, capabilities: m.capabilities.filter((c) => c !== "text"), ...(m.contextLength ? { contextLength: m.contextLength } : {}), supports: m.supports,
});
const price = (i: number, o: number) => `${formatMicro(i)} in, ${formatMicro(o)} out per 1M tokens (USD)`;
const ctxLabel = (n: number | null | undefined) => (n ? `${n.toLocaleString("en-US")} tokens context` : "context unknown");

/** Enabled models: pick up to 50 from the browser, choose the default. Prices and capabilities are UNVERIFIED (read from OpenRouter's documented list, never tested against the live service). */
export function OpenRouterModels({ workspaceId, picked, onPicked, defaultModel, onDefault, disabled }: { workspaceId: string; picked: Picked; onPicked: (p: Picked) => void; defaultModel: string; onDefault: (id: string) => void; disabled: boolean }) {
  const [open, setOpen] = React.useState(false);
  const ids = Object.keys(picked);
  return (
    <div className="flex flex-col gap-3 sm:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-fg">Enabled models <span className="font-normal text-fg-muted">({ids.length} of {MAX_ENABLED})</span></p>
          <p className="text-xs text-fg-subtle">Only enabled models can be used. The default is used for reply suggestions.</p>
        </div>
        <Button type="button" variant="secondary" size="sm" disabled={disabled} onClick={() => setOpen(true)}>Browse models</Button>
      </div>
      {ids.length === 0
        ? <EmptyState icon={Search} title="No models enabled" description="Browse OpenRouter's models and enable the ones you want to use." />
        : (
          <ul className="flex flex-col gap-2" aria-label="Enabled models">
            {ids.map((id) => {
              const m = picked[id]!;
              return (
                <li key={id} className="flex flex-wrap items-center gap-2 rounded-control border border-line-card px-3 py-2">
                  <label className="flex min-w-0 flex-1 basis-56 items-start gap-2 text-sm text-fg">
                    <input type="radio" name="or-default" className="mt-1" checked={defaultModel === id} disabled={disabled} onChange={() => onDefault(id)} aria-label={`Use ${id} as the default`} />
                    <span className="min-w-0 break-words">{id}<span className="block text-xs text-fg-subtle">{price(m.inputMicroPer1M, m.outputMicroPer1M)}, {ctxLabel(m.contextLength)}</span></span>
                  </label>
                  <span className="flex flex-wrap gap-1.5">{defaultModel === id && <Badge tone="success">Default</Badge>}{m.capabilities?.includes("vision") && <Badge tone="neutral">Vision</Badge>}{m.supports?.tools && <Badge tone="neutral">Tools</Badge>}</span>
                  <Button type="button" variant="ghost" size="sm" disabled={disabled} aria-label={`Remove ${id}`} onClick={() => { const { [id]: _drop, ...rest } = picked; onPicked(rest); if (defaultModel === id) onDefault(Object.keys(rest)[0] ?? ""); }}>Remove</Button>
                </li>
              );
            })}
          </ul>
        )}
      <Dialog open={open} onOpenChange={setOpen}>
        {open && <Browser workspaceId={workspaceId} picked={picked} onPicked={onPicked} onDefault={onDefault} defaultModel={defaultModel} onClose={() => setOpen(false)} />}
      </Dialog>
    </div>
  );
}

function Browser({ workspaceId, picked, onPicked, defaultModel, onDefault, onClose }: { workspaceId: string; picked: Picked; onPicked: (p: Picked) => void; defaultModel: string; onDefault: (id: string) => void; onClose: () => void }) {
  const [state, setState] = React.useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; items: OpenRouterModelDto[]; syncedAt: string; mock: boolean }>({ kind: "loading" });
  const [text, setText] = React.useState("");
  const [vision, setVision] = React.useState(false);
  const [tools, setTools] = React.useState(false);
  const load = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.listOpenRouterModels, { params: { workspaceId } });
    setState(r.ok ? { kind: "ready", items: r.data.items, syncedAt: r.data.syncedAt, mock: r.data.mock } : { kind: "error", message: errorMessage(r.error) });
  }, [workspaceId]);
  React.useEffect(() => { void load(); }, [load]); // eslint-disable-line react-hooks/set-state-in-effect

  const count = Object.keys(picked).length;
  function toggle(m: OpenRouterModelDto, on: boolean) {
    if (on) { if (count >= MAX_ENABLED) return; onPicked({ ...picked, [m.id]: entryOf(m) }); if (!defaultModel) onDefault(m.id); return; }
    const { [m.id]: _drop, ...rest } = picked;
    onPicked(rest);
    if (defaultModel === m.id) onDefault(Object.keys(rest)[0] ?? "");
  }
  const matches = state.kind === "ready"
    ? state.items.filter((m) => (!text.trim() || `${m.id} ${m.name}`.toLowerCase().includes(text.trim().toLowerCase())) && (!vision || m.capabilities.includes("vision")) && (!tools || m.supports.tools))
    : [];

  return (
    <DialogContent title="Browse OpenRouter models" description="Prices are per 1M tokens in USD. Capabilities are read from OpenRouter's list and are UNVERIFIED: not tested against the live service." className="md:max-w-2xl">
      <div className="flex flex-col gap-3">
        {state.kind === "loading" && <div role="status" aria-label="Loading models" className="flex flex-col gap-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
        {state.kind === "error" && <ErrorState title="Could not load models" description={state.message} onRetry={() => { setState({ kind: "loading" }); void load(); }} />}
        {state.kind === "ready" && (
          <>
            {state.mock && <Alert tone="warning">MOCK list: a fixed offline list, not OpenRouter's real models.</Alert>}
            <Input aria-label="Search models" placeholder="Search by name or id" value={text} onChange={(e) => setText(e.target.value)} />
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Capability filters">
              <Button type="button" size="sm" variant={vision ? "primary" : "secondary"} aria-pressed={vision} onClick={() => setVision(!vision)}>Vision</Button>
              <Button type="button" size="sm" variant={tools ? "primary" : "secondary"} aria-pressed={tools} onClick={() => setTools(!tools)}>Tools</Button>
              <span className="ml-auto text-sm text-fg-muted" role="status" aria-live="polite">{count} of {MAX_ENABLED} selected</span>
            </div>
            <p className="text-xs text-fg-subtle">List synced {new Date(state.syncedAt).toLocaleString()}. {matches.length} model{matches.length === 1 ? "" : "s"}{matches.length > SHOWN ? `, showing the first ${SHOWN}: refine the search` : ""}.</p>
            {matches.length === 0
              ? <EmptyState icon={Search} title="No models match" description="Change the search or turn a filter off." />
              : (
                <ul className="flex max-h-[50dvh] flex-col gap-1 overflow-y-auto" aria-label="Models">
                  {matches.slice(0, SHOWN).map((m) => {
                    const on = !!picked[m.id];
                    return (
                      <li key={m.id} className="rounded-control border border-line-card px-3 py-2">
                        <Checkbox label={m.id} checked={on} disabled={!on && count >= MAX_ENABLED} onChange={(e) => toggle(m, e.target.checked)} />
                        <p className="ml-6 text-xs text-fg-subtle">{m.name}: {price(m.inputMicroPer1M, m.outputMicroPer1M)}, {ctxLabel(m.contextLength)}</p>
                        <span className="ml-6 mt-1 flex flex-wrap gap-1.5">{m.capabilities.includes("vision") && <Badge tone="neutral">Vision</Badge>}{m.supports.tools && <Badge tone="neutral">Tools</Badge>}{m.supports.structuredOutput && <Badge tone="neutral">Structured output</Badge>}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
          </>
        )}
        <DialogActions><Button type="button" variant="primary" onClick={onClose}>Done</Button></DialogActions>
      </div>
    </DialogContent>
  );
}
