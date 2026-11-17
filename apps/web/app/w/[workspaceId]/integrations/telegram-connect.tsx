"use client";
import * as React from "react";
import { Plug } from "lucide-react";
import { endpoints, type ConnectTelegramResult } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";

/**
 * Telegram bot connection (MOCK ONLY so far): the owner pastes the BotFather token and connects. The token lives only in this component's state while the form is used, goes to our API over the
 * same-origin proxy, is cleared as soon as the request succeeds and is never shown again.
 */
export function TelegramConnect({ workspaceId, disabledReason, mock, onConnected }: { workspaceId: string; disabledReason?: string; mock: boolean; onConnected: (r: ConnectTelegramResult) => void | Promise<void> }) {
  const [token, setToken] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErr, setFieldErr] = React.useState<string | undefined>();
  const off = !!disabledReason;

  async function connect() {
    setError(null);
    const t = token.trim();
    if (t.length < 20 || /\s/.test(t)) { setFieldErr("Paste the whole token from BotFather, with no spaces."); return; }
    setFieldErr(undefined);
    setBusy(true);
    const r = await browserApi.call(endpoints.connectTelegram, { params: { workspaceId }, body: { botToken: t } });
    setBusy(false);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    setToken("");
    await onConnected(r.data);
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void connect(); }} className="flex flex-col gap-3" noValidate>
      {mock && <div><Badge tone="warning">MOCK</Badge></div>}
      <Field label="Bot token" error={fieldErr} hint="From BotFather. Stored encrypted. Never shown again.">
        {(p) => <Input {...p} type="password" autoComplete="off" spellCheck={false} value={token} disabled={off || busy} onChange={(e) => setToken(e.target.value)} />}
      </Field>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={off} loading={busy}><Plug className="size-4" aria-hidden />Connect bot</Button>
        {disabledReason && <p className="text-sm text-fg-subtle">{disabledReason}</p>}
      </div>
      <details className="text-sm text-fg-subtle">
        <summary className="cursor-pointer font-medium text-fg-muted">Technical details</summary>
        <p className="mt-1">
          Create a bot with BotFather and copy its token. We check it with Telegram, set the bot&apos;s webhook to this server and keep the token encrypted. Only private chats are used. A bot cannot start a chat, so you can reply once the person has written to the bot.
          Everything here is tested with a mock only, not with Telegram.
        </p>
      </details>
    </form>
  );
}
