"use client";
import * as React from "react";
import { endpoints, type AdConsentDto, type Member } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogActions } from "@/components/ui/overlays";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, ErrorState } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";

const STATE = { granted: { label: "Granted", tone: "success" }, revoked: { label: "Withdrawn", tone: "warning" }, none: { label: "None recorded", tone: "neutral" } } as const;
const SOURCE: Record<string, string> = { manual: "Recorded by a team member", form: "Form", import: "Import", api: "API", customer_request: "Customer request" };

/**
 * Ad measurement consent for one contact (purpose ad_measurement). Append-only: every change adds a record, nothing is edited or deleted.
 * Without consent.edit the API refuses to even read it, so read-only roles get an explanation and no request is made.
 */
export function AdConsentPanel({ workspaceId, contactId, canEdit, timeZone, members }: { workspaceId: string; contactId: string; canEdit: boolean; timeZone: string; members: Member[] }) {
  const p = { workspaceId, contactId };
  const [consent, setConsent] = React.useState<AdConsentDto | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<"granted" | "revoked" | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fetchConsent = React.useCallback(() => browserApi.call(endpoints.getAdConsent, { params: { workspaceId, contactId } }), [workspaceId, contactId]);
  const apply = (r: Awaited<ReturnType<typeof fetchConsent>>) => { if (r.ok) { setLoadError(null); setConsent(r.data); } else setLoadError(errorMessage(r.error)); };
  const load = async () => apply(await fetchConsent());
  React.useEffect(() => { if (canEdit) void fetchConsent().then(apply); }, [canEdit, fetchConsent]); // eslint-disable-line react-hooks/exhaustive-deps

  async function record(status: "granted" | "revoked") {
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.setAdConsent, { params: p, body: { status, source: "manual" } });
    setBusy(false);
    if (!r.ok) { setError(errorMessage(r.error)); return; }
    setConsent(r.data); setPending(null);
  }
  const who = (id: string | null) => (id ? members.find((m) => m.userId === id)?.name ?? "a former member" : "the system");
  const when = (iso: string) => <time dateTime={iso}>{formatDateTime(iso, timeZone)}</time>;

  return (
    <Panel>
      <PanelHeader title="Ad measurement consent" description="Whether we may send this contact's hashed identifiers to Meta for ad measurement." actions={consent && <Badge tone={STATE[consent.status].tone}>{STATE[consent.status].label}</Badge>} />
      <div className="flex flex-col gap-3 p-4" aria-live="polite">
        {!canEdit ? (
          <Alert>You do not have permission to view or change ad measurement consent. Ask an owner, admin or agent. Until consent is recorded, nothing about this contact is sent to Meta.</Alert>
        ) : loadError ? (
          <ErrorState title="Could not load consent" description={loadError} onRetry={() => void load()} />
        ) : consent === null ? (
          <div role="status" aria-label="Loading consent" className="flex flex-col gap-2"><Skeleton className="h-6" /><Skeleton className="h-16" /></div>
        ) : (
          <>
            <p className="text-sm text-fg">
              {consent.status === "none" ? "No consent recorded. Nothing about this contact is sent to Meta." : <>{consent.status === "granted" ? "Granted" : "Withdrawn"} on {when(consent.recordedAt!)} by {who(consent.recordedBy)}. Source: {SOURCE[consent.source ?? ""] ?? consent.source}.</>}
            </p>
            {error && !pending && <Alert tone="error">{error}</Alert>}
            <div className="flex flex-wrap gap-2">
              {consent.status !== "granted" && <Button variant="primary" onClick={() => { setError(null); setPending("granted"); }}>Record consent</Button>}
              {consent.status === "granted" && <Button variant="secondary" onClick={() => { setError(null); setPending("revoked"); }}>Record withdrawal</Button>}
            </div>
            {consent.history.length > 0 && (
              <section aria-label="Consent history" className="border-t border-line-card pt-3">
                <h3 className="mb-1 text-sm font-medium text-fg">History</h3>
                <ul className="flex flex-col gap-1 text-sm text-fg-muted">
                  {consent.history.map((h, i) => <li key={`${h.recordedAt}-${i}`}>{h.status === "granted" ? "Granted" : "Withdrawn"} · {when(h.recordedAt)} · by {who(h.recordedBy)} · {SOURCE[h.source] ?? h.source}</li>)}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
      <Dialog open={pending !== null} onOpenChange={(o) => { if (!o && !busy) setPending(null); }}>
        <DialogContent
          title={pending === "granted" ? "Record ad measurement consent?" : "Record withdrawal of consent?"}
          description={pending === "granted"
            ? "Confirm only if this contact agreed. It allows the CRM to send hashed identifiers (email, phone) and conversion events, such as a won lead, to Meta through the Conversions API for ad measurement."
            : "This stops any further sending of this contact's identifiers to Meta. Events already waiting are skipped. Earlier records stay in the history."}
        >
          {error && <Alert tone="error" className="mb-3">{error}</Alert>}
          <DialogActions>
            <DialogClose asChild><Button variant="ghost" disabled={busy}>Cancel</Button></DialogClose>
            <Button variant={pending === "granted" ? "primary" : "danger"} loading={busy} onClick={() => pending && void record(pending)}>{pending === "granted" ? "Confirm consent" : "Confirm withdrawal"}</Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
