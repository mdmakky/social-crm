"use client";
import * as React from "react";
import Link from "next/link";
import { Copy, Eye, MessageSquareText, Plus } from "lucide-react";
import { endpoints, type ChatWidgetDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Checkbox, Textarea } from "@/components/ui/form-controls";
import { Input } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";

type Form = { name: string; origins: string; color: string; greeting: string; offline: string; prechat: boolean };
const BLANK: Form = { name: "", origins: "", color: "#2563eb", greeting: "", offline: "", prechat: false };
const toForm = (w: ChatWidgetDto): Form => ({ name: w.name, origins: w.allowedOrigins.join("\n"), color: w.color, greeting: w.greeting ?? "", offline: w.offlineMessage ?? "", prechat: w.prechatForm });
const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const FORMAT = "Use the address of the site: https://www.example.com (no page path, no slash at the end).";
/** One address per line -> the clean origin the server stores (scheme and host, lower case) or a plain reason why not. A site that is not on this list shows no chat at all. */
function parseOrigins(text: string): { origins: string[]; errors: string[] } {
  const origins: string[] = [], errors: string[] = [];
  for (const line of lines(text)) {
    let u: URL | null = null;
    try { u = new URL(line); } catch { /* handled below */ }
    if (!u || !/^https?:$/.test(u.protocol) || !/^https?:\/\/[^/]/i.test(line)) errors.push(`"${line}" is not an address. ${FORMAT}`);
    else if (u.username || u.password || u.search || u.hash || u.pathname.replace(/\/+$/, "") !== "") errors.push(`"${line}" has more than the site address. Remove the page path: ${u.origin}`);
    else if (!origins.includes(u.origin)) origins.push(u.origin);
  }
  return { origins, errors };
}
const snippet =(key: string) => `<script src="${typeof window === "undefined" ? "" : window.location.origin}/widget.js" data-widget-key="${key}" async></script>`;

/** Widget form: used to create and to edit. Origins are one per line, scheme and host only. */
function WidgetForm({ initial, busy, error, submitLabel, onSubmit, onCancel }: { initial: Form; busy: boolean; error: string | null; submitLabel: string; onSubmit: (f: Form) => void; onCancel: () => void }) {
  const [f, setF] = React.useState(initial);
  const [nameErr, setNameErr] = React.useState<string | null>(null);
  const [touched, setTouched] = React.useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const parsed = parseOrigins(f.origins);
  const originErr = touched && parsed.errors.length ? parsed.errors.join(" ") : null;
  return (
    <form
      className="flex flex-col gap-4 px-4 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!f.name.trim()) { setNameErr("Give the widget a name."); return; }
        setNameErr(null);
        if (parsed.errors.length) return;
        onSubmit({ ...f, origins: parsed.origins.join("\n") });
      }}
    >
      <Field label="Name" hint="Only you see this." error={nameErr}>{(p) => <Input {...p} value={f.name} maxLength={80} onChange={(e) => set("name", e.target.value)} />}</Field>
      <div className="flex flex-col gap-1.5">
        <Field label="Sites that may show the chat" hint="One address per line, like https://www.example.com (no page path, no slash at the end). A site that is not on this list shows no chat at all. Add both the www and the plain address if you use both." error={originErr}>
          {(p) => <Textarea {...p} rows={3} value={f.origins} spellCheck={false} placeholder={"https://www.example.com\nhttps://example.com"} onChange={(e) => set("origins", e.target.value)} onBlur={() => setTouched(true)} />}
        </Field>
        {parsed.origins.length > 0 && <p aria-live="polite" className="text-xs text-fg-subtle">Will be saved as: {parsed.origins.join(", ")}</p>}
      </div>
      <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
        <Field label="Color">{(p) => <input {...p} type="color" value={f.color} onChange={(e) => set("color", e.target.value)} className="h-[var(--control-h)] w-full cursor-pointer rounded-control border border-line bg-surface p-1 pointer-coarse:h-[var(--control-h-touch)]" />}</Field>
        <Field label="Greeting" hint="Shown before the visitor writes. Optional.">{(p) => <Input {...p} value={f.greeting} maxLength={300} onChange={(e) => set("greeting", e.target.value)} />}</Field>
      </div>
      <Field label="Message when chat is switched off" hint="Optional.">{(p) => <Input {...p} value={f.offline} maxLength={300} onChange={(e) => set("offline", e.target.value)} />}</Field>
      <Checkbox label="Ask visitors for a name and email first (they can skip)" checked={f.prechat} onChange={(e) => set("prechat", e.target.checked)} />
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={busy}>{submitLabel}</Button>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

