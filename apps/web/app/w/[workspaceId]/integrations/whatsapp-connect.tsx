"use client";
import * as React from "react";
import { Plug, Search } from "lucide-react";
import { endpoints, type ConnectWhatsAppResult, type WhatsAppLookupResult } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";

type Numbers = WhatsAppLookupResult["numbers"];

/**
 * WhatsApp manual connection: the owner pastes the WhatsApp Business Account id and a system user token, picks a number, and connects it.
 * The token lives only in this component's state while the form is used; it is sent to our API over the same-origin proxy and cleared as soon as a request succeeds. It is never shown again.
 */
export function WhatsAppConnect({ workspaceId, disabledReason, mock, onConnected }: { workspaceId: string; disabledReason?: string; mock: boolean; onConnected: (r: ConnectWhatsAppResult) => void | Promise<void> }) {
  const params = { workspaceId };
  const [waba, setWaba] = React.useState("");
  const [token, setToken] = React.useState("");
  const [numbers, setNumbers] = React.useState<Numbers | null>(null);
  const [pick, setPick] = React.useState("");
  const [busy, setBusy] = React.useState<"find" | "connect" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErr, setFieldErr] = React.useState<{ waba?: string; token?: string }>({});
  const off = !!disabledReason;

  function validate() {
    const e: { waba?: string; token?: string } = {};
    if (!/^[1-9][0-9]{0,99}$/.test(waba.trim())) e.waba = "Enter the WhatsApp Business Account ID: digits only.";
    if (token.trim().length < 20 || /\s/.test(token.trim())) e.token = "Paste the whole system user token, with no spaces.";
    setFieldErr(e);
    return Object.keys(e).length === 0;
  }

  async function find() {
    setError(null);
    if (!validate()) return;
    setBusy("find");
    const r = await browserApi.call(endpoints.lookupWhatsAppNumbers, { params, body: { wabaId: waba.trim(), accessToken: token.trim() } });
    setBusy(null);
    if (!r.ok) { setNumbers(null); setError(errorMessage(r.error)); return; }
    setNumbers(r.data.numbers);
    setPick(r.data.numbers.find((n) => !n.connected && !n.unavailable)?.phoneNumberId ?? "");
  }

  async function connect() {
    setError(null);
    if (!pick || !validate()) return;
    setBusy("connect");
    const r = await browserApi.call(endpoints.connectWhatsApp, { params, body: { wabaId: waba.trim(), accessToken: token.trim(), phoneNumberId: pick } });
    setBusy(null);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    setToken("");
    setWaba("");
    setNumbers(null);
    setPick("");
    await onConnected(r.data);
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void (numbers ? connect() : find()); }} className="flex flex-col gap-3" noValidate>
      <p className="text-sm text-fg-subtle">
        Connect a number from your own WhatsApp Business Account. In Meta Business Settings create a system user, give it access to your app and to the WhatsApp account, and generate a token with the permissions
        {" "}<span className="font-medium text-fg-muted">business_management</span>, <span className="font-medium text-fg-muted">whatsapp_business_management</span> and <span className="font-medium text-fg-muted">whatsapp_business_messaging</span>.
        The token is stored encrypted and is never shown again. Receiving works once the app&apos;s WhatsApp webhook is set up in the Meta app dashboard (see below). Sending replies is not available yet.
      </p>
      {mock && <Alert tone="warning">Mock mode: nothing is sent to Meta. Any WhatsApp Business Account ID known to the mock works.</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="WhatsApp Business Account ID" error={fieldErr.waba} hint="Shown in WhatsApp Manager and in the app dashboard.">
          {(p) => <Input {...p} inputMode="numeric" autoComplete="off" value={waba} disabled={off || busy !== null} onChange={(e) => { setWaba(e.target.value); setNumbers(null); }} />}
        </Field>
        <Field label="System user token" error={fieldErr.token} hint="Pasted once, kept encrypted on the server.">
          {(p) => <Input {...p} type="password" autoComplete="off" spellCheck={false} value={token} disabled={off || busy !== null} onChange={(e) => { setToken(e.target.value); setNumbers(null); }} />}
        </Field>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {numbers && (
        numbers.length === 0 ? <Alert tone="warning">This account has no phone numbers. Add and verify a number in WhatsApp Manager first.</Alert> : numbers.every((n) => n.unavailable) ? <Alert tone="warning">Every number of this account is already connected to another workspace. Disconnect it there first, or contact support.</Alert> : (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-fg">Choose the number to connect</legend>
            {numbers.map((n) => (
              <label key={n.phoneNumberId} className={`flex min-h-11 items-center gap-3 rounded-control border border-line-card px-3 py-2 ${n.unavailable ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}>
                <input type="radio" name="wa-number" value={n.phoneNumberId} checked={pick === n.phoneNumberId} disabled={n.unavailable} onChange={() => setPick(n.phoneNumberId)} />
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{n.verifiedName ?? n.displayPhoneNumber}</span><span className="block text-sm text-fg-muted">{n.displayPhoneNumber} · ID {n.phoneNumberId}{n.unavailable ? " · already connected to another workspace: it cannot be connected here" : n.connected ? " · already connected (connecting again replaces its token)" : ""}</span></span>
              </label>
            ))}
          </fieldset>
        )
      )}
      <div className="flex flex-wrap items-center gap-2">
        {numbers && numbers.some((n) => !n.unavailable)
          ? <Button type="submit" variant="primary" disabled={off || !pick} loading={busy === "connect"}><Plug className="size-4" aria-hidden />Connect number</Button>
          : <Button type="submit" variant="primary" disabled={off} loading={busy === "find"}><Search className="size-4" aria-hidden />Find numbers</Button>}
        {numbers && <Button type="button" onClick={() => { setNumbers(null); setPick(""); }} disabled={busy !== null}>Start over</Button>}
        {disabledReason && <p className="text-sm text-fg-subtle">{disabledReason}</p>}
      </div>
    </form>
  );
}
