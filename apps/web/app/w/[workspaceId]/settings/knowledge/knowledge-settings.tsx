"use client";
import * as React from "react";
import { BookOpen, RefreshCw, Search, Trash2 } from "lucide-react";
import { endpoints, KNOWLEDGE_LIMITS, MEDIA_LIMITS, KNOWLEDGE_SEARCH_MAX_QUERY, type KnowledgeHit, type KnowledgeSourceDto, type KnowledgeSourceList } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";

const TEXT_TYPES = [".txt", ".md", ".csv", ".html", ".htm"];
// PDF, images (text is read by OCR) and audio (transcribed) go through the AI provider's media capabilities; they need a provider that supports them (Settings, AI, Capabilities).
const PDF_TYPES = [".pdf"], IMAGE_TYPES = [".png", ".jpg", ".jpeg", ".webp", ".gif"], AUDIO_TYPES = [".mp3", ".wav", ".m4a", ".ogg", ".webm"];
const FILE_TYPES = [...TEXT_TYPES, ...PDF_TYPES, ...IMAGE_TYPES, ...AUDIO_TYPES];
const endsWithAny = (name: string, list: string[]) => list.some((x) => name.toLowerCase().endsWith(x));
/** Size limit for a file by its extension: 2 MB for text formats, 10 MB PDF, 5 MB image, 20 MB audio. */
const limitFor = (name: string) => (endsWithAny(name, PDF_TYPES) ? MEDIA_LIMITS.document : endsWithAny(name, IMAGE_TYPES) ? MEDIA_LIMITS.image : endsWithAny(name, AUDIO_TYPES) ? MEDIA_LIMITS.audio : KNOWLEDGE_LIMITS.maxFileBytes);
const fmtMb = (n: number) => `${n / 1048576} MB`;
const TYPE_LABEL = { text: "Pasted text", file: "File", url: "Web page" } as const;
const STATUS = { pending: { tone: "accent", label: "Indexing" }, ready: { tone: "success", label: "Ready" }, failed: { tone: "danger", label: "Failed" } } as const;
const ERROR_TEXT: Record<string, string> = {
  fetch_failed: "The address could not be reached.", fetch_timeout: "The website took too long to answer.", fetch_status: "The website returned an error.", url_blocked: "The address is not allowed.",
  unsupported_content_type: "The page is not a web page or text file.", too_large: "The content is too large.", empty_content: "No text was found.", too_many_redirects: "Too many redirects.",
  capability_not_configured: "No AI provider with this capability. Add one in Settings, AI.", budget_exceeded: "The monthly AI budget was used up.",
  unsupported_media: "The file is not a valid PDF, image or audio file of its type.", ai_unavailable: "The AI provider could not process the file.", rate_limited: "Too many files in a short time.",
};
/** The server's message for our own errors (it is written for people), the generic text otherwise. */
const apiMessage = (e: Parameters<typeof errorMessage>[0]) => (e.kind === "http" && e.message ? e.message : errorMessage(e));
const fmtNumber = (n: number) => n.toLocaleString("en-US");