function WidgetCard({ w, workspaceId, onChanged }: { w: ChatWidgetDto; workspaceId: string; onChanged: (w: ChatWidgetDto) => void }) {
  const toast = useToast();
  const params = { workspaceId, widgetId: w.id };
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const code = snippet(w.publicKey);

  async function save(f: Form) {
    setBusy("save"); setError(null);
    const r = await browserApi.call(endpoints.updateChatWidget, { params, body: { name: f.name, allowedOrigins: lines(f.origins), color: f.color, greeting: f.greeting, offlineMessage: f.offline, prechatForm: f.prechat } });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    onChanged(r.data); setEditing(false); toast("Saved.");
  }
  async function toggle() {
    setBusy("toggle");
    const r = await browserApi.call(endpoints.updateChatWidget, { params, body: { enabled: !w.enabled } });
    setBusy(null);
    if (!r.ok) { toast(errorMessage(r.error), "error"); return; }
    onChanged(r.data); toast(r.data.enabled ? "Chat is on." : "Chat is off. Visitors see your offline message.");
  }
  async function rotate() {
    if (!window.confirm("Make a new install code? The code on your website stops working until you replace it.")) return;
    setBusy("rotate");
    const r = await browserApi.call(endpoints.rotateChatWidgetKey, { params });
    setBusy(null);
    if (!r.ok) { toast(errorMessage(r.error), "error"); return; }
    onChanged(r.data); toast("New install code ready. Copy it to your website.");
  }
  async function copy() {
    try { await navigator.clipboard.writeText(code); toast("Install code copied."); } catch { toast("Could not copy. Select the code and copy it by hand.", "error"); }
  }

  return (
    <Panel>
      <PanelHeader
        title={w.name}
        description={w.allowedOrigins.length ? w.allowedOrigins.join(", ") : "No sites yet: chat will not load anywhere."}
        actions={<Badge tone={w.enabled ? "success" : "neutral"}>{w.enabled ? "On" : "Off"}</Badge>}
      />
      {editing ? (
        <WidgetForm initial={toForm(w)} busy={busy === "save"} error={error} submitLabel="Save changes" onSubmit={save} onCancel={() => { setEditing(false); setError(null); }} />
      ) : (
        <div className="flex flex-col gap-4 px-4 py-4">
          <div className="flex flex-wrap items-center gap-3 rounded-control bg-subtle px-3 py-3">
            <Button asChild variant="primary"><Link href={`/w/${workspaceId}/settings/web-chat/preview?widget=${w.id}`}><Eye aria-hidden /> Preview on a sample page</Link></Button>
            <p className="text-sm text-fg-muted">Try the chat on a made-up page first. No need to install anything.</p>
          </div>
          <div>
            <p className="text-sm font-medium text-fg" id={`snip-${w.id}`}>Install code</p>
            <p className="mt-0.5 text-sm text-fg-subtle">Paste this before the closing &lt;/body&gt; tag of your website.</p>
            <pre aria-labelledby={`snip-${w.id}`} tabIndex={0} className="mt-2 overflow-x-auto rounded-control bg-subtle px-3 py-2 text-xs text-fg"><code>{code}</code></pre>
          </div>
          {w.allowedOrigins.length === 0 && <Alert tone="warning">Add the address of your website first. Until then the chat will not appear.</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void copy()}><Copy aria-hidden /> Copy install code</Button>
            <Button onClick={() => setEditing(true)}>Edit</Button>
            <Button onClick={() => void toggle()} loading={busy === "toggle"}>{w.enabled ? "Turn off" : "Turn on"}</Button>
          </div>
          <details className="text-sm text-fg-muted">
            <summary className="cursor-pointer font-medium text-fg">Technical details</summary>
            <div className="mt-2 flex flex-col gap-2">
              <p>Widget key: <code className="break-all text-xs">{w.publicKey}</code></p>
              <p>The chat loads in a frame from this app. Browsers only show it on the sites listed above. Visitors have a private session code stored in their browser, valid for 30 days of activity.</p>
              <p>New messages appear within a few seconds (the chat checks every 3 seconds while open). There is no instant push yet. Visitors can only send text.</p>
              <div><Button size="sm" variant="danger" onClick={() => void rotate()} loading={busy === "rotate"}>Make a new install code</Button></div>
            </div>
          </details>
        </div>
      )}
    </Panel>
  );
}

