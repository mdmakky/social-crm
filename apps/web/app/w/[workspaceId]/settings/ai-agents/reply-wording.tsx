"use client";
import * as React from "react";
import { endpoints, type AiPromptDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/form-controls";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, ErrorState } from "@/components/ui/states";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";

/** The wording sent with every reply suggestion. Moved here from Setup: it is instructions, like an agent's. Each save is a new version; the built-in text is always one click away. */
export function ReplyWording({ workspaceId }: { workspaceId: string }) {
  return <ToastProvider><Inner workspaceId={workspaceId} /></ToastProvider>;
}

function Inner({ workspaceId }: { workspaceId: string }) {
  const params = { workspaceId };
  const toast = useToast();
  const [pr, setPr] = React.useState<AiPromptDto | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.listAiPrompts, { params: { workspaceId } });
    if (!r.ok) { setLoadError(errorMessage(r.error)); return; }
    const first = r.data.items[0];
    if (!first) { setLoadError("No prompt found."); return; }
    setLoadError(null); setPr(first);
    setText(first.versions.find((v) => v.active)?.template ?? first.defaultTemplate);
  }, [workspaceId]);
  React.useEffect(() => { void load(); }, [load]); // eslint-disable-line react-hooks/set-state-in-effect

  const head = <PanelHeader title="Reply suggestion wording" description="The instructions sent with every reply suggestion in the inbox. Each save is a new version." />;
  if (loadError) return <Panel id="reply-wording" className="scroll-mt-14">{head}<ErrorState title="Could not load the reply wording" description={loadError} onRetry={() => { setLoadError(null); void load(); }} /></Panel>;
  if (!pr) return <Panel id="reply-wording" className="scroll-mt-14" role="status" aria-label="Loading reply wording">{head}<div className="p-4"><Skeleton className="h-40" /></div></Panel>;

  const activeText = pr.versions.find((v) => v.active)?.template ?? pr.defaultTemplate;
  const changed = text.trim() !== activeText.trim();
  async function publish() {
    if (!pr) return;
    setError(null); setBusy("publish");
    const r = await browserApi.call(endpoints.setAiPrompt, { params: { ...params, key: pr.key }, body: { template: text } });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    toast("New prompt version published", "success");
    await load();
  }
  async function activate(version: number) {
    if (!pr) return;
    setError(null); setBusy(`v${version}`);
    const r = await browserApi.call(endpoints.activateAiPrompt, { params: { ...params, key: pr.key }, body: { version } });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    toast(version === 0 ? "Built-in prompt is active" : `Version ${version} is active`, "success");
    await load();
  }

  return (
    <Panel id="reply-wording" className="scroll-mt-14">
      {head}
      <div className="flex flex-col gap-4 p-4">
        <form onSubmit={(e) => { e.preventDefault(); void publish(); }} className="flex flex-col gap-3" noValidate>
          <Field label="Prompt template" hint={`Placeholders: ${pr.variables.map((v) => `{{${v}}}`).join(", ")}. Nothing else is allowed.`}>{(p) => (
            <Textarea {...p} rows={8} maxLength={4000} value={text} disabled={busy !== null} onChange={(e) => setText(e.target.value)} />
          )}</Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" loading={busy === "publish"} disabled={!changed || !text.trim()}>Publish as new version</Button>
            <span className="text-sm text-fg-muted">{pr.activeVersion === 0 ? "Using the built-in prompt." : `Version ${pr.activeVersion} is active.`}</span>
          </div>
        </form>
        {error && <Alert tone="error">{error}</Alert>}
        <section aria-labelledby="prompt-versions">
          <h3 id="prompt-versions" className="mb-2 text-sm font-medium text-fg">Versions</h3>
          <ul className="flex flex-col gap-2">
            <li className="flex flex-wrap items-center gap-3 rounded-control border border-line-card px-3 py-2">
              <span className="min-w-0 flex-1 text-sm text-fg">Built-in default</span>
              {pr.activeVersion === 0 ? <Badge tone="success">Active</Badge> : <Button size="sm" onClick={() => void activate(0)} loading={busy === "v0"} aria-label="Use the built-in prompt">Use this</Button>}
            </li>
            {pr.versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-3 rounded-control border border-line-card px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-fg">Version {v.version} <span className="text-fg-muted">· {new Date(v.createdAt).toLocaleDateString()}</span></span>
                {v.active ? <Badge tone="success">Active</Badge> : <Button size="sm" onClick={() => void activate(v.version)} loading={busy === `v${v.version}`} aria-label={`Use version ${v.version}`}>Use this</Button>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Panel>
  );
}
