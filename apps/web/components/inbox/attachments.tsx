"use client";
import * as React from "react";
import { BookOpen, Download, FileText, Loader2, Paperclip, RefreshCw, ScanText, Sparkles, Trash2, Waves, X } from "lucide-react";
import { endpoints, type AiCapabilities, type AttachmentDto, type AttachmentList, type ConversationItem, type MediaResult } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { formatMicro } from "@/lib/ai-money";
import { checkPick, contentUrl, downloadFailureText, extOf, formatBytes, uploadFailureText } from "@/lib/attachments";
import { browserApi, errorMessage } from "@/lib/client-api";
import { useInbox } from "./context";

const POLL_MS = 10_000;
const EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg",
  webm: "video/webm", mp4: "video/mp4", mov: "video/quicktime", pdf: "application/pdf", txt: "text/plain", csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export const ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.mp3,.wav,.m4a,.ogg,.webm,.mp4,.mov,.docx,.xlsx,.pptx,.txt,.csv";

/** The files of one conversation (received and uploaded), refreshed with the thread. `null` until the first answer. */
export function useConversationAttachments(workspaceId: string, conversationId: string) {
  const [data, setData] = React.useState<AttachmentList | null>(null);
  const refresh = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.listAttachments, { params: { workspaceId, conversationId } });
    if (r.ok) setData(r.data);
  }, [workspaceId, conversationId]);
  React.useEffect(() => {
    void Promise.resolve().then(refresh);
    const t = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);
  return { data, refresh };
}

/** What the workspace's AI providers can do (GET /ai/capabilities). Only asked for people who may use AI. */
function useCapabilities(workspaceId: string, enabled: boolean) {
  const [caps, setCaps] = React.useState<AiCapabilities["available"] | null | "none">(null);
  React.useEffect(() => {
    if (!enabled) return;
    let live = true;
    void browserApi.call(endpoints.getAiCapabilities, { params: { workspaceId } }).then((r) => { if (live) setCaps(r.ok ? r.data.available : "none"); });
    return () => { live = false; };
  }, [workspaceId, enabled]);
  return caps;
}

type Action = "describe" | "extract" | "transcribe";
const ACTIONS: Record<Action, { label: string; icon: React.ComponentType<{ className?: string }>; needs: "vision" | "ocr" | "transcription"; why: string }> = {
  describe: { label: "Describe", icon: Sparkles, needs: "vision", why: "Describe needs an AI model that understands images." },
  extract: { label: "Extract text", icon: ScanText, needs: "ocr", why: "Extract text needs an AI model that reads documents or images." },
  transcribe: { label: "Transcribe", icon: Waves, needs: "transcription", why: "Transcribe needs a speech-to-text model." },
};
const ACTIONS_FOR: Record<AttachmentDto["kind"], Action[]> = { image: ["describe", "extract"], document: ["extract"], audio: ["transcribe"], video: [] };

