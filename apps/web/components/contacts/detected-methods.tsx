"use client";
import * as React from "react";
import { Pencil, Trash2 } from "lucide-react";
import { endpoints, type ContactMethodDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Alert, ErrorState } from "@/components/ui/states";
import { Skeleton } from "@/components/ui/skeleton";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";

const SOURCE: Record<string, string> = { messenger: "Messenger", instagram: "Instagram", manual: "Added by hand", import: "Imported", other: "Other" };
const href = (m: ContactMethodDto) => (m.kind === "email" ? `mailto:${encodeURI(m.value)}` : `tel:${m.value.replace(/[^\d+]/g, "")}`);

/**
 * Phone numbers and emails the system read out of conversations. They are marked unverified and kept apart from the details a person entered above; the contact's own
 * fields are only ever changed by the details form. Correcting or removing is limited to detected values (the API and the database enforce it too).
 */
export function DetectedMethodsPanel({ workspaceId, contactId, initial, canEdit, timeZone, onPrimaryChanged }: { workspaceId: string; contactId: string; /** Loaded on the server with the page; null when that request failed. */ initial: ContactMethodDto[] | null; canEdit: boolean; timeZone: string; onPrimaryChanged: () => void }) {
  const p = { workspaceId, contactId };
  const [items, setItems] = React.useState<ContactMethodDto[] | null>(initial);
  const [loadError, setLoadError] = React.useState<string | null>(initial === null ? "The list could not be loaded." : null);
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<{ id: string; value: string } | null>(null);
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.listContactMethods, { params: p });
    if (r.ok) { setItems(r.data.items); setLoadError(null); } else setLoadError(errorMessage(r.error));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, contactId]);

  async function save() {
    if (!editing) return;
    setBusy(true); setError(null);
    const was = items?.find((m) => m.id === editing.id);
    const r = await browserApi.call(endpoints.correctContactMethod, { params: { ...p, methodId: editing.id }, body: { value: editing.value } });
    setBusy(false);
    if (!r.ok) return setError(errorMessage(r.error));
    setItems((cur) => (cur ?? []).map((m) => (m.id === r.data.id ? r.data : m)));
    setEditing(null);
    if (was?.isPrimary) onPrimaryChanged();
  }
  async function remove(m: ContactMethodDto) {
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.deleteContactMethod, { params: { ...p, methodId: m.id } });
    setBusy(false);
    if (!r.ok) return setError(errorMessage(r.error));
    setItems((cur) => (cur ?? []).filter((x) => x.id !== m.id));
    setConfirmId(null);
    if (m.isPrimary) onPrimaryChanged();
  }

  return (
    <Panel>
      <PanelHeader title="Detected from conversations" description="Read automatically from messages. Not verified; the details above are only what a person entered." />
      <div className="flex flex-col gap-3 p-4">
        {error && <Alert tone="error">{error}</Alert>}
        {loadError ? <ErrorState title="Couldn't load detected details" description={loadError} onRetry={() => { setItems(null); setLoadError(null); void load(); }} />
          : items === null ? <div role="status" aria-label="Loading detected details" className="space-y-2"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-2/3" /></div>
          : items.length === 0 ? <p className="text-sm text-fg-muted">Nothing detected yet. Phone numbers and emails customers write in a conversation appear here.</p>
          : (
            <ul className="flex flex-col divide-y divide-line-card">
              {items.map((m) => {
                const detected = (m.source === "messenger" || m.source === "instagram") && !m.verified;
                const label = `${m.kind === "email" ? "email" : "phone number"} ${m.value}`;
                return (
                  <li key={m.id} className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0">
                    {editing?.id === m.id ? (
                      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
                        <Input aria-label={`Corrected ${m.kind === "email" ? "email" : "phone number"}`} className="min-w-0 flex-1 basis-48" value={editing.value} onChange={(e) => setEditing({ id: m.id, value: e.target.value })} inputMode={m.kind === "email" ? "email" : "tel"} maxLength={254} autoFocus />
                        <Button type="submit" variant="primary" size="sm" loading={busy}>Save</Button>
                        <Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(null); setError(null); }}>Cancel</Button>
                      </form>
                    ) : (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <a className="min-w-0 break-all text-base text-accent-fg underline underline-offset-2" href={href(m)}>{m.value}</a>
                        {m.isPrimary && <Badge tone="neutral">Shown in details</Badge>}
                        <Badge tone={detected ? "warning" : "success"}>{detected ? "Auto-detected, unverified" : m.verified ? "Verified" : "Entered"}</Badge>
                        {canEdit && detected && (
                          <span className="ml-auto flex gap-1">
                            <Button variant="ghost" icon size="sm" aria-label={`Correct ${label}`} onClick={() => { setEditing({ id: m.id, value: m.value }); setConfirmId(null); setError(null); }}><Pencil /></Button>
                            {confirmId === m.id
                              ? <><Button variant="danger" size="sm" loading={busy} aria-label={`Confirm remove ${label}`} onClick={() => void remove(m)}>Confirm remove</Button><Button variant="ghost" size="sm" onClick={() => setConfirmId(null)}>Cancel</Button></>
                              : <Button variant="ghost" icon size="sm" aria-label={`Remove ${label}`} onClick={() => { setConfirmId(m.id); setEditing(null); }}><Trash2 /></Button>}
                          </span>
                        )}
                      </div>
                    )}
                    <p className="text-xs text-fg-subtle">
                      {SOURCE[m.source] ?? m.source} · {m.kind === "email" ? "Email" : "Phone"} · {Math.round(m.confidence * 100)}% confidence · {m.correctedAt ? `corrected ${formatDateTime(m.correctedAt, timeZone)}` : `detected ${formatDateTime(m.extractedAt, timeZone)}`}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
      </div>
    </Panel>
  );
}
