"use client";
import * as React from "react";
import { AlertCircle, BookOpen, Check, Eye, File as FileIcon, FileText, Globe, Loader2, MessageSquare, MoreHorizontal, Mic, Plus, RotateCcw, Search, X } from "lucide-react";
import { endpoints, KNOWLEDGE_LIMITS, MEDIA_LIMITS, KNOWLEDGE_SEARCH_MAX_QUERY, type KnowledgeHit, type KnowledgeSourceDto, type KnowledgeSourceList } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form-controls";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { Drawer } from "@/components/knowledge/add-drawer";
import { cn } from "@/lib/cn";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";

const TEXT_TYPES = [".txt", ".md", ".csv", ".html", ".htm"];
// PDF, images (text is read by OCR) and audio (transcribed) go through the AI provider's media capabilities; they need a provider that supports them (Settings, AI, Capabilities).
const PDF_TYPES = [".pdf"], IMAGE_TYPES = [".png", ".jpg", ".jpeg", ".webp", ".gif"], AUDIO_TYPES = [".mp3", ".wav", ".m4a", ".ogg", ".webm"];
const FILE_TYPES = [...TEXT_TYPES, ...PDF_TYPES, ...IMAGE_TYPES, ...AUDIO_TYPES];
const endsWithAny = (name: string, list: string[]) => list.some((x) => name.toLowerCase().endsWith(x));
type Kind = "text" | "pdf" | "image" | "audio" | "paste" | "url" | "qa";
const kindOfFile = (name: string): Kind | null => (endsWithAny(name, PDF_TYPES) ? "pdf" : endsWithAny(name, IMAGE_TYPES) ? "image" : endsWithAny(name, AUDIO_TYPES) ? "audio" : endsWithAny(name, TEXT_TYPES) ? "text" : null);
/** Size limit for a file by its extension: 2 MB for text formats, 10 MB PDF, 5 MB image, 20 MB audio. */
const limitFor = (name: string) => (endsWithAny(name, PDF_TYPES) ? MEDIA_LIMITS.document : endsWithAny(name, IMAGE_TYPES) ? MEDIA_LIMITS.image : endsWithAny(name, AUDIO_TYPES) ? MEDIA_LIMITS.audio : KNOWLEDGE_LIMITS.maxFileBytes);
const fmtMb = (n: number) => `${n / 1048576} MB`;
const fmtSize = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtNumber = (n: number) => n.toLocaleString("en-US");
const fmtShort = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

const KIND_UI: Record<Kind, { label: string; icon: React.ComponentType<{ className?: string }>; hue: string; reading: string }> = {
  text: { label: "Text file", icon: FileText, hue: "bg-accent-subtle text-accent-fg", reading: "Reading the file" },
  paste: { label: "Pasted text", icon: FileText, hue: "bg-accent-subtle text-accent-fg", reading: "Reading the text" },
  pdf: { label: "PDF", icon: FileIcon, hue: "bg-danger-bg text-danger-fg", reading: "Reading the PDF" },
  image: { label: "Image", icon: Eye, hue: "bg-warning-bg text-warning-fg", reading: "Reading the text in the image" },
  audio: { label: "Voice or audio", icon: Mic, hue: "bg-success-bg text-success-fg", reading: "Listening and writing it down" },
  url: { label: "Web page", icon: Globe, hue: "bg-hover text-fg", reading: "Reading the web page" },
  qa: { label: "Questions and answers", icon: MessageSquare, hue: "bg-hover text-fg-muted", reading: "Reading the answers" },
};
/** What the stored source was made from: a file's extension tells the kind, a title like our Q&A one the rest. */
const kindOfSource = (s: KnowledgeSourceDto): Kind => (s.type === "url" ? "url" : s.type === "file" ? (kindOfFile(s.sourceRef ?? s.title) ?? "text") : s.title.startsWith(QA_PREFIX) ? "qa" : "paste");
const QA_PREFIX = "Questions and answers";

const ERROR_TEXT: Record<string, string> = {
  fetch_failed: "The address could not be reached.", fetch_timeout: "The website took too long to answer.", fetch_status: "The website returned an error.", url_blocked: "The address is not allowed.",
  unsupported_content_type: "The page is not a web page or text file.", too_large: "The content is too large.", empty_content: "No text was found.", too_many_redirects: "Too many redirects.",
  capability_not_configured: "No AI provider with this capability. Add one in Settings, AI.", budget_exceeded: "The monthly AI budget was used up.",
  unsupported_media: "The file is not a valid PDF, image or audio file of its type.", ai_unavailable: "The AI provider could not process the file.", rate_limited: "Too many files in a short time.",
};
/** The server's message for our own errors (it is written for people), the generic text otherwise. */
const apiMessage = (e: Parameters<typeof errorMessage>[0]) => (e.kind === "http" && e.message ? e.message : errorMessage(e));
const STEPS = ["Upload", "Read", "Split", "Ready"] as const;