function Thumb({ a, workspaceId }: { a: AttachmentDto; workspaceId: string }) {
  const [open, setOpen] = React.useState(false);
  const label = a.filename ?? "Image";
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={`Open image ${label}`} className="block overflow-hidden rounded-control border border-line bg-hover focus-visible:outline-2">
        {/* plain <img>: the file is served by our API with the session cookie, which next/image cannot proxy */}
        <img src={contentUrl(a, workspaceId)} alt={label} loading="lazy" className="max-h-48 max-w-full object-contain" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={label} description={`${formatBytes(a.sizeBytes)} image`} className="max-w-3xl">
          <img src={contentUrl(a, workspaceId)} alt={label} className="mx-auto max-h-[70vh] max-w-full object-contain" />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** One file in a message: preview or player when ready, a clear state otherwise, and the actions the person may take. */
function AttachmentView({ a, storageConfigured, onChanged }: { a: AttachmentDto; storageConfigured: boolean; onChanged: () => void }) {
  const { workspaceId, myUserId, canReply, canUseAi, canManageKnowledge, canAssignAny } = useInbox();
  const toast = useToast();
  const caps = useCapabilities(workspaceId, canUseAi && a.status === "ready");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ title: string; res: MediaResult } | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const params = { workspaceId, conversationId: a.conversationId, attachmentId: a.id };
  const name = a.filename ?? `${a.kind[0]!.toUpperCase()}${a.kind.slice(1)} file`;
  const canDelete = canAssignAny || (canReply && a.createdBy === myUserId);

  async function run(action: Action) {
    setBusy(action); setProblem(null); setResult(null);
    const r = action === "describe" ? await browserApi.call(endpoints.describeAttachment, { params })
      : action === "extract" ? await browserApi.call(endpoints.extractAttachment, { params })
      : await browserApi.call(endpoints.transcribeAttachment, { params, body: {} });
    setBusy(null);
    if (!r.ok) { setProblem(r.error.code === "capability_not_configured" ? ACTIONS[action].why + " An owner or admin can set one up in Settings, AI." : r.error.code === "budget_exceeded" ? "The monthly AI budget is used up. Raise it in Settings, AI." : errorMessage(r.error)); return; }
    setResult({ title: ACTIONS[action].label, res: r.data });
  }
  async function toKnowledge() {
    setBusy("knowledge"); setProblem(null);
    const r = await browserApi.call(endpoints.addAttachmentToKnowledge, { params: { workspaceId }, body: { attachmentId: a.id } });
    setBusy(null);
    if (!r.ok) { setProblem(r.error.code === "already_in_knowledge" ? "This file is already in the knowledge base." : r.error.code === "unsupported_type" ? "This file type can't be added. Use images, PDFs, audio, text or CSV." : errorMessage(r.error)); return; }
    toast("Added to the knowledge base");
  }
  async function remove() {
    if (!window.confirm(`Delete ${name}? The file is removed from storage and from any knowledge base entry made from it.`)) return;
    setBusy("delete");
    const r = await browserApi.call(endpoints.deleteAttachment, { params });
    setBusy(null);
    if (!r.ok) { toast(r.error.status === 403 ? "Only an owner, an admin or the person who uploaded it can delete this file." : errorMessage(r.error), "error"); return; }
    toast("File deleted");
    onChanged();
  }
  async function retry() {
    setBusy("retry");
    const r = await browserApi.call(endpoints.retryAttachment, { params });
    setBusy(null);
    if (!r.ok) { toast(errorMessage(r.error), "error"); return; }
    onChanged();
  }

  const deleteButton = canDelete && <Button size="sm" variant="ghost" loading={busy === "delete"} onClick={() => void remove()} aria-label={`Delete ${name}`}><Trash2 aria-hidden />Delete</Button>;
  const frame = "mt-1.5 max-w-full rounded-control border border-line bg-canvas p-2 text-sm text-fg";

  if (a.status === "pending") {
    return (
      <div role="status" aria-label={`${name}: ${storageConfigured ? "downloading" : "not saved"}`} className={frame}>
        {storageConfigured ? <div className="flex items-center gap-2"><Skeleton className="h-10 w-16" /><span className="text-fg-muted">Downloading {a.kind}…</span></div>
          : <p className="text-fg-muted">{a.kind[0]!.toUpperCase()}{a.kind.slice(1)} received. Storage is not configured, so the file can&apos;t be shown.</p>}
      </div>
    );
  }
  if (a.status === "failed" || a.status === "missing") {
    return (
      <div className={frame}>
        <p role="alert" className="text-danger-fg">{a.status === "missing" ? "The file is missing from storage." : `Couldn't download this ${a.kind}.`} {downloadFailureText(a.status === "missing" ? "blob_missing" : a.errorCode)}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {canReply && a.direction === "inbound" && <Button size="sm" loading={busy === "retry"} onClick={() => void retry()}><RefreshCw aria-hidden />Retry download</Button>}
          {deleteButton}
        </div>
      </div>
    );
  }

  const url = contentUrl(a, workspaceId);
  const available = caps !== null && caps !== "none" ? caps : null;
  return (
    <div className="mt-1.5 flex max-w-full flex-col items-start gap-1.5 text-fg">
      {a.kind === "image" && <Thumb a={a} workspaceId={workspaceId} />}
      {a.kind === "audio" && <audio controls preload="none" src={url} aria-label={`Audio ${name}`} className="w-full max-w-72" />}
      {a.kind === "video" && <video controls preload="metadata" src={url} aria-label={`Video ${name}`} className="max-h-64 max-w-full rounded-control bg-fg/5" />}
      {a.kind === "document" && (
        <a href={contentUrl(a, workspaceId, true)} download className="inline-flex max-w-full items-center gap-2 rounded-control border border-line bg-canvas px-2.5 py-1.5 text-sm text-fg hover:bg-hover focus-visible:outline-2" aria-label={`Download ${name}, ${formatBytes(a.sizeBytes)}`}>
          <FileText className="size-4 shrink-0 text-fg-muted" aria-hidden /><span className="min-w-0 truncate">{name}</span><span className="shrink-0 text-xs text-fg-subtle">{formatBytes(a.sizeBytes)}</span><Download className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
        </a>
      )}
      {a.kind !== "document" && <p className="text-xs text-fg-subtle">{name} · {formatBytes(a.sizeBytes)}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        {canUseAi && ACTIONS_FOR[a.kind].map((act) => {
          const A = ACTIONS[act];
          if (available && !available[A.needs]) return <span key={act} className="text-xs text-fg-subtle">{A.label} is unavailable: {A.why.replace(/^.*? needs /, "needs ").replace(/\.$/, "")}.</span>;
          return <Button key={act} size="sm" loading={busy === act} disabled={caps === null || caps === "none" || busy !== null} title={caps === "none" ? "AI is not set up for this workspace" : undefined} onClick={() => void run(act)}><A.icon aria-hidden />{A.label}</Button>;
        })}
        {canManageKnowledge && a.kind !== "video" && <Button size="sm" loading={busy === "knowledge"} disabled={busy !== null} onClick={() => void toKnowledge()}><BookOpen aria-hidden />Add to Knowledge</Button>}
        {deleteButton}
      </div>
      {canUseAi && caps === "none" && ACTIONS_FOR[a.kind].length > 0 && <p className="text-xs text-fg-subtle">AI actions are off: no AI provider is set up for this workspace.</p>}
      {problem && <Alert tone="warning" className="max-w-md">{problem}</Alert>}
      {result && (
        <section aria-label={`${result.title} result`} className="w-full max-w-md rounded-control border border-line bg-surface p-3 text-sm">
          <div className="flex items-center gap-2"><h4 className="font-medium">{result.title}</h4>{result.res.mock && <Badge tone="warning">MOCK</Badge>}<Button size="sm" variant="ghost" icon className="ml-auto" aria-label="Close result" onClick={() => setResult(null)}><X aria-hidden /></Button></div>
          <p className="mt-1 whitespace-pre-wrap break-words">{result.res.text}</p>
          <p className="mt-2 text-xs text-fg-subtle">{result.res.usage.inputTokens} input + {result.res.usage.outputTokens} output tokens · {formatMicro(result.res.usage.costMicro)} USD · {result.res.provider}</p>
        </section>
      )}
    </div>
  );
}

/** Files attached to one message. */
export function MessageFiles({ items, storageConfigured, onChanged }: { items: AttachmentDto[]; storageConfigured: boolean; onChanged: () => void }) {
  if (items.length === 0) return null;
  return <div className="flex flex-col items-start">{items.map((a) => <AttachmentView key={a.id} a={a} storageConfigured={storageConfigured} onChanged={onChanged} />)}</div>;
}

// ---------------------------------------------------------------- composer

export type Upload = { key: string; name: string; size: number; status: "uploading" | "ready" | "failed"; error?: string; attachmentId?: string };
const toBase64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] ?? ""); r.onerror = () => rej(r.error); r.readAsDataURL(f); });

