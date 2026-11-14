"use client";
import * as React from "react";
import { Camera, ChevronLeft, MessageCircle, Phone, Plug, RefreshCw, Send, Trash2, type LucideIcon } from "lucide-react";
import { endpoints, MESSENGER_WEBHOOK_FIELDS, type ConnectMetaResult, type IntegrationAccountDto, type MetaAccountEvents, type MetaIntegrationState, type MetaPendingList } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/form-controls";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { cn } from "@/lib/cn";

type ChannelKey = "messenger" | "instagram" | "whatsapp" | "telegram";
type Channel = { key: ChannelKey; label: string; blurb: string; icon: LucideIcon; platform?: "messenger" | "instagram"; soon?: string };

/** One entry per channel. A channel without `platform` is not built: it is listed honestly as coming soon, with the reason. */
export const CHANNELS: Channel[] = [
  { key: "messenger", label: "Messenger", blurb: "Receive and answer messages sent to your Facebook Pages.", icon: MessageCircle, platform: "messenger" },
  { key: "instagram", label: "Instagram", blurb: "Receive and answer direct messages sent to your Instagram professional account.", icon: Camera, platform: "instagram" },
  { key: "whatsapp", label: "WhatsApp", blurb: "Business messaging on WhatsApp.", icon: Phone, soon: "Not available yet. The receiving side (webhook) for WhatsApp is built, but you cannot connect a WhatsApp number or send messages from here yet. Connecting comes first, then replying." },
  { key: "telegram", label: "Telegram", blurb: "Bot messaging on Telegram.", icon: Send, soon: "Not available yet. It will connect through a Telegram bot that you create." },
];
const isChannel = (v: string | undefined): v is ChannelKey => CHANNELS.some((c) => c.key === v);

type Props = { workspaceId: string; canManage: boolean; initial: MetaIntegrationState | null; result?: string; channel?: string };

/** What the OAuth callback redirect (?meta=...) means, in plain language. "select" and "no_pages" are handled by the picker. */
const RESULT: Record<string, { tone: "error" | "warning" | "info"; text: string }> = {
  denied: { tone: "warning", text: "The Meta login was cancelled. Nothing was connected." },
  error: { tone: "error", text: "Meta could not complete the login. Nothing was connected. Try again." },
  invalid_state: { tone: "error", text: "That login link expired or was not started from this browser. Start the connection again." },
  forbidden: { tone: "error", text: "Only owners and admins can connect Meta accounts." },
  no_pages: { tone: "warning", text: "Meta returned no Pages for this login. Make sure you have access to a Page and approved it in the Meta dialog." },
  not_configured: { tone: "warning", text: "Meta is not configured on this server." },
  ig_connected: { tone: "info", text: "Instagram account connected directly (no Facebook Page). Its webhook subscription was accepted." },
  ig_connected_unsubscribed: { tone: "warning", text: "Instagram account connected, but Instagram did not accept the webhook subscription. New messages may not arrive until it is re-checked (see Webhook subscription below)." },
  ig_no_accounts: { tone: "warning", text: "No Instagram account was shared in the login. Connect again and select the Instagram account (it must be a Business or Creator account) in the Meta dialog." },
  ig_partial: { tone: "warning", text: "Some Instagram accounts were connected; others were skipped (already connected to another workspace, could not be saved, or more than 10 were shared). Connect again to retry the rest." },
  account_unavailable: { tone: "error", text: "That Instagram account is already connected to another workspace, so it can't be connected here." },
};
const SUBSCRIPTION = { subscribed: "Webhook subscribed", failed: "Webhook subscription failed", dashboard_required: "Instagram webhook fields must be enabled in the Meta app dashboard (UNVERIFIED)" } as const;
const STATUS: Record<IntegrationAccountDto["status"], { label: string; tone: "success" | "warning" | "neutral" }> = {
  connected: { label: "Connected", tone: "success" }, reauth_required: { label: "Reconnect needed", tone: "warning" }, disabled: { label: "Disconnected", tone: "neutral" },
};
/** Local date/time. The server cannot know the browser locale or time zone, so this text legitimately differs between SSR and the client: suppressHydrationWarning marks that one element as expected. */
function LocalTime({ iso, fallback = "Never" }: { iso: string | null; fallback?: string }) {
  return <time dateTime={iso ?? undefined} suppressHydrationWarning>{iso ? new Date(iso).toLocaleString() : fallback}</time>;
}

