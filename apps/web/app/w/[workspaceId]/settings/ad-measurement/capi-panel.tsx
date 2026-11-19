"use client";
import * as React from "react";
import { ChevronRight, Plug, Send } from "lucide-react";
import { endpoints, type CapiDatasetDto, type CapiEventDto, type PipelineDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/overlays";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { browserApi, errorMessage } from "@/lib/client-api";
import { RuleTest } from "./rule-test";
import { StageMap } from "./stage-map";

const STATUS: Record<CapiEventDto["status"], { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  pending: { label: "Waiting to send", tone: "warning" }, sent: { label: "Accepted (mock)", tone: "success" }, failed: { label: "Failed", tone: "danger" }, skipped_no_consent: { label: "Skipped, no consent", tone: "neutral" }, skipped: { label: "Skipped", tone: "neutral" }, cancelled: { label: "Cancelled, contact deleted", tone: "neutral" },
};
const ERROR_TEXT: Record<string, string> = {
  no_consent: "No ad measurement consent recorded for the lead.", opted_out: "The lead withdrew consent.", event_too_old: "Older than 7 days, Meta would reject it.", dataset_inactive: "The dataset was disabled.",
  mode_mismatch: "Dataset mode does not match the sender.", token_unavailable: "The stored token could not be opened.", invalid_payload: "The event failed validation.", no_value: "The lead has no value, so a Purchase cannot be sent.", auth: "The token was rejected.",
};
const errorText = (code: string | null) => (code === null ? "" : ERROR_TEXT[code] ?? (code.startsWith("max_attempts:") ? "Gave up after repeated failures." : code.startsWith("http_") ? `Request failed (${code.slice(5)}).` : code));

function LocalTime({ iso }: { iso: string | null }) {
  return <time dateTime={iso ?? undefined} suppressHydrationWarning>{iso ? new Date(iso).toLocaleString() : ""}</time>;
}

/**
 * Ad measurement (Meta Conversions API). MOCK ONLY: events are validated, queued and "sent" to a mock adapter; nothing reaches Meta until a real test event has been recorded (docs/architecture/capi-architecture.md section 10).
 * The page is the stage map (stage-map.tsx): pick a dataset, then choose which stage sends which event. Connecting a dataset is a secondary section once one exists.
 * The access token is typed into a password field, sent once over the same-origin proxy and cleared immediately; the server never returns it.
 */
export function CapiPanel({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const params = { workspaceId };
  const [datasets, setDatasets] = React.useState<CapiDatasetDto[] | null>(null);
  const [events, setEvents] = React.useState<CapiEventDto[] | null>(null);
  const [pipelines, setPipelines] = React.useState<PipelineDto[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<string>("");
  const [form, setForm] = React.useState({ datasetId: "", name: "", token: "", testCode: "" });
  const [fieldErr, setFieldErr] = React.useState<{ datasetId?: string; name?: string; token?: string }>({});
  const [busy, setBusy] = React.useState<"create" | string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const idRef = React.useRef<HTMLInputElement>(null);
  const [connectOpen, setConnectOpen] = React.useState(false);

  const fetchAll = React.useCallback(
    () => Promise.all([browserApi.call(endpoints.listCapiDatasets, { params: { workspaceId } }), browserApi.call(endpoints.listCapiEvents, { params: { workspaceId }, query: { limit: 25 } }), browserApi.call(endpoints.listPipelines, { params: { workspaceId } })]),
    [workspaceId],
  );
  const apply = ([d, e, p]: Awaited<ReturnType<typeof fetchAll>>) => {
    if (!d.ok) { setLoadError(errorMessage(d.error)); return; }
    if (!e.ok) { setLoadError(errorMessage(e.error)); return; }
    if (!p.ok) { setLoadError(errorMessage(p.error)); return; }
    setLoadError(null);
    setDatasets(d.data.items);
    setEvents(e.data.items);
    setPipelines(p.data.pipelines);
  };
  const load = async () => apply(await fetchAll());
  React.useEffect(() => { void fetchAll().then(apply); }, [fetchAll]); // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    setError(null);
    const e: typeof fieldErr = {};
    if (!/^[1-9][0-9]{0,99}$/.test(form.datasetId.trim())) e.datasetId = "Enter the dataset ID: digits only.";
    if (!form.name.trim()) e.name = "Give it a name.";
    if (form.token.trim().length < 20 || /\s/.test(form.token.trim())) e.token = "Paste the whole access token, with no spaces.";
    setFieldErr(e);
    if (Object.keys(e).length) return;
    setBusy("create");
    const r = await browserApi.call(endpoints.createCapiDataset, { params, body: { datasetId: form.datasetId.trim(), name: form.name.trim(), accessToken: form.token.trim(), ...(form.testCode.trim() ? { testEventCode: form.testCode.trim() } : {}), events: ["Purchase"] } });
    setBusy(null);
    if (!r.ok) { setError(r.error.code === "dataset_exists" ? "This dataset is already connected." : errorMessage(r.error)); return; }
    setForm({ datasetId: "", name: "", token: "", testCode: "" }); // the token is gone from the page as soon as it is accepted
    setPicked(r.data.id);
    setConnectOpen(false);
    await load();
  }

  async function disable(d: CapiDatasetDto) {
    if (!window.confirm(`Disable "${d.name}"? New events stop being queued for it, and it cannot be switched back on (connect it again instead).`)) return;
    setBusy(d.id);
    const r = await browserApi.call(endpoints.disableCapiDataset, { params: { workspaceId, datasetId: d.id } });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    await load();
  }

  const nameOf = (id: string) => datasets?.find((d) => d.id === id)?.name ?? "Dataset";
  const usable = (datasets ?? []).filter((d) => d.status !== "disabled");
  const current = usable.find((d) => d.id === picked) ?? usable[0];
  const stageLabel = (t: string, s: string | null) => (t === "lead_stage_entered" ? `A lead enters ${pipelines.flatMap((p) => p.stages).find((x) => x.id === s)?.name ?? "a stage"}` : t === "lead_created" ? "A lead is added" : t === "lead_won" ? "A lead is won" : "A lead is lost");

  const connectForm = canManage && (
    <form onSubmit={(e) => { e.preventDefault(); void create(); }} className="flex flex-col gap-3" noValidate aria-label="Connect a dataset">
      <h3 className="text-sm font-medium text-fg">Connect a dataset</h3>
      <p className="text-sm text-fg-subtle">Create the token in Events Manager, under your dataset&apos;s Settings. It is stored encrypted.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Dataset ID" error={fieldErr.datasetId}>{(p) => <Input {...p} ref={idRef} inputMode="numeric" autoComplete="off" value={form.datasetId} disabled={busy !== null} onChange={(e) => setForm({ ...form, datasetId: e.target.value })} />}</Field>
        <Field label="Name" error={fieldErr.name}>{(p) => <Input {...p} autoComplete="off" maxLength={120} value={form.name} disabled={busy !== null} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label="Access token" error={fieldErr.token} hint="Shown once, then only its last four digits.">{(p) => <Input {...p} type="password" autoComplete="off" spellCheck={false} value={form.token} disabled={busy !== null} onChange={(e) => setForm({ ...form, token: e.target.value })} />}</Field>
        <Field label="Test event code (optional)" hint="From the Test Events tab.">{(p) => <Input {...p} autoComplete="off" maxLength={40} value={form.testCode} disabled={busy !== null} onChange={(e) => setForm({ ...form, testCode: e.target.value })} />}</Field>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <div><Button type="submit" variant="primary" loading={busy === "create"}><Plug className="size-4" aria-hidden />Connect dataset</Button></div>
    </form>
  );

  return (
    <div className="flex flex-col gap-4">
      {loadError ? <ErrorState title="Could not load Conversions API" description={loadError} onRetry={() => { setLoadError(null); void load(); }} /> : datasets === null ? (
        <div className="flex flex-col gap-2" role="status" aria-label="Loading"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-64" /></div>
      ) : usable.length === 0 ? (
        <>
          <Panel className="p-5 sm:p-7">
            <h2 className="text-lg font-semibold text-fg">Start with a dataset</h2>
            <p className="mb-4 mt-1 max-w-[56ch] text-sm text-fg-subtle">Choose which stage sends which event after you connect one. Nothing is sent until you do, and only leads who agreed to ad measurement are ever sent.</p>
            <ol className="grid max-w-[520px] gap-2.5">
              <li className="flex items-center gap-3 rounded-card border border-line-card px-3.5 py-3"><span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-sm font-semibold text-on-accent">1</span><div className="min-w-0 flex-1"><b className="block font-semibold text-fg">Connect a dataset</b><span className="text-sm text-fg-subtle">Paste the dataset ID and access token.</span></div>{canManage ? <Button variant="primary" onClick={() => idRef.current?.focus()}>Connect</Button> : <span className="text-sm text-fg-subtle">An owner or admin can connect one.</span>}</li>
              <li className="flex items-center gap-3 rounded-card border border-line-card px-3.5 py-3 "><span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-hover text-sm font-semibold text-fg-muted">2</span><div><b className="block font-semibold text-fg-muted">Choose events for your stages</b><span className="text-sm text-fg-subtle">Locked until a dataset is connected.</span></div></li>
              <li className="flex items-center gap-3 rounded-card border border-line-card px-3.5 py-3 "><span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-hover text-sm font-semibold text-fg-muted">3</span><b className="font-semibold text-fg-muted">Test with a test event code</b></li>
            </ol>
          </Panel>
          {connectForm && <Panel className="p-5">{connectForm}</Panel>}
          {!canManage && error && <Alert tone="error">{error}</Alert>}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2.5">
            <Tooltip label="Mock mode: events are recorded here, nothing is sent to Meta."><span><Badge tone="warning">MOCK</Badge></span></Tooltip>
            <Badge tone="neutral">Not tested live</Badge>
            <Select aria-label="Dataset" value={current!.id} wrapperClassName="min-w-0 max-w-full sm:w-auto" className="min-h-10 pointer-coarse:min-h-11" onChange={(e) => setPicked(e.target.value)}>
              {usable.map((d) => <option key={d.id} value={d.id}>{d.name} &middot; {d.datasetId}</option>)}
            </Select>
            {current!.status === "needs_reauth" && <Badge tone="warning">Reconnect needed</Badge>}
          </div>
          <Panel className="overflow-hidden">
            <StageMap key={current!.id} workspaceId={workspaceId} dataset={current!} pipelines={pipelines} canManage={canManage} />
          </Panel>
          <Panel>
            <details className="group" open={connectOpen} onToggle={(e) => setConnectOpen((e.target as HTMLDetailsElement).open)}>
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-fg [&::-webkit-details-marker]:hidden"><ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden />Datasets and connection</summary>
              <div className="flex flex-col gap-4 border-t border-line-card p-4">
                <ul className="flex flex-col gap-2">
                  {datasets.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-3 rounded-control border border-line-card px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-fg">{d.name} <span className="font-normal text-fg-muted">&middot; ID {d.datasetId}</span></p>
                        <p className="text-sm text-fg-muted">Token ending {d.tokenLast4}{d.testEventCode ? ` · Test code ${d.testEventCode}` : ""}</p>
                      </div>
                      {d.mode === "mock" && <Badge tone="warning">MOCK</Badge>}
                      <Badge tone={d.status === "active" ? "success" : d.status === "needs_reauth" ? "warning" : "neutral"}>{d.status === "active" ? "Active" : d.status === "needs_reauth" ? "Reconnect needed" : "Disabled"}</Badge>
                      {canManage && d.status !== "disabled" && <Button onClick={() => void disable(d)} loading={busy === d.id}>Disable</Button>}
                    </li>
                  ))}
                </ul>
                {connectForm ? <div className="border-t border-line-card pt-4">{connectForm}</div> : null}
                {!canManage && error && <Alert tone="error">{error}</Alert>}
              </div>
            </details>
          </Panel>
          <Panel>
            <details className="group">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-fg [&::-webkit-details-marker]:hidden"><ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden />Test with a lead</summary>
              <div className="border-t border-line-card p-4"><RuleTest workspaceId={workspaceId} when={stageLabel} /></div>
            </details>
          </Panel>
          <Panel>
            <section aria-labelledby="capi-history" className="p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 id="capi-history" className="text-sm font-medium text-fg">Delivery history</h3>
                <Button onClick={() => { setEvents(null); void load(); }}>Refresh</Button>
              </div>
              {events === null ? <Skeleton className="h-24" /> : events.length === 0 ? (
                <EmptyState icon={Send} title="No events yet" description="They appear when a lead moves to a stage that sends an event." />
              ) : (
                <Table scrollLabel="Delivery history">
                  <THead><TR><TH>When</TH><TH>Dataset</TH><TH>Event</TH><TH>Status</TH><TH>Tries</TH><TH>Detail</TH></TR></THead>
                  <TBody>
                    {events.map((e) => (
                      <TR key={e.id}>
                        <TD><LocalTime iso={e.createdAt} /></TD>
                        <TD>{nameOf(e.datasetId)}</TD>
                        <TD>{e.eventName}</TD>
                        <TD><Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge></TD>
                        <TD>{e.attempts}</TD>
                        <TD className="text-fg-muted">{e.status === "pending" && e.nextAttemptAt ? <>Next try <LocalTime iso={e.nextAttemptAt} /> </> : null}{errorText(e.lastError)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </section>
          </Panel>
        </>
      )}
    </div>
  );
}