/** A source being added right now (this browser tab): the request is in flight, or it failed before the server stored it. */
type Job = { key: string; kind: Kind; title: string; meta: string; phase: "uploading" | "reading" | "done" | "failed"; error?: string };

function toBase64(buf: ArrayBuffer): string {
  let s = "";
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
const hostOf = (raw: string): { host: string; url: string } | null => { try { const u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`); return u.hostname.includes(".") ? { host: `${u.host}${u.pathname === "/" ? "" : u.pathname}`, url: u.href } : null; } catch { return null; } };

export function KnowledgeSettings({ workspaceId, timeZone, canManage }: { workspaceId: string; timeZone: string; canManage: boolean }) {
  const toast = useToast();
  const params = { workspaceId };
  const [state, setState] = React.useState<"loading" | "error" | "ready">("loading");
  const [error, setError] = React.useState("");
  const [data, setData] = React.useState<KnowledgeSourceList | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [deleting, setDeleting] = React.useState<KnowledgeSourceDto | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [filter, setFilter] = React.useState<"all" | "ready" | "work" | "bad">("all");

  const load = React.useCallback(async (quiet = false) => {
    const res = await browserApi.call(endpoints.listKnowledgeSources, { params });
    if (!res.ok) { if (!quiet) { setError(errorMessage(res.error)); setState("error"); } return; }
    setData(res.data); setState("ready");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);
  React.useEffect(() => { const t = setTimeout(() => void load(false), 0); return () => clearTimeout(t); }, [load]); // from a callback, not the effect body (react-hooks/set-state-in-effect)
  const anyPending = data?.items.some((s) => s.status === "pending") ?? false;
  React.useEffect(() => { if (!anyPending) return; const t = setInterval(() => void load(true), 3000); return () => clearInterval(t); }, [anyPending, load]);

  async function reindex(s: KnowledgeSourceDto) {
    setBusy(`re-${s.id}`);
    const res = await browserApi.call(endpoints.reindexKnowledgeSource, { params: { ...params, sourceId: s.id } });
    setBusy(null);
    if (!res.ok) toast(errorMessage(res.error), "error"); else toast(`Read "${s.title}" again`);
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

  /** Run one add request and keep its progress visible (in the panel and on top of the list) until the server has answered. */
  async function runJob(job: Omit<Job, "phase">, send: () => Promise<{ ok: true; id: string } | { ok: false; message: string }>): Promise<string | null> {
    const key = job.key;
    setJobs((j) => [{ ...job, phase: "uploading" }, ...j]);
    await new Promise((r) => setTimeout(r, 0));
    setJobs((j) => j.map((x) => (x.key === key ? { ...x, phase: "reading" } : x)));
    const r = await send();
    if (r.ok) { await load(true); setJobs((j) => j.map((x) => (x.key === key ? { ...x, phase: "done" } : x))); return r.id; }
    await load(true); // a failed media upload leaves a failed row on the server
    setJobs((j) => j.map((x) => (x.key === key ? { ...x, phase: "failed", error: r.message } : x)));
    return null;
  }

  if (state === "loading") return <div role="status" aria-label="Loading knowledge" className="space-y-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-40 w-full" /><span className="sr-only">Loading…</span></div>;
  if (state === "error" || !data) return <div className="rounded-card bg-surface shadow-sheet"><ErrorState title="Could not load knowledge" description={error} onRetry={() => { setState("loading"); void load(false); }} /></div>;

  const u = data.usage;
  const MEDIA: Kind[] = ["pdf", "image", "audio"];
  // A failed media upload leaves a failed row on the server (with Retry); only failures with no row are listed here.
  const listJobs = jobs.filter((j) => j.phase !== "done" && (j.phase !== "failed" || !MEDIA.includes(j.kind)));
  const isWork = (s: KnowledgeSourceDto) => s.status === "pending";
  const counts = { all: data.items.length + listJobs.length, ready: data.items.filter((s) => s.status === "ready").length, work: data.items.filter(isWork).length + listJobs.filter((j) => j.phase !== "failed").length, bad: data.items.filter((s) => s.status === "failed").length + listJobs.filter((j) => j.phase === "failed").length };
  const items = data.items.filter((s) => filter === "all" || (filter === "ready" && s.status === "ready") || (filter === "work" && isWork(s)) || (filter === "bad" && s.status === "failed"));
  const shownJobs = listJobs.filter((j) => filter === "all" || (filter === "work" && j.phase !== "failed") || (filter === "bad" && j.phase === "failed"));

  return (
    <div className="space-y-[var(--page-gap)]">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-stretch">
        <Meter label="Sources" value={`${fmtNumber(u.sources)} / ${fmtNumber(u.maxSources)}`} pct={(u.sources / u.maxSources) * 100} />
        <Meter label="Characters" value={`${fmtShort(u.chars)} / ${fmtShort(u.maxChars)}`} pct={(u.chars / u.maxChars) * 100} />
        {canManage && <Button variant="primary" size="lg" onClick={() => setAdding(true)} className="max-sm:h-12 sm:h-auto sm:px-6"><Plus aria-hidden />Add knowledge</Button>}
      </div>

      <div role="group" aria-label="Filter sources" className="flex gap-1.5 overflow-x-auto pb-0.5" data-scroll="allowed">
        {([["all", "All"], ["ready", "Ready"], ["work", "Working"], ["bad", "Needs attention"]] as const).map(([k, v]) => (
          <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={cn("press inline-flex h-10 shrink-0 items-center gap-2 rounded-full border-[1.5px] px-4 text-base font-semibold pointer-coarse:h-11", filter === k ? "border-fg bg-fg text-surface" : "border-line text-fg-muted hover:bg-hover")}>
            {v}<span className={cn("tnum rounded-full px-2 text-xs font-bold", filter === k ? "bg-surface/20" : k === "bad" && counts.bad > 0 ? "bg-danger-bg text-danger-fg" : k === "work" && counts.work > 0 ? "bg-accent-subtle text-accent-fg" : "bg-hover")}>{counts[k]}</span>
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-card bg-surface shadow-sheet max-sm:-mx-4 max-sm:rounded-none">
        {data.items.length === 0 && listJobs.length === 0 ? (
          <EmptyState icon={BookOpen} title="No knowledge yet" description={canManage ? "Add a policy, price list, FAQ or web page." : "Ask an owner or admin to add documents."} action={canManage ? <Button variant="primary" onClick={() => setAdding(true)}>Add knowledge</Button> : undefined} />
        ) : items.length === 0 && shownJobs.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-fg-subtle">Nothing in this filter.</p>
        ) : (
          <ul aria-label="Knowledge sources">
            {shownJobs.map((j) => <JobRow key={j.key} job={j} onDismiss={() => setJobs((x) => x.filter((y) => y.key !== j.key))} />)}
            {items.map((s) => <SourceRow key={s.id} s={s} timeZone={timeZone} canManage={canManage} busy={busy} onReindex={() => void reindex(s)} onDelete={() => setDeleting(s)} />)}
          </ul>
        )}
      </div>

      <TestRetrieval workspaceId={workspaceId} hasSources={data.items.length > 0} />

      <AddDrawer open={adding} onOpenChange={setAdding} jobs={jobs} onStart={runJob} workspaceId={workspaceId} onDismissJob={(k) => setJobs((x) => x.filter((y) => y.key !== k))} />
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

function Meter({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div className="rounded-2xl bg-surface px-4 py-3.5 shadow-control">
      <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm font-semibold text-fg-muted">{label}<span className="tnum text-fg">{value}</span></p>
      <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-hover"><div className="h-full rounded-full bg-accent transition-[width] duration-[var(--dur-slow)]" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} /></div>
    </div>
  );
}

/** Upload, Read, Split, Ready as four dots on a line. `at` is the dot that is busy; `fail` marks the dot that stopped. */
function Pipeline({ at, fail, label }: { at: number; fail?: boolean; label: string }) {
  return (
    <ol aria-label={label} className="mt-2 flex items-start">
      {STEPS.map((x, i) => {
        const done = fail ? i < at : i < at;
        const on = !fail && i === at && at < 3;
        const bad = fail && i === at;
        const ok = !fail && at >= 3;
        return (
          <li key={x} className={cn("relative flex flex-1 flex-col gap-1", i === 0 ? "items-start" : i === 3 ? "items-end" : "items-center")} aria-current={on ? "step" : undefined}>
            <span className={cn("relative z-10 flex size-4 items-center justify-center rounded-full text-on-accent", bad ? "bg-danger" : done || ok ? "bg-success" : on ? "bg-accent ring-4 ring-accent/20" : "bg-line-control")}>{bad ? <X className="size-2.5" aria-hidden /> : done || ok ? <Check className="size-2.5" aria-hidden /> : null}</span>
            {i < 3 && <span aria-hidden className={cn("absolute left-[calc(50%+0.5rem)] right-[calc(-50%+0.5rem)] top-[7px] h-0.5 rounded", i < at || ok ? "bg-success" : "bg-line")} />}
            <span className={cn("text-xs font-semibold", bad ? "text-danger-fg" : on ? "text-accent-fg" : "text-fg-subtle", !on && "max-sm:sr-only")}>{x}</span>
          </li>
        );
      })}
    </ol>
  );
}

function SourceRow({ s, timeZone, canManage, busy, onReindex, onDelete }: { s: KnowledgeSourceDto; timeZone: string; canManage: boolean; busy: string | null; onReindex: () => void; onDelete: () => void }) {
  const k = kindOfSource(s);
  const ui = KIND_UI[k];
  const failed = s.status === "failed", pending = s.status === "pending";
  return (
    <li className={cn("grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t border-line-card px-4 py-4 first:border-t-0 sm:px-6", failed && "bg-danger-bg/40")}>
      <span className={cn("flex size-12 items-center justify-center rounded-2xl", ui.hue)}><ui.icon className="size-5" aria-hidden /></span>
      <div className="min-w-0">
        <p className="break-words text-md font-bold text-fg">{s.title}</p>
        <p className="mt-0.5 break-words text-sm text-fg-subtle">{ui.label}{s.type === "url" && s.sourceRef ? ` · ${s.sourceRef}` : ""} · {s.createdByName ?? "Unknown"}, {formatDateTime(s.createdAt, timeZone)}</p>
      </div>
      <div className="flex items-center gap-1">
        {s.status === "ready" && <Badge tone="success" className="px-3 py-1 text-sm font-bold"><Check className="size-3.5" aria-hidden />{fmtNumber(s.chunkCount)} {s.chunkCount === 1 ? "passage" : "passages"}</Badge>}
        {pending && <Badge tone="accent" className="px-3 py-1 text-sm font-bold"><Loader2 className="size-3.5 animate-spin" aria-hidden />Reading</Badge>}
        {failed && <Badge tone="danger" className="px-3 py-1 text-sm font-bold"><AlertCircle className="size-3.5" aria-hidden />Needs attention</Badge>}
        {canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" icon aria-label={`More for ${s.title}`} loading={busy === `re-${s.id}`} className="pointer-coarse:size-11"><MoreHorizontal /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onReindex}>{failed ? `Retry ${s.title}` : `Read ${s.title} again`}</DropdownMenuItem>
              <DropdownMenuItem danger onSelect={onDelete}>Delete {s.title}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {pending && <div className="col-span-full sm:col-start-2"><Pipeline at={1} label={ui.reading} /></div>}
      {failed && (
        <div className="col-span-full flex flex-wrap items-center gap-3 sm:col-start-2">
          <p role="note" className="flex min-w-0 flex-1 basis-60 items-start gap-2 rounded-xl bg-surface px-3.5 py-2.5 text-sm text-danger-fg shadow-control"><AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden /><span>{ERROR_TEXT[s.error ?? ""] ?? "The last refresh failed."}{s.chunkCount > 0 ? " Earlier passages still work." : ""}</span></p>
          {canManage && <Button variant="primary" loading={busy === `re-${s.id}`} onClick={onReindex} aria-label={`Retry ${s.title}`} className="pointer-coarse:h-11"><RotateCcw aria-hidden />Retry</Button>}
        </div>
      )}
    </li>
  );
}

function JobRow({ job, onDismiss }: { job: Job; onDismiss: () => void }) {
  const ui = KIND_UI[job.kind];
  const failed = job.phase === "failed", done = job.phase === "done";
  return (
    <li className={cn("grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t border-line-card px-4 py-4 first:border-t-0 sm:px-6", failed && "bg-danger-bg/40")}>
      <span className={cn("flex size-12 items-center justify-center rounded-2xl", ui.hue)}><ui.icon className="size-5" aria-hidden /></span>
      <div className="min-w-0"><p className="break-words text-md font-bold text-fg">{job.title}</p><p className="mt-0.5 text-sm text-fg-subtle">{ui.label}{job.meta ? ` · ${job.meta}` : ""}</p></div>
      {failed ? <Button variant="ghost" icon aria-label={`Dismiss ${job.title}`} onClick={onDismiss} className="pointer-coarse:size-11"><X /></Button> : done ? <Badge tone="success" className="px-3 py-1 text-sm font-bold"><Check className="size-3.5" aria-hidden />Ready</Badge> : <Badge tone="accent" className="px-3 py-1 text-sm font-bold"><Loader2 className="size-3.5 animate-spin" aria-hidden />{job.phase === "uploading" ? "Uploading" : "Reading"}</Badge>}
      <div className="col-span-full sm:col-start-2">
        <Pipeline at={failed ? 1 : done ? 4 : job.phase === "uploading" ? 0 : 1} fail={failed} label={failed ? "Stopped" : done ? "Ready" : job.phase === "uploading" ? "Uploading" : ui.reading} />
        {failed && <p role="alert" className="mt-2 flex items-start gap-2 rounded-xl bg-surface px-3.5 py-2.5 text-sm text-danger-fg shadow-control"><AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />{job.error}</p>}
      </div>
    </li>
  );
}

function TestRetrieval({ workspaceId, hasSources }: { workspaceId: string; hasSources: boolean }) {
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [asked, setAsked] = React.useState<string | null>(null);
  const [hits, setHits] = React.useState<KnowledgeHit[]>([]);

  async function ask(q: string) {
    q = q.trim();
    if (!q) return setError("Enter something to search for.");
    setBusy(true); setError(null);
    const res = await browserApi.call(endpoints.searchKnowledge, { params: { workspaceId }, query: { q, limit: 5 } });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.error));
    setHits(res.data.items); setAsked(q);
  }
  return (
    <section aria-labelledby="try-h" className="rounded-card bg-surface p-5 shadow-sheet sm:p-7 max-sm:-mx-4 max-sm:rounded-none">
      <h2 id="try-h" className="text-lg font-bold tracking-title text-fg">Check what it finds</h2>
      <p className="mb-4 mt-1 text-base text-fg-subtle">Ask a question the way a customer would. You see which passage answers it.</p>
      <form onSubmit={(e) => { e.preventDefault(); void ask(text); }} noValidate className="flex gap-2">
        <label htmlFor="kb-q" className="sr-only">Question or keywords</label>
        <Input id="kb-q" type="search" value={text} maxLength={KNOWLEDGE_SEARCH_MAX_QUERY} placeholder="What is the refund policy?" onChange={(e) => setText(e.target.value)} aria-invalid={error ? true : undefined} className="h-[3.25rem] flex-1 rounded-xl border-[1.5px] bg-subtle px-4 text-md" />
        <Button type="submit" variant="primary" size="lg" loading={busy} className="h-[3.25rem] px-5"><Search aria-hidden />Search</Button>
      </form>
      {error && <p role="alert" className="mt-2 text-sm text-danger-fg">{error}</p>}
      <div className="mt-4" aria-live="polite">
        {asked === null ? (
          <p className="text-sm text-fg-subtle">{hasSources ? "Results appear here, best match first." : "Add a source first, then test what can be found."}</p>
        ) : hits.length === 0 ? (
          <EmptyState title="Nothing found" description={`No passage matched "${asked}". Search matches whole words, so try other words from the document.`} />
        ) : (
          <ol aria-label="Search results" className="space-y-3">
            {hits.map((h, i) => (
              <li key={`${h.sourceId}-${h.position}`} className="rounded-2xl border border-line-card bg-subtle p-4">
                <p className="flex flex-wrap items-center gap-x-2 text-sm"><span className="font-semibold text-fg">{i + 1}. {h.title}</span><span className="text-fg-subtle">passage {h.position + 1}</span></p>
                <p className="mt-0.5 break-words text-xs text-fg-subtle">Source: {h.sourceRef ?? "Pasted text"}</p>
                <p className="mt-1.5 whitespace-pre-line break-words text-base text-fg-muted">{h.snippet}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

type Pick = "paste" | "file" | "url" | "qa";
type FileItem = { file: File; kind: Kind | null; error?: string };
const TILES: { id: Pick; name: string; text: string; icon: React.ComponentType<{ className?: string }>; hue: string }[] = [
  { id: "paste", name: "Write or paste text", text: "Policies, prices, answers.", icon: FileText, hue: "bg-accent-subtle text-accent-fg" },
  { id: "file", name: "Upload files", text: "PDF, photos, voice notes.", icon: FileIcon, hue: "bg-danger-bg text-danger-fg" },
  { id: "url", name: "Web page", text: "We read it for you.", icon: Globe, hue: "bg-hover text-fg" },
  { id: "qa", name: "Questions and answers", text: "Say what to reply.", icon: MessageSquare, hue: "bg-success-bg text-success-fg" },
];
const checkFile = (f: File): FileItem => {
  const kind = kindOfFile(f.name);
  if (/\.(docx?|xlsx?|pptx?)$/i.test(f.name)) return { file: f, kind: null, error: "Word, Excel and PowerPoint files are not supported yet. Save it as a PDF and add that." };
  if (!kind) return { file: f, kind: null, error: `This type of file is not supported. Use ${FILE_TYPES.join(", ")}.` };
  if (f.size > limitFor(f.name)) return { file: f, kind, error: `Too big: ${fmtSize(f.size)}. ${KIND_UI[kind].label} files can be up to ${fmtMb(limitFor(f.name))}.` };
  return { file: f, kind };
};

function AddDrawer({ open, onOpenChange, jobs, onStart, workspaceId, onDismissJob }: { open: boolean; onOpenChange: (o: boolean) => void; jobs: Job[]; onStart: (j: Omit<Job, "phase">, send: () => Promise<{ ok: true; id: string } | { ok: false; message: string }>) => Promise<string | null>; workspaceId: string; onDismissJob: (k: string) => void }) {
  const [mode, setMode] = React.useState<Pick | null>(null);
  const [view, setView] = React.useState<"pick" | "busy">("pick");
  const [title, setTitle] = React.useState("");
  const [text, setText] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [files, setFiles] = React.useState<FileItem[]>([]);
  const [qa, setQa] = React.useState([{ q: "", a: "" }]);
  const [over, setOver] = React.useState(false);
  const [batch, setBatch] = React.useState<string[]>([]);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const params = { workspaceId };

  const reset = () => { batch.forEach((k) => onDismissJob(k)); setBatch([]); setMode(null); setView("pick"); setTitle(""); setText(""); setUrl(""); setFiles([]); setQa([{ q: "", a: "" }]); };
  const urlInfo = hostOf(url);
  const okFiles = files.filter((f) => !f.error);
  const qaOk = qa.filter((p) => p.q.trim() && p.a.trim());
  const ready = mode === "paste" ? !!title.trim() && !!text.trim() : mode === "url" ? !!urlInfo : mode === "file" ? okFiles.length > 0 : mode === "qa" ? qaOk.length > 0 : false;

  async function go() {
    const wrap = async (title: string, kind: Kind, meta: string, send: () => Promise<{ ok: true; id: string } | { ok: false; message: string }>) => { const key = crypto.randomUUID(); keys.push(key); void onStart({ key, title, kind, meta }, send); };
    const keys: string[] = [];
    setView("busy");
    if (mode === "paste") await wrap(title.trim(), "paste", "", async () => { const r = await browserApi.call(endpoints.createKnowledgeText, { params, body: { title: title.trim(), text } }); return r.ok ? { ok: true, id: r.data.id } : { ok: false, message: apiMessage(r.error) }; });
    if (mode === "url") await wrap(urlInfo!.host, "url", urlInfo!.host, async () => { const r = await browserApi.call(endpoints.createKnowledgeUrl, { params, body: { url: urlInfo!.url } }); return r.ok ? { ok: true, id: r.data.id } : { ok: false, message: apiMessage(r.error) }; });
    if (mode === "qa") await wrap(`${QA_PREFIX} (${qaOk.length})`, "qa", "", async () => { const body = qaOk.map((p) => `Question: ${p.q.trim()}\nAnswer: ${p.a.trim()}`).join("\n\n"); const r = await browserApi.call(endpoints.createKnowledgeText, { params, body: { title: `${QA_PREFIX} (${qaOk.length})`, text: body } }); return r.ok ? { ok: true, id: r.data.id } : { ok: false, message: apiMessage(r.error) }; });
    if (mode === "file") for (const it of okFiles) await wrap(it.file.name, it.kind!, fmtSize(it.file.size), async () => { const r = await browserApi.call(endpoints.createKnowledgeFile, { params, body: { filename: it.file.name, contentBase64: toBase64(await it.file.arrayBuffer()) } }); return r.ok ? { ok: true, id: r.data.id } : { ok: false, message: apiMessage(r.error) }; });
    setBatch(keys);
  }
  const addFiles = (list: FileList | null) => { if (!list) return; const picked = [...list].map(checkFile); setFiles((f) => [...f, ...picked]); }; // copy now: the input is cleared right after, which empties the live FileList
  const mine = jobs.filter((j) => batch.includes(j.key));
  const working = mine.some((j) => j.phase === "uploading" || j.phase === "reading");
  const failedJobs = mine.filter((j) => j.phase === "failed");

  const footer = view === "busy"
    ? <><Button onClick={() => { reset(); }} disabled={working && false}>Add another</Button><Button variant="primary" onClick={() => { onOpenChange(false); reset(); }}>{working ? "Close, keep reading in the background" : "Done"}</Button></>
    : mode ? <><Button onClick={() => setMode(null)}>Back</Button><Button variant="primary" disabled={!ready} onClick={() => void go()}>{mode === "file" ? `Add ${okFiles.length || ""} file${okFiles.length === 1 ? "" : "s"}` : "Add to knowledge"}</Button></> : undefined;

  const tile = mode ? TILES.find((t) => t.id === mode)! : null;
  return (
    <Drawer open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }} title={view === "busy" ? (working ? "Adding…" : failedJobs.length ? "Needs attention" : "Done") : "Add knowledge"} footer={footer}>
      {view === "busy" ? (
        <div>
          <div className="flex flex-col items-center py-4 text-center">
            <span className={cn("mb-3 flex size-[4.5rem] items-center justify-center rounded-full", working ? "bg-accent-subtle text-accent-fg" : failedJobs.length ? "bg-danger-bg text-danger-fg" : "bg-success-bg text-success-fg")}>{working ? <Loader2 className="size-8 animate-spin" aria-hidden /> : failedJobs.length ? <AlertCircle className="size-8" aria-hidden /> : <Check className="size-8" aria-hidden />}</span>
            <h3 className="text-xl font-bold text-fg">{working ? "Reading…" : failedJobs.length ? "Something needs attention" : "Added. Your agents can use it now"}</h3>
            <p role="status" className="mt-1 text-base text-fg-muted">{working ? "This takes a few seconds." : failedJobs.length ? "Retry it from the list, or add it another way." : "You can check it with the search below the list."}</p>
          </div>
          <ul>{mine.map((j) => <JobRow key={j.key} job={j} onDismiss={() => onDismissJob(j.key)} />)}</ul>
        </div>
      ) : !mode ? (
        <div>
          <p className="mb-4 text-md text-fg-muted">What do you want your agents to know about?</p>
          <div className="grid grid-cols-2 gap-3">
            {TILES.map((t) => (
              <button key={t.id} type="button" onClick={() => setMode(t.id)} className="press relative flex min-h-36 flex-col justify-start rounded-3xl border-[1.5px] border-line p-4 text-left transition-[border-color,transform,box-shadow] duration-[var(--dur-base)] hover:-translate-y-0.5 hover:border-line-strong hover:shadow-popover">
                <span className={cn("mb-3 flex size-11 items-center justify-center rounded-2xl", t.hue)}><t.icon className="size-5" aria-hidden /></span>
                <b className="text-md text-fg">{t.name}</b><span className="text-sm text-fg-subtle">{t.text}</span>
              </button>
            ))}
          </div>
          <p className="mb-2.5 mt-6 text-sm font-semibold text-fg-subtle">Coming soon</p>
          <ul className="flex flex-wrap gap-2">{["Word or Excel · save as PDF for now", "Google Sheet", "Whole website"].map((x) => <li key={x} className="rounded-full bg-hover px-3.5 py-2 text-sm text-fg-muted">{x}</li>)}</ul>
        </div>
      ) : (
        <div>
          {tile && <div className="mb-5 flex items-center gap-3 rounded-2xl bg-subtle p-2.5 pr-3"><span className={cn("flex size-10 items-center justify-center rounded-xl", tile.hue)}><tile.icon className="size-5" aria-hidden /></span><b className="flex-1 text-md">{tile.name}</b><button type="button" onClick={() => setMode(null)} className="min-h-11 rounded px-2 font-semibold text-accent-fg">Change</button></div>}
          {mode === "paste" && (
            <div className="space-y-5">
              <div><label htmlFor="kb-title" className="mb-2 block text-md font-semibold">Title</label><Input id="kb-title" value={title} maxLength={200} placeholder="e.g. Refund policy" onChange={(e) => setTitle(e.target.value)} className="h-[3.25rem] rounded-xl border-[1.5px] bg-subtle px-4 text-md" autoFocus /><p className="mt-1.5 text-sm text-fg-subtle">So you can find it later.</p></div>
              <div><label htmlFor="kb-text" className="mb-2 block text-md font-semibold">Text</label><Textarea id="kb-text" rows={9} value={text} maxLength={KNOWLEDGE_LIMITS.maxCharsPerSource} onChange={(e) => setText(e.target.value)} placeholder="Paste the text here" className="min-h-52 rounded-xl border-[1.5px] bg-subtle px-4 py-3 text-md" /><p className="mt-1.5 text-sm text-fg-subtle">{fmtNumber(text.length)} of {fmtNumber(KNOWLEDGE_LIMITS.maxCharsPerSource)} characters</p></div>
            </div>
          )}
          {mode === "url" && (
            <div>
              <label htmlFor="kb-url" className="mb-2 block text-md font-semibold">Web page address</label>
              <Input id="kb-url" value={url} inputMode="url" autoCapitalize="off" maxLength={2048} placeholder="shop.example.com/delivery" onChange={(e) => setUrl(e.target.value)} className="h-[3.25rem] rounded-xl border-[1.5px] bg-subtle px-4 text-md" autoFocus />
              {urlInfo && <p className="mt-3 flex items-center gap-3 rounded-2xl bg-hover p-3.5 text-fg"><Globe className="size-5 shrink-0" aria-hidden /><span className="min-w-0"><b className="block break-words">{urlInfo.host}</b><span className="text-sm">We will read the text on this page.</span></span></p>}
              <p className="mt-2 text-sm text-fg-subtle">One public page at a time. Pages that need a login cannot be read.</p>
            </div>
          )}
          {mode === "file" && (
            <div>
              <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }} className={cn("rounded-3xl border-2 border-dashed px-5 py-9 text-center transition-[border-color,background-color,transform]", over ? "scale-[1.01] border-accent bg-accent-subtle" : "border-accent/30 bg-accent-subtle/30")}>
                <span className="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl bg-accent text-on-accent shadow-popover"><FileIcon className="size-6" aria-hidden /></span>
                <b className="block text-md">Drop files here</b>
                <p className="mx-auto mb-4 mt-1 max-w-xs text-sm text-fg-subtle">PDF, text, CSV, images and audio. Up to {fmtMb(MEDIA_LIMITS.document)} per PDF, {fmtMb(MEDIA_LIMITS.image)} per image, {fmtMb(MEDIA_LIMITS.audio)} per audio file.</p>
                <Button variant="primary" size="lg" onClick={() => inputRef.current?.click()} className="pointer-coarse:h-12">Choose files</Button>
                <input ref={inputRef} type="file" multiple accept={FILE_TYPES.join(",")} className="sr-only" tabIndex={-1} aria-label="Choose files" data-testid="kb-file" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
              </div>
              <ul className="mt-3 space-y-2">
                {files.map((f, i) => {
                  const ui = KIND_UI[f.kind ?? "text"];
                  return (
                    <li key={`${f.file.name}-${i}`} className={cn("flex items-start gap-3 rounded-2xl p-3.5", f.error ? "bg-danger-bg text-danger-fg" : "bg-subtle")}>
                      {f.error ? <AlertCircle className="mt-0.5 size-5 shrink-0" aria-hidden /> : <ui.icon className="mt-0.5 size-5 shrink-0 text-fg-muted" aria-hidden />}
                      <div className="min-w-0 flex-1"><b className="block break-words">{f.file.name}</b><span className={cn("text-sm", f.error ? "" : "text-fg-subtle")}>{f.error ?? `${fmtSize(f.file.size)} · ${ui.label}`}</span></div>
                      <Button variant="ghost" icon aria-label={`Remove ${f.file.name}`} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} className="pointer-coarse:size-11"><X /></Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {mode === "qa" && (
            <div>
              <p className="mb-4 text-base text-fg-muted">Add the questions customers really ask, with the answer you want given.</p>
              {qa.map((p, i) => (
                <div key={i} className="mb-3 space-y-2 rounded-2xl bg-subtle p-3.5">
                  <Input aria-label={`Question ${i + 1}`} value={p.q} maxLength={300} placeholder="Question, e.g. How long does delivery take?" onChange={(e) => setQa((x) => x.map((y, j) => (j === i ? { ...y, q: e.target.value } : y)))} className="h-12 bg-surface" />
                  <Textarea aria-label={`Answer ${i + 1}`} value={p.a} maxLength={2000} placeholder="Answer" onChange={(e) => setQa((x) => x.map((y, j) => (j === i ? { ...y, a: e.target.value } : y)))} className="min-h-20 bg-surface" />
                </div>
              ))}
              <Button size="sm" onClick={() => setQa((x) => [...x, { q: "", a: "" }])} className="pointer-coarse:h-11"><Plus aria-hidden />Add another question</Button>
              <Alert tone="info" className="mt-4">Saved as one text source. Your agents find each answer by its question.</Alert>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
