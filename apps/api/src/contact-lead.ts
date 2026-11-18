import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { ContactLead, PutContactLeadBody } from "@crm/contracts";
import { schema, type Tx } from "@crm/db";
import { loadContact } from "./crm-service.ts";
import type { LeadOps } from "./routes/leads.ts";
import type { ErrStatus, SC } from "./routes/scope.ts";

/**
 * One contact = one lead in the UI (decision D260). The database keeps leads as they are; this file is the thin layer that
 *  - picks the PRIMARY lead of a contact (most recent open lead, else most recent lead; soft-deleted ones never count),
 *  - treats a contact without a lead as sitting in the FIRST stage of the default pipeline (virtual, nothing is written),
 *  - creates the lead lazily on the first write, through the same createLeadIn / updateLeadIn / moveLead as /leads (CAPI, consent, audit, versions, automations unchanged).
 */

/** The contact's primary lead, as a lateral join on `contacts c`. Uses leads_contact_idx (workspace_id, primary_contact_id). Adds the aliases pl (lead) and ps (its stage). */
export const PRIMARY_LEAD_JOIN = sql`LEFT JOIN LATERAL (SELECT l.id, l.stage_id, l.value_minor FROM leads l WHERE l.workspace_id = c.workspace_id AND l.primary_contact_id = c.id AND l.deleted_at IS NULL ORDER BY (l.outcome = 'open') DESC, l.created_at DESC, l.id DESC LIMIT 1) pl ON true LEFT JOIN pipeline_stages ps ON ps.workspace_id = c.workspace_id AND ps.id = pl.stage_id`;

export type FirstStage = { id: string; name: string; position: number; pipelineId: string };
/** The first active open stage of the default pipeline: where a contact without a lead is shown. */
export async function firstStage(tx: Tx, workspaceId: string): Promise<FirstStage | null> {
  const [s] = await tx
    .select({ id: schema.pipelineStages.id, name: schema.pipelineStages.name, position: schema.pipelineStages.position, pipelineId: schema.pipelineStages.pipelineId })
    .from(schema.pipelineStages)
    .innerJoin(schema.pipelines, and(eq(schema.pipelines.workspaceId, schema.pipelineStages.workspaceId), eq(schema.pipelines.id, schema.pipelineStages.pipelineId)))
    .where(and(eq(schema.pipelines.workspaceId, workspaceId), eq(schema.pipelines.isDefault, true), isNull(schema.pipelines.archivedAt), eq(schema.pipelineStages.kind, "open"), isNull(schema.pipelineStages.archivedAt)))
    .orderBy(asc(schema.pipelineStages.position))
    .limit(1);
  return s ?? null;
}

/** Stage filter shared by the list and (through the same join) the counts. Needs PRIMARY_LEAD_JOIN. */
export const stageWhere = (stageId: string, first: FirstStage | null): SQL => (first && first.id === stageId ? sql`(pl.stage_id = ${stageId}::uuid OR pl.id IS NULL)` : sql`pl.stage_id = ${stageId}::uuid`);

type Row = { contact_id: string; id: string; stage_id: string; stage_name: string; stage_kind: string; value_minor: string | null; currency: string | null; owner_user_id: string | null; version: number; n: string };

/** The primary lead of each given contact (contacts without one are absent). Value is hidden for callers who may not see it, exactly like the lead DTO. */
export async function leadsFor(tx: Tx, c: SC, ops: LeadOps, contactIds: string[]): Promise<Map<string, ContactLead>> {
  const out = new Map<string, ContactLead>();
  if (!contactIds.length) return out;
  const ws = c.get("workspaceId");
  const rows = (await tx.execute(sql`
    SELECT DISTINCT ON (l.primary_contact_id) l.primary_contact_id AS contact_id, l.id, l.stage_id, ps.name AS stage_name, ps.kind AS stage_kind, l.value_minor::text AS value_minor, l.currency, l.owner_user_id, l.version,
      count(*) OVER (PARTITION BY l.primary_contact_id)::text AS n
    FROM leads l JOIN pipeline_stages ps ON ps.workspace_id = l.workspace_id AND ps.id = l.stage_id
    WHERE l.workspace_id = ${ws} AND l.deleted_at IS NULL AND l.primary_contact_id IN (${sql.join(contactIds.map((i) => sql`${i}::uuid`), sql`, `)})
    ORDER BY l.primary_contact_id, (l.outcome = 'open') DESC, l.created_at DESC, l.id DESC`)).rows as Row[];
  const g = await ops.grantsFor(tx, c, rows.map((r) => r.id));
  for (const r of rows) {
    const show = ops.mayView(c, g, r.id);
    out.set(r.contact_id, {
      id: r.id, stageId: r.stage_id, stageName: r.stage_name, stageKind: r.stage_kind as ContactLead["stageKind"],
      valueMinor: show && r.value_minor !== null ? Number(r.value_minor) : null, currency: show ? r.currency : null, valueHidden: !show,
      ownerId: r.owner_user_id, version: r.version, moreCount: Number(r.n) - 1,
    });
  }
  return out;
}

