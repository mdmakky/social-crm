"use client";
import * as React from "react";
import { Plug, RefreshCw, Trash2 } from "lucide-react";
import { endpoints, type ConnectMetaResult, type IntegrationAccountDto, type MetaIntegrationState, type MetaPendingList } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/form-controls";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";

type Props = { workspaceId: string; canManage: boolean; initial: MetaIntegrationState | null; result?: string };

/** What the OAuth callback redirect (?meta=...) means, in plain language. "select" and "no_pages" are handled by the picker. */
const RESULT: Record<string, { tone: "error" | "warning" | "info"; text: string }> = {
  denied: { tone: "warning", text: "The Meta login was cancelled. Nothing was connected." },
  error: { tone: "error", text: "Meta could not complete the login. Nothing was connected. Try again." },
  invalid_state: { tone: "error", text: "That login link expired or was not started from this browser. Start the connection again." },
  forbidden: { tone: "error", text: "Only owners and admins can connect Meta accounts." },
  no_pages: { tone: "warning", text: "Meta returned no Pages for this login. Make sure you have access to a Page and approved it in the Meta dialog." },
  not_configured: { tone: "warning", text: "Meta is not configured on this server." },
};
const SUBSCRIPTION = { subscribed: "Webhook subscribed", failed: "Webhook subscription failed", dashboard_required: "Instagram webhook fields must be enabled in the Meta app dashboard (UNVERIFIED)" } as const;
const STATUS: Record<IntegrationAccountDto["status"], { label: string; tone: "success" | "warning" | "neutral" }> = {
  connected: { label: "Connected", tone: "success" }, reauth_required: { label: "Reconnect needed", tone: "warning" }, disabled: { label: "Disconnected", tone: "neutral" },
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "Never");

export function MetaIntegrations(p: Props) {
  return <ToastProvider><Inner {...p} /></ToastProvider>;
}

