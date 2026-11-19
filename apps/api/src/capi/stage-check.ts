import { sql } from "drizzle-orm";
import { CONSENT_PURPOSE } from "@crm/capi";
import type { StageCheck } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import type { Tx } from "@crm/db";
import { firstStage } from "../contact-lead.ts";
import { loadContact } from "../crm-service.ts";
import type { LeadOps } from "../routes/leads.ts";
import type { SC } from "../routes/scope.ts";
import { firedTriggers, type Trigger, type TransitionInput } from "./mappings.ts";

const rowsOf = (r: unknown) => (r as { rows: Record<string, unknown>[] }).rows;

/**
 * The preflight of a stage change (read only, nothing queued): which enabled rules of active datasets would fire for this contact moving to `stageId`,
 * and whether the app has to ask for a deal value first (a firing rule with ask_for_value whose lead has no value).
 * A contact without a lead gets one on its first move (D261): an open target is the creation (lead_created and entering that stage); a won/lost target is created in the first stage, then moved.
 * The lead's value is only returned to a caller who may see it; `needsValue` is computed from the real value either way.
 * ponytail: a won/lost rule that already sent once for this lead (dedupe key) is still listed; the dialog may ask once more than strictly needed.
 */
export async function stageCheck(tx: Tx, c: SC, ops: LeadOps, contactId: string, stageId: string): Promise<StageCheck | "no_contact" | "bad_stage" | "no_pipeline"> {
  const ws = c.get("workspaceId");
  const contact = await loadContact(tx, ws, contactId);
  if (!contact) return "no_contact";
  const target = await ops.stageOf(tx, ws, stageId);
  if (!target || target.archivedAt) return "bad_stage";
  const lead = rowsOf(await tx.execute(sql`SELECT id, stage_id, outcome, value_minor::text AS value_minor, currency, pipeline_id FROM leads WHERE workspace_id = ${ws} AND primary_contact_id = ${contactId} AND deleted_at IS NULL ORDER BY (outcome = 'open') DESC, created_at DESC, id DESC LIMIT 1`))[0];
  const kind = target.kind as "open" | "won" | "lost";
  const transitions: Pick<TransitionInput, "fromStageId" | "toStageId" | "fromOutcome" | "outcome" | "created">[] = [];
  if (lead) {
    if (lead.stage_id !== stageId) transitions.push({ fromStageId: lead.stage_id as string, toStageId: stageId, fromOutcome: lead.outcome as string, outcome: kind });
  } else {
    const first = await firstStage(tx, ws);
    if (!first) return "no_pipeline";
    if (kind === "open") transitions.push({ fromStageId: null, toStageId: stageId, fromOutcome: null, outcome: "open", created: true });
    else transitions.push({ fromStageId: null, toStageId: first.id, fromOutcome: null, outcome: "open", created: true }, { fromStageId: first.id, toStageId: stageId, fromOutcome: "open", outcome: kind });
  }
  const valueMinor = lead?.value_minor != null ? Number(lead.value_minor) : null;
  const currency = (lead?.currency as string | null) ?? null;
  const missing = valueMinor === null || !currency;

  const mappings = rowsOf(await tx.execute(sql`
    SELECT m.id, m.trigger_type, m.stage_id, m.event_name, m.value_mode, m.ask_for_value, d.name AS dataset_name, d.mode AS dataset_mode
    FROM capi_event_mappings m JOIN capi_datasets d ON d.workspace_id = m.workspace_id AND d.id = m.dataset_id
    WHERE m.workspace_id = ${ws} AND m.enabled AND d.status = 'active' ORDER BY d.id, m.id`));
  const fires: StageCheck["fires"] = [];
  for (const m of mappings) {
    const hit = transitions.some((t) => firedTriggers(t).includes(m.trigger_type as Trigger) && (m.trigger_type !== "lead_stage_entered" || m.stage_id === t.toStageId));
    if (!hit) continue;
    fires.push({ mappingId: m.id as string, datasetName: m.dataset_name as string, datasetMode: m.dataset_mode as "mock" | "live", eventName: m.event_name as string, trigger: m.trigger_type as Trigger, ask: m.ask_for_value === true && m.value_mode === "lead_value" && missing });
  }

  const grants = lead ? await ops.grantsFor(tx, c, [lead.id as string]) : new Map<string, boolean>();
  const canSetValue = lead ? ops.mayEditValue(c, grants, lead.id as string) : can(c.get("role"), "lead.value.edit", {});
  const visible = lead ? ops.mayView(c, grants, lead.id as string) : true;
  const latest = rowsOf(await tx.execute(sql`SELECT status FROM consent_records WHERE workspace_id = ${ws} AND contact_id = ${contactId} AND purpose = ${CONSENT_PURPOSE} ORDER BY id DESC LIMIT 1`))[0] as { status: "granted" | "revoked" } | undefined;
  const pipe = rowsOf(await tx.execute(sql`SELECT default_currency FROM pipelines WHERE workspace_id = ${ws} AND id = ${target.pipelineId}`))[0];
  return {
    stageId, stageName: target.name, stageKind: kind, fires, needsValue: fires.some((f) => f.ask), canSetValue,
    value: visible && !missing ? { valueMinor: valueMinor!, currency: currency! } : null, valueHidden: !visible,
    currency: (visible ? currency : null) ?? (pipe?.default_currency as string | undefined) ?? "USD", consent: latest ? latest.status : "none",
  };
}
