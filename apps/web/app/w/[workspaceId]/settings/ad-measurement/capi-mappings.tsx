"use client";
import * as React from "react";
import Link from "next/link";
import { ListChecks, Pencil, Plus, Trash2 } from "lucide-react";
import { CAPI_CUSTOM_EVENT_NAME, endpoints, META_STANDARD_EVENTS, type CapiDatasetDto, type CapiMappingDto, type CapiMappingPreview, type CreateCapiMappingBody, type LeadDto, type PipelineDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogActions, DialogClose, DialogContent } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";

type Trigger = CapiMappingDto["triggerType"];
const TRIGGERS: { value: Trigger; label: string }[] = [
  { value: "lead_created", label: "A lead is created" }, { value: "lead_stage_entered", label: "A lead enters a stage" }, { value: "lead_won", label: "A lead is won" }, { value: "lead_lost", label: "A lead is lost" },
];
/** Plain-language names for the events people reach for first; the rest of Meta's standard list follows. */
const COMMON: Record<string, string> = {
  Lead: "Lead: someone showed interest", Purchase: "Purchase: a sale was made", Schedule: "Schedule: a meeting or visit was booked", CompleteRegistration: "CompleteRegistration: signed up",
  Contact: "Contact: they got in touch", SubmitApplication: "SubmitApplication: applied", StartTrial: "StartTrial: started a trial", Subscribe: "Subscribe: started a subscription",
};
const COMMON_NAMES = Object.keys(COMMON);
const MORE_NAMES = META_STANDARD_EVENTS.filter((n) => !COMMON_NAMES.includes(n));
const CUSTOM = "__custom";
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const toMinor = (major: string, cur: string) => Math.round(Number(major) * (ZERO_DECIMAL.has(cur) ? 1 : 100));
const toMajor = (minor: number, cur: string) => String(ZERO_DECIMAL.has(cur) ? minor : minor / 100);
const SKIP_TEXT: Record<string, string> = {
  mapping_disabled: "This rule is turned off.", dataset_inactive: "The dataset is disabled.", no_value: "The lead has no value.", no_consent: "No ad measurement consent for this lead.", opted_out: "The lead withdrew consent.",
};

type Draft = { triggerType: Trigger; stageId: string; event: string; custom: string; valueMode: "lead_value" | "fixed" | "none"; amount: string; currency: string; enabled: boolean };
const blank = (currency: string): Draft => ({ triggerType: "lead_won", stageId: "", event: "Purchase", custom: "", valueMode: "lead_value", amount: "", currency, enabled: true });
const draftOf = (m: CapiMappingDto, currency: string): Draft => ({
  triggerType: m.triggerType, stageId: m.stageId ?? "", event: META_STANDARD_EVENTS.includes(m.eventName as never) ? m.eventName : CUSTOM, custom: META_STANDARD_EVENTS.includes(m.eventName as never) ? "" : m.eventName,
  valueMode: m.valueMode, amount: m.fixedValueMinor === null ? "" : toMajor(m.fixedValueMinor, m.currency ?? currency), currency: m.currency ?? currency, enabled: m.enabled,
});

/**
 * "When this happens, send this event" rules per dataset, plus a dry run against a real lead. Kept in its own file so the CAPI panel can move to a Settings page without touching it.
 * The server owns every rule (validation, 50 per dataset, stage ownership); the inline checks here only save a round trip.
 */
