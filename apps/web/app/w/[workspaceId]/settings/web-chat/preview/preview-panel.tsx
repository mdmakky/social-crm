"use client";
import * as React from "react";
import Link from "next/link";
import { ChevronLeft, MessageSquareText, MessageSquareShare, RotateCcw } from "lucide-react";
import { endpoints, type ChatWidgetDto } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";
import { cn } from "@/lib/cn";

const SIZES = [
  { id: "desktop", label: "Desktop", width: null },
  { id: "tablet", label: "Tablet", width: 768 },
  { id: "mobile", label: "Mobile", width: 375 },
] as const;
type Grant = { grant: string; expiresAt: string };

/**
 * Owner-only preview of the real chat on a made-up page (decision D270). The sample page is our own /widget-preview route in a frame of the chosen width, so the loader sees a real window width
 * (the 375 px sheet appears for real). A short-lived grant from the API lets our own origin use the widget without being added to its allowed sites.
 */
export function PreviewPanel({ workspaceId }: { workspaceId: string }) {
  const back = `/w/${workspaceId}/settings/web-chat`;
  const [items, setItems] = React.useState<ChatWidgetDto[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [widgetId, setWidgetId] = React.useState("");
  const [size, setSize] = React.useState<(typeof SIZES)[number]["id"]>("desktop");
  const [grant, setGrant] = React.useState<Grant | null>(null);
  const [grantError, setGrantError] = React.useState<string | null>(null);
  const [expired, setExpired] = React.useState(false);
  const [shown, setShown] = React.useState<boolean | null>(null);
  const [nonce, setNonce] = React.useState(0);
  const frame = React.useRef<HTMLIFrameElement>(null);

  const loadList = React.useCallback(async () => {
    setLoadError(null);
    const r = await browserApi.call(endpoints.listChatWidgets, { params: { workspaceId } });
    if (!r.ok) { setLoadError(errorMessage(r.error)); return; }
    setItems(r.data.items);
    const asked = new URLSearchParams(window.location.search).get("widget");
    setWidgetId((cur) => cur || r.data.items.find((w) => w.id === asked)?.id || (r.data.items.find((w) => w.enabled) ?? r.data.items[0])?.id || "");
  }, [workspaceId]);
  React.useEffect(() => { void Promise.resolve().then(loadList); }, [loadList]);

  const widget = items?.find((w) => w.id === widgetId) ?? null;

  const mint = React.useCallback(async (id: string) => {
    setGrant(null); setGrantError(null); setExpired(false); setShown(null);
    const r = await browserApi.call(endpoints.createChatWidgetPreview, { params: { workspaceId, widgetId: id } });
    if (!r.ok) { setGrantError(errorMessage(r.error)); return; }
    setGrant(r.data);
    setNonce((n) => n + 1);
  }, [workspaceId]);
  React.useEffect(() => {
    if (widget?.enabled) void Promise.resolve().then(() => mint(widget.id));
    else void Promise.resolve().then(() => { setGrant(null); setGrantError(null); });
  }, [widget?.id, widget?.enabled, mint]);

  React.useEffect(() => {
    if (!grant) return;
    const ms = new Date(grant.expiresAt).getTime() - Date.now() - 15_000;
    const t = setTimeout(() => setExpired(true), Math.max(ms, 0));
    return () => clearTimeout(t);
  }, [grant]);

  React.useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.source === frame.current?.contentWindow && e.data?.type === "crm-preview:status") setShown(Boolean(e.data.shown));
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);

  function reset() {
    if (!widget) return;
    try { localStorage.removeItem(`crm-chat:${widget.publicKey}`); } catch { /* storage blocked: the reload below still starts clean for this tab */ }
    setShown(null);
    setNonce((n) => n + 1);
  }
  const open = () => frame.current?.contentWindow?.postMessage({ type: "crm-preview:open" }, window.location.origin);
  const width = SIZES.find((s) => s.id === size)!.width;
  const src = widget && grant ? `/widget-preview#key=${encodeURIComponent(widget.publicKey)}&grant=${encodeURIComponent(grant.grant)}` : null;

  const backLink = <Button asChild variant="ghost" size="sm"><Link href={back}><ChevronLeft aria-hidden /> Back to web chat settings</Link></Button>;

  if (loadError) return <Panel><ErrorState title="Could not load your chat widgets" description={loadError} onRetry={() => void loadList()} /></Panel>;
  if (items === null) return <Panel className="flex flex-col gap-3 p-4" aria-busy="true"><span className="sr-only" role="status">Loading</span><Skeleton className="h-8 w-64" /><Skeleton className="h-96 w-full" /></Panel>;
  if (items.length === 0) {
    return <Panel><EmptyState icon={MessageSquareText} title="No chat widget yet" description="Add a widget first, then come back to try it." action={<Button asChild variant="primary"><Link href={back}>Go to web chat settings</Link></Button>} /></Panel>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>{backLink}</div>
      <Panel className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          {items.length > 1 && (
            <div className="flex flex-col gap-1">
              <label htmlFor="pv-widget" className="text-sm font-medium text-fg">Widget</label>
              <select id="pv-widget" value={widgetId} onChange={(e) => setWidgetId(e.target.value)} className="h-[var(--control-h)] rounded-control border border-line bg-surface px-2 text-base text-fg pointer-coarse:h-[var(--control-h-touch)]">
                {items.map((w) => <option key={w.id} value={w.id}>{w.name}{w.enabled ? "" : " (off)"}</option>)}
              </select>
            </div>
          )}
          <div role="group" aria-label="Screen size" className="flex flex-col gap-1">
            <span className="text-sm font-medium text-fg">Screen size</span>
            <div className="flex gap-1">
              {SIZES.map((s) => (
                <Button key={s.id} variant={size === s.id ? "primary" : "secondary"} aria-pressed={size === s.id} onClick={() => setSize(s.id)}>{s.label}{s.width ? ` ${s.width}` : ""}</Button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={open} disabled={!src || shown !== true || expired}><MessageSquareShare aria-hidden /> Open widget</Button>
            <Button onClick={reset} disabled={!src}><RotateCcw aria-hidden /> Reset visitor</Button>
          </div>
        </div>
        <p className="text-sm text-fg-muted">Messages you send here are real: they appear in your Inbox as a Web chat user. &quot;Reset visitor&quot; starts a new visitor, so your next message opens a new conversation.</p>
      </Panel>

      {widget && !widget.enabled && (
        <Alert tone="warning">This chat is switched off, so visitors would only see your offline message. <Link href={back} className="font-medium underline">Turn it on in web chat settings</Link> to preview it.</Alert>
      )}
      {grantError && <ErrorState title="Could not start the preview" description={grantError} onRetry={() => widget && void mint(widget.id)} />}
      {expired && <Alert tone="info">The preview timed out after 10 minutes. <button type="button" className="font-medium underline" onClick={() => widget && void mint(widget.id)}>Start it again</button></Alert>}
      {shown === false && !expired && <Alert tone="warning">The chat button did not appear on the sample page. Reload this page and try again.</Alert>}

      {widget?.enabled && !grantError && (
        <div className="rounded-xl border border-line bg-subtle p-3">
          {!src ? (
            <div aria-busy="true" className="flex flex-col gap-3"><span className="sr-only" role="status">Starting the preview</span><Skeleton className="h-[720px] w-full" /></div>
          ) : (
            <>
              {shown === null && <p role="status" className="pb-2 text-sm text-fg-muted">Loading the sample page…</p>}
              <div className={cn("mx-auto w-full overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line transition-[max-width] motion-reduce:transition-none")} style={{ maxWidth: width ?? "100%" }}>
                <iframe key={nonce} ref={frame} title="Sample page with your chat" src={src} className="block h-[720px] w-full border-0" />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
