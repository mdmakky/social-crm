"use client";
import * as React from "react";
import { Plug, Send } from "lucide-react";
import { CAPI_EVENT_NAMES, endpoints, type CapiDatasetDto, type CapiEventDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { browserApi, errorMessage } from "@/lib/client-api";

const STATUS: Record<CapiEventDto["status"], { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  pending: { label: "Waiting to send", tone: "warning" }, sent: { label: "Accepted (mock)", tone: "success" }, failed: { label: "Failed", tone: "danger" }, skipped_no_consent: { label: "Skipped, no consent", tone: "neutral" }, cancelled: { label: "Cancelled, contact deleted", tone: "neutral" },
};
const ERROR_TEXT: Record<string, string> = {
  no_consent: "No ad measurement consent recorded for the contact.", opted_out: "The contact withdrew consent.", event_too_old: "Older than 7 days, Meta would reject it.", dataset_inactive: "The dataset was disabled.",
  mode_mismatch: "Dataset mode does not match the sender.", token_unavailable: "The stored token could not be opened.", invalid_payload: "The event failed validation.", auth: "The token was rejected.",
};
const errorText = (code: string | null) => (code === null ? "" : ERROR_TEXT[code] ?? (code.startsWith("max_attempts:") ? "Gave up after repeated failures." : code.startsWith("http_") ? `Request failed (${code.slice(5)}).` : code));

function LocalTime({ iso }: { iso: string | null }) {
  return <time dateTime={iso ?? undefined} suppressHydrationWarning>{iso ? new Date(iso).toLocaleString() : ""}</time>;
}

/**
 * Meta Conversions API, slice 1. MOCK ONLY: events are validated, queued and "sent" to a mock adapter; nothing reaches Meta until a real test event has been recorded (docs/architecture/capi-architecture.md section 10).
 * The access token is typed into a password field, sent once over the same-origin proxy and cleared immediately; the server never returns it.
 */
export function CapiPanel({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const params = { workspaceId };
  const [datasets, setDatasets] = React.useState<CapiDatasetDto[] | null>(null);
  const [events, setEvents] = React.useState<CapiEventDto[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({ datasetId: "", name: "", token: "", testCode: "" });
  const [chosen, setChosen] = React.useState<string[]>(["Purchase"]);
  const [fieldErr, setFieldErr] = React.useState<{ datasetId?: string; name?: string; token?: string }>({});
  const [busy, setBusy] = React.useState<"create" | string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const fetchAll = React.useCallback(
    () => Promise.all([browserApi.call(endpoints.listCapiDatasets, { params: { workspaceId } }), browserApi.call(endpoints.listCapiEvents, { params: { workspaceId }, query: { limit: 25 } })]),
    [workspaceId],
  );
  const apply = ([d, e]: Awaited<ReturnType<typeof fetchAll>>) => {
    if (!d.ok) { setLoadError(errorMessage(d.error)); return; }
    if (!e.ok) { setLoadError(errorMessage(e.error)); return; }
    setLoadError(null);
    setDatasets(d.data.items);
    setEvents(e.data.items);
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
    const r = await browserApi.call(endpoints.createCapiDataset, { params, body: { datasetId: form.datasetId.trim(), name: form.name.trim(), accessToken: form.token.trim(), ...(form.testCode.trim() ? { testEventCode: form.testCode.trim() } : {}), events: chosen as never } });
    setBusy(null);
    if (!r.ok) { setError(r.error.code === "dataset_exists" ? "This dataset is already connected." : errorMessage(r.error)); return; }
    setForm({ datasetId: "", name: "", token: "", testCode: "" }); // the token is gone from the page as soon as it is accepted
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

  return (
    <Panel className="mt-6">
      <PanelHeader title="Meta Conversions API" description="Send CRM outcomes, such as a won lead, back to Meta for ad measurement. Only for contacts who agreed to it. Record consent on the contact page, under Ad measurement consent." actions={<Badge tone="warning">MOCK</Badge>} />
      <div className="flex flex-col gap-4 p-4">
        <Alert tone="warning">Mock only. Events are checked and recorded here, but nothing is sent to Meta. Live sending stays off until a real test event has been accepted and recorded.</Alert>

        {loadError ? <ErrorState title="Could not load Conversions API" description={loadError} onRetry={() => { setLoadError(null); void load(); }} /> : datasets === null ? (
          <div className="flex flex-col gap-2" role="status" aria-label="Loading"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-24" /></div>
        ) : (
          <>
            <section aria-labelledby="capi-datasets">
              <h3 id="capi-datasets" className="mb-2 text-sm font-medium text-fg">Datasets</h3>
              {datasets.length === 0 ? <EmptyState icon={Send} title="No dataset connected" description={canManage ? "Add a dataset ID and access token from Meta Events Manager below." : "An owner or admin can connect a dataset."} /> : (
                <ul className="flex flex-col gap-2">
                  {datasets.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-3 rounded-control border border-line-card px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-fg">{d.name} <span className="font-normal text-fg-muted">· ID {d.datasetId}</span></p>
                        <p className="text-sm text-fg-muted">Token ending {d.tokenLast4} · Events: {d.events.length ? d.events.join(", ") : "none selected"}{d.testEventCode ? ` · Test code ${d.testEventCode}` : ""}</p>
                      </div>
                      {d.mode === "mock" && <Badge tone="warning">MOCK</Badge>}
                      <Badge tone={d.status === "active" ? "success" : d.status === "needs_reauth" ? "warning" : "neutral"}>{d.status === "active" ? "Active" : d.status === "needs_reauth" ? "Reconnect needed" : "Disabled"}</Badge>
                      {canManage && d.status !== "disabled" && <Button onClick={() => void disable(d)} loading={busy === d.id}>Disable</Button>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {canManage && (
              <form onSubmit={(e) => { e.preventDefault(); void create(); }} className="flex flex-col gap-3 border-t border-line-card pt-4" noValidate>
                <h3 className="text-sm font-medium text-fg">Connect a dataset</h3>
                <p className="text-sm text-fg-subtle">In Events Manager open your dataset, then Settings, and generate an access token. The token is stored encrypted and is never shown again; only its last four characters are.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Dataset ID" error={fieldErr.datasetId}>{(p) => <Input {...p} inputMode="numeric" autoComplete="off" value={form.datasetId} disabled={busy !== null} onChange={(e) => setForm({ ...form, datasetId: e.target.value })} />}</Field>
                  <Field label="Name" error={fieldErr.name}>{(p) => <Input {...p} autoComplete="off" maxLength={120} value={form.name} disabled={busy !== null} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
                  <Field label="Access token" error={fieldErr.token} hint="Pasted once, kept encrypted on the server.">{(p) => <Input {...p} type="password" autoComplete="off" spellCheck={false} value={form.token} disabled={busy !== null} onChange={(e) => setForm({ ...form, token: e.target.value })} />}</Field>
                  <Field label="Test event code (optional)" hint="From the Test Events tab.">{(p) => <Input {...p} autoComplete="off" maxLength={40} value={form.testCode} disabled={busy !== null} onChange={(e) => setForm({ ...form, testCode: e.target.value })} />}</Field>
                </div>
                <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
                  <legend className="mb-1 text-sm font-medium text-fg">Events to send</legend>
                  {CAPI_EVENT_NAMES.map((n) => (
                    <label key={n} className="flex min-h-8 items-center gap-2 text-sm text-fg pointer-coarse:min-h-11">
                      <input type="checkbox" checked={chosen.includes(n)} disabled={busy !== null} onChange={(e) => setChosen(e.target.checked ? [...chosen, n] : chosen.filter((x) => x !== n))} />{n}
                    </label>
                  ))}
                  <p className="basis-full text-sm text-fg-subtle">Today a lead moved to a Won stage creates a Purchase event (it needs a value). Other events are accepted but nothing creates them yet.</p>
                </fieldset>
                {error && <Alert tone="error">{error}</Alert>}
                <div><Button type="submit" variant="primary" loading={busy === "create"}><Plug className="size-4" aria-hidden />Connect dataset</Button></div>
              </form>
            )}
            {!canManage && error && <Alert tone="error">{error}</Alert>}

            <section aria-labelledby="capi-history" className="border-t border-line-card pt-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 id="capi-history" className="text-sm font-medium text-fg">Delivery history</h3>
                <Button onClick={() => { setEvents(null); void load(); }}>Refresh</Button>
              </div>
              {events === null ? <Skeleton className="h-24" /> : events.length === 0 ? (
                <EmptyState icon={Send} title="No events yet" description="Events appear here when a lead with a value is moved to a Won stage and a dataset is connected. Contacts need recorded consent to be sent." />
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
              <p className="mt-2 text-sm text-fg-subtle">Accepted means the mock accepted it. A real send is not enabled, and even a real accepted request would not mean Meta counted a conversion.</p>
            </section>
          </>
        )}
      </div>
    </Panel>
  );
}