export function CapiMappings({ workspaceId, datasets, canManage }: { workspaceId: string; datasets: CapiDatasetDto[]; canManage: boolean }) {
  const live = datasets.filter((d) => d.status !== "disabled");
  const [rules, setRules] = React.useState<Record<string, CapiMappingDto[]> | null>(null);
  const [pipelines, setPipelines] = React.useState<PipelineDto[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [edit, setEdit] = React.useState<{ dataset: CapiDatasetDto; rule: CapiMappingDto | null } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const key = live.map((d) => d.id).join(",");

  const ids = key.split(",").filter(Boolean);
  const fetchAll = () => Promise.all([browserApi.call(endpoints.listPipelines, { params: { workspaceId } }), ...ids.map((id) => browserApi.call(endpoints.listCapiMappings, { params: { workspaceId, datasetId: id } }))]);
  const apply = ([p, ...m]: Awaited<ReturnType<typeof fetchAll>>) => {
    const failed = [p, ...m].find((r) => !r.ok);
    if (failed && !failed.ok) { setError(errorMessage(failed.error)); return; }
    setError(null);
    if (p.ok) setPipelines(p.data.pipelines);
    setRules(Object.fromEntries(ids.map((id, i) => [id, (m[i] as { ok: true; data: { items: CapiMappingDto[] } }).data.items])));
  };
  const load = async () => apply(await fetchAll());
  React.useEffect(() => { void fetchAll().then(apply); }, [workspaceId, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const stageName = (id: string | null) => {
    if (!id) return "";
    for (const p of pipelines) { const s = p.stages.find((x) => x.id === id); if (s) return pipelines.length > 1 ? `${p.name} / ${s.name}` : s.name; }
    return "a stage";
  };
  const currency = pipelines.find((p) => p.isDefault)?.defaultCurrency ?? "USD";
  const when = (m: CapiMappingDto) => (m.triggerType === "lead_stage_entered" ? `A lead enters ${stageName(m.stageId)}` : TRIGGERS.find((t) => t.value === m.triggerType)!.label);
  const valueText = (m: CapiMappingDto) => (m.valueMode === "lead_value" ? "Lead value" : m.valueMode === "fixed" ? `${toMajor(m.fixedValueMinor ?? 0, m.currency ?? currency)} ${m.currency}` : "No value");
  const body = (m: CapiMappingDto, enabled: boolean): CreateCapiMappingBody => ({ triggerType: m.triggerType, stageId: m.stageId, eventName: m.eventName, valueMode: m.valueMode, fixedValueMinor: m.fixedValueMinor, currency: m.currency, enabled, askForValue: m.askForValue });

  async function toggle(d: CapiDatasetDto, m: CapiMappingDto) {
    setBusy(m.id); setError(null);
    const r = await browserApi.call(endpoints.updateCapiMapping, { params: { workspaceId, datasetId: d.id, mappingId: m.id }, body: body(m, !m.enabled) });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    await load();
  }
  async function remove(d: CapiDatasetDto, m: CapiMappingDto) {
    if (!window.confirm(`Delete this rule? "${when(m)}" will stop sending ${m.eventName}.`)) return;
    setBusy(m.id); setError(null);
    const r = await browserApi.call(endpoints.deleteCapiMapping, { params: { workspaceId, datasetId: d.id, mappingId: m.id } });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    await load();
  }
  async function suggest(d: CapiDatasetDto) {
    setBusy(d.id); setError(null);
    const r = await browserApi.call(endpoints.createCapiMapping, { params: { workspaceId, datasetId: d.id }, body: { triggerType: "lead_won", stageId: null, eventName: "Purchase", valueMode: "lead_value", fixedValueMinor: null, currency: null, enabled: true } });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    await load();
  }

  if (live.length === 0) return null;
  return (
    <section aria-labelledby="capi-rules" className="border-t border-line-card pt-4">
      <h3 id="capi-rules" className="text-sm font-medium text-fg">Event rules</h3>
      <p className="mb-3 text-sm text-fg-subtle">Choose which changes in your CRM send an event to Meta. Only leads with ad measurement consent are sent; <Link className="underline" href={`/w/${workspaceId}/contacts`}>record consent on the lead</Link>.</p>
      {error && <Alert tone="error" className="mb-3">{error}</Alert>}
      {rules === null && !error ? <div role="status" aria-label="Loading rules" className="flex flex-col gap-2"><Skeleton className="h-12" /><Skeleton className="h-12" /></div> : rules === null ? <ErrorState title="Could not load rules" description={error ?? undefined} onRetry={() => void load()} /> : (
        <div className="flex flex-col gap-4">
          {live.map((d) => {
            const list = rules[d.id] ?? [];
            return (
              <div key={d.id} className="rounded-control border border-line-card">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-card px-3 py-2">
                  <h4 className="font-medium text-fg">{d.name}</h4>
                  {canManage && <Button size="sm" onClick={() => setEdit({ dataset: d, rule: null })} disabled={list.length >= 50}><Plus className="size-4" aria-hidden />Add rule</Button>}
                </div>
                {list.length === 0 ? (
                  <EmptyState icon={ListChecks} title="No rules yet" description="Suggested: when a lead is won, send a Purchase with the lead value."
                    action={canManage ? <Button variant="primary" onClick={() => void suggest(d)} loading={busy === d.id}>Add the suggested rule</Button> : undefined} />
                ) : (
                  <ul>
                    {list.map((m) => (
                      <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line-card px-3 py-2 last:border-b-0">
                        <p className="min-w-0 flex-1 basis-60 text-sm text-fg">
                          <span className="text-fg-muted">When</span> {when(m)} <span aria-hidden className="text-fg-subtle">&rarr;</span><span className="sr-only">send</span> <strong className="font-medium">{m.eventName}</strong>
                          <span className="text-fg-muted"> · {valueText(m)}</span>
                        </p>
                        <label className="flex min-h-8 items-center gap-2 text-sm text-fg pointer-coarse:min-h-11">
                          <input type="checkbox" role="switch" checked={m.enabled} disabled={!canManage || busy === m.id} onChange={() => void toggle(d, m)} aria-label={`${m.enabled ? "On" : "Off"}: ${when(m)}, send ${m.eventName}`} />
                          {m.enabled ? "On" : "Off"}
                        </label>
                        {canManage && (
                          <div className="flex gap-1">
                            <Button size="sm" icon variant="ghost" aria-label={`Edit rule: ${when(m)}, send ${m.eventName}`} onClick={() => setEdit({ dataset: d, rule: m })}><Pencil /></Button>
                            <Button size="sm" icon variant="ghost" aria-label={`Delete rule: ${when(m)}, send ${m.eventName}`} onClick={() => void remove(d, m)} loading={busy === m.id}><Trash2 /></Button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
          <RuleTest workspaceId={workspaceId} when={(t, s) => (t === "lead_stage_entered" ? `A lead enters ${stageName(s)}` : TRIGGERS.find((x) => x.value === t)!.label)} />
        </div>
      )}
      {edit && <RuleDialog key={edit.rule?.id ?? "new"} workspaceId={workspaceId} dataset={edit.dataset} rule={edit.rule} pipelines={pipelines} currency={currency} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); }} />}
    </section>
  );
}

function RuleDialog({ workspaceId, dataset, rule, pipelines, currency, onClose, onSaved }: { workspaceId: string; dataset: CapiDatasetDto; rule: CapiMappingDto | null; pipelines: PipelineDto[]; currency: string; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = React.useState<Draft>(rule ? draftOf(rule, currency) : blank(currency));
  const [err, setErr] = React.useState<{ stage?: string; event?: string; amount?: string; cur?: string }>({});
  const [serverErr, setServerErr] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const eventName = f.event === CUSTOM ? f.custom.trim() : f.event;
  const set = (p: Partial<Draft>) => setF((x) => {
    const n = { ...x, ...p };
    if ((n.event === "Purchase") && n.valueMode === "none") n.valueMode = "lead_value"; // a Purchase needs a value
    return n;
  });

  async function save() {
    const e: typeof err = {};
    if (f.triggerType === "lead_stage_entered" && !f.stageId) e.stage = "Choose the stage.";
    if (!CAPI_CUSTOM_EVENT_NAME.test(eventName)) e.event = f.event === CUSTOM ? "Start with a letter; letters, digits and underscores only, up to 40 characters." : "Choose an event.";
    if (f.valueMode === "fixed") {
      if (!(Number(f.amount) >= 0) || f.amount.trim() === "") e.amount = "Enter an amount, for example 25.";
      if (!/^[A-Z]{3}$/.test(f.currency)) e.cur = "Three letters, for example USD.";
    }
    setErr(e);
    if (Object.keys(e).length) return;
    setSaving(true); setServerErr(null);
    const b: CreateCapiMappingBody = {
      triggerType: f.triggerType, stageId: f.triggerType === "lead_stage_entered" ? f.stageId : null, eventName, valueMode: f.valueMode,
      fixedValueMinor: f.valueMode === "fixed" ? toMinor(f.amount, f.currency) : null, currency: f.valueMode === "fixed" ? f.currency : null, enabled: f.enabled, askForValue: rule?.askForValue && f.valueMode === "lead_value" ? true : false,
    };
    const r = rule ? await browserApi.call(endpoints.updateCapiMapping, { params: { workspaceId, datasetId: dataset.id, mappingId: rule.id }, body: b }) : await browserApi.call(endpoints.createCapiMapping, { params: { workspaceId, datasetId: dataset.id }, body: b });
    setSaving(false);
    if (!r.ok) { setServerErr(errorMessage(r.error)); return; }
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={rule ? "Edit rule" : "Add rule"} description={`Sent to ${dataset.name}.`}>
        <form onSubmit={(ev) => { ev.preventDefault(); void save(); }} className="flex flex-col gap-3" noValidate>
          <Field label="When this happens">{(p) => (
            <Select {...p} value={f.triggerType} disabled={saving} onChange={(ev) => set({ triggerType: ev.target.value as Trigger })}>
              {TRIGGERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          )}</Field>
          {f.triggerType === "lead_stage_entered" && (
            <Field label="Stage" error={err.stage}>{(p) => (
              <Select {...p} value={f.stageId} disabled={saving} onChange={(ev) => set({ stageId: ev.target.value })}>
                <option value="">Choose a stage</option>
                {pipelines.filter((x) => !x.archived).map((pl) => <optgroup key={pl.id} label={pl.name}>{pl.stages.filter((s) => !s.archived).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>)}
              </Select>
            )}</Field>
          )}
          <Field label="Send this event" error={f.event === CUSTOM ? null : err.event}>{(p) => (
            <Select {...p} value={f.event} disabled={saving} onChange={(ev) => set({ event: ev.target.value })}>
              <optgroup label="Common">{COMMON_NAMES.map((n) => <option key={n} value={n}>{COMMON[n]}</option>)}</optgroup>
              <optgroup label="More from Meta">{MORE_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}</optgroup>
              <option value={CUSTOM}>Custom event name</option>
            </Select>
          )}</Field>
          {f.event === CUSTOM && (
            <Field label="Custom event name" hint="Letters, digits and underscores, up to 40." error={err.event}>{(p) => <Input {...p} value={f.custom} maxLength={40} autoComplete="off" spellCheck={false} disabled={saving} onChange={(ev) => set({ custom: ev.target.value })} />}</Field>
          )}
          {f.event === CUSTOM && <Alert tone="warning">Meta ignores a custom event until you set it up in Events Manager.</Alert>}
          <Field label="Value sent">{(p) => (
            <Select {...p} value={f.valueMode} disabled={saving} onChange={(ev) => set({ valueMode: ev.target.value as Draft["valueMode"] })}>
              <option value="lead_value">Lead value</option>
              <option value="fixed">Fixed amount</option>
              <option value="none" disabled={eventName === "Purchase"}>No value{eventName === "Purchase" ? " (a Purchase needs one)" : ""}</option>
            </Select>
          )}</Field>
          {f.valueMode === "fixed" && (
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <Field label="Amount" error={err.amount}>{(p) => <Input {...p} inputMode="decimal" value={f.amount} disabled={saving} onChange={(ev) => set({ amount: ev.target.value })} />}</Field>
              <Field label="Currency" error={err.cur}>{(p) => <Input {...p} maxLength={3} autoComplete="off" value={f.currency} disabled={saving} onChange={(ev) => set({ currency: ev.target.value.toUpperCase() })} />}</Field>
            </div>
          )}
          <label className="flex min-h-8 items-center gap-2 text-sm text-fg pointer-coarse:min-h-11"><input type="checkbox" checked={f.enabled} disabled={saving} onChange={(ev) => set({ enabled: ev.target.checked })} />Rule is on</label>
          {serverErr && <Alert tone="error">{serverErr}</Alert>}
          <DialogActions>
            <DialogClose asChild><Button disabled={saving}>Cancel</Button></DialogClose>
            <Button type="submit" variant="primary" loading={saving}>{rule ? "Save rule" : "Add rule"}</Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Dry run: pick a lead, see which rules would send and which would be skipped, and why. Queues nothing. */
function RuleTest({ workspaceId, when }: { workspaceId: string; when: (t: Trigger, stageId: string | null) => string }) {
  const [leads, setLeads] = React.useState<LeadDto[] | null>(null);
  const [leadId, setLeadId] = React.useState("");
  const [result, setResult] = React.useState<CapiMappingPreview | null>(null);
  const [state, setState] = React.useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    void browserApi.call(endpoints.listLeads, { params: { workspaceId }, query: { limit: 50, sort: "updated", dir: "desc" } }).then((r) => { if (r.ok) setLeads(r.data.items); else { setLeads([]); setError(errorMessage(r.error)); } });
  }, [workspaceId]);
  async function pick(id: string) {
    setLeadId(id); setResult(null); setError(null);
    if (!id) { setState("idle"); return; }
    setState("loading");
    const r = await browserApi.call(endpoints.previewCapiMappings, { params: { workspaceId }, body: { leadId: id } });
    if (!r.ok) { setState("error"); setError(errorMessage(r.error)); return; }
    setState("idle"); setResult(r.data);
  }
  return (
    <div className="rounded-control border border-line-card p-3">
      <h4 className="font-medium text-fg">Test with a lead</h4>
      <p className="mb-2 text-sm text-fg-subtle">See what each rule would do for a real lead. Nothing is sent.</p>
      {leads === null ? <Skeleton className="h-9" /> : leads.length === 0 ? <p className="text-sm text-fg-muted">{error ?? "No leads yet. Create a lead to test the rules."}</p> : (
        <Field label="Lead">{(p) => (
          <Select {...p} value={leadId} onChange={(ev) => void pick(ev.target.value)}>
            <option value="">Choose a lead</option>
            {leads.map((l) => <option key={l.id} value={l.id}>{l.title} ({l.primaryContact.name})</option>)}
          </Select>
        )}</Field>
      )}
      {state === "loading" && <div role="status" aria-label="Checking" className="mt-3"><Skeleton className="h-10" /></div>}
      {state === "error" && error && <Alert tone="error" className="mt-3">{error}</Alert>}
      {result && (
        <ul className="mt-3 flex flex-col gap-1" aria-label="Test result">
          {result.items.length === 0 && <li className="text-sm text-fg-muted">There are no rules to test.</li>}
          {result.items.map((i) => (
            <li key={i.mappingId} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={i.result === "send" ? "success" : "neutral"}>{i.result === "send" ? "Would send" : "Skipped"}</Badge>
              <span className="text-fg">{i.eventName} to {i.datasetName}{i.value !== null ? `, ${i.value} ${i.currency}` : ""}</span>
              <span className="text-fg-muted">{when(i.triggerType, i.stageId)}{i.reason ? `. ${SKIP_TEXT[i.reason]}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
