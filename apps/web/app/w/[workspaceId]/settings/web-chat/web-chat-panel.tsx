"use client";
import * as React from "react";
import Link from "next/link";
import { Copy, Eye, MessageSquareText, Plus } from "lucide-react";
import { endpoints, type ChatWidgetDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Checkbox, Textarea } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { WidgetMock } from "./widget-mock";

type Form = { name: string; origins: string; color: string; greeting: string; offline: string; prechat: boolean; avatar: string; subtitle: string; position: "left" | "right"; q: [string, string, string]; away: boolean; awayText: string; lang: "en" | "bn" };
const BLANK: Form = { name: "", origins: "", color: "#2563eb", greeting: "", offline: "", prechat: false, avatar: "", subtitle: "We reply here", position: "right", q: ["", "", ""], away: false, awayText: "", lang: "en" };
const toForm = (w: ChatWidgetDto): Form => ({
  name: w.name, origins: w.allowedOrigins.join("\n"), color: w.color, greeting: w.greeting ?? "", offline: w.offlineMessage ?? "", prechat: w.prechatForm,
  avatar: w.avatarUrl ?? "", subtitle: w.subtitle, position: w.position, q: [w.quickReplies[0] ?? "", w.quickReplies[1] ?? "", w.quickReplies[2] ?? ""], away: w.awayMode, awayText: w.awayText ?? "", lang: w.defaultLanguage,
});
/** The part of the form the API stores. Empty quick replies are dropped. */
const toBody = (f: Form) => ({
  name: f.name, allowedOrigins: lines(f.origins), color: f.color, greeting: f.greeting, offlineMessage: f.offline, prechatForm: f.prechat,
  avatarUrl: f.avatar, subtitle: f.subtitle, position: f.position, quickReplies: f.q.map((x) => x.trim()).filter(Boolean), awayMode: f.away, awayText: f.awayText, defaultLanguage: f.lang,
});
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