export function WebChatPanel({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [items, setItems] = React.useState<ChatWidgetDto[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fetchAll = React.useCallback(() => browserApi.call(endpoints.listChatWidgets, { params: { workspaceId } }), [workspaceId]);
  const apply = (r: Awaited<ReturnType<typeof fetchAll>>) => {
    if (!r.ok) { setLoadError(errorMessage(r.error)); return; }
    setLoadError(null);
    setItems(r.data.items);
  };
  const load = async () => apply(await fetchAll());
  React.useEffect(() => { void fetchAll().then(apply); }, [fetchAll]); // eslint-disable-line react-hooks/exhaustive-deps

  async function create(f: Form) {
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.createChatWidget, { params: { workspaceId }, body: { name: f.name, allowedOrigins: lines(f.origins), color: f.color, greeting: f.greeting, offlineMessage: f.offline, prechatForm: f.prechat } });
    setBusy(false);
    if (!r.ok) { setError(r.error.code === "too_many_widgets" ? r.error.message ?? errorMessage(r.error) : errorMessage(r.error)); return; }
    setItems((cur) => [r.data, ...(cur ?? [])]); setCreating(false); toast("Widget created. Copy its install code to your website.");
  }

  return (
    <div className="flex flex-col gap-[var(--page-gap)]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warning">Not tested on real sites</Badge>
        <p className="text-sm text-fg-subtle">Checked only against our own test pages so far. Try it on a staging page first.</p>
      </div>
      {loadError ? <Panel><ErrorState title="Could not load web chat" description={loadError} onRetry={() => void load()} /></Panel>
        : items === null ? <Panel className="flex flex-col gap-3 p-4" aria-busy="true"><span className="sr-only" role="status">Loading</span><Skeleton className="h-5 w-40" /><Skeleton className="h-20 w-full" /></Panel>
        : (
          <>
            {creating ? (
              <Panel>
                <PanelHeader title="New widget" />
                <WidgetForm initial={BLANK} busy={busy} error={error} submitLabel="Create widget" onSubmit={create} onCancel={() => { setCreating(false); setError(null); }} />
              </Panel>
            ) : items.length === 0 ? (
              <Panel><EmptyState icon={MessageSquareText} title="No chat widget yet" description="Add one, paste its code into your website, and visitors can write to you." action={<Button variant="primary" onClick={() => setCreating(true)}><Plus aria-hidden /> Add widget</Button>} /></Panel>
            ) : (
              <div><Button variant="primary" onClick={() => setCreating(true)}><Plus aria-hidden /> Add widget</Button></div>
            )}
            {items.map((w) => <WidgetCard key={w.id} w={w} workspaceId={workspaceId} onChanged={(n) => setItems((cur) => (cur ?? []).map((x) => (x.id === n.id ? n : x)))} />)}
          </>
        )}
    </div>
  );
}