/** Files chosen in the composer: each is uploaded at once (before Send) and shows its own status; a failed one can be retried or removed. */
export function useUploads(workspaceId: string, conversationId: string, limits: AttachmentList["limits"] | undefined, onRejected: (msg: string) => void) {
  const [items, setItems] = React.useState<Upload[]>([]);
  const files = React.useRef(new Map<string, File>());
  const patch = (key: string, p: Partial<Upload>) => setItems((old) => old.map((u) => (u.key === key ? { ...u, ...p } : u)));
  const send = React.useCallback(async (key: string) => {
    const file = files.current.get(key);
    if (!file) return;
    patch(key, { status: "uploading", error: undefined });
    const mime = file.type && file.type !== "application/octet-stream" ? file.type : EXT_MIME[extOf(file.name)] ?? "application/octet-stream";
    let r;
    try { r = await browserApi.call(endpoints.uploadAttachment, { params: { workspaceId, conversationId }, body: { filename: file.name, mime, contentBase64: await toBase64(file) } }); } catch { patch(key, { status: "failed", error: "The file could not be read." }); return; }
    if (!r.ok) { patch(key, { status: "failed", error: r.error.kind === "http" ? uploadFailureText(r.error.code, r.error.message) : errorMessage(r.error) }); return; }
    files.current.delete(key);
    patch(key, { status: "ready", attachmentId: r.data.id });
  }, [workspaceId, conversationId]);
  const add = (list: FileList | File[]) => {
    for (const f of Array.from(list)) {
      const why = checkPick(f, limits);
      if (why) { onRejected(`${f.name}: ${why}`); continue; }
      const key = crypto.randomUUID();
      files.current.set(key, f);
      setItems((old) => [...old, { key, name: f.name, size: f.size, status: "uploading" }]);
      void send(key);
    }
  };
  /** Removing an uploaded file also deletes it on the server, so nothing is left behind. */
  const remove = async (u: Upload) => {
    files.current.delete(u.key);
    setItems((old) => old.filter((x) => x.key !== u.key));
    if (u.attachmentId) await browserApi.call(endpoints.deleteAttachment, { params: { workspaceId, conversationId, attachmentId: u.attachmentId } });
  };
  const clear = () => { files.current.clear(); setItems([]); };
  return { items, add, retry: send, remove, clear, ready: items.filter((u) => u.status === "ready" && u.attachmentId), busy: items.some((u) => u.status === "uploading") };
}

