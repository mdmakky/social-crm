"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { endpoints, type InvitationPreview } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/states";
import { authClient } from "@/lib/auth-client";
import { browserApi } from "@/lib/client-api";
import { formatDate, ROLE_LABEL } from "@/lib/format";

const maskEmail = (e: string) => `${e.split("@")[0]!.slice(0, 1)}***@${e.split("@")[1] ?? ""}`.toLowerCase();

export function InvitePanel({ token, preview, me }: { token: string; preview: InvitationPreview; me: { email: string } | null }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null);
  const next = encodeURIComponent(`/invite/${token}`);
  // The preview only carries a masked address, so this can prove a mismatch but never a match: the server decides on accept.
  const wrong = !!me && (maskEmail(me.email) !== preview.emailMasked.toLowerCase() || error?.code === "wrong_email");

  async function join() {
    setBusy(true);
    setError(null);
    const res = await browserApi.call(endpoints.acceptInvitation, { body: { token } });
    if (!res.ok) {
      setBusy(false);
      setError({ code: res.error.code, message: res.error.code === "wrong_email" ? "This invitation was sent to another email." : res.error.code === "expired" ? "This invitation has expired. Ask for a new one." : res.error.code === "not_found" ? "This invitation is no longer valid." : res.error.message });
      return;
    }
    router.replace(`/w/${res.data.workspaceId}`);
    router.refresh();
  }
  async function signOut() {
    setBusy(true);
    await authClient.signOut();
    setError(null);
    router.refresh();
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-[-0.025em] text-fg">Join {preview.workspaceName}</h1>
        <p className="mt-1.5 text-md text-fg-muted">{preview.inviterName} invited you as {ROLE_LABEL[preview.role].toLowerCase()}.</p>
      </div>
      <p className="text-sm text-fg-subtle">For {preview.emailMasked}. Expires {formatDate(preview.expiresAt, "UTC")}.</p>
      {error && <Alert tone="error">{error.message}</Alert>}
      {!me ? (
        <div className="flex flex-col gap-3">
          <Button asChild variant="primary" size="lg" className="h-12 text-md"><Link href={`/login?next=${next}`}>Sign in</Link></Button>
          <Button asChild size="lg" className="h-12 text-md"><Link href={`/register?next=${next}`}>Create account</Link></Button>
        </div>
      ) : wrong ? (
        <div className="flex flex-col gap-3">
          <Alert tone="warning">You are signed in as {me.email}. This invitation was sent to another email.</Alert>
          <Button variant="primary" size="lg" className="h-12 text-md" loading={busy} onClick={signOut}>Sign out</Button>
        </div>
      ) : (
        <Button variant="primary" size="lg" className="h-12 text-md" loading={busy} onClick={join}>Join {preview.workspaceName}</Button>
      )}
    </div>
  );
}