export function MetaIntegrations(p: Props) {
  return <ToastProvider><Inner {...p} /></ToastProvider>;
}

function Inner({ workspaceId, canManage, initial, result, channel: initialChannel }: Props) {
  const toast = useToast();
  const params = { workspaceId };
  const [data, setData] = React.useState<MetaIntegrationState | null>(initial);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<MetaPendingList | null | "loading">(result === "select" ? "loading" : null);
  const [pick, setPick] = React.useState<{ pageId: string; ig: boolean }>({ pageId: "", ig: false });
  const [done, setDone] = React.useState<ConnectMetaResult["accounts"] | null>(null);
  const [confirm, setConfirm] = React.useState<IntegrationAccountDto | null>(null);
  // The dialog is opened from a row button; closing it must return keyboard focus there (a controlled Dialog has no Trigger to do it).
  const opener = React.useRef<HTMLElement | null>(null);
  const [banner, setBanner] = React.useState(result && RESULT[result] ? RESULT[result] : null);
  // `selected` is what the detail pane shows. null on a phone means "show the channel list"; from md up the rail is always visible and falls back to Messenger.
  const [selected, setSelected] = React.useState<ChannelKey | null>(isChannel(initialChannel) ? initialChannel : result ? "messenger" : null);
  const [events, setEvents] = React.useState<Record<string, MetaAccountEvents["items"] | "error">>({});
  const [resub, setResub] = React.useState<Record<string, keyof typeof SUBSCRIPTION>>({});
  const active = CHANNELS.find((c) => c.key === (selected ?? "messenger"))!;

  const reload = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.getMetaIntegration, { params });
    if (r.ok) setData(r.data);
    return r.ok;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const choose = (k: ChannelKey | null) => {
    setSelected(k);
    window.history.replaceState(null, "", k ? `${window.location.pathname}?channel=${k}` : window.location.pathname);
  };

  // After the Meta dialog the callback redirects here with ?meta=select; load the discovered Pages, then drop the query so a refresh does not repeat it.
  React.useEffect(() => {
    if (result) window.history.replaceState(null, "", `${window.location.pathname}?channel=${isChannel(initialChannel) ? initialChannel : "messenger"}`);
    if (result !== "select") return;
    void browserApi.call(endpoints.listMetaPending, { params }).then((r) => {
      if (!r.ok) { setBanner({ tone: "error", text: "The Meta login expired. Connect again." }); setPending(null); return; }
      setPending(r.data);
      setPick({ pageId: r.data.pages.find((x) => x.eligible && !x.connected)?.pageId ?? r.data.pages.find((x) => x.eligible)?.pageId ?? "", ig: false });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recent activity for the accounts shown in the current pane (owner/admin only: the events are an admin audit trail).
  const shown = React.useMemo(() => (data?.accounts ?? []).filter((a) => a.platform === active.platform), [data, active.platform]);
  const shownKey = shown.map((a) => `${a.id}:${a.status}:${a.lastTokenCheckAt ?? ""}`).join("|");
  React.useEffect(() => {
    if (!canManage) return;
    for (const a of shown.slice(0, 3)) {
      void browserApi.call(endpoints.listMetaAccountEvents, { params: { workspaceId, accountId: a.id } }).then((r) => setEvents((e) => ({ ...e, [a.id]: r.ok ? r.data.items.slice(0, 5) : "error" })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey, canManage]);

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
    if (!r.ok) { toast(r.error.code === "account_unavailable" ? "This Page can't be connected to this workspace." : r.error.code === "page_task_missing" ? "Your role on this Page cannot send messages as the Page." : errorMessage(r.error), "error"); return; }
    setDone(r.data.accounts);
    setPending(null);
    toast("Connected");
    await reload();
  }
  async function startInstagramUnified() {
    setBusy("ig-connect");
    const r = await browserApi.call(endpoints.startInstagramUnified, { params });
    if (!r.ok) { setBusy(null); toast(r.error.code === "integration_not_configured" ? "Direct Instagram connection is not configured on this server." : errorMessage(r.error), "error"); return; }
    window.location.assign(r.data.authUrl);
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
    setBusy(`sub:${id}`);
    const r = await browserApi.call(endpoints.resubscribeMetaAccount, { params: { ...params, accountId: id } });
    setBusy(null);
    if (!r.ok) { toast(errorMessage(r.error), "error"); return; }
    setResub((s) => ({ ...s, [id]: r.data.subscription }));
    setDone((d) => d?.map((x) => (x.account.id === id ? { ...x, subscription: r.data.subscription } : x)) ?? null);
    toast(SUBSCRIPTION[r.data.subscription], r.data.subscription === "failed" ? "error" : "success");
    await reload();
  }
  function closeConfirm() {
    setConfirm(null);
    const el = opener.current;
    if (el) window.setTimeout(() => { if (el.isConnected) el.focus(); }, 0);
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
  const igReason = reason ?? (!data.instagramUnifiedConfigured ? "Direct Instagram connection is not configured on this server." : undefined);
  /** Instagram has two independent ways in; both are always shown side by side so the choice is explicit. */
  const instagramConnect = (compact = false) => (
    <div className={cn("grid gap-3", compact ? "" : "sm:grid-cols-2")}>
      <div className="flex flex-col gap-2 rounded-control border border-line-card p-3">
        <p className="text-sm font-medium text-fg">With a Facebook Page</p>
        <p className="text-sm text-fg-subtle">For an Instagram professional account that is linked to a Facebook Page. Also connects the Page&apos;s Messenger inbox.</p>
        <div>{connectBtn("Connect with Facebook Page", "secondary")}</div>
      </div>
      <div className="flex flex-col gap-2 rounded-control border border-line-card p-3">
        <p className="text-sm font-medium text-fg">Directly, without a Facebook Page</p>
        <p className="text-sm text-fg-subtle">For Business or Creator accounts that are not linked to any Page. You sign in with Instagram and choose the account to share.</p>
        <div><Button variant="primary" disabled={!!igReason} loading={busy === "ig-connect"} onClick={() => void startInstagramUnified()} title={igReason} aria-describedby={igReason ? "ig-reason" : undefined}><Plug className="size-4" aria-hidden />Connect Instagram</Button></div>
        {igReason && <p id="ig-reason" className="text-sm text-fg-subtle">{igReason}</p>}
      </div>
    </div>
  );
  const live = (platform: "messenger" | "instagram") => data.accounts.filter((a) => a.platform === platform && a.status !== "disabled");
  const railState = (c: Channel): { sub: string; dot: "ok" | "warn" | "idle" | "soon" } => {
    if (!c.platform) return { sub: "Coming soon", dot: "soon" };
    const l = live(c.platform);
    if (l.some((a) => a.status === "reauth_required")) return { sub: "Reconnect needed", dot: "warn" };
    if (l.length) return { sub: c.platform === "messenger" ? `${l.length} ${l.length === 1 ? "Page" : "Pages"} connected` : `${l.length} connected`, dot: "ok" };
    return { sub: "Not connected", dot: "idle" };
  };

  return (
    <div className="flex flex-col gap-4">
      {data.mock && <div><Badge tone="warning">Mock mode: no real Meta connection</Badge></div>}
      {!data.configured && <Alert tone="warning">Meta is not configured on this server. Connecting is unavailable until the Meta app settings and encryption key are set.</Alert>}
      {banner && <Alert tone={banner.tone}>{banner.text}</Alert>}
      {reason && <p id="meta-reason" className="sr-only">{reason}</p>}

      <div className="grid gap-5 md:grid-cols-[13rem_minmax(0,1fr)] lg:grid-cols-[15rem_minmax(0,1fr)]">
        {/* Channel rail: a plain list on the canvas, not a panel. On a phone it is the list screen; selecting a channel swaps it for the detail screen. */}
        <nav aria-label="Channels" className={cn("flex-col gap-1", selected ? "hidden md:flex" : "flex")}>
          {CHANNELS.map((c) => {
            const st = railState(c);
            const sel = c.key === active.key;
            return (
              <button key={c.key} type="button" aria-current={sel ? "page" : undefined} onClick={() => choose(c.key)}
                className={cn("flex min-h-12 w-full items-center gap-3 rounded-control border px-3 py-2 text-left transition-colors", sel ? "border-line-card bg-surface shadow-sheet" : "border-transparent hover:bg-hover", !c.platform && "text-fg-subtle")}>
                <span className={cn("grid size-9 flex-none place-items-center rounded-control", c.platform && st.dot === "ok" ? "bg-accent-subtle text-accent-fg" : "bg-hover text-fg-subtle")}><c.icon className="size-5" aria-hidden /></span>
                <span className="min-w-0 flex-1"><span className="block truncate font-medium text-fg">{c.label}</span><span className="block truncate text-sm text-fg-subtle">{st.sub}</span></span>
                {st.dot === "soon" ? <Badge className="border border-dashed border-line-strong bg-transparent text-fg-subtle">Soon</Badge>
                  : <span className="inline-flex items-center gap-1.5"><span aria-hidden className={cn("size-2 rounded-full", st.dot === "ok" ? "bg-success-fg" : st.dot === "warn" ? "bg-warning-fg" : "bg-fg-disabled")} /><span className="sr-only">{st.sub}</span></span>}
              </button>
            );
          })}
        </nav>

        <div className={cn("min-w-0", selected ? "" : "hidden md:block")}>
          <button type="button" onClick={() => choose(null)} className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-accent-fg md:hidden"><ChevronLeft className="size-4" aria-hidden />Integrations</button>
          <Panel>
            <div className="flex flex-wrap items-center gap-3 border-b border-line-card px-4 py-3">
              <span className="grid size-9 flex-none place-items-center rounded-control bg-accent-subtle text-accent-fg"><active.icon className="size-5" aria-hidden /></span>
              <div className="min-w-[12rem] flex-1"><h2 className="text-base font-semibold text-fg">{active.label}</h2><p className="text-sm text-fg-subtle">{active.blurb}</p></div>
              {active.platform === "messenger" && live("messenger").length > 0 && <div className="w-full sm:w-auto [&>button]:w-full sm:[&>button]:w-auto">{connectBtn("Connect another Page", "primary")}</div>}
            </div>

            {!active.platform ? (
              <div className="flex flex-col gap-3 p-4">
                <Alert tone="info">{active.soon}</Alert>
                <div><Button disabled aria-describedby="soon-reason"><Plug className="size-4" aria-hidden />Connect {active.label}</Button><p id="soon-reason" className="mt-2 text-sm text-fg-subtle">Unavailable: this channel is not built yet.</p></div>
              </div>
            ) : (
              <div className="flex flex-col">
                {pending === "loading" && <section aria-busy="true" aria-label="Loading your Pages" className="flex flex-col gap-3 border-b border-line-card p-4"><Skeleton className="h-5 w-48" /><Skeleton className="h-10" /><Skeleton className="h-10" /></section>}
                {pending && pending !== "loading" && (
                  <section className="border-b border-line-card">
                    <PanelHeader title="Choose a Page to connect" description="Pick one Facebook Page. Its Messenger inbox is connected; tick the box to add its linked Instagram professional account too." />
                    <fieldset className="flex flex-col gap-2 p-4">
                      <legend className="sr-only">Facebook Pages</legend>
                      {pending.pages.map((g) => (
                        <label key={g.pageId} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-control border border-line-card px-3 py-2 has-[:disabled]:opacity-60">
                          <input type="radio" name="page" value={g.pageId} disabled={!g.eligible} checked={pick.pageId === g.pageId} onChange={() => setPick({ pageId: g.pageId, ig: active.platform === "instagram" && !!g.instagramAccountId })} />
                          <span className="min-w-0 flex-1"><span className="block truncate font-medium">{g.name}</span><span className="block text-sm text-fg-muted">ID {g.pageId}{g.connected ? " · already connected" : ""}</span>{g.instagramAccountId && <span className="block text-sm text-fg-muted">Instagram: {g.instagram?.username ? `@${g.instagram.username}` : `ID ${g.instagramAccountId}`}{g.instagramConnected ? " · already connected" : ""}</span>}{!g.instagramAccountId && active.platform === "instagram" && <span className="block text-sm text-fg-subtle">No Instagram professional account is linked to this Page.</span>}{!g.eligible && g.ineligibleReason && <span className="block text-sm text-warning-fg">{g.ineligibleReason}</span>}</span>
                        </label>
                      ))}
                      {(() => {
                        const sel = pending.pages.find((g) => g.pageId === pick.pageId);
                        return sel?.instagramAccountId ? <Checkbox label={`Also connect the linked Instagram account${sel.instagram?.username ? ` (@${sel.instagram.username})` : ""}`} checked={pick.ig} onChange={(e) => setPick({ ...pick, ig: e.target.checked })} /> : null;
                      })()}
                      <div><Button variant="primary" disabled={!pick.pageId} loading={busy === "pick"} onClick={() => void connectSelected()}>Connect Page</Button></div>
                    </fieldset>
                  </section>
                )}
                {done && (
                  <section className="border-b border-line-card">
                    <PanelHeader title="Connection result" />
                    <ul className="flex flex-col gap-3 p-4">
                      {done.map((x) => (
                        <li key={x.account.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">{x.account.displayName ?? x.account.externalAccountId}</span>
                          <Badge tone={x.subscription === "subscribed" ? "success" : "warning"}>{x.account.platform === "instagram" ? "Instagram" : "Messenger"}{x.reconnected ? " · reconnected" : ""}</Badge>
                          <span className="text-fg-muted">{SUBSCRIPTION[x.subscription]}</span>
                          {x.subscription === "failed" && <Button size="sm" loading={busy === `sub:${x.account.id}`} onClick={() => void resubscribe(x.account.id)}><RefreshCw className="size-4" aria-hidden />Retry</Button>}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                <section aria-labelledby="accts" className="border-b border-line-card">
                  <h3 id="accts" className="px-4 pt-4 text-sm font-semibold text-fg">{active.platform === "messenger" ? "Connected Pages" : "Connected accounts"}</h3>
                  {shown.length === 0 ? (
                    <EmptyState icon={active.icon} title={`No ${active.label} account connected`}
                      description={active.platform === "messenger" ? "Connect a Facebook Page to receive its Messenger messages here." : "Connect an Instagram Business or Creator account either through the Facebook Page it is linked to, or directly with Instagram if it has no Page. Turn on “Allow access to messages” in Instagram first."}
                      action={active.platform === "instagram" ? undefined : connectBtn("Connect with Meta")} />
                  ) : (
                    <ul className="flex flex-col divide-y divide-line-card">
                      {shown.map((a) => (
                        <li key={a.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2"><span className="truncate font-medium">{a.displayName ?? a.externalAccountId}</span><Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>{a.platform === "instagram" && <Badge shape="square">{a.authMethod === "unified" ? "Direct · no Page" : "Via Facebook Page"}</Badge>}</div>
                            <p className="mt-1 text-sm text-fg-muted">ID {a.externalAccountId} · Last token check: <LocalTime iso={a.lastTokenCheckAt} /></p>
                            {a.status === "reauth_required" && <p className="mt-2 rounded-control bg-warning-bg px-3 py-2 text-sm text-warning-fg">Meta stopped accepting this connection, so new messages are not arriving. Reconnect to resume.</p>}
                          </div>
                          {canManage && (
                            <div className="flex flex-wrap gap-2">
                              {a.status !== "disabled" && <Button size="sm" loading={busy === a.id} onClick={() => void checkToken(a)}><RefreshCw className="size-4" aria-hidden />Check token</Button>}
                              {a.status !== "connected" && <Button size="sm" variant={a.status === "reauth_required" ? "primary" : "secondary"} disabled={!data.configured} loading={busy === (a.authMethod === "unified" ? "ig-connect" : "connect")} onClick={() => void (a.authMethod === "unified" ? startInstagramUnified() : startConnect())}>Reconnect</Button>}
                              {a.status !== "disabled" && <Button size="sm" variant="danger" onClick={(e) => { opener.current = e.currentTarget; setConfirm(a); }}><Trash2 className="size-4" aria-hidden />Disconnect</Button>}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {active.platform === "instagram" && (
                  <section aria-labelledby="igc" className="border-b border-line-card p-4">
                    <h3 id="igc" className="mb-3 text-sm font-semibold text-fg">{live("instagram").length ? "Connect another Instagram account" : "Connect an Instagram account"}</h3>
                    {instagramConnect()}
                  </section>
                )}

                <section aria-labelledby="wh" className="border-b border-line-card p-4">
                  <h3 id="wh" className="text-sm font-semibold text-fg">Webhook subscription</h3>
                  {active.platform === "messenger" ? (
                    <>
                      <p className="mt-1 text-sm text-fg-subtle">Requested from Meta when a Page is connected:</p>
                      <ul className="mt-2 flex flex-wrap gap-1.5">{MESSENGER_WEBHOOK_FIELDS.map((f) => <li key={f}><Badge shape="square">{f}</Badge></li>)}</ul>
                      {canManage && shown.filter((a) => a.status === "connected").map((a) => (
                        <div key={a.id} className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">{a.displayName ?? a.externalAccountId}</span>
                          <Button size="sm" loading={busy === `sub:${a.id}`} onClick={() => void resubscribe(a.id)}><RefreshCw className="size-4" aria-hidden />Re-check subscription</Button>
                          {resub[a.id] && <Badge tone={resub[a.id] === "subscribed" ? "success" : "warning"}>{SUBSCRIPTION[resub[a.id]!]}</Badge>}
                        </div>
                      ))}
                    </>
                  ) : (
                    <>
                      <p className="mt-1 text-sm text-fg-subtle">Accounts connected through a Facebook Page: webhook fields cannot be set from here and must be enabled in the Meta app dashboard (UNVERIFIED until a real Instagram message is delivered). Accounts connected directly (no Page) are subscribed from here.</p>
                      {canManage && shown.filter((a) => a.status === "connected" && a.authMethod === "unified").map((a) => (
                        <div key={a.id} className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">{a.displayName ?? a.externalAccountId}</span>
                          <Button size="sm" loading={busy === `sub:${a.id}`} onClick={() => void resubscribe(a.id)}><RefreshCw className="size-4" aria-hidden />Re-check subscription</Button>
                          {resub[a.id] && <Badge tone={resub[a.id] === "subscribed" ? "success" : "warning"}>{SUBSCRIPTION[resub[a.id]!]}</Badge>}
                        </div>
                      ))}
                    </>
                  )}
                </section>

                {canManage && shown.length > 0 && (
                  <section aria-labelledby="act" className="p-4">
                    <h3 id="act" className="text-sm font-semibold text-fg">Recent activity</h3>
                    <div className="mt-2 flex flex-col gap-3">
                      {shown.slice(0, 3).map((a) => {
                        const ev = events[a.id];
                        return (
                          <div key={a.id}>
                            {shown.length > 1 && <p className="text-sm font-medium text-fg-muted">{a.displayName ?? a.externalAccountId}</p>}
                            {!ev ? <Skeleton className="mt-1 h-5 w-64" /> : ev === "error" ? <p className="text-sm text-fg-subtle">Activity could not be loaded.</p> : ev.length === 0 ? <p className="text-sm text-fg-subtle">No activity yet.</p> : (
                              <ul className="divide-y divide-line-card text-sm">{ev.map((e) => <li key={e.id} className="flex gap-3 py-1.5"><span className="w-36 flex-none text-fg-subtle"><LocalTime iso={e.createdAt} /></span><span>{e.summary}</span></li>)}</ul>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}
              </div>
            )}
          </Panel>
        </div>
      </div>

      <Dialog open={!!confirm} onOpenChange={(o) => { if (!o) closeConfirm(); }}>
        <DialogContent title="Disconnect this account?" description="Its saved token is deleted and new messages stop arriving. Existing conversations are kept. You can reconnect later.">
          <div className="flex justify-end gap-2">
            <Button onClick={closeConfirm}>Cancel</Button>
            <Button variant="danger" loading={!!confirm && busy === confirm.id} onClick={() => confirm && void disconnect(confirm)}>Disconnect</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