export function KnowledgeSettings({ workspaceId, timeZone, canManage }: { workspaceId: string; timeZone: string; canManage: boolean }) {
  const toast = useToast();
  const params = { workspaceId };
  const [state, setState] = React.useState<"loading" | "error" | "ready">("loading");
  const [error, setError] = React.useState("");
  const [data, setData] = React.useState<KnowledgeSourceList | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [deleting, setDeleting] = React.useState<KnowledgeSourceDto | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async (quiet = false) => {
    const res = await browserApi.call(endpoints.listKnowledgeSources, { params });
    if (!res.ok) { if (!quiet) { setError(errorMessage(res.error)); setState("error"); } return; }
    setData(res.data); setState("ready");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);
  React.useEffect(() => { const t = setTimeout(() => void load(false), 0); return () => clearTimeout(t); }, [load]); // from a callback, not the effect body (react-hooks/set-state-in-effect)

  async function reindex(s: KnowledgeSourceDto) {
    setBusy(`re-${s.id}`);
    const res = await browserApi.call(endpoints.reindexKnowledgeSource, { params: { ...params, sourceId: s.id } });
    setBusy(null);
    if (!res.ok) toast(errorMessage(res.error), "error"); else toast(`Re-indexed "${s.title}"`);
    await load(true);
  }
  async function remove(s: KnowledgeSourceDto) {
    setBusy(`del-${s.id}`);
    const res = await browserApi.call(endpoints.deleteKnowledgeSource, { params: { ...params, sourceId: s.id } });
    setBusy(null);
    setDeleting(null);
    if (!res.ok) toast(errorMessage(res.error), "error"); else toast(`Deleted "${s.title}"`);
    await load(true);
  }

  if (state === "loading") return <div role="status" aria-label="Loading knowledge" className="space-y-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-40 w-full" /><span className="sr-only">Loading…</span></div>;
  if (state === "error" || !data) return <Panel><ErrorState title="Could not load knowledge" description={error} onRetry={() => { setState("loading"); void load(false); }} /></Panel>;

  const addButton = canManage ? <Button variant="primary" size="sm" onClick={() => setAdding(true)}>Add source</Button> : undefined;
  return (
    <div className="space-y-[var(--page-gap)]">
      <Panel>
        <PanelHeader title="Sources" description={`${fmtNumber(data.usage.sources)} of ${fmtNumber(data.usage.maxSources)} sources, ${fmtNumber(data.usage.chars)} of ${fmtNumber(data.usage.maxChars)} characters used.`} actions={addButton} />
        {data.items.length === 0 ? (
          <EmptyState icon={BookOpen} title="No knowledge yet" description={canManage ? "Add a policy, price list, FAQ or web page." : "Ask an owner or admin to add documents."} action={canManage ? <Button variant="primary" onClick={() => setAdding(true)}>Add source</Button> : undefined} />
        ) : (
          <Table scrollLabel="Knowledge sources">
            <THead><TR className="hover:bg-transparent"><TH>Title</TH><TH>Type</TH><TH>Status</TH><TH className="text-right">Passages</TH><TH>Added</TH>{canManage && <TH><span className="sr-only">Actions</span></TH>}</TR></THead>
            <TBody>
              {data.items.map((s) => (
                <TR key={s.id}>
                  <TD className="max-w-72 min-w-44">
                    <p className="truncate font-medium" title={s.title}>{s.title}</p>
                    {s.sourceRef && <p className="truncate text-xs text-fg-subtle" title={s.sourceRef}>{s.sourceRef}</p>}
                  </TD>
                  <TD className="whitespace-nowrap text-fg-muted">{TYPE_LABEL[s.type]}</TD>
                  <TD>
                    <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
                    {s.status === "failed" && <p role="note" className="mt-1 max-w-48 text-xs text-danger-fg">{ERROR_TEXT[s.error ?? ""] ?? "The last refresh failed."}{s.chunkCount > 0 ? " Earlier passages still work." : ""}</p>}
                  </TD>
                  <TD className="text-right tabular-nums">{fmtNumber(s.chunkCount)}</TD>
                  <TD className="whitespace-nowrap text-fg-muted">{s.createdByName ?? "Unknown"}<span className="block text-xs text-fg-subtle">{formatDateTime(s.createdAt, timeZone)}</span></TD>
                  {canManage && (
                    <TD className="whitespace-nowrap">
                      <Button size="sm" variant="ghost" icon aria-label={`Re-index ${s.title}`} loading={busy === `re-${s.id}`} onClick={() => void reindex(s)}><RefreshCw /></Button>
                      <Button size="sm" variant="ghost" icon aria-label={`Delete ${s.title}`} onClick={() => setDeleting(s)}><Trash2 /></Button>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Panel>

      <TestRetrieval workspaceId={workspaceId} hasSources={data.items.length > 0} />

      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && <AddDialog workspaceId={workspaceId} onDone={async (title) => { setAdding(false); toast(`Added "${title}"`); await load(true); }} onCancel={() => setAdding(false)} onFailed={() => void load(true)} />}
      </Dialog>
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        {deleting && (
          <DialogContent title="Delete this source?" description={`"${deleting.title}" and its ${fmtNumber(deleting.chunkCount)} passages will be removed and can no longer be searched. This cannot be undone.`}>
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={() => setDeleting(null)}>Cancel</Button>
              <Button variant="danger" loading={busy === `del-${deleting.id}`} onClick={() => void remove(deleting)}>Delete source</Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function TestRetrieval({ workspaceId, hasSources }: { workspaceId: string; hasSources: boolean }) {
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [asked, setAsked] = React.useState<string | null>(null);
  const [hits, setHits] = React.useState<KnowledgeHit[]>([]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = text.trim();
    if (!q) return setError("Enter something to search for.");
    setBusy(true); setError(null);
    const res = await browserApi.call(endpoints.searchKnowledge, { params: { workspaceId }, query: { q, limit: 5 } });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.error));
    setHits(res.data.items); setAsked(q);
  }

  return (
    <Panel>
      <PanelHeader title="Test retrieval" description="See which passages a question would find." />
      <form onSubmit={submit} noValidate className="flex flex-wrap items-start gap-2 px-4 pt-4">
        <Field label="Question or keywords" error={error} className="min-w-60 flex-1">
          {(p) => <Input {...p} type="search" value={text} maxLength={KNOWLEDGE_SEARCH_MAX_QUERY} placeholder="What is the refund policy?" onChange={(e) => setText(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" loading={busy} className="mt-[1.65rem]"><Search />Search</Button>
      </form>
      <div className="px-4 pb-4 pt-3" aria-live="polite">
        {asked === null ? (
          <p className="text-sm text-fg-subtle">{hasSources ? "Results appear here, best match first." : "Add a source first, then test what can be found."}</p>
        ) : hits.length === 0 ? (
          <EmptyState title="Nothing found" description={`No passage matched "${asked}". Search matches whole words, so try other words from the document.`} />
        ) : (
          <ol aria-label="Search results" className="space-y-3">
            {hits.map((h, i) => (
              <li key={`${h.sourceId}-${h.position}`} className="rounded-control bg-subtle p-3">
                <p className="flex flex-wrap items-center gap-x-2 text-sm"><span className="font-semibold text-fg">{i + 1}. {h.title}</span><span className="text-fg-subtle">passage {h.position + 1}</span></p>
                <p className="mt-0.5 break-words text-xs text-fg-subtle">Source: {h.sourceRef ?? "Pasted text"}</p>
                <p className="mt-1.5 whitespace-pre-line break-words text-sm text-fg-muted">{h.snippet}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Panel>
  );
}

function toBase64(buf: ArrayBuffer): string {
  let s = "";
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function AddDialog({ workspaceId, onDone, onCancel, onFailed }: { workspaceId: string; onDone: (title: string) => Promise<void>; onCancel: () => void; onFailed: () => void }) {
  const [kind, setKind] = React.useState<"text" | "file" | "url">("text");
  const [title, setTitle] = React.useState("");
  const [text, setText] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function pick(f: File | null) {
    setFile(f); setError(null);
    if (!f) return;
    if (!endsWithAny(f.name, FILE_TYPES)) setError(`Files of this type are not supported yet. Use ${FILE_TYPES.join(", ")}.`);
    else if (f.size > limitFor(f.name)) setError(`The file is larger than ${fmtMb(limitFor(f.name))}.`);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (kind === "text" && !text.trim()) return setError("Paste some text.");
    if (kind === "text" && !title.trim()) return setError("Enter a title.");
    if (kind === "url" && !url.trim()) return setError("Enter a web address.");
    if (kind === "file" && !file) return setError("Choose a file.");
    if (kind === "file" && file && (!endsWithAny(file.name, FILE_TYPES) || file.size > limitFor(file.name))) return pick(file);
    setSaving(true);
    const t = title.trim() || undefined;
    const res = kind === "text" ? await browserApi.call(endpoints.createKnowledgeText, { params: { workspaceId }, body: { title: title.trim(), text } })
      : kind === "url" ? await browserApi.call(endpoints.createKnowledgeUrl, { params: { workspaceId }, body: { url: url.trim(), title: t } })
      : await browserApi.call(endpoints.createKnowledgeFile, { params: { workspaceId }, body: { filename: file!.name, title: t, contentBase64: toBase64(await file!.arrayBuffer()) } });
    setSaving(false);
    if (!res.ok) { if (kind === "file") onFailed(); return setError(apiMessage(res.error)); } // a failed media upload leaves a failed source row: show it
    await onDone(res.data.title);
  }

  return (
    <DialogContent title="Add a source" description="Split into passages and indexed. Never shared." className="max-h-[90vh] w-full max-w-xl overflow-y-auto">
      <form onSubmit={save} className="space-y-4" noValidate>
        <Field label="Source type">{(p) => (
          <Select {...p} value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); setError(null); }}>
            <option value="text">Paste text</option>
            <option value="file">Upload a file</option>
            <option value="url">Web page address</option>
          </Select>
        )}</Field>
        <Field label={kind === "text" ? "Title" : "Title (optional)"} hint={kind === "url" ? "Defaults to the page title." : kind === "file" ? "Defaults to the file name." : undefined}>
          {(p) => <Input {...p} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Refund policy" />}
        </Field>
        {kind === "text" && <Field label="Text" hint={`Up to ${fmtNumber(KNOWLEDGE_LIMITS.maxCharsPerSource)} characters.`}>{(p) => <Textarea {...p} rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the document text here" />}</Field>}
        {kind === "file" && (
          <Field label="File" hint="TXT, MD, CSV or HTML up to 2 MB. With AI support: PDF, images, audio (transcribed).">
            {(p) => <Input {...p} type="file" accept={FILE_TYPES.join(",")} onChange={(e) => pick(e.target.files?.[0] ?? null)} />}
          </Field>
        )}
        {kind === "url" && (
          <Field label="Web address" hint="One public http(s) page.">
            {(p) => <Input {...p} type="url" inputMode="url" value={url} maxLength={2048} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/returns" />}
          </Field>
        )}
        {error && <p role="alert" className="text-sm text-danger-fg">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" loading={saving}>{kind === "url" ? "Fetch and add" : "Add source"}</Button>
        </div>
      </form>
    </DialogContent>
  );
}