/** Attach button and the status list. The button is always explained: why it is off is written next to it, never silent. */
export function AttachControls({ uploads, platform, storageConfigured, disabled }: { uploads: ReturnType<typeof useUploads>; platform: ConversationItem["platform"]; storageConfigured: boolean; disabled: boolean }) {
  const input = React.useRef<HTMLInputElement>(null);
  const off = platform !== "whatsapp" ? "Sending files is only available on WhatsApp for now." : !storageConfigured ? "File storage is not set up on this server." : null;
  return (
    <>
      <input ref={input} type="file" multiple accept={ACCEPT} className="sr-only" tabIndex={-1} aria-label="Choose files to attach" data-testid="attach-input" onChange={(e) => { if (e.target.files) uploads.add(e.target.files); e.target.value = ""; }} />
      <Button type="button" size="sm" icon disabled={disabled || off !== null} aria-label={off ? `Attach file. ${off}` : "Attach file"} title={off ?? "Attach file"} onClick={() => input.current?.click()}><Paperclip aria-hidden /></Button>
    </>
  );
}

export function UploadList({ uploads, notice }: { uploads: ReturnType<typeof useUploads>; notice: string | null }) {
  if (uploads.items.length === 0 && !notice) return null;
  return (
    <div className="px-3 pt-2.5">
      {notice && <p role="alert" className="mb-1.5 text-xs text-danger-fg">{notice}</p>}
      <ul aria-label="Files to send" className="flex flex-col gap-1.5">
        {uploads.items.map((u) => (
          <li key={u.key} className="flex flex-wrap items-center gap-2 rounded-control border border-line bg-canvas px-2 py-1 text-sm">
            <FileText className="size-4 shrink-0 text-fg-muted" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{u.name}</span>
            <span className="text-xs text-fg-subtle">{formatBytes(u.size)}</span>
            {u.status === "uploading" && <span role="status" className="inline-flex items-center gap-1 text-xs text-fg-muted"><Loader2 className="size-3 animate-spin" aria-hidden />Uploading…</span>}
            {u.status === "ready" && <Badge tone="success">Ready</Badge>}
            {u.status === "failed" && <><span role="alert" className="basis-full text-xs text-danger-fg sm:basis-auto">{u.error}</span><Button type="button" size="sm" onClick={() => void uploads.retry(u.key)}><RefreshCw aria-hidden />Retry</Button></>}
            <Button type="button" size="sm" variant="ghost" icon aria-label={`Remove ${u.name}`} onClick={() => void uploads.remove(u)}><X aria-hidden /></Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
