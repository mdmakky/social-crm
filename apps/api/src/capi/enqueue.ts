import { sql } from "drizzle-orm";
import { buildUserData, CapiEvent, CONSENT_PURPOSE, consentGate, eventId, staleness, type CapiEventName, type UserInput } from "@crm/capi";
import type { Tx } from "@crm/db";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;

export type EnqueueInput = {
  workspaceId: string;
  eventName: CapiEventName;
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
 * One row per ACTIVE dataset that opted in to this event name. The consent gate runs here: without a granted ad_measurement record the row is stored as
 * `skipped_no_consent` with EMPTY user_data (nothing identifying is kept), so the history shows why nothing was sent. The worker checks consent again at send time.
 * Returns the number of rows created. Throws if the event is not valid (callers on a CRM write path run it in a savepoint and swallow the error).
 */
export async function enqueueCapiEvent(tx: Tx, e: EnqueueInput): Promise<number> {
  if (staleness(Math.floor(e.eventTime.getTime() / 1000), e.nowMs ?? Date.now()) !== "ok") return 0;
  const datasets = rowsOf(await tx.execute(sql`SELECT id FROM capi_datasets WHERE workspace_id = ${e.workspaceId} AND status = 'active' AND ${e.eventName} = ANY(events)`));
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
    const payload = CapiEvent.parse({ event_name: e.eventName, event_time: Math.floor(e.eventTime.getTime() / 1000), event_id: id, action_source: "system_generated", user_data: userData, ...(e.customData ? { custom_data: e.customData } : {}) });
    // rowCount instead of RETURNING; ON CONFLICT needs the SELECT policy, which includes agents (see migration 0026).
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
 * THE one CRM hook of slice 1: a lead moved into a `won` stage becomes a `Purchase` event (value and currency from the lead).
 * A lead without a value cannot make a valid Purchase, so nothing is queued for it (it needs a value first). Runs in a SAVEPOINT: a CAPI problem can never fail or roll back the stage move.
 * Fires at most once per lead and dataset: the event ref is the lead id, so winning, reopening and winning again does not send a second Purchase.
 */
export async function captureLeadWon(tx: Tx, l: { workspaceId: string; leadId: string; contactId: string; valueMinor: number | null; currency: string | null }): Promise<void> {
  if (l.valueMinor === null || !l.currency) return;
  try {
    await tx.transaction(async (sp) => {
      const c = rowsOf(await sp.execute(sql`SELECT name, email, phone FROM contacts WHERE workspace_id = ${l.workspaceId} AND id = ${l.contactId}`))[0];
      if (!c) return;
      const parts = String(c.name ?? "").trim().split(/\s+/).filter(Boolean);
      await enqueueCapiEvent(sp, {
        workspaceId: l.workspaceId, eventName: "Purchase", crmEventRef: `lead:${l.leadId}:won`, eventTime: new Date(), contactId: l.contactId,
        user: { email: c.email as string | null, phone: c.phone as string | null, firstName: parts[0] ?? null, lastName: parts.length > 1 ? parts[parts.length - 1]! : null, externalId: l.contactId },
        customData: { value: majorUnits(l.valueMinor!, l.currency!), currency: l.currency! },
      });
    });
  } catch (err) {
    console.error(JSON.stringify({ msg: "capi enqueue failed", error: (err as Error).name })); // name only: the message could carry a payload
  }
}
