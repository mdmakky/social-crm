"use client";
import * as React from "react";
import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { endpoints, type LeadDto, type PipelineDto } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogActions } from "@/components/ui/overlays";
import { Alert, EmptyState } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDate } from "@/lib/format";

/** Owner/admin only (the API refuses everyone else): contacts that were removed from the pipeline, with Restore. Uses GET /leads?deleted=true and POST /leads/:id/restore. */
export function RemovedLeadsDialog({ open, onOpenChange, workspaceId, timeZone, pipelines, onRestored }: { open: boolean; onOpenChange: (o: boolean) => void; workspaceId: string; timeZone: string; pipelines: PipelineDto[]; onRestored: () => void }) {
  const [items, setItems] = React.useState<LeadDto[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const apply = React.useCallback((r: Awaited<ReturnType<typeof browserApi.call<typeof endpoints.listLeads>>>, after?: string) => {
    if (!r.ok) { setError(errorMessage(r.error)); return setStatus("error"); }
    setError(null);
    setItems((p) => (after ? [...p, ...r.data.items] : r.data.items));
    setCursor(r.data.nextCursor);
    setStatus("ready");
  }, []);
  const fetchPage = React.useCallback((after?: string) => browserApi.call(endpoints.listLeads, { params: { workspaceId }, query: { deleted: "true", limit: 25, ...(after ? { cursor: after } : {}) } }), [workspaceId]);
  const load = (after?: string) => { if (!after) setStatus("loading"); void fetchPage(after).then((r) => apply(r, after)); };
  // The parent mounts this only while open, so "loading" is the initial state and the first fetch needs no state reset.
  React.useEffect(() => { let live = true; void fetchPage().then((r) => { if (live) apply(r); }); return () => { live = false; }; }, [fetchPage, apply]);

  async function restore(l: LeadDto) {
    setBusyId(l.id); setError(null); setNote(null);
    const r = await browserApi.call(endpoints.restoreLead, { params: { workspaceId, leadId: l.id }, body: { expectedVersion: l.version } });
    setBusyId(null);
    if (!r.ok) { setError(errorMessage(r.error)); if (r.error.kind === "http" && r.error.code === "version_conflict") void load(); return; }
    setItems((p) => p.filter((x) => x.id !== l.id));
    setNote(`${l.primaryContact.name} is back in the pipeline.`);
    onRestored();
  }
  const stageOf = (l: LeadDto) => pipelines.flatMap((p) => p.stages).find((s) => s.id === l.stageId)?.name ?? "Stage";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Recently removed" description="Contacts removed from the pipeline. The contact and its history are untouched; restoring puts it back where it was.">
        {error && <Alert tone="error" className="mb-3">{error}</Alert>}
        <div role="status">{note && <Alert tone="success" className="mb-3">{note}</Alert>}</div>
        {status === "loading" && <p role="status" className="py-6 text-center text-sm text-fg-muted">Loading removed contacts…</p>}
        {status === "error" && <div className="py-2"><Button variant="secondary" onClick={() => void load()}>Try again</Button></div>}
        {status === "ready" && items.length === 0 && <EmptyState icon={RotateCcw} title="Nothing removed" description="Contacts you remove from the pipeline show up here so you can restore them." className="py-8" />}
        {status === "ready" && items.length > 0 && (
          <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto" aria-label="Removed contacts">
            {items.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <Link href={`/w/${workspaceId}/contacts/${l.primaryContact.id}`} className="block truncate text-sm font-medium text-fg underline-offset-2 hover:underline">{l.primaryContact.name}</Link>
                  <p className="truncate text-xs text-fg-subtle">{stageOf(l)}{l.deletedAt ? ` · removed ${formatDate(l.deletedAt, timeZone)}` : ""}{l.primaryContact.deleted ? " · contact deleted" : ""}</p>
                </div>
                <Button variant="secondary" size="sm" loading={busyId === l.id} disabled={l.primaryContact.deleted || (busyId !== null && busyId !== l.id)} title={l.primaryContact.deleted ? "Restore the contact first" : undefined} aria-label={`Restore ${l.primaryContact.name}`} onClick={() => void restore(l)}><RotateCcw aria-hidden />Restore</Button>
              </li>
            ))}
          </ul>
        )}
        {status === "ready" && cursor && <div className="mt-2"><Button variant="ghost" onClick={() => void load(cursor)}>Load more</Button></div>}
        <DialogActions className="mt-3"><DialogClose asChild><Button variant="primary">Done</Button></DialogClose></DialogActions>
      </DialogContent>
    </Dialog>
  );
}
