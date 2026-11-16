"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, MailPlus, Send, UserPlus } from "lucide-react";
import { endpoints, type InvitationDto, type InvitationIssued, type Role } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogActions, DialogClose, DialogContent } from "@/components/ui/overlays";
import { EmptyState, ErrorState, Alert } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDate, ROLE_LABEL } from "@/lib/format";

type InviteRole = "admin" | "agent" | "viewer";
const ROLE_HELP: Record<InviteRole, string> = {
  admin: "Manages members, integrations and settings.",
  agent: "Works conversations, contacts and leads.",
  viewer: "Can look around, never change anything.",
};
const MESSAGES = {
  already_member: "That person is already a member.",
  duplicate_pending: "An invitation is already pending for this email. Resend it instead.",
  rate_limited: "Too many invitations. Try again later.",
  admin_invite_needs_owner: "Only an owner can invite an admin.",
  too_many_pending: "Too many pending invitations. Revoke some first.",
} as const;
const STATUS_TONE = { pending: "accent", accepted: "success", revoked: "neutral", expired: "warning" } as const;
const STATUS_LABEL = { pending: "Pending", accepted: "Joined", revoked: "Revoked", expired: "Expired" } as const;

/** The secret link, shown once. The field is read-only so it can also be copied by hand when the clipboard is blocked. */
function LinkResult({ issued }: { issued: InvitationIssued }) {
  const [copied, setCopied] = React.useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(issued.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="flex flex-col gap-3">
      {issued.emailSent && <Alert tone="success">Email sent to {issued.invitation.email}.</Alert>}
      <Field label="Invite link" hint="Shown once. Copy it now.">
        {(p) => (
          <div className="flex gap-2">
            <Input {...p} readOnly value={issued.link} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1" data-testid="invite-link" />
            <Button variant="secondary" onClick={copy} aria-live="polite">{copied ? <Check aria-hidden /> : <Copy aria-hidden />}{copied ? "Copied" : "Copy"}</Button>
          </div>
        )}
      </Field>
    </div>
  );
}

export function InviteButton({ workspaceId, myRole }: { workspaceId: string; myRole: Role }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<InviteRole>("agent");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [issued, setIssued] = React.useState<InvitationIssued | null>(null);
  const roles: InviteRole[] = myRole === "owner" ? ["admin", "agent", "viewer"] : ["agent", "viewer"];

  function onOpenChange(o: boolean) {
    setOpen(o);
    if (o) {
      setEmail("");
      setRole("agent");
      setError(null);
      setIssued(null);
    } else if (issued) router.refresh();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await browserApi.call(endpoints.createInvitation, { params: { workspaceId }, body: { email: email.trim(), role } });
    setBusy(false);
    if (!res.ok) return setError(res.error.kind === "http" && res.error.code in MESSAGES ? MESSAGES[res.error.code as keyof typeof MESSAGES] : res.error.code === "invalid_body" ? "Enter a valid email address." : errorMessage(res.error));
    setIssued(res.data);
    router.refresh();
  }

  return (
    <>
      <Button variant="primary" onClick={() => onOpenChange(true)}><UserPlus aria-hidden />Invite people</Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent title={issued ? "Invite ready" : "Invite people"} description={issued ? "Send this link to the person you invited." : "They join with the role you pick."}>
          {issued ? (
            <>
              <LinkResult issued={issued} />
              <DialogActions className="mt-5"><DialogClose asChild><Button variant="primary">Done</Button></DialogClose></DialogActions>
            </>
          ) : (
            <form onSubmit={submit} noValidate className="flex flex-col gap-4">
              {error && <Alert tone="error">{error}</Alert>}
              <Field label="Email">{(p) => <Input {...p} type="email" name="email" autoComplete="off" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />}</Field>
              <Field label="Role" hint={ROLE_HELP[role]}>
                {(p) => <Select {...p} name="role" value={role} onChange={(e) => setRole(e.target.value as InviteRole)}>{roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select>}
              </Field>
              <DialogActions>
                <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
                <Button type="submit" variant="primary" loading={busy} disabled={!email.trim()}><Send aria-hidden />Create invite</Button>
              </DialogActions>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function InvitationsList({ workspaceId, invitations, myRole, timeZone }: { workspaceId: string; invitations: InvitationDto[] | null; myRole: Role; timeZone: string }) {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [issued, setIssued] = React.useState<InvitationIssued | null>(null);

  if (!invitations) return <ErrorState title="Invites unavailable" description="Reload the page to try again." onRetry={() => router.refresh()} />;
  if (invitations.length === 0) return <EmptyState icon={MailPlus} title="No invitations" description="People you invite appear here until they join." />;

  async function act(inv: InvitationDto, op: "resend" | "revoke") {
    setBusyId(inv.id);
    setError(null);
    const params = { workspaceId, invitationId: inv.id };
    if (op === "resend") {
      const res = await browserApi.call(endpoints.resendInvitation, { params });
      setBusyId(null);
      if (!res.ok) return setError(MESSAGES[res.error.code as keyof typeof MESSAGES] ?? errorMessage(res.error));
      setIssued(res.data);
    } else {
      const res = await browserApi.call(endpoints.revokeInvitation, { params });
      setBusyId(null);
      if (!res.ok) return setError(errorMessage(res.error));
    }
    router.refresh();
  }

  return (
    <>
      {error && <Alert tone="error" className="m-3">{error}</Alert>}
      <ul aria-label="Invitations">
        {invitations.map((inv) => {
          const open = inv.status === "pending" || inv.status === "expired";
          const allowed = open && (inv.role !== "admin" || myRole === "owner");
          return (
            <li key={inv.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3 last:border-b-0">
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate font-medium text-fg">{inv.email}</p>
                <p className="truncate text-sm text-fg-muted">{ROLE_LABEL[inv.role]}{inv.invitedByName ? ` · invited by ${inv.invitedByName}` : ""}{open ? ` · ${inv.status === "expired" ? "expired" : "expires"} ${formatDate(inv.expiresAt, timeZone)}` : ""}</p>
              </div>
              <Badge tone={STATUS_TONE[inv.status]}>{STATUS_LABEL[inv.status]}</Badge>
              {allowed && (
                <div className="flex gap-1.5">
                  <Button size="sm" loading={busyId === inv.id} onClick={() => act(inv, "resend")} aria-label={`Resend invitation to ${inv.email}`}>Resend</Button>
                  <Button size="sm" variant="ghost" disabled={busyId === inv.id} onClick={() => act(inv, "revoke")} aria-label={`Revoke invitation to ${inv.email}`}>Revoke</Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <Dialog open={!!issued} onOpenChange={(o) => !o && setIssued(null)}>
        {issued && (
          <DialogContent title="New link" description="The old link no longer works.">
            <LinkResult issued={issued} />
            <DialogActions className="mt-5"><DialogClose asChild><Button variant="primary">Done</Button></DialogClose></DialogActions>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
