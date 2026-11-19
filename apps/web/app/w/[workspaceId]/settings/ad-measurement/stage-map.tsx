"use client";
import * as React from "react";
import { Check, ChevronDown, Plus, Trash2, Zap } from "lucide-react";
import { CAPI_CUSTOM_EVENT_NAME, endpoints, META_STANDARD_EVENTS, MAX_CAPI_MAPPINGS_PER_DATASET, type CapiDatasetDto, type CapiMappingDto, type CreateCapiMappingBody, type PipelineDto, type StageDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Picker, PickerOption } from "@/components/ui/picker";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Alert, ErrorState } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";
import { cn } from "@/lib/cn";
import { defaultPipeline, orderedStages, stageHue } from "@/lib/contact-lead";
import { CURRENCIES, fromMinor, toMinor } from "@/lib/leads";

/** One line per event Meta documents, in plain words. The first seven are the ones people reach for. */
const DESC: Record<string, string> = {
  Lead: "Someone showed interest", Contact: "You got in touch", Schedule: "A time was booked", SubmitApplication: "They applied", CompleteRegistration: "They signed up", InitiateCheckout: "They started checkout", Purchase: "A sale. Needs a value",
};
const FIRST = Object.keys(DESC);
const MORE = META_STANDARD_EVENTS.filter((n) => !FIRST.includes(n));
const isStandard = (n: string) => (META_STANDARD_EVENTS as readonly string[]).includes(n);

type Row = { key: string; kind: "created" | "stage" | "won" | "lost"; stage?: StageDto; stages?: StageDto[]; trigger: CapiMappingDto["triggerType"]; stageId: string | null; match: (m: CapiMappingDto) => boolean };
type ValueKind = "ask" | "skip" | "fixed" | "none";
const valueKindOf = (m: CapiMappingDto): ValueKind => (m.valueMode === "fixed" ? "fixed" : m.valueMode === "none" ? "none" : m.askForValue ? "ask" : "skip");
const dotOf = (s: Pick<StageDto, "kind" | "position">) => { const h = stageHue(s); return h === "muted" ? "var(--fg-disabled)" : `var(--hue-${h}-dot)`; };
const pillTone = (s: Pick<StageDto, "kind" | "position">) => { const h = stageHue(s); return h === "muted" ? "stone" as const : (`hue-${h}` as const); };

function StagePill({ stage, className }: { stage: Pick<StageDto, "kind" | "position" | "name">; className?: string }) {
  return <Badge tone={pillTone(stage)} className={cn("h-6 max-w-full gap-1.5 px-2.5 text-sm", className)} title={stage.name}><span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: dotOf(stage) }} /><span className="truncate">{stage.name}</span></Badge>;
}

const bodyOf = (m: CapiMappingDto, over: Partial<CreateCapiMappingBody> = {}): CreateCapiMappingBody => ({
  triggerType: m.triggerType, stageId: m.stageId, eventName: m.eventName, valueMode: m.valueMode, fixedValueMinor: m.fixedValueMinor, currency: m.currency, enabled: m.enabled, askForValue: m.askForValue, ...over,
});
const valueBody = (kind: ValueKind, fixed?: { minor: number; currency: string }): Pick<CreateCapiMappingBody, "valueMode" | "fixedValueMinor" | "currency" | "askForValue"> =>
  kind === "fixed" ? { valueMode: "fixed", fixedValueMinor: fixed!.minor, currency: fixed!.currency, askForValue: false } : kind === "none" ? { valueMode: "none", fixedValueMinor: null, currency: null, askForValue: false } : { valueMode: "lead_value", fixedValueMinor: null, currency: null, askForValue: kind === "ask" };

/**
 * The stage map (D330): one row per moment in the pipeline, each with the event it sends. Stages come from Settings > Lead stages, so a renamed, added or removed stage changes the map by itself.
 * One event per row here; if the data holds more rules on the same moment the first shows and "+N more" lists all of them, so nothing is hidden. Rules that sit on no row are listed under "Other rules".
 * Every change goes through the normal rules API (create, update, delete) and shows at once; if the server says no, the row goes back and says why, with a Retry.
 */
