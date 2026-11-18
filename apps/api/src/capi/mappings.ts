import { sql } from "drizzle-orm";
import { consentGate, CONSENT_PURPOSE } from "@crm/capi";
import type { Tx } from "@crm/db";
import { enqueueCapiEvent, majorUnits } from "./enqueue.ts";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;

export type Trigger = "lead_created" | "lead_stage_entered" | "lead_won" | "lead_lost";
export type Mapping = { id: string; datasetId: string; triggerType: Trigger; stageId: string | null; eventName: string; valueMode: "lead_value" | "fixed" | "none"; fixedValueMinor: number | null; currency: string | null; askForValue: boolean };
export type LeadFacts = { valueMinor: number | null; currency: string | null };
export type Skip = "no_value" | null;

const toMapping = (r: Row): Mapping => ({
  id: r.id as string, datasetId: r.dataset_id as string, triggerType: r.trigger_type as Trigger, stageId: (r.stage_id as string | null) ?? null, eventName: r.event_name as string,
  valueMode: r.value_mode as Mapping["valueMode"], fixedValueMinor: r.fixed_value_minor === null || r.fixed_value_minor === undefined ? null : Number(r.fixed_value_minor), currency: (r.currency as string | null) ?? null, askForValue: r.ask_for_value === true,
});

/**
 * The value of one event, from the mapping's value mode. `lead_value` takes the lead's value and currency when it has both, `fixed` the mapping's own amount, `none` sends no value.
 * A Purchase without a value is not a valid Meta event, so it is `skip: "no_value"` (recorded, not queued). Every other event is valid without a value and is sent without one.
 */
export function resolveValue(m: Pick<Mapping, "valueMode" | "fixedValueMinor" | "currency" | "eventName">, lead: LeadFacts): { custom: { value: number; currency: string } | null; skip: Skip } {
  const minor = m.valueMode === "fixed" ? m.fixedValueMinor : m.valueMode === "lead_value" ? lead.valueMinor : null;
  const currency = m.valueMode === "fixed" ? m.currency : m.valueMode === "lead_value" ? lead.currency : null;
  if (minor === null || !currency) return { custom: null, skip: m.eventName === "Purchase" ? "no_value" : null };
  return { custom: { value: majorUnits(minor, currency), currency }, skip: null };
}

/**
 * The idempotency key of the CRM fact a mapping reacts to. THE DEDUPE RULE (docs/architecture/capi-architecture.md section 2):
 *  - created, won, lost: once per lead, ever (`lead:<id>:created|won|lost`). Winning, reopening and winning again is the same conversion and does not send a second one (this is the legacy Purchase key, so rows sent before mappings existed still dedupe).
 *  - stage entered: once per ENTRY (`lead:<id>:stage:<stageId>:<n>`), n = how many times the lead has entered that stage so far (counted from stage_transitions, including this entry).
 *    A repeat request that changes nothing (same column) is not an entry; leaving and coming back is entry n+1 and may send again.
 * The mapping id is NOT part of the key: the same trigger on the same dataset and event name is unique anyway (unique index), and deleting then re-creating a rule must not re-send history.
 * The event name and dataset are part of the final event_id (see eventId()), so two mappings on one transition with different event names are two events.
 */
export const crmRef = (m: Pick<Mapping, "triggerType" | "stageId">, leadId: string, entryCount: number) =>
  m.triggerType === "lead_stage_entered" ? `lead:${leadId}:stage:${m.stageId}:${entryCount}` : `lead:${leadId}:${m.triggerType.slice(5)}`;

export type TransitionInput = {
  workspaceId: string; leadId: string; contactId: string;
  fromStageId: string | null; toStageId: string; fromOutcome?: string | null; outcome: "open" | "won" | "lost";
  valueMinor: number | null; currency: string | null;
  /** True for the lead's creation (it also counts as entering its first stage). */
  created?: boolean;
};

/** Which triggers a transition satisfies. Pure; the SQL below only filters by it. */
export function firedTriggers(t: Pick<TransitionInput, "fromStageId" | "toStageId" | "fromOutcome" | "outcome" | "created">): Trigger[] {
  const out: Trigger[] = [];
  if (t.created) out.push("lead_created");
  if (t.created || t.fromStageId !== t.toStageId) out.push("lead_stage_entered");
  if (t.outcome === "won" && t.fromOutcome !== "won") out.push("lead_won");
  if (t.outcome === "lost" && t.fromOutcome !== "lost") out.push("lead_lost");
  return out;
}

/**
 * THE CRM hook (replaces captureLeadWon): called from every place a lead is created or changes stage, in the caller's transaction, AFTER the lead row and its stage_transitions row are written.
 * It finds the ENABLED mappings of ACTIVE datasets in this workspace whose trigger the transition satisfies and writes one outbox row per mapping through enqueueCapiEvent (consent gate, stable event id).
 * A mapping that cannot send is recorded as `skipped` with a reason code (no_value) instead of vanishing. Every mapping runs in its own SAVEPOINT inside an outer one:
 * a CAPI problem, even a broken mapping, can never fail or roll back the stage move, and never stops the other mappings. No network here; the worker sends later.
 */
