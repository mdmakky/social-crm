"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { endpoints, UpdateWorkspaceBody } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";

export function WorkspaceForm({ workspaceId, name, timezone, readOnly }: { workspaceId: string; name: string; timezone: string; readOnly: boolean }) {
  const router = useRouter();
  const zones = React.useMemo(() => {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    return Array.from(new Set(["UTC", ...all, timezone])).sort();
  }, [timezone]);
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [nameError, setNameError] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = UpdateWorkspaceBody.safeParse({ name: f.get("name"), timezone: f.get("timezone") });
    setSaved(false);
    setError(null);
    if (!parsed.success) return setNameError(parsed.error.issues[0]?.message ?? "Check the name.");
    setNameError(null);
    setBusy(true);
    const res = await browserApi.call(endpoints.updateWorkspace, { params: { workspaceId }, body: parsed.data });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.error));
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4 p-4">
      {error && <Alert tone="error">{error}</Alert>}
      {saved && <Alert tone="success">Workspace settings saved.</Alert>}
      <Field label="Workspace name" error={nameError}>
        {(p) => <Input {...p} name="name" defaultValue={name} maxLength={60} disabled={readOnly} />}
      </Field>
      <Field label="Time zone" hint="Used for dates in this workspace.">
        {(p) => (
          <Select {...p} name="timezone" defaultValue={timezone} disabled={readOnly}>
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
          </Select>
        )}
      </Field>
      {!readOnly && <div><Button type="submit" variant="primary" loading={busy}>Save changes</Button></div>}
    </form>
  );
}