export function StageMap({ workspaceId, dataset, pipelines, canManage }: { workspaceId: string; dataset: CapiDatasetDto; pipelines: PipelineDto[]; canManage: boolean }) {
  const [rules, setRules] = React.useState<CapiMappingDto[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<Set<string>>(new Set());
  const [errs, setErrs] = React.useState<Record<string, { message: string; retry: () => void }>>({});
  const [saved, setSaved] = React.useState(false);
  const rulesRef = React.useRef<CapiMappingDto[] | null>(null);
  React.useEffect(() => { rulesRef.current = rules; });
  const params = { workspaceId, datasetId: dataset.id };

  const load = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.listCapiMappings, { params: { workspaceId, datasetId: dataset.id } });
    if (!r.ok) { setLoadError(errorMessage(r.error)); return false; }
    setLoadError(null); setRules(r.data.items); return true;
  }, [workspaceId, dataset.id]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  React.useEffect(() => { void load(); }, [load]); // the parent remounts this map per dataset, so state starts empty
  React.useEffect(() => { if (!saved) return; const t = setTimeout(() => setSaved(false), 2500); return () => clearTimeout(t); }, [saved]);

  const pipeline = defaultPipeline(pipelines);
  const stages = orderedStages(pipeline);
  const openStages = stages.filter((s) => s.kind === "open");
  const wonStages = stages.filter((s) => s.kind === "won");
  const lostStages = stages.filter((s) => s.kind === "lost");
  const currency0 = pipeline?.defaultCurrency ?? "USD";

  const rows: Row[] = [
    { key: "created", kind: "created", trigger: "lead_created", stageId: null, match: (m) => m.triggerType === "lead_created" },
    ...openStages.map((s): Row => ({ key: s.id, kind: "stage", stage: s, trigger: "lead_stage_entered", stageId: s.id, match: (m) => m.triggerType === "lead_stage_entered" && m.stageId === s.id })),
    ...(wonStages.length ? [{ key: "won", kind: "won", stages: wonStages, trigger: "lead_won", stageId: null, match: (m: CapiMappingDto) => m.triggerType === "lead_won" } as Row] : []),
    ...(lostStages.length ? [{ key: "lost", kind: "lost", stages: lostStages, trigger: "lead_lost", stageId: null, match: (m: CapiMappingDto) => m.triggerType === "lead_lost" } as Row] : []),
  ];
  const placed = new Set((rules ?? []).filter((m) => rows.some((r) => r.match(m))).map((m) => m.id));
  const others = (rules ?? []).filter((m) => !placed.has(m.id));
  const stageName = (id: string | null) => { for (const p of pipelines) { const s = p.stages.find((x) => x.id === id); if (s) return s.name; } return "a stage that no longer exists"; };

  /** Run one server change. `optimistic` updates the screen first; on failure the server's list comes back and the row shows the reason with Retry. */
  async function run(rowKey: string, optimistic: (list: CapiMappingDto[]) => CapiMappingDto[], call: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    setErrs((e) => { const { [rowKey]: _drop, ...rest } = e; return rest; });
    setBusy((b) => new Set(b).add(rowKey));
    setRules((l) => (l ? optimistic(l) : l));
    const r = await call();
    if (r.ok) { await load(); setSaved(true); }
    else { await load(); setErrs((e) => ({ ...e, [rowKey]: { message: r.message, retry: () => void 0 } })); }
    setBusy((b) => { const n = new Set(b); n.delete(rowKey); return n; });
    return r.ok;
  }
  const retryable = (rowKey: string, fn: () => Promise<boolean>) => {
    void fn().then((ok) => { if (!ok) setErrs((e) => (e[rowKey] ? { ...e, [rowKey]: { ...e[rowKey]!, retry: () => void retryable(rowKey, fn) } } : e)); });
  };
  const fail = (e: unknown) => ({ ok: false as const, message: errorMessage(e as never) });

  const upsert = (row: Row, primary: CapiMappingDto | undefined, body: CreateCapiMappingBody) => {
    const fn = () => {
      const tmp: CapiMappingDto = { id: primary?.id ?? `tmp-${row.key}`, datasetId: dataset.id, createdAt: "", updatedAt: "", ...body };
      if (!primary && (rulesRef.current?.length ?? 0) >= MAX_CAPI_MAPPINGS_PER_DATASET) { setErrs((e) => ({ ...e, [row.key]: { message: "A dataset can have at most 50 rules.", retry: () => void 0 } })); return Promise.resolve(false); }
      return run(row.key, (l) => (primary ? l.map((m) => (m.id === primary.id ? tmp : m)) : [...l, tmp]), async () => {
        const r = primary ? await browserApi.call(endpoints.updateCapiMapping, { params: { ...params, mappingId: primary.id }, body }) : await browserApi.call(endpoints.createCapiMapping, { params, body });
        return r.ok ? { ok: true as const } : fail(r.error);
      });
    };
    retryable(row.key, fn);
  };
  const removeRule = (rowKey: string, m: CapiMappingDto) => {
    const fn = () => run(rowKey, (l) => l.filter((x) => x.id !== m.id), async () => {
      const r = await browserApi.call(endpoints.deleteCapiMapping, { params: { ...params, mappingId: m.id } });
      return r.ok ? { ok: true as const } : fail(r.error);
    });
    retryable(rowKey, fn);
  };
  const toggleRule = (rowKey: string, m: CapiMappingDto, enabled: boolean) => upsert({ key: rowKey } as Row, m, bodyOf(m, { enabled }));

  const active = rows.map((r) => ({ r, m: (rules ?? []).find(r.match) })).filter((x): x is { r: Row; m: CapiMappingDto } => !!x.m && x.m.enabled);
  const labelOf = (r: Row) => (r.kind === "created" ? "new leads" : r.kind === "stage" ? r.stage!.name : r.kind === "won" ? "won leads" : "lost leads");

  return (
    <div className="@container" data-testid="stage-map">
      {loadError ? <div className="p-4"><ErrorState title="Could not load the event map" description={loadError} onRetry={() => void load()} /></div> : rules === null ? (
        <div role="status" aria-label="Loading the event map" className="flex flex-col gap-2 p-5"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
      ) : (
        <>
          <div aria-label="What gets sent" role="group" className="flex flex-wrap items-center gap-2 border-y border-line-card px-5 py-3.5">
            <span className="mr-1 text-sm font-semibold text-fg-subtle">What gets sent</span>
            <span role="status" aria-live="polite" className="order-last ml-auto inline-flex min-w-[4.5rem] items-center justify-end gap-1 text-sm text-success-fg">{saved && <><Check className="size-4" aria-hidden />Saved</>}</span>
            {active.length === 0 ? <span className="text-sm text-fg-subtle">Nothing yet. Add an event to a stage below.</span> : active.map(({ r, m }) => (
              <span key={r.key} className="inline-flex min-h-8 max-w-full items-center gap-2 rounded-full border border-line bg-surface py-0.5 pl-1 pr-2.5 text-sm font-semibold">
                {r.kind === "created" ? <Badge tone="accent" className="h-6 px-2.5 text-sm">Lead added</Badge> : <StagePill stage={r.kind === "stage" ? r.stage! : r.stages![0]!} />}
                <span aria-hidden className="text-fg-subtle">&rarr;</span><span className="sr-only">sends</span><b className="truncate font-semibold text-accent-fg">{m.eventName}</b>
              </span>
            ))}
          </div>
          {openStages.length === 0 && <p className="px-5 pt-3 text-sm text-fg-subtle">Your pipeline has no open stages yet. Add some under Settings, Lead stages.</p>}
          <ol className="py-2.5">
            {rows.map((r, i) => (
              <React.Fragment key={r.key}>
                {(r.kind === "won" || (r.kind === "lost" && !wonStages.length)) && <li aria-hidden className="flex items-center gap-3 px-5 pb-1 pt-3 text-xs font-semibold tracking-wide text-fg-subtle @3xl:pl-[4.25rem]"><span>FINAL STAGES</span><span className="h-px flex-1 bg-line-card" /></li>}
                <MapRow row={r} first={i === 0} last={i === rows.length - 1} matches={(rules ?? []).filter(r.match)} busy={busy.has(r.key)} err={errs[r.key]?.message ?? null} onRetry={errs[r.key]?.retry}
                  canManage={canManage} currency0={currency0} label={labelOf(r)}
                  onEvent={(ev) => {
                    const primary = (rules ?? []).find(r.match);
                    if (ev === null) { if (primary) removeRule(r.key, primary); return; }
                    const purchase = ev === "Purchase";
                    if (primary) upsert(r, primary, bodyOf(primary, { eventName: ev, enabled: true, ...(purchase && primary.valueMode === "none" ? valueBody("ask") : {}) }));
                    else upsert(r, undefined, { triggerType: r.trigger, stageId: r.stageId, eventName: ev, enabled: true, ...valueBody(purchase ? "ask" : "none") });
                  }}
                  onValue={(kind, fixed) => { const primary = (rules ?? []).find(r.match); if (primary) upsert(r, primary, bodyOf(primary, valueBody(kind, fixed))); }}
                  onEnabled={(v) => { const primary = (rules ?? []).find(r.match); if (primary) toggleRule(r.key, primary, v); }}
                  onToggleOne={(m, v) => toggleRule(r.key, m, v)} onRemoveOne={(m) => removeRule(r.key, m)} />
              </React.Fragment>
            ))}
          </ol>
          {others.length > 0 && (
            <section aria-labelledby="other-rules" className="border-t border-line-card px-5 py-3">
              <h3 id="other-rules" className="text-sm font-semibold text-fg">Other rules</h3>
              <p className="mb-2 text-sm text-fg-subtle">These do not match a row above (for example a stage that was removed or is in another pipeline). They still run while they are on.</p>
              <ul className="flex flex-col gap-1.5">
                {others.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border border-line-card px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 basis-56 text-fg">{m.triggerType === "lead_stage_entered" ? `A lead enters ${stageName(m.stageId)}` : m.triggerType === "lead_created" ? "A lead is added" : m.triggerType === "lead_won" ? "A lead is won" : "A lead is lost"} <span aria-hidden>&rarr;</span><span className="sr-only">sends</span> <b className="font-medium">{m.eventName}</b></span>
                    {canManage && <Switch label={`${m.enabled ? "On" : "Off"}: ${m.eventName} for ${m.triggerType === "lead_stage_entered" ? stageName(m.stageId) : m.triggerType}`} checked={m.enabled} onCheckedChange={(v) => toggleRule("other", m, v)} />}
                    {canManage && <Button size="sm" icon variant="ghost" aria-label={`Remove ${m.eventName} rule`} onClick={() => { if (window.confirm(`Remove this rule? It will stop sending ${m.eventName}.`)) removeRule("other", m); }}><Trash2 /></Button>}
                  </li>
                ))}
              </ul>
              {errs.other && <Alert tone="error" className="mt-2">{errs.other.message} <button type="button" className="underline" onClick={errs.other.retry}>Retry</button></Alert>}
            </section>
          )}
          <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 border-t border-line-card px-5 py-3.5 text-sm text-fg-subtle">
            <span>Stages come from Lead stages, so a new stage appears here by itself.</span>
            <span>Only leads who agreed to ad measurement are sent.</span>
          </div>
        </>
      )}
    </div>
  );
}

