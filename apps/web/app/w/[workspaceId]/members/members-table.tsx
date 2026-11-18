"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, ShieldCheck, UserMinus } from "lucide-react";
import type { Member, Role } from "@crm/contracts";
import { can, memberChangeAllowed } from "@crm/core/permissions";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DialogActions } from "@/components/ui/overlays";
import { Alert } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { endpoints } from "@crm/contracts";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDate, ROLE_LABEL } from "@/lib/format";

const ROLES: Role[] = ["owner", "admin", "agent", "viewer"];
const ROLE_HELP: Record<Role, string> = {
  owner: "Full control, including ownership transfer and deleting the workspace.",
  admin: "Manages members, integrations, automation and settings.",
  agent: "Works conversations and contacts.",
  viewer: "Read-only access.",
};

export function MembersTable({ workspaceId, members, myRole, myUserId, timeZone }: { workspaceId: string; members: Member[]; myRole: Role; myUserId: string; timeZone: string }) {
  const router = useRouter();
  const [dialog, setDialog] = React.useState<{ kind: "role" | "remove"; member: Member } | null>(null);
  const [role, setRole] = React.useState<Role>("agent");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const ownerCount = members.filter((m) => m.role === "owner" && m.status === "active").length;
  const canManage = can(myRole, "member.manage", {});

  const open = (kind: "role" | "remove", member: Member) => {
    setError(null);
    setRole(member.role);
    setDialog({ kind, member });
  };

  async function submit() {
    if (!dialog) return;
    setBusy(true);
    setError(null);
    const params = { workspaceId, userId: dialog.member.userId };
    const res = dialog.kind === "role" ? await browserApi.call(endpoints.updateMember, { params, body: { role } }) : await browserApi.call(endpoints.removeMember, { params });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.error));
    setDialog(null);
    router.refresh();
  }

  const roleOptionsFor = (m: Member) => ROLES.filter((r) => memberChangeAllowed({ actor: myRole, target: m.role, change: { role: r }, ownerCount }).ok || r === m.role);

  const rows = members.map((m) => {
    const isMe = m.userId === myUserId;
    const canChange = canManage && ROLES.some((r) => r !== m.role && memberChangeAllowed({ actor: myRole, target: m.role, change: { role: r }, ownerCount }).ok);
    const canRemove = canManage && !isMe && memberChangeAllowed({ actor: myRole, target: m.role, change: { remove: true }, ownerCount }).ok;
    return { m, isMe, canChange, canRemove };
  });

  const identity = (m: Member, isMe: boolean) => (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={m.name} />
      <div className="min-w-0">
        <p className="truncate font-medium text-fg">{m.name}{isMe && <span className="ml-1.5 text-xs font-normal text-fg-subtle">You</span>}</p>
        <p className="truncate text-sm text-fg-muted">{m.email}</p>
      </div>
    </div>
  );
  const actions = (m: Member, canChange: boolean, canRemove: boolean) =>
    canChange || canRemove ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" icon size="sm" aria-label={`Actions for ${m.name}`}><MoreHorizontal /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canChange && <DropdownMenuItem onSelect={() => open("role", m)}><ShieldCheck aria-hidden />Change role</DropdownMenuItem>}
          {canRemove && <DropdownMenuItem danger onSelect={() => open("remove", m)}><UserMinus aria-hidden />Remove from workspace</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  return (
    <>
      {/* Below sm a stacked list keeps role and actions visible without sideways scrolling */}
      <ul className="sm:hidden">
        {rows.map(({ m, isMe, canChange, canRemove }) => (
          <li key={m.userId} className="flex items-center gap-2 border-b border-line px-4 py-3 last:border-b-0">
            <div className="min-w-0 flex-1">
              {identity(m, isMe)}
              <div className="mt-1.5 pl-11"><Badge tone={m.role === "owner" ? "accent" : "neutral"}>{ROLE_LABEL[m.role]}</Badge></div>
            </div>
            {actions(m, canChange, canRemove)}
          </li>
        ))}
      </ul>
      <div className="hidden sm:block">
        <Table>
          <THead>
            <tr>
              <TH>Name</TH>
              <TH>Role</TH>
              <TH>Joined</TH>
              <TH className="w-12"><span className="sr-only">Actions</span></TH>
            </tr>
          </THead>
          <TBody>
            {rows.map(({ m, isMe, canChange, canRemove }) => (
              <TR key={m.userId}>
                <TD className="w-full max-w-0">{identity(m, isMe)}</TD>
                <TD><Badge tone={m.role === "owner" ? "accent" : "neutral"}>{ROLE_LABEL[m.role]}</Badge></TD>
                <TD className="tnum whitespace-nowrap text-fg-muted">{formatDate(m.joinedAt, timeZone)}</TD>
                <TD>{actions(m, canChange, canRemove)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>

      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        {dialog && (
          <DialogContent
            title={dialog.kind === "role" ? `Change role for ${dialog.member.name}` : `Remove ${dialog.member.name}?`}
            description={dialog.kind === "role" ? undefined : "They lose access immediately. Their activity stays in the audit log."}
          >
            {error && <Alert tone="error" className="mb-3">{error}</Alert>}
            {dialog.kind === "role" && (
              <Field label="Role" hint={role === dialog.member.role ? "This is their current role. Pick a different one to save." : ROLE_HELP[role]}>
                {(p) => (
                  <Select {...p} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                    {roleOptionsFor(dialog.member).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </Select>
                )}
              </Field>
            )}
            <DialogActions className="mt-5">
              <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
              <Button variant={dialog.kind === "remove" ? "danger" : "primary"} loading={busy} disabled={dialog.kind === "role" && role === dialog.member.role} onClick={submit}>
                {dialog.kind === "role" ? "Save role" : "Remove member"}
              </Button>
            </DialogActions>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