/** Widget form: used to create and to edit. Origins are one per line, scheme and host only. The picture on the right is a live preview of what visitors will see. */
function WidgetForm({ initial, busy, error, submitLabel, onSubmit, onCancel }: { initial: Form; busy: boolean; error: string | null; submitLabel: string; onSubmit: (f: Form) => void; onCancel: () => void }) {
  const [f, setF] = React.useState(initial);
  const [errs, setErrs] = React.useState<Partial<Record<"name" | "avatar" | "subtitle", string>>>({});
  const [touched, setTouched] = React.useState(false);
  const [shownAvatar, setShownAvatar] = React.useState(initial.avatar);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const setQ = (i: number, v: string) => setF((x) => ({ ...x, q: x.q.map((y, j) => (j === i ? v : y)) as Form["q"] }));
  const parsed = parseOrigins(f.origins);
  const originErr = touched && parsed.errors.length ? parsed.errors.join(" ") : null;
  const avatarOk = (v: string) => { const x = v.trim(); if (!x) return true; try { const u = new URL(x); return u.protocol === "https:" && !u.username && !u.password && x.length <= 500; } catch { return false; } };
  return (
    <form
      className="grid gap-6 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        const next: typeof errs = {};
        if (!f.name.trim()) next.name = "Give the widget a name.";
        if (!avatarOk(f.avatar)) next.avatar = "Use a picture address that starts with https:// (up to 500 characters), or leave it empty.";
        if (!f.subtitle.trim()) next.subtitle = "Write a short line, like: We reply here";
        setErrs(next);
        if (Object.keys(next).length || parsed.errors.length) return;
        onSubmit({ ...f, origins: parsed.origins.join("\n") });
      }}
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" hint="Shown at the top of the chat." error={errs.name}>{(p) => <Input {...p} value={f.name} maxLength={80} onChange={(e) => set("name", e.target.value)} />}</Field>
        <div className="flex flex-col gap-1.5">
          <Field label="Sites that may show the chat" hint="One address per line, like https://www.example.com (no page path, no slash at the end). A site that is not on this list shows no chat at all. Add both the www and the plain address if you use both." error={originErr}>
            {(p) => <Textarea {...p} rows={3} value={f.origins} spellCheck={false} placeholder={"https://www.example.com\nhttps://example.com"} onChange={(e) => set("origins", e.target.value)} onBlur={() => setTouched(true)} />}
          </Field>
          {parsed.origins.length > 0 && <p aria-live="polite" className="text-xs text-fg-subtle">Will be saved as: {parsed.origins.join(", ")}</p>}
        </div>
        <Field label="Picture address" hint="Optional. A square logo or photo at an https:// address. Empty: the first letter of the name." error={errs.avatar}>
          {(p) => <Input {...p} type="url" inputMode="url" value={f.avatar} maxLength={500} placeholder="https://example.com/logo.png" onChange={(e) => set("avatar", e.target.value)} onBlur={() => setShownAvatar(avatarOk(f.avatar) ? f.avatar : "")} />}
        </Field>
        <Field label="Line under the name" hint="A short note, up to 60 characters. Do not promise a reply time." error={errs.subtitle}>{(p) => <Input {...p} value={f.subtitle} maxLength={60} onChange={(e) => set("subtitle", e.target.value)} />}</Field>
        <Field label="Greeting" hint="The big line when the chat opens, up to 90 characters. Optional.">{(p) => <Input {...p} value={f.greeting} maxLength={90} onChange={(e) => set("greeting", e.target.value)} />}</Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-fg">Quick replies</legend>
          <p className="text-xs text-fg-subtle">Up to three questions visitors can tap to start. Up to 30 characters each. Text only.</p>
          {[0, 1, 2].map((i) => <Input key={i} aria-label={`Quick reply ${i + 1}`} value={f.q[i]} maxLength={30} onChange={(e) => setQ(i, e.target.value)} />)}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Color">{(p) => <input {...p} type="color" value={f.color} onChange={(e) => set("color", e.target.value)} className="h-[var(--control-h)] w-full cursor-pointer rounded-control border border-line bg-surface p-1 pointer-coarse:h-[var(--control-h-touch)]" />}</Field>
          <Field label="Position">{(p) => <Select {...p} value={f.position} onChange={(e) => set("position", e.target.value as Form["position"])}><option value="right">Bottom right</option><option value="left">Bottom left</option></Select>}</Field>
          <Field label="Language" hint="Visitors can switch.">{(p) => <Select {...p} value={f.lang} onChange={(e) => set("lang", e.target.value as Form["lang"])}><option value="en">English</option><option value="bn">Bangla</option></Select>}</Field>
        </div>
        <Checkbox label="Show an away notice that asks for an email (you turn it on and off yourself)" checked={f.away} onChange={(e) => set("away", e.target.checked)} />
        {f.away && <Field label="Away notice" hint="Up to 160 characters. Optional. Visitors can still send messages.">{(p) => <Input {...p} value={f.awayText} maxLength={160} onChange={(e) => set("awayText", e.target.value)} />}</Field>}
        <Field label="Message when chat is switched off" hint="Optional.">{(p) => <Input {...p} value={f.offline} maxLength={300} onChange={(e) => set("offline", e.target.value)} />}</Field>
        <Checkbox label="Ask visitors for a name and email first (they can skip)" checked={f.prechat} onChange={(e) => set("prechat", e.target.checked)} />
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={busy}>{submitLabel}</Button>
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        </div>
      </div>
      <div className="lg:sticky lg:top-4 lg:self-start">
        <p className="mb-2 text-sm font-medium text-fg">Preview</p>
        <WidgetMock v={{ name: f.name, color: f.color, avatar: shownAvatar, subtitle: f.subtitle, greeting: f.greeting, position: f.position, quick: f.q, away: f.away, awayText: f.awayText, lang: f.lang }} />
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
    const r = await browserApi.call(endpoints.updateChatWidget, { params, body: toBody(f) });
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
    const r = await browserApi.call(endpoints.createChatWidget, { params: { workspaceId }, body: toBody(f) });
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