function MapRow({ row, first, last, matches, busy, err, onRetry, canManage, currency0, label, onEvent, onValue, onEnabled, onToggleOne, onRemoveOne }: {
  row: Row; first: boolean; last: boolean; matches: CapiMappingDto[]; busy: boolean; err: string | null; onRetry?: () => void; canManage: boolean; currency0: string; label: string;
  onEvent: (ev: string | null) => void; onValue: (k: ValueKind, fixed?: { minor: number; currency: string }) => void; onEnabled: (v: boolean) => void; onToggleOne: (m: CapiMappingDto, v: boolean) => void; onRemoveOne: (m: CapiMappingDto) => void;
}) {
  const m = matches[0];
  const evRef = React.useRef<HTMLButtonElement>(null);
  const valRef = React.useRef<HTMLButtonElement>(null);
  const moreRef = React.useRef<HTMLButtonElement>(null);
  const [evOpen, setEvOpen] = React.useState(false);
  const [valOpen, setValOpen] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const off = !!m && !m.enabled;
  const stagesText = row.stages?.map((s) => s.name).join(", ");
  const dis = !canManage || busy;

  const rail = row.kind === "created" ? <span className="grid size-[26px] place-items-center rounded-full bg-accent text-on-accent ring-[3px] ring-surface"><Plus className="size-4" aria-hidden /></span>
    : <i className="block size-3.5 rounded-full ring-[3px] ring-surface" style={{ background: dotOf(row.stage ?? row.stages![0]!), boxShadow: `0 0 0 3px var(--bg-surface), 0 0 0 4.5px ${dotOf(row.stage ?? row.stages![0]!)}` }} />;

  return (
    <li aria-busy={busy} className={cn("relative border-t border-line-card first:border-t-0 @3xl:border-t-0 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-2.5 px-4 py-3.5 @3xl:grid-cols-[30px_11rem_minmax(11.5rem,1fr)_minmax(15rem,1.1fr)_3.5rem] @3xl:px-5 @3xl:py-0 @3xl:min-h-[4.25rem]")}>
      <span aria-hidden className="relative hidden self-stretch @3xl:flex @3xl:items-center @3xl:justify-center">
        <span className={cn("absolute left-1/2 -ml-px w-0.5 bg-line", first ? "top-1/2" : "top-0", last ? "bottom-1/2" : "bottom-0")} />
        <span className="relative z-[1]">{rail}</span>
      </span>
      <div className="min-w-0">
        {row.kind === "created" ? <><p className="font-semibold text-fg">When a lead is added</p><p className="text-sm text-fg-subtle">Every new lead</p></> : row.kind === "stage" ? <StagePill stage={row.stage!} /> : (
          row.stages!.length === 1 ? <><StagePill stage={row.stages![0]!} /><p className="mt-0.5 text-sm text-fg-subtle">Final stage &middot; {row.kind}</p></> : (
            <><p className="font-semibold text-fg">When a lead is {row.kind}</p><p className="text-sm text-fg-subtle">Any of the {row.stages!.length} {row.kind} stages: {stagesText}. One rule covers them all.</p></>
          )
        )}
      </div>
      <div className="col-span-2 @3xl:col-span-1 @3xl:col-start-3">
        <div className="flex flex-wrap items-center gap-2">
          <button ref={evRef} type="button" disabled={!canManage} aria-haspopup="dialog" aria-expanded={evOpen} onClick={() => setEvOpen(true)}
            aria-label={m ? `Event for ${label}: ${m.eventName}. Change` : `Add event for ${label}`}
            className={cn("press inline-flex min-h-10 max-w-full items-center gap-2 rounded-xl border px-3 text-base font-bold pointer-coarse:min-h-11 disabled:cursor-default",
              m ? cn(off ? "border-line bg-hover text-fg-muted" : "border-accent/30 bg-accent-subtle text-accent-fg hover:border-accent", !isStandard(m.eventName) && "font-mono text-sm") : "border-dashed border-line-strong text-fg-subtle hover:border-accent hover:text-accent-fg")}>
            {m ? <Zap className="size-4 shrink-0" aria-hidden /> : <Plus className="size-4 shrink-0" aria-hidden />}
            <span className="truncate">{m ? m.eventName : "Add event"}</span>{m && canManage && <ChevronDown className="size-3.5 shrink-0" aria-hidden />}
          </button>
          {matches.length > 1 && (
            <button ref={moreRef} type="button" onClick={() => setMoreOpen(true)} aria-haspopup="dialog" aria-label={`${matches.length - 1} more ${matches.length === 2 ? "rule" : "rules"} for ${label}. Show`}
              className="press inline-flex min-h-8 items-center rounded-full border border-line px-2.5 text-sm font-medium text-fg-muted hover:bg-hover pointer-coarse:min-h-11">+{matches.length - 1} more</button>
          )}
        </div>
      </div>
      <div className="col-span-2 min-w-0 @3xl:col-span-1 @3xl:col-start-4">
        {m ? (
          <button ref={valRef} type="button" disabled={!canManage} aria-haspopup="dialog" aria-expanded={valOpen} onClick={() => setValOpen(true)} aria-label={`Value for ${m.eventName} on ${label}: ${valueText(m)}. Change`}
            className={cn("press -mx-2.5 flex min-h-10 items-center gap-2 rounded-control px-2.5 text-left hover:bg-hover pointer-coarse:min-h-11 disabled:cursor-default disabled:hover:bg-transparent", off ? "text-fg-muted" : "text-fg-muted")}>
            <ValueText m={m} currency0={currency0} />
          </button>
        ) : <span className="text-sm text-fg-subtle">Pick an event to set the value.</span>}
      </div>
      <div className={cn("col-start-2 row-start-1 justify-self-end @3xl:col-start-5", !m && "invisible")}>
        <Switch disabled={dis || !m} checked={!!m?.enabled} label={m ? `${m.enabled ? "On" : "Off"}: ${m.eventName} for ${label}` : `Off: nothing for ${label}`} onCheckedChange={onEnabled} />
      </div>
      {err && <div className="col-span-2 @3xl:col-span-5 @3xl:col-start-2"><Alert tone="error">{err} {onRetry && <button type="button" className="font-medium underline" onClick={onRetry}>Retry</button>}</Alert></div>}

      <Picker open={evOpen} onOpenChange={setEvOpen} anchor={evRef} title={`Event for ${label}`} description="Choose what is sent to Meta.">
        <EventList current={m?.eventName ?? null} label={label} onPick={(ev) => { setEvOpen(false); onEvent(ev); }} />
      </Picker>
      {m && <Picker open={valOpen} onOpenChange={setValOpen} anchor={valRef} title={`Value for ${m.eventName}`} description="Choose which amount is sent with the event.">
        <ValueList m={m} currency0={currency0} onPick={(k, f) => { setValOpen(false); onValue(k, f); }} />
      </Picker>}
      <Picker open={moreOpen} onOpenChange={setMoreOpen} anchor={moreRef} title={`All rules for ${label}`} description="Each rule can be turned off or removed.">
        <ul className="flex flex-col gap-1">
          {matches.map((x) => (
            <li key={x.id} className="flex items-center gap-2 rounded-control px-2 py-1.5">
              <span className="min-w-0 flex-1"><b className="block truncate text-base font-medium text-fg">{x.eventName}</b><span className="block text-sm text-fg-subtle">{valueText(x)}</span></span>
              <Switch disabled={dis} checked={x.enabled} label={`${x.enabled ? "On" : "Off"}: ${x.eventName}`} onCheckedChange={(v) => onToggleOne(x, v)} />
              <Button size="sm" icon variant="ghost" disabled={dis} aria-label={`Remove ${x.eventName}`} onClick={() => { if (window.confirm(`Remove this rule? It will stop sending ${x.eventName}.`)) { setMoreOpen(false); onRemoveOne(x); } }}><Trash2 /></Button>
            </li>
          ))}
        </ul>
      </Picker>
    </li>
  );
}

