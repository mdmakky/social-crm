import { sql } from "drizzle-orm";
import { buildUserData, CapiEvent, CONSENT_PURPOSE, consentGate, eventId, staleness, type UserInput } from "@crm/capi";
import type { Tx } from "@crm/db";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;

export type EnqueueInput = {
  workspaceId: string;
  /** A Meta standard name or a validated custom name (the mapping decides). */
  eventName: string;
  /** The datasets to write for (the caller resolved them from enabled mappings of ACTIVE datasets). */
  datasetIds: string[];
  /** Record the event as `skipped` with this reason code instead of queueing it (payload stays empty; nothing identifying is kept). */
  skipReason?: string;
  /** Stable id of the CRM fact (e.g. `lead:<id>:won`). It is the idempotency key: the same ref on the same dataset never creates a second row. */
  crmEventRef: string;
  /** When it happened in the business, not now-by-default: retries keep it. */
  eventTime: Date;
  contactId: string | null;
  user: UserInput;
  customData?: { value: number; currency: string };
  nowMs?: number;
};

/**
 * Writes the outbox rows for one CRM event, in the CALLER's transaction (crm_app, workspace context already set). No network, never waits for Meta.
 * One row per dataset in `datasetIds` (resolved by the caller from enabled mappings). The consent gate runs here: without a granted ad_measurement record the row is stored as
 * `skipped_no_consent` with EMPTY user_data (nothing identifying is kept), so the history shows why nothing was sent. The worker checks consent again at send time.
 * Returns the number of rows created. Throws if the event is not valid (callers on a CRM write path run it in a savepoint and swallow the error).
 */
export async function enqueueCapiEvent(tx: Tx, e: EnqueueInput): Promise<number> {
  if (staleness(Math.floor(e.eventTime.getTime() / 1000), e.nowMs ?? Date.now()) !== "ok") return 0;
  const datasets = e.datasetIds.map((id) => ({ id }));
  if (datasets.length === 0) return 0;
  let gate = consentGate(null);
  if (e.contactId) {
    const latest = rowsOf(await tx.execute(sql`SELECT status FROM consent_records WHERE workspace_id = ${e.workspaceId} AND contact_id = ${e.contactId} AND purpose = ${CONSENT_PURPOSE} ORDER BY id DESC LIMIT 1`))[0] as { status: "granted" | "revoked" } | undefined;
    gate = consentGate(latest);
  }
  const userData = gate.allow ? buildUserData(e.user) : {};
  let created = 0;
  for (const d of datasets) {
    const datasetId = d.id as string;
    const id = eventId({ workspaceId: e.workspaceId, datasetId, crmEventRef: e.crmEventRef, eventName: e.eventName });
    if (e.skipReason) {
      // Recorded, not dropped: the history shows why nothing was sent. Same ON CONFLICT rule, so a repeat of the same fact adds no second row.
      const r = await tx.execute(sql`
        INSERT INTO capi_events (workspace_id, dataset_id, contact_id, event_name, event_id, crm_event_ref, event_time, payload, status, last_error)
        VALUES (${e.workspaceId}, ${datasetId}, ${e.contactId}, ${e.eventName}, ${id}, ${e.crmEventRef}, ${e.eventTime.toISOString()}::timestamptz, '{}'::jsonb, 'skipped', ${e.skipReason})
        ON CONFLICT (workspace_id, dataset_id, event_id) DO NOTHING`);
      created += (r as unknown as { rowCount: number }).rowCount ?? 0;
      continue;
    }
    const payload = CapiEvent.parse({ event_name: e.eventName, event_time: Math.floor(e.eventTime.getTime() / 1000), event_id: id, action_source: "system_generated", user_data: userData, ...(e.customData ? { custom_data: e.customData } : {}) });
    // rowCount instead of RETURNING; ON CONFLICT needs the SELECT policy, which includes agents (see migration 0028).
    const r = await tx.execute(sql`
      INSERT INTO capi_events (workspace_id, dataset_id, contact_id, event_name, event_id, crm_event_ref, event_time, payload, status, last_error)
      VALUES (${e.workspaceId}, ${datasetId}, ${e.contactId}, ${e.eventName}, ${id}, ${e.crmEventRef}, ${e.eventTime.toISOString()}::timestamptz, ${JSON.stringify(payload)}::jsonb,
        ${gate.allow ? "pending" : "skipped_no_consent"}, ${gate.allow ? null : gate.reason})
      ON CONFLICT (workspace_id, dataset_id, event_id) DO NOTHING`);
    created += (r as unknown as { rowCount: number }).rowCount ?? 0;
  }
  return created;
}

const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
/** Minor units to the decimal amount Meta expects. ponytail: assumes 2 decimals except the common zero-decimal currencies; three-decimal currencies (KWD, BHD) would be off by 10x. */
export const majorUnits = (minor: number, currency: string) => (ZERO_DECIMAL.has(currency) ? minor : minor / 100);

/**
 * Contact deletion (soft delete) cleanup, in the delete's own transaction, AFTER contacts.deleted_at is set (the RLS policy requires it). No network.
 * Pending rows become `cancelled` (never sent); every other row keeps its delivery metadata but loses its payload (hashed identifiers). consent_records is left alone: append-only, no PII.
 * ponytail: a row the worker already claimed and is sending at this instant may still go out once; closing that needs a lock shared with the worker.
 */
export async function purgeContactCapi(tx: Tx, workspaceId: string, contactId: string): Promise<void> {
  await tx.execute(sql`UPDATE capi_events SET status = 'cancelled', payload = '{}'::jsonb, last_error = 'contact_deleted', updated_at = now() WHERE workspace_id = ${workspaceId} AND contact_id = ${contactId} AND status = 'pending'`);
  await tx.execute(sql`UPDATE capi_events SET payload = '{}'::jsonb, updated_at = now() WHERE workspace_id = ${workspaceId} AND contact_id = ${contactId} AND payload <> '{}'::jsonb`);
}