function Inner({ workspaceId, canManage, initial, result }: Props) {
  const toast = useToast();
  const params = { workspaceId };
  const [data, setData] = React.useState<MetaIntegrationState | null>(initial);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<MetaPendingList | null | "loading">(result === "select" ? "loading" : null);
  const [pick, setPick] = React.useState<{ pageId: string; ig: boolean }>({ pageId: "", ig: false });
  const [done, setDone] = React.useState<ConnectMetaResult["accounts"] | null>(null);
  const [confirm, setConfirm] = React.useState<IntegrationAccountDto | null>(null);
  const [banner, setBanner] = React.useState(result && RESULT[result] ? RESULT[result] : null);

  const reload = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.getMetaIntegration, { params });
    if (r.ok) setData(r.data);
    return r.ok;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // After the Meta dialog the callback redirects here with ?meta=select; load the discovered Pages, then drop the query so a refresh does not repeat it.
  React.useEffect(() => {
    if (result) window.history.replaceState(null, "", window.location.pathname);
    if (result !== "select") return;
    void browserApi.call(endpoints.listMetaPending, { params }).then((r) => {
      if (!r.ok) { setBanner({ tone: "error", text: "The Meta login expired. Connect again." }); setPending(null); return; }
      setPending(r.data);
      setPick({ pageId: r.data.pages.find((x) => !x.connected)?.pageId ?? "", ig: false });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startConnect() {
    setBusy("connect");
    const r = await browserApi.call(endpoints.startMetaConnect, { params });
    if (!r.ok) { setBusy(null); toast(errorMessage(r.error), "error"); return; }
    window.location.assign(r.data.authUrl);
  }
  async function connectSelected() {
    setBusy("pick");
    const r = await browserApi.call(endpoints.connectMetaPage, { params, body: { pageId: pick.pageId, connectInstagram: pick.ig } });
    setBusy(null);
    if (!r.ok) { toast(r.error.code === "account_unavailable" ? "This Page can't be connected to this workspace." : errorMessage(r.error), "error"); return; }
    setDone(r.data.accounts);
    setPending(null);
    toast("Connected");
    await reload();
  }
  async function checkToken(a: IntegrationAccountDto) {
    setBusy(a.id);
    const r = await browserApi.call(endpoints.checkMetaAccountToken, { params: { ...params, accountId: a.id } });
    setBusy(null);
    if (!r.ok) { toast(r.error.code === "meta_unavailable" ? "Meta could not be reached. Try again later." : errorMessage(r.error), "error"); return; }
    toast(r.data.status === "connected" ? "Token is valid" : "Token is no longer valid. Reconnect this account.", r.data.status === "connected" ? "success" : "error");
    await reload();
  }
  async function resubscribe(id: string) {
    setBusy(id);
    const r = await browserApi.call(endpoints.resubscribeMetaAccount, { params: { ...params, accountId: id } });
    setBusy(null);
    if (!r.ok) { toast(errorMessage(r.error), "error"); return; }
    setDone((d) => d?.map((x) => (x.account.id === id ? { ...x, subscription: r.data.subscription } : x)) ?? null);
    toast(SUBSCRIPTION[r.data.subscription]);
  }
  async function disconnect(a: IntegrationAccountDto) {
    setBusy(a.id);
    const r = await browserApi.call(endpoints.disconnectMetaAccount, { params: { ...params, accountId: a.id } });
    setBusy(null);
    setConfirm(null);
    if (!r.ok) { toast(errorMessage(r.error), "error"); return; }
    toast("Disconnected");
    await reload();
  }

  if (!data) return <ErrorState description="Integrations could not be loaded." onRetry={() => void reload()} />;
  const reason = !data.configured ? "Meta is not configured on this server." : !canManage ? "Only owners and admins can connect accounts." : undefined;
  const connectBtn = (label: string, variant: "primary" | "secondary" = "primary") => (
    <Button variant={variant} disabled={!!reason} loading={busy === "connect"} onClick={() => void startConnect()} title={reason} aria-describedby={reason ? "meta-reason" : undefined}><Plug className="size-4" aria-hidden />{label}</Button>
  );
  const accounts = data.accounts;

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {data.mock && <div><Badge tone="warning">Mock mode: no real Meta connection</Badge></div>}
      {!data.configured && <Alert tone="warning">Meta is not configured on this server. Connecting is unavailable until the Meta app settings and encryption key are set.</Alert>}
      {banner && <Alert tone={banner.tone}>{banner.text}</Alert>}
      {reason && <p id="meta-reason" className="sr-only">{reason}</p>}

      {pending === "loading" && <Panel><div className="flex flex-col gap-3 p-4" aria-busy="true" aria-label="Loading your Pages"><Skeleton className="h-5 w-48" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div></Panel>}
      {pending && pending !== "loading" && (
        <Panel>
          <PanelHeader title="Choose a Page to connect" description="Pick one Facebook Page. Its Messenger inbox is connected; you can add its linked Instagram account too." />
          <fieldset className="flex flex-col gap-2 p-4 pt-0">
            <legend className="sr-only">Facebook Pages</legend>
            {pending.pages.map((g) => (
              <label key={g.pageId} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-control border border-line-card px-3 py-2 has-[:disabled]:opacity-60">
                <input type="radio" name="page" value={g.pageId} checked={pick.pageId === g.pageId} onChange={() => setPick({ pageId: g.pageId, ig: false })} />
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{g.name}</span><span className="block text-sm text-fg-muted">ID {g.pageId}{g.connected ? " · already connected" : ""}</span></span>
              </label>
            ))}
            {(() => {
              const sel = pending.pages.find((g) => g.pageId === pick.pageId);
              return sel?.instagramAccountId ? <Checkbox label="Also connect the linked Instagram account" checked={pick.ig} onChange={(e) => setPick({ ...pick, ig: e.target.checked })} /> : null;
            })()}
            <div><Button variant="primary" disabled={!pick.pageId} loading={busy === "pick"} onClick={() => void connectSelected()}>Connect Page</Button></div>
          </fieldset>
        </Panel>
      )}

      {done && (
        <Panel>
          <PanelHeader title="Connection result" />
          <ul className="flex flex-col gap-3 p-4 pt-0">
            {done.map((x) => (
              <li key={x.account.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{x.account.displayName ?? x.account.externalAccountId}</span>
                <Badge tone={x.subscription === "subscribed" ? "success" : "warning"}>{x.account.platform === "instagram" ? "Instagram" : "Messenger"}{x.reconnected ? " · reconnected" : ""}</Badge>
                <span className="text-fg-muted">{SUBSCRIPTION[x.subscription]}</span>
                {x.subscription === "failed" && <Button size="sm" loading={busy === x.account.id} onClick={() => void resubscribe(x.account.id)}><RefreshCw className="size-4" aria-hidden />Retry</Button>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Connected accounts</h2>
        {accounts.length > 0 && connectBtn("Connect another")}
      </div>
      {accounts.length === 0 ? (
        <Panel><EmptyState icon={Plug} title="No accounts connected" description="Connect a Facebook Page to receive its Messenger messages here." action={connectBtn("Connect with Meta")} /></Panel>
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.map((a) => (
            <li key={a.id}>
              <Panel>
                <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{a.displayName ?? a.externalAccountId}</span>
                      <Badge>{a.platform === "instagram" ? "Instagram" : "Messenger"}</Badge>
                      <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-fg-muted">ID {a.externalAccountId} · Last token check: {when(a.lastTokenCheckAt)}</p>
                  </div>
                  {canManage && (
                    <div className="flex flex-wrap gap-2">
                      {a.status !== "disabled" && <Button size="sm" loading={busy === a.id} onClick={() => void checkToken(a)}><RefreshCw className="size-4" aria-hidden />Check token</Button>}
                      {a.status !== "connected" && <Button size="sm" disabled={!data.configured} loading={busy === "connect"} onClick={() => void startConnect()}>Reconnect</Button>}
                      {a.status !== "disabled" && <Button size="sm" variant="danger" onClick={() => setConfirm(a)}><Trash2 className="size-4" aria-hidden />Disconnect</Button>}
                    </div>
                  )}
                </div>
              </Panel>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <DialogContent title="Disconnect this account?" description="Its saved token is deleted and new messages stop arriving. Existing conversations are kept. You can reconnect later.">
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="danger" loading={!!confirm && busy === confirm.id} onClick={() => confirm && void disconnect(confirm)}>Disconnect</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