const valueText = (m: CapiMappingDto) => (m.valueMode === "none" ? "No value" : m.valueMode === "fixed" ? `${fromMinor(m.fixedValueMinor ?? 0, m.currency ?? "USD")} ${m.currency} fixed` : m.askForValue ? "Deal value, asks if missing" : "Deal value, skips if missing");
function ValueText({ m, currency0 }: { m: CapiMappingDto; currency0: string }) {
  void currency0;
  if (m.valueMode === "none") return <b className="font-semibold text-fg">No value</b>;
  if (m.valueMode === "fixed") return <><b className="font-semibold text-fg">{fromMinor(m.fixedValueMinor ?? 0, m.currency ?? "USD")} {m.currency}</b><span className="text-sm">fixed</span></>;
  return <><b className="font-semibold text-fg">Deal value</b><span className="text-sm">{m.askForValue ? "asks if missing" : "skips if missing"}</span></>;
}

function EventList({ current, label, onPick }: { current: string | null; label: string; onPick: (ev: string | null) => void }) {
  const [custom, setCustom] = React.useState(isStandard(current ?? "") ? "" : current ?? "");
  const [err, setErr] = React.useState<string | null>(null);
  function use() {
    const n = custom.trim();
    if (n === "PageView") return setErr("PageView is sent by your website Pixel, not the CRM.");
    if (!CAPI_CUSTOM_EVENT_NAME.test(n)) return setErr("Start with a letter; letters, digits and underscores only, up to 40 characters.");
    onPick(n);
  }
  return (
    <div>
      {current !== null && <PickerOption title="Don't send anything" hint={`Nothing goes to Meta for ${label}.`} onClick={() => onPick(null)} />}
      {current !== null && <hr className="mx-2 my-1 border-line-card" />}
      {FIRST.map((n) => <PickerOption key={n} title={n} hint={DESC[n]} checked={current === n} onClick={() => onPick(n)} />)}
      <p className="px-2.5 pb-1 pt-2 text-xs font-semibold text-fg-subtle">More from Meta</p>
      {MORE.map((n) => <PickerOption key={n} title={n} checked={current === n} onClick={() => onPick(n)} />)}
      <hr className="mx-2 my-1 border-line-card" />
      <form className="flex flex-col gap-1.5 px-2.5 pb-2 pt-1" noValidate onSubmit={(e) => { e.preventDefault(); use(); }}>
        <label htmlFor="custom-event" className="text-sm font-semibold text-fg">Custom event</label>
        <div className="flex gap-2">
          <Input id="custom-event" value={custom} maxLength={40} autoComplete="off" spellCheck={false} placeholder="EventName" aria-invalid={err ? true : undefined} aria-describedby="custom-event-note" className="min-h-10 flex-1" onChange={(e) => { setCustom(e.target.value); setErr(null); }} />
          <Button type="submit" className="min-h-10">Use</Button>
        </div>
        {err && <p role="alert" className="text-xs text-danger-fg">{err}</p>}
        <p id="custom-event-note" className="text-xs text-fg-subtle">Meta ignores a custom event until you set it up in Events Manager.</p>
      </form>
    </div>
  );
}