/** Thrown inside the transaction to undo a half-done upsert (the move after the create, for instance). */
export class Rollback extends Error {
  constructor(public status: ErrStatus, public code: string, public override message: string, public details?: unknown) { super(message); }
}
export type UpsertOut = { ok: true; lead: ContactLead; created: boolean; changed: boolean } | { ok: false; status: ErrStatus; code: string; message?: string; details?: unknown };
const bad = (status: ErrStatus, code: string, message?: string): UpsertOut => ({ ok: false, status, code, message });

/**
 * Write stage, value and/or owner of a contact. No lead yet: create it (default pipeline, first stage unless the stage says otherwise; a won/lost target is created open, then moved, so history and CAPI see both steps).
 * A lead exists: update value/owner first (so a Won sent to Meta carries the new value), then move. `bulk` allows no expectedVersion ("whatever is current", like POST /leads/bulk-stage).
 * Caller must have checked lead.edit and runs this in one transaction; failures after the first write throw Rollback.
 */
export async function upsertContactLead(tx: Tx, c: SC, ops: LeadOps, contactId: string, b: PutContactLeadBody, bulk = false): Promise<UpsertOut> {
  const ws = c.get("workspaceId");
  const contact = await loadContact(tx, ws, contactId);
  if (!contact) return bad(404, "not_found");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`contact-lead:${ws}:${contactId}`}, 0))`); // two quick edits of a lead-less contact must not both create
  const current = (await leadsFor(tx, c, ops, [contactId])).get(contactId);
  const noop = async (): Promise<UpsertOut> => ({ ok: true, lead: (await leadsFor(tx, c, ops, [contactId])).get(contactId)!, created: false, changed: false });

  if (!current) {
    const target = b.stageId ? await ops.stageOf(tx, ws, b.stageId) : await firstStage(tx, ws);
    if (!target || ("archivedAt" in target && target.archivedAt)) return bad(b.stageId ? 400 : 409, b.stageId ? "invalid_body" : "no_pipeline", b.stageId ? "Choose an active stage." : "Set up a pipeline with a stage first.");
    const open = !("kind" in target) || target.kind === "open";
    const made = await ops.createLeadIn(tx, c, {
      title: contact.name.slice(0, 160), primaryContactId: contactId, pipelineId: target.pipelineId, stageId: open ? target.id : undefined,
      valueMinor: b.valueMinor ?? null, currency: b.valueMinor == null ? null : b.currency ?? null, ownerUserId: b.ownerUserId ?? null,
    });
    if (!made.ok) return made;
    if (!open) {
      const moved = await ops.moveLead(tx, c, made.lead.id, { stageId: target.id, lostReasonId: b.lostReasonId }, true);
      if (!moved.ok) throw new Rollback(moved.status, moved.code, moved.message ?? "");
    }
    return { ok: true, lead: (await leadsFor(tx, c, ops, [contactId])).get(contactId)!, created: true, changed: true };
  }

  if (b.expectedVersion === undefined && !bulk) return bad(400, "invalid_body", "Send expectedVersion of the current lead.");
  if (b.expectedVersion !== undefined && b.expectedVersion !== current.version) return bad(409, "version_conflict", "This lead was changed by someone else.");
  let version = current.version;
  let changed = false;
  if (b.valueMinor !== undefined || b.currency !== undefined || b.ownerUserId !== undefined) {
    const upd = await ops.updateLeadIn(tx, c, current.id, {
      expectedVersion: version,
      ...(b.valueMinor !== undefined || b.currency !== undefined ? { valueMinor: b.valueMinor ?? null, currency: b.valueMinor == null ? null : b.currency ?? null } : {}),
      ...(b.ownerUserId !== undefined ? { ownerUserId: b.ownerUserId } : {}),
    });
    if (!upd.ok) return upd;
    changed = upd.lead.version !== version;
    version = upd.lead.version;
  }
  if (b.stageId !== undefined && b.stageId !== current.stageId) {
    const moved = await ops.moveLead(tx, c, current.id, { expectedVersion: version, stageId: b.stageId, lostReasonId: b.lostReasonId }, true);
    if (!moved.ok) {
      if (changed) throw new Rollback(moved.status, moved.code, moved.message ?? ""); // undo the value/owner write: the request is all or nothing
      return moved;
    }
    changed = changed || moved.changed;
  }
  if (!changed) return noop();
  return { ok: true, lead: (await leadsFor(tx, c, ops, [contactId])).get(contactId)!, created: false, changed: true };
}
