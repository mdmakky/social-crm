"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { WorkspaceName } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";
import { api, errorMessage } from "@/lib/client-api";
import { authClient } from "@/lib/auth-client";

export function CreateWorkspaceForm({ canCancel }: { canCancel: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = WorkspaceName.safeParse(new FormData(e.currentTarget).get("name"));
    setFormError(null);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Enter a workspace name.");
    setError(null);
    setBusy(true);
    const res = await api<{ id: string }>("/v1/workspaces", { method: "POST", body: { name: parsed.data } });
    if (!res.ok) {
      setBusy(false);
      return setFormError(errorMessage(res));
    }
    router.replace(`/w/${res.data.id}`);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-title text-fg">Create your workspace</h1>
        <p className="mt-0.5 text-sm text-fg-muted">A workspace keeps one business&rsquo;s customers, conversations and settings separate from everyone else&rsquo;s. You can create more later.</p>
      </div>
      {formError && <Alert tone="error">{formError}</Alert>}
      <Field label="Workspace name" hint="Usually your business or brand name, for example Northwind Studio." error={error}>
        {(p) => <Input {...p} name="name" autoFocus autoComplete="organization" maxLength={60} />}
      </Field>
      <div className="flex items-center justify-end gap-2">
        {canCancel ? <Button asChild variant="ghost"><Link href="/">Cancel</Link></Button> : <Button variant="ghost" onClick={async () => { await authClient.signOut(); router.replace("/login"); }}>Sign out</Button>}
        <Button type="submit" variant="primary" loading={busy}>Create workspace</Button>
      </div>
    </form>
  );
}
