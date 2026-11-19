"use client";
import * as React from "react";
import { Cpu, Eye, FlaskConical } from "lucide-react";
import { endpoints, MEDIA_LIMITS, type AiCapabilities, type AiProviderDto, type MediaResult } from "@crm/contracts";
import type { ApiError } from "@crm/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/overlays";
import { FoldPanel } from "@/components/ai/fold-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatMicro } from "@/lib/ai-money";

const CAPS = [["text", "Text"], ["vision", "Vision"], ["document", "OCR and PDF"], ["transcription", "Transcription"]] as const;

/**
 * Capabilities per connected model. Flags come from a built-in catalog written from memory: UNVERIFIED for every real provider.
 * A model id you add yourself is text only. The mock provider is offline and labelled MOCK.
 */
export function CapabilitiesPanel({ workspaceId, providers }: { workspaceId: string; providers: AiProviderDto[] }) {
  const [state, setState] = React.useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: AiCapabilities }>({ kind: "loading" });
  const load = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.getAiCapabilities, { params: { workspaceId } });
    setState(r.ok ? { kind: "ready", data: r.data } : { kind: "error", message: errorMessage(r.error) });
  }, [workspaceId]);
  const sig = providers.map((p) => `${p.id}:${p.enabled}:${p.isDefault}:${p.defaultModel}:${p.models.length}`).join("|");
  React.useEffect(() => { void load(); }, [load, sig]); // eslint-disable-line react-hooks/set-state-in-effect

  return (
    <FoldPanel id="ai-capabilities" icon={Eye} title="Capabilities" summary="What each model can do with images, documents and audio.">
      <div className="p-4">
        {state.kind === "loading" && <div role="status" aria-label="Loading capabilities"><Skeleton className="h-24" /></div>}
        {state.kind === "error" && <ErrorState title="Could not load capabilities" description={state.message} onRetry={() => { setState({ kind: "loading" }); void load(); }} />}
        {state.kind === "ready" && state.data.providers.length === 0 && <EmptyState icon={Cpu} title="No provider connected" description="Connect and enable one above." />}
        {state.kind === "ready" && state.data.providers.length > 0 && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-fg-muted" role="status">
              Available now: <strong className="font-medium text-fg">{[state.data.available.vision && "image understanding", state.data.available.ocr && "text from PDFs and images", state.data.available.transcription && "audio transcription"].filter(Boolean).join(", ") || "text only"}</strong>.
            </p>
            {state.data.providers.map((p) => (
              <section key={p.provider} aria-label={`${p.label} capabilities`} className="flex flex-col gap-2">
                <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">{p.label}{p.mock && <Badge tone="warning">MOCK</Badge>}{p.unverified && <Tooltip label="From a built-in list, not checked against the vendor." side="bottom"><span><Badge tone="warning">Not tested live</Badge></span></Tooltip>}{p.isDefault && <Badge tone="success">Default</Badge>}</h3>
                <ul className="flex flex-col gap-2">
                  {p.models.map((m) => (
                    <li key={m.id} aria-label={`${m.label} capabilities`} className="flex flex-wrap items-center gap-2 rounded-control border border-line-card px-3 py-2">
                      <span className="min-w-0 flex-1 basis-40 break-words text-sm text-fg">{m.label}</span>
                      <span className="flex flex-wrap gap-1.5">
                        {CAPS.map(([cap, label]) => (m.capabilities as string[]).includes(cap)
                          ? <Badge key={cap} tone="success">{label}</Badge>
                          : <Badge key={cap} tone="neutral"><span className="sr-only">No </span><span aria-hidden className="line-through">{label}</span></Badge>)}
                      </span>
                      {m.transcriptionMicroPerMinute !== null && <span className="basis-full text-xs text-fg-subtle">Transcription price: {formatMicro(m.transcriptionMicroPerMinute)} USD per minute (indicative)</span>}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </FoldPanel>
  );
}

type Op = "describe" | "ask" | "extract" | "transcribe";
const OPS: Record<Op, { label: string; accept: string; kinds: string; hint: string; max: number }> = {
  describe: { label: "Describe an image", accept: "image/png,image/jpeg,image/webp,image/gif", kinds: "png, jpeg, webp or gif", hint: "PNG, JPEG, WebP or GIF, up to 5 MB.", max: MEDIA_LIMITS.image },
  ask: { label: "Ask about an image", accept: "image/png,image/jpeg,image/webp,image/gif", kinds: "png, jpeg, webp or gif", hint: "PNG, JPEG, WebP or GIF, up to 5 MB.", max: MEDIA_LIMITS.image },
  extract: { label: "Extract text from a PDF or image", accept: "application/pdf,image/png,image/jpeg,image/webp,image/gif", kinds: "pdf, png, jpeg, webp or gif", hint: "PDF up to 10 MB, or an image up to 5 MB.", max: MEDIA_LIMITS.document },
  transcribe: { label: "Transcribe audio", accept: "audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,audio/ogg,audio/webm", kinds: "mp3, wav, m4a, ogg or webm", hint: "MP3, WAV, M4A, OGG or WebM, up to 20 MB.", max: MEDIA_LIMITS.audio },
};

function toBase64(buf: ArrayBuffer): string {
  let s = "";
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Failure -> title and text. Our API errors carry a curated message; anything else falls back to the generic one. */
function describeFailure(e: ApiError): { title: string; text: string } {
  const code = e.kind === "http" ? e.code : "";
  const text = e.kind === "http" && e.message ? e.message : errorMessage(e);
  const title = code === "budget_exceeded" ? "Blocked by the monthly budget" : code === "capability_not_configured" ? "No provider with this capability" : code === "unsupported_capability" ? "This model cannot do that" : code === "rate_limited" ? "Slow down" : "Could not process the file";
  return { title, text };
}

/** Try describe, ask, extract and transcribe on one file. The file is sent to the AI provider you configured and is not stored; only sizes and a hash go to the usage log. */
export function MediaPlayground({ workspaceId }: { workspaceId: string }) {
  const [op, setOp] = React.useState<Op>("describe");
  const [file, setFile] = React.useState<File | null>(null);
  const [question, setQuestion] = React.useState("");
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<{ title: string; text: string } | null>(null);
  const [result, setResult] = React.useState<MediaResult | null>(null);
  const [inputKey, setInputKey] = React.useState(0);
  const o = OPS[op];

  function pick(f: File | null, forOp: Op = op) {
    setFile(f); setFieldError(null); setResult(null); setFailure(null);
    if (f && f.size > OPS[forOp].max) setFieldError(`This file is ${fmtSize(f.size)}. The limit is ${fmtSize(OPS[forOp].max)} for this action.`);
  }
  function chooseOp(next: Op) {
    setOp(next); setFile(null); setFieldError(null); setResult(null); setFailure(null); setQuestion("");
    setInputKey((k) => k + 1); // clears the native file input
  }

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setFailure(null); setResult(null);
    if (!file) return setFieldError("Choose a file first.");
    if (file.size > o.max) return setFieldError(`This file is ${fmtSize(file.size)}. The limit is ${fmtSize(o.max)} for this action.`);
    if (op === "ask" && !question.trim()) return setFieldError("Type a question about the image.");
    setFieldError(null); setBusy(true);
    const mime = file.type || "application/octet-stream";
    const contentBase64 = toBase64(await file.arrayBuffer());
    const params = { workspaceId };
    const res = op === "describe" ? await browserApi.call(endpoints.describeMedia, { params, body: { mime, contentBase64 } })
      : op === "ask" ? await browserApi.call(endpoints.askMedia, { params, body: { mime, contentBase64, question: question.trim() } })
      : op === "extract" ? await browserApi.call(endpoints.extractMedia, { params, body: { mime, contentBase64 } })
      : await browserApi.call(endpoints.transcribeMedia, { params, body: { mime, contentBase64 } });
    setBusy(false);
    if (!res.ok) return setFailure(describeFailure(res.error));
    setResult(res.data);
  }

  return (
    <FoldPanel id="ai-playground" icon={FlaskConical} title="Media playground" summary="Send one file to your provider. It is not stored here. Advanced.">
      <form onSubmit={run} className="flex flex-col gap-4 p-4" noValidate aria-label="Media playground">
        <Field label="Action">{(p) => (
          <Select {...p} value={op} disabled={busy} onChange={(e) => chooseOp(e.target.value as Op)}>
            {(Object.keys(OPS) as Op[]).map((k) => <option key={k} value={k}>{OPS[k].label}</option>)}
          </Select>
        )}</Field>
        <Field label="File" hint={o.hint} error={fieldError}>{(p) => <Input {...p} key={inputKey} type="file" accept={o.accept} disabled={busy} onChange={(e) => pick(e.target.files?.[0] ?? null)} />}</Field>
        {op === "ask" && <Field label="Question" hint="Up to 1000 characters.">{(p) => <Textarea {...p} rows={3} maxLength={1000} value={question} disabled={busy} onChange={(e) => setQuestion(e.target.value)} placeholder="What does the label say?" />}</Field>}
        <div><Button type="submit" variant="primary" loading={busy}><FlaskConical className="size-4" aria-hidden />{busy ? "Working…" : "Run"}</Button></div>
      </form>
      <div className="flex flex-col gap-3 px-4 pb-4" aria-live="polite">
        {failure && <Alert tone="error"><strong className="font-medium">{failure.title}.</strong> {failure.text}</Alert>}
        {!failure && !result && !busy && <p className="text-sm text-fg-subtle">The result appears here with its token usage and cost.</p>}
        {busy && <p role="status" className="text-sm text-fg-muted">Sending the file to the provider…</p>}
        {result && (
          <section aria-label="Result" className="flex flex-col gap-2">
            <p className="flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
              <span>{result.provider} / {result.model}</span>
              {result.mock && <Badge tone="warning">MOCK</Badge>}
              {result.provider !== "mock" && <Badge tone="warning">Not tested live</Badge>}
            </p>
            <p data-testid="media-result" className="whitespace-pre-wrap break-words rounded-control bg-subtle p-3 text-sm text-fg">{result.text || "(The model returned no text.)"}</p>
            <p className="text-xs text-fg-muted">Tokens: {result.usage.inputTokens.toLocaleString()} in, {result.usage.outputTokens.toLocaleString()} out. Cost: {formatMicro(result.usage.costMicro)} USD. Run {result.runId.slice(0, 8)}.</p>
          </section>
        )}
      </div>
    </FoldPanel>
  );
}
