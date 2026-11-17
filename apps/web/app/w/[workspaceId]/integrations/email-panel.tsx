"use client";
import * as React from "react";
import { Check, Copy, Mail, Plug, RefreshCw } from "lucide-react";
import { endpoints, type EmailIntegrationState, type EmailSetupCheck } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogActions, DialogContent } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";

const SETUP = { unchecked: { label: "Not checked yet", tone: "neutral" }, pending: { label: "Not confirmed", tone: "warning" }, verified: { label: "Checked (mock)", tone: "success" }, failed: { label: "Problem found", tone: "danger" } } as const;

/**
 * Email support inbox panel: a support address, the DNS records the owner adds, a setup check, on/off and disconnect. No OAuth.
 * MOCK until a provider has been verified with a real request: the badges say so and never claim live delivery.
 */
export function EmailPanel({ workspaceId, canManage, state, onState }: { workspaceId: string; canManage: boolean; state: EmailIntegrationState | null; onState: (s: EmailIntegrationState) => void }) {
  const params = { workspaceId };
  const [busy, setBusy] = React.useState<"connect" | "check" | "toggle" | "disconnect" | "load" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [checks, setChecks] = React.useState<EmailSetupCheck["checks"] | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);

  async function load() {
    setBusy("load");
    setError(null);
    const r = await browserApi.call(endpoints.getEmailIntegration, { params });
    setBusy(null);
    if (r.ok) onState(r.data); else setError(errorMessage(r.error));
  }
  async function run<T extends EmailIntegrationState | EmailSetupCheck>(kind: NonNullable<typeof busy>, call: () => Promise<{ ok: true; data: T } | { ok: false; error: Parameters<typeof errorMessage>[0] }>, apply: (d: T) => void) {
    setBusy(kind);
    setError(null);
    const r = await call();
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    apply(r.data);
  }
  const connect = () => run("connect", () => browserApi.call(endpoints.connectEmail, { params, body: {} }), (d) => onState(d));
  const check = () => run("check", () => browserApi.call(endpoints.checkEmailSetup, { params }), (d) => { setChecks(d.checks); onState(d.state); });
  const toggle = (enabled: boolean) => run("toggle", () => browserApi.call(endpoints.setEmailEnabled, { params, body: { enabled } }), (d) => onState(d));
  const disconnect = () => run("disconnect", () => browserApi.call(endpoints.disconnectEmail, { params }), (d) => { setChecks(null); setConfirm(false); onState(d); });

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError("Copying is not allowed here. Select the address and copy it by hand."); }
  }

  if (!state) {
    return busy === "load"
      ? <div aria-busy="true" aria-label="Loading email settings" className="flex flex-col gap-3 p-4"><Skeleton className="h-5 w-48" /><Skeleton className="h-10" /><Skeleton className="h-24" /></div>
      : <ErrorState title="Could not load email settings" description={error ?? "Try again in a moment."} onRetry={() => void load()} />;
  }
  if (!state.available) {
    return <div className="p-4"><Alert tone="info">Email is not set up on this server yet. The server needs a mail provider and an inbound domain; see the email setup guide.</Alert></div>;
  }
  const a = state.account;
  // The "Not tested live" badge is in the channel header (meta-integrations.tsx); here only the mock label.
  const badges = state.mock ? <div><Badge tone="warning">MOCK</Badge></div> : null;

  if (!a) {
    return (
      <div className="flex flex-col gap-2 p-4">
        {badges}
        <EmptyState icon={Mail} title="Add an email address for support" description="Customers email you, each sender becomes a conversation, and your team replies from the Inbox. You add a few DNS records to your own domain." action={canManage ? <Button variant="primary" loading={busy === "connect"} onClick={() => void connect()}><Plug className="size-4" aria-hidden />Create support address</Button> : <p className="text-sm text-fg-subtle">Ask an owner or admin to set this up.</p>} />
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    );
  }

  const setup = SETUP[a.setupStatus];
  return (
    <div className="flex flex-col">
      <section aria-labelledby="em-addr" className="flex flex-col gap-3 border-b border-line-card p-4">
        {badges}
        <h3 id="em-addr" className="text-sm font-semibold text-fg">Your support address</h3>
        <div className="flex flex-wrap items-center gap-2">
          <code data-testid="email-support-address" className="min-w-0 break-all rounded-control bg-hover px-2 py-1 text-sm text-fg">{a.supportAddress}</code>
          <Button onClick={() => void copy(a.supportAddress)}>{copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}{copied ? "Copied" : "Copy"}</Button>
        </div>
        <p className="text-sm text-fg-subtle">Customers write here. Your replies are sent from <span className="font-medium text-fg-muted">{a.fromAddress}</span> as {a.displayName}. The long part of the address is private to this workspace.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={a.enabled ? "success" : "neutral"}>{a.enabled ? "On" : "Off"}</Badge>
          {canManage && <Button loading={busy === "toggle"} onClick={() => void toggle(!a.enabled)}>{a.enabled ? "Turn off" : "Turn on"}</Button>}
          {!a.enabled && <span className="text-sm text-fg-subtle">New email is kept aside until you turn this on.</span>}
        </div>
      </section>

      <section aria-labelledby="em-dns" className="flex flex-col gap-3 border-b border-line-card p-4">
        <h3 id="em-dns" className="text-sm font-semibold text-fg">Set up your domain</h3>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-fg-muted">
          {state.dns.map((d) => <li key={d.id}><span className="font-medium text-fg">{d.title}.</span> {d.plain}</li>)}
        </ol>
        <details className="text-sm text-fg-subtle">
          <summary className="cursor-pointer font-medium text-fg-muted">Technical details</summary>
          <div className="mt-2 flex flex-col gap-3">
            {state.dns.map((d) => (
              <dl key={d.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-control border border-line-card p-3">
                <dt className="text-fg-subtle">Type</dt><dd className="font-mono text-fg">{d.type}</dd>
                <dt className="text-fg-subtle">Host</dt><dd className="break-all font-mono text-fg">{d.host}</dd>
                <dt className="text-fg-subtle">Value</dt><dd className="break-all font-mono text-fg">{d.value}</dd>
                <dt className="text-fg-subtle">Notes</dt><dd>{d.technical}</dd>
              </dl>
            ))}
          </div>
        </details>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && <Button loading={busy === "check"} onClick={() => void check()}><RefreshCw className="size-4" aria-hidden />Check setup</Button>}
          <Badge tone={setup.tone}>{setup.label}</Badge>
        </div>
        {checks && (
          <ul aria-label="Setup check result" className="flex flex-col gap-1 text-sm">
            {checks.map((c) => <li key={c.id} className="flex items-start gap-2"><Badge tone={c.ok ? "success" : "warning"} shape="square">{c.id.toUpperCase()}</Badge><span className="text-fg-muted">{c.message}</span></li>)}
          </ul>
        )}
        {state.mock && <p className="text-sm text-fg-subtle">Mock mode: the check returns example results. No DNS lookup and no email provider call is made.</p>}
      </section>

      <section aria-labelledby="em-more" className="flex flex-col gap-2 p-4">
        <h3 id="em-more" className="text-sm font-semibold text-fg">Good to know</h3>
        <ul className="list-disc pl-5 text-sm text-fg-subtle">
          <li>Only the text of an email is kept. Pictures, formatting and attachments are not stored; attachments are listed by name.</li>
          <li>Automatic replies, newsletters and bounce notices are ignored.</li>
          <li>Email from a sender that fails the SPF/DKIM checks is marked &quot;Unverified sender&quot; and cannot be replied to.</li>
        </ul>
        {canManage && <div className="mt-2"><Button variant="danger" onClick={() => setConfirm(true)}>Disconnect email</Button></div>}
      </section>
      {error && <div className="px-4 pb-4"><Alert tone="error">{error}</Alert></div>}

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent title="Disconnect email?" description="New email stops arriving and replies are blocked. Your support address and past conversations are kept; you can turn it on again.">
          <DialogActions>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" loading={busy === "disconnect"} onClick={() => void disconnect()}>Disconnect</Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}