export async function captureLeadTransition(tx: Tx, t: TransitionInput): Promise<void> {
  try {
    const triggers = firedTriggers(t);
    if (triggers.length === 0) return;
    await tx.transaction(async (sp) => {
      const stageEntered = triggers.includes("lead_stage_entered");
      const mappings = rowsOf(await sp.execute(sql`
        SELECT m.* FROM capi_event_mappings m JOIN capi_datasets d ON d.workspace_id = m.workspace_id AND d.id = m.dataset_id
        WHERE m.workspace_id = ${t.workspaceId} AND m.enabled AND d.status = 'active'
          AND (m.trigger_type IN (${sql.join(triggers.map((x) => sql`${x}`), sql`, `)}) AND (m.trigger_type <> 'lead_stage_entered' OR m.stage_id = ${t.toStageId}))
        ORDER BY m.id`)).map(toMapping);
      if (mappings.length === 0) return;
      const c = rowsOf(await sp.execute(sql`SELECT name, email, phone FROM contacts WHERE workspace_id = ${t.workspaceId} AND id = ${t.contactId}`))[0];
      if (!c) return;
      const parts = String(c.name ?? "").trim().split(/\s+/).filter(Boolean);
      const user = { email: c.email as string | null, phone: c.phone as string | null, firstName: parts[0] ?? null, lastName: parts.length > 1 ? parts[parts.length - 1]! : null, externalId: t.contactId };
      const entries = stageEntered && mappings.some((m) => m.triggerType === "lead_stage_entered")
        ? Number(rowsOf(await sp.execute(sql`SELECT count(*)::int AS n FROM stage_transitions WHERE workspace_id = ${t.workspaceId} AND lead_id = ${t.leadId} AND to_stage_id = ${t.toStageId}`))[0]?.n ?? 1)
        : 1;
      for (const m of mappings) {
        try {
          await sp.transaction(async (mp) => {
            const v = resolveValue(m, t);
            const ref = crmRef(m, t.leadId, entries);
            await enqueueCapiEvent(mp, {
              workspaceId: t.workspaceId, datasetIds: [m.datasetId], eventName: m.eventName, contactId: t.contactId, eventTime: new Date(), user,
              // a skipped fact gets its own key so that fixing the value later (and winning again) can still send the real event
              crmEventRef: v.skip ? `${ref}:${v.skip}` : ref, ...(v.skip ? { skipReason: v.skip } : {}), ...(v.custom ? { customData: v.custom } : {}),
            });
          });
        } catch (err) {
          console.error(JSON.stringify({ msg: "capi mapping failed", error: (err as Error).name })); // name only: the message could carry a payload
        }
      }
    });
  } catch (err) {
    console.error(JSON.stringify({ msg: "capi enqueue failed", error: (err as Error).name }));
  }
}

export type PreviewItem = { mapping: Mapping; datasetName: string; result: "send" | "skip"; reason: "mapping_disabled" | "dataset_inactive" | "no_value" | "no_consent" | "opted_out" | null; value: number | null; currency: string | null };

/**
 * Dry run for the settings screen: what would each rule do if THIS lead met its trigger now. Reads only; nothing is queued. Uses the same value and consent rules as the real path.
 */
export async function previewLead(tx: Tx, workspaceId: string, lead: LeadFacts & { contactId: string }): Promise<{ items: PreviewItem[]; consent: "granted" | "revoked" | "none" }> {
  const latest = rowsOf(await tx.execute(sql`SELECT status FROM consent_records WHERE workspace_id = ${workspaceId} AND contact_id = ${lead.contactId} AND purpose = ${CONSENT_PURPOSE} ORDER BY id DESC LIMIT 1`))[0] as { status: "granted" | "revoked" } | undefined;
  const gate = consentGate(latest);
  const rows = rowsOf(await tx.execute(sql`
    SELECT m.*, d.name AS dataset_name, d.status AS dataset_status FROM capi_event_mappings m JOIN capi_datasets d ON d.workspace_id = m.workspace_id AND d.id = m.dataset_id
    WHERE m.workspace_id = ${workspaceId} ORDER BY d.id, m.id`));
  const items = rows.map((r): PreviewItem => {
    const mapping = toMapping(r);
    const v = resolveValue(mapping, lead);
    const reason = !r.enabled ? "mapping_disabled" as const : r.dataset_status !== "active" ? "dataset_inactive" as const : v.skip ? "no_value" as const : !gate.allow ? gate.reason : null;
    return { mapping, datasetName: r.dataset_name as string, result: reason ? "skip" : "send", reason, value: v.custom?.value ?? null, currency: v.custom?.currency ?? null };
  });
  return { items, consent: latest ? latest.status : "none" };
}

/** The default rule every dataset starts with: the old behaviour (a lead moved to a Won stage becomes a Purchase with the lead's value). Editable and deletable like any other. */
export async function seedDefaultMapping(tx: Tx, a: { workspaceId: string; datasetId: string; userId: string; enabled: boolean }): Promise<void> {
  await tx.execute(sql`
    INSERT INTO capi_event_mappings (workspace_id, dataset_id, trigger_type, event_name, value_mode, enabled, created_by)
    VALUES (${a.workspaceId}, ${a.datasetId}, 'lead_won', 'Purchase', 'lead_value', ${a.enabled}, ${a.userId}) ON CONFLICT DO NOTHING`);
}