function ValueList({ m, currency0, onPick }: { m: CapiMappingDto; currency0: string; onPick: (k: ValueKind, fixed?: { minor: number; currency: string }) => void }) {
  const cur = valueKindOf(m);
  const purchase = m.eventName === "Purchase";
  const [amount, setAmount] = React.useState(m.fixedValueMinor != null ? fromMinor(m.fixedValueMinor, m.currency ?? currency0) : "");
  const [currency, setCurrency] = React.useState(m.currency ?? currency0);
  const [showFixed, setShowFixed] = React.useState(cur === "fixed");
  const [err, setErr] = React.useState<string | null>(null);
  function applyFixed() {
    if (amount.trim() === "" || !(Number(amount.replace(/,/g, "")) >= 0)) return setErr("Enter an amount, for example 25.");
    if (!/^[A-Z]{3}$/.test(currency)) return setErr("Use a three-letter currency code, for example USD.");
    const minor = toMinor(amount, currency);
    if (minor === null) return setErr("Enter an amount, for example 25.");
    onPick("fixed", { minor, currency });
  }
  const opts: { k: ValueKind; t: string; h: string }[] = [
    { k: "ask", t: "Deal value, ask if missing", h: "Use the lead’s value. If it is empty, ask when the lead moves here." },
    { k: "skip", t: "Deal value, skip if missing", h: "Use the lead’s value. If it is empty, send nothing." },
    { k: "fixed", t: "Fixed amount", h: "Always send the same amount." },
    { k: "none", t: "No value", h: "Send the event without a value." },
  ];
  return (
    <div>
      {opts.map((o) => {
        const dis = o.k === "none" && purchase;
        return <PickerOption key={o.k} title={o.t} hint={dis ? "A Purchase needs a value." : o.h} checked={cur === o.k} disabled={dis} onClick={() => (o.k === "fixed" ? setShowFixed(true) : onPick(o.k))} />;
      })}
      {showFixed && (
        <form className="flex flex-col gap-1.5 px-2.5 pb-2 pt-1" noValidate onSubmit={(e) => { e.preventDefault(); applyFixed(); }}>
          <div className="flex gap-2">
            <Input aria-label="Fixed amount" inputMode="decimal" autoComplete="off" placeholder="Amount" value={amount} aria-invalid={err ? true : undefined} className="min-h-10 min-w-0 flex-1" onChange={(e) => { setAmount(e.target.value); setErr(null); }} />
            <Select aria-label="Currency" wrapperClassName="w-24 [&_select]:min-h-10" value={currency} onChange={(e) => { setCurrency(e.target.value); setErr(null); }}>{(CURRENCIES.includes(currency as never) ? CURRENCIES : [...CURRENCIES, currency]).map((c) => <option key={c}>{c}</option>)}</Select>
          </div>
          {err && <p role="alert" className="text-xs text-danger-fg">{err}</p>}
          <Button type="submit" variant="primary" className="min-h-10 self-start">Use this amount</Button>
        </form>
      )}
    </div>
  );
}
