"use client";
import * as React from "react";
import { Phone } from "lucide-react";
import { endpoints, type ContactDetail } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { browserApi, errorMessage } from "@/lib/client-api";

/**
 * The one way an enquiry becomes a lead (D310): save a phone number. Inline field (16 px text so phones do not zoom), the same PATCH the lead page uses.
 * The person then shows in Leads in the first stage (no lead record is written); the toast says so.
 */
export function AddPhone({ workspaceId, contactId, version, name, onSaved, prominent, autoOpen }: { workspaceId: string; contactId: string; version: number; name: string; onSaved: (c: ContactDetail) => void; prominent?: boolean; autoOpen?: boolean }) {
  const toast = useToast();
  const [open, setOpen] = React.useState(!!autoOpen);
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const phone = value.trim();
    if (!phone) return setError("Enter a phone number.");
    setBusy(true);
    setError(null);
    const res = await browserApi.call(endpoints.updateContact, { params: { workspaceId, contactId }, body: { expectedVersion: version, phone } });
    setBusy(false);
    if (!res.ok) {
      const e2 = res.error;
      return setError(e2.code === "duplicate_contact" ? "Another lead already has that number." : e2.code === "version_conflict" ? "This was changed by someone else. Reload and try again." : errorMessage(e2));
    }
    toast("Moved to Leads, New");
    onSaved(res.data);
  }

  if (!open) return <Button variant={prominent ? "primary" : "secondary"} size={prominent ? "md" : "sm"} className="pointer-coarse:min-h-11 max-md:min-h-11" aria-label={`Add phone for ${name}`} onClick={() => setOpen(true)}><Phone aria-hidden />Add phone</Button>;
  return (
    <form onSubmit={(e) => void save(e)} noValidate className="flex w-full flex-col gap-1.5">
      <div className="flex w-full flex-wrap items-center gap-2">
        <Input aria-label={`Phone number for ${name}`} aria-invalid={!!error} aria-describedby={error ? `ph-err-${contactId}` : undefined} type="tel" inputMode="tel" autoComplete="off" autoFocus placeholder="Phone number" value={value} onChange={(e) => setValue(e.target.value)} className="h-11 min-w-0 flex-1 basis-40 max-md:text-md md:h-9" />
        <Button type="submit" variant="primary" size="sm" className="pointer-coarse:min-h-11 max-md:min-h-11" loading={busy}>Save</Button>
        <Button type="button" variant="ghost" size="sm" className="pointer-coarse:min-h-11 max-md:min-h-11" onClick={() => { setOpen(false); setError(null); setValue(""); }}>Cancel</Button>
      </div>
      {error && <p id={`ph-err-${contactId}`} role="alert" className="text-sm text-danger-fg">{error}</p>}
    </form>
  );
}
