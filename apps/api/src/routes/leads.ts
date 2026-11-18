import { Hono } from "hono";
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { BulkStageBody, CreateLeadBody, LeadListQuery, LeadStageCountsQuery, LeadVersionBody, LeadVersionQuery, MoveLeadBody, SetValueGrantBody, UpdateLeadBody, type LeadDto } from "@crm/contracts";
import { escapeLike } from "@crm/core";
import { can } from "@crm/core/permissions";
import { schema, user, withContext, type Db, type Tx } from "@crm/db";
import { emitEvent } from "../events.ts";
import { writeAudit } from "../audit.ts";
import { captureLeadTransition } from "../capi/mappings.ts"; // track:capi
import { activeMember, loadContact, recordActivity } from "../crm-service.ts";
import { lockPipeline } from "./pipelines.ts";
import { WindowCounter } from "../throttle.ts";
import { actor, body, fail, forbidden, isUuid, query, wctx, type ErrStatus, type SC, type ScopedEnv } from "./scope.ts";

type LeadRow = typeof schema.leads.$inferSelect;
const RANK_STEP = 1_000_000;
const rankStr = (n: number) => String(Math.max(0, Math.round(n))).padStart(12, "0");
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const ownerU = alias(user, "owner_u");

/** shortcut: cursor is an opaque base64 JSON blob, not signed; it only carries a sort key the caller could already filter on. */
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const dec = (s: string): { k: string; id: string; sort: string; dir: string } | null => {
  try {
    const o = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return typeof o?.k === "string" && isUuid(o?.id) ? o : null;
  } catch {
    return null;
  }
};
const SORT_EXPR = { updated: "leads.updated_at", created: "leads.created_at", close: "coalesce(leads.expected_close_date, DATE '9999-12-31')" } as const;

/** Stateless lead operations shared by the lead routes and the contact routes (contact-lead upsert), so there is one create, one update and one move implementation. */
export type LeadOut = { ok: true; lead: LeadDto } | { ok: false; status: ErrStatus; code: string; message?: string; details?: unknown };
export function leadOps() {
  const audit = (c: SC, tx: Tx, action: string, id: string, summary: Record<string, unknown>) => writeAudit(tx, { ...actor(c), workspaceId: c.get("workspaceId"), action, entityType: "lead", entityId: id, summary });

  /** Grants of this caller for the given leads: leadId -> canEdit. Owner/admin need none. */
  async function grantsFor(tx: Tx, c: SC, ids: string[]) {
    const map = new Map<string, boolean>();
    if (!ids.length || can(c.get("role"), "lead.value.view", {})) return map;
    const rows = await tx.select().from(schema.leadValueGrants).where(and(eq(schema.leadValueGrants.workspaceId, c.get("workspaceId")), eq(schema.leadValueGrants.userId, c.get("userId")), inArray(schema.leadValueGrants.leadId, ids)));
    for (const g of rows) map.set(g.leadId, g.canEdit);
    return map;
  }
  const mayView = (c: SC, g: Map<string, boolean>, id: string) => can(c.get("role"), "lead.value.view", { isGranted: g.has(id) });
  const mayEditValue = (c: SC, g: Map<string, boolean>, id: string) => can(c.get("role"), "lead.value.edit", { isGranted: g.get(id) === true });

  type Joined = { l: LeadRow; contactName: string; contactDeleted: boolean; ownerName: string | null };
  const dto = (c: SC, g: Map<string, boolean>, j: Joined): LeadDto => {
    const show = mayView(c, g, j.l.id);
    return {
      id: j.l.id, title: j.l.title, description: j.l.description, primaryContact: { id: j.l.primaryContactId, name: j.contactName, deleted: j.contactDeleted },
      pipelineId: j.l.pipelineId, stageId: j.l.stageId, outcome: j.l.outcome as LeadDto["outcome"], rank: j.l.rank,
      valueMinor: show ? j.l.valueMinor : null, currency: show ? j.l.currency : null, valueHidden: !show, canEditValue: mayEditValue(c, g, j.l.id),
      expectedCloseDate: j.l.expectedCloseDate, probability: j.l.probability, probabilityManual: j.l.probabilityManual, closedAt: iso(j.l.closedAt), lostReasonId: j.l.lostReasonId, nextActivityAt: iso(j.l.nextActivityAt),
      priority: j.l.priority as LeadDto["priority"], source: j.l.source, owner: j.l.ownerUserId ? { id: j.l.ownerUserId, name: j.ownerName ?? "" } : null,
      version: j.l.version, createdAt: j.l.createdAt.toISOString(), updatedAt: j.l.updatedAt.toISOString(), deletedAt: iso(j.l.deletedAt),
    };
  };
  const joined = (tx: Tx, where: SQL | undefined) =>
    tx.select({ l: schema.leads, contactName: schema.contacts.name, contactDeleted: sql<boolean>`${schema.contacts.deletedAt} IS NOT NULL`, ownerName: ownerU.name, ku: sql<string>`leads.updated_at::text`, kc: sql<string>`leads.created_at::text` })
      .from(schema.leads)
      .innerJoin(schema.contacts, and(eq(schema.contacts.workspaceId, schema.leads.workspaceId), eq(schema.contacts.id, schema.leads.primaryContactId)))
      .leftJoin(ownerU, eq(ownerU.id, schema.leads.ownerUserId))
      .where(where);
  async function loadDto(tx: Tx, c: SC, id: string): Promise<LeadDto | null> {
    const [j] = await joined(tx, and(eq(schema.leads.workspaceId, c.get("workspaceId")), eq(schema.leads.id, id)));
    return j ? dto(c, await grantsFor(tx, c, [id]), j) : null;
  }
  async function stageOf(tx: Tx, workspaceId: string, id: string) {
    const [s] = await tx.select().from(schema.pipelineStages).where(and(eq(schema.pipelineStages.workspaceId, workspaceId), eq(schema.pipelineStages.id, id)));
    return s ?? null;
  }
  async function nextRank(tx: Tx, workspaceId: string, stageId: string) {
    const [m] = (await tx.execute(sql`SELECT coalesce(max(rank::bigint), 0) AS m FROM leads WHERE workspace_id = ${workspaceId} AND stage_id = ${stageId} AND deleted_at IS NULL`)).rows as { m: string }[];
    return rankStr(Number(m!.m) + RANK_STEP);
  }
  /** Rank between two neighbours in the target column; renumbers the column when there is no gap left. */
  async function rankBetween(tx: Tx, workspaceId: string, stageId: string, before?: string, after?: string): Promise<string> {
    if (!before && !after) return nextRank(tx, workspaceId, stageId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const get = async (id?: string) => {
        if (!id) return null;
        const [x] = (await tx.execute(sql`SELECT rank::bigint AS r FROM leads WHERE workspace_id = ${workspaceId} AND id = ${id} AND stage_id = ${stageId} AND deleted_at IS NULL`)).rows as { r: string }[];
        return x ? Number(x.r) : null;
      };
      const hi = await get(before); // lead that will end up after the moved one
      const lo = await get(after); // lead that will end up before it
      if (hi === null && lo === null) return nextRank(tx, workspaceId, stageId);
      const a = lo ?? 0;
      const b = hi ?? a + 2 * RANK_STEP;
      if (b - a >= 2) return rankStr(a + Math.floor((b - a) / 2));
      await tx.execute(sql`UPDATE leads SET rank = lpad((n.rn * ${RANK_STEP})::text, 12, '0') FROM (SELECT id, row_number() OVER (ORDER BY rank, id) AS rn FROM leads WHERE workspace_id = ${workspaceId} AND stage_id = ${stageId} AND deleted_at IS NULL) n WHERE leads.id = n.id AND leads.workspace_id = ${workspaceId}`);
    }
    return nextRank(tx, workspaceId, stageId);
  }
  const transition = (tx: Tx, c: SC, l: { id: string; pipelineId: string }, from: { stageId: string; outcome: string } | null, to: { stageId: string; outcome: string }, lostReasonId?: string | null) =>
    tx.insert(schema.stageTransitions).values({ workspaceId: c.get("workspaceId"), leadId: l.id, pipelineId: l.pipelineId, fromStageId: from?.stageId ?? null, toStageId: to.stageId, fromOutcome: from?.outcome ?? null, toOutcome: to.outcome, actorUserId: c.get("userId"), lostReasonId: lostReasonId ?? null });
  const validOwner = async (tx: Tx, c: SC, ownerId: string | null | undefined): Promise<string | null> => {
    if (ownerId == null) return null;
    if (c.get("role") === "agent" && ownerId !== c.get("userId")) return "Agents can only assign leads to themselves.";
    return (await activeMember(tx, c.get("workspaceId"), ownerId)) ? null : "The owner must be an active member of this workspace.";
  };
  const writer = (c: SC) => can(c.get("role"), "lead.edit", {});

  // ---------------------------------------------------------------- create
  /** The one lead-create implementation (POST /leads and the contact "stage, value, owner" upsert). Runs inside the caller's transaction. */
  async function createLeadIn(tx: Tx, c: SC, data: CreateLeadBody): Promise<LeadOut> {
    const { workspaceId, userId } = wctx(c);
    const hasValue = data.valueMinor != null;
    const bad = (status: ErrStatus, code: string, message?: string, details?: unknown): LeadOut => ({ ok: false, status, code, message, details });
    if (hasValue && !can(c.get("role"), "lead.value.edit", {})) return bad(403, "forbidden", "You don't have permission to set lead value.");
    const contact = await loadContact(tx, workspaceId, data.primaryContactId);
    if (!contact) return bad(400, "invalid_body", "The primary contact does not exist.");
    const pipelines = await tx.select().from(schema.pipelines).where(and(eq(schema.pipelines.workspaceId, workspaceId), isNull(schema.pipelines.archivedAt)));
    const pipeline = data.pipelineId ? pipelines.find((p) => p.id === data.pipelineId) : pipelines.find((p) => p.isDefault);
    if (!pipeline) return bad(400, "invalid_body", "Choose an active pipeline.");
    if (!(await lockPipeline(tx, workspaceId, pipeline.id, "share"))) return bad(400, "invalid_body", "Choose an active pipeline.");
    const [still] = await tx.select({ a: schema.pipelines.archivedAt }).from(schema.pipelines).where(and(eq(schema.pipelines.workspaceId, workspaceId), eq(schema.pipelines.id, pipeline.id)));
    if (still!.a) return bad(409, "pipeline_archived", "This pipeline was archived.");
    const stage = data.stageId ? await stageOf(tx, workspaceId, data.stageId) : (await tx.select().from(schema.pipelineStages).where(and(eq(schema.pipelineStages.workspaceId, workspaceId), eq(schema.pipelineStages.pipelineId, pipeline.id), eq(schema.pipelineStages.kind, "open"), isNull(schema.pipelineStages.archivedAt))).orderBy(asc(schema.pipelineStages.position)).limit(1))[0];
    if (!stage || stage.pipelineId !== pipeline.id || stage.kind !== "open" || stage.archivedAt) return bad(400, "invalid_body", "New leads start in an active open stage of the pipeline.");
    const ownerErr = await validOwner(tx, c, data.ownerUserId);
    if (ownerErr) return bad(400, "invalid_body", ownerErr);
    if (!data.allowDuplicate) {
      const dups = await tx.select({ id: schema.leads.id, title: schema.leads.title }).from(schema.leads).where(and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.primaryContactId, contact.id), eq(schema.leads.pipelineId, pipeline.id), eq(schema.leads.outcome, "open"), isNull(schema.leads.deletedAt))).limit(5);
      if (dups.length) return bad(409, "duplicate_lead", "This contact already has an open lead in this pipeline.", { duplicates: dups });
    }
    const manual = data.probability !== undefined;
    const [l] = await tx.insert(schema.leads).values({
      workspaceId, title: data.title, description: data.description ?? null, primaryContactId: contact.id, pipelineId: pipeline.id, stageId: stage.id, outcome: "open",
      rank: await nextRank(tx, workspaceId, stage.id), valueMinor: data.valueMinor ?? null, currency: hasValue ? (data.currency ?? null) : null, expectedCloseDate: data.expectedCloseDate ?? null,
      probability: data.probability ?? stage.defaultProbability, probabilityManual: manual, priority: data.priority ?? "normal", source: data.source ?? "manual", ownerUserId: data.ownerUserId ?? null, createdBy: userId,
    }).returning();
    await transition(tx, c, l!, null, { stageId: stage.id, outcome: "open" });
    await recordActivity(tx, { workspaceId, contactId: contact.id, leadId: l!.id, kind: "lead.created", actorUserId: userId, data: { title: l!.title, pipelineId: pipeline.id, stageId: stage.id } });
    await audit(c, tx, "lead.created", l!.id, { pipelineId: pipeline.id });
    await captureLeadTransition(tx, { workspaceId, leadId: l!.id, contactId: contact.id, fromStageId: null, toStageId: stage.id, fromOutcome: null, outcome: "open", valueMinor: l!.valueMinor, currency: l!.currency, created: true }); // track:capi
    if (l!.ownerUserId) await emitEvent(tx, { workspaceId, type: "lead.owner_assigned", entityType: "lead", entityId: l!.id, actorUserId: userId, payload: { ownerUserId: l!.ownerUserId, previousOwnerUserId: null, leadTitle: l!.title } });
    return { ok: true, lead: (await loadDto(tx, c, l!.id))! };
  }

  // ---------------------------------------------------------------- update
  /** The one lead-update implementation (PATCH /leads/:id and the contact upsert). Runs inside the caller's transaction. */
  async function updateLeadIn(tx: Tx, c: SC, id: string, d: UpdateLeadBody): Promise<LeadOut> {
    const { workspaceId, userId } = wctx(c);
    const bad = (status: ErrStatus, code: string, message?: string): LeadOut => ({ ok: false, status, code, message });
    const [cur] = (await tx.execute(sql`SELECT * FROM leads WHERE workspace_id = ${workspaceId} AND id = ${id} AND deleted_at IS NULL FOR UPDATE`)).rows as { id: string }[];
    if (!cur) return bad(404, "not_found");
    const [l] = await tx.select().from(schema.leads).where(and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.id, id)));
    if (l!.version !== d.expectedVersion) return bad(409, "version_conflict", "This lead was changed by someone else.");
    const g = await grantsFor(tx, c, [id]);
    const touchesValue = d.valueMinor !== undefined || d.currency !== undefined;
    if (touchesValue && !mayEditValue(c, g, id)) return bad(403, "forbidden", "You don't have permission to change lead value.");
    const set: Partial<typeof schema.leads.$inferInsert> = {};
    const changed: string[] = [];
    const put = <K extends keyof typeof set>(k: K, v: (typeof set)[K], label: string, differs: boolean) => { if (differs) { set[k] = v; changed.push(label); } };
    if (d.title !== undefined) put("title", d.title, "title", d.title !== l!.title);
    if (d.description !== undefined) put("description", d.description, "description", d.description !== l!.description);
    if (d.priority !== undefined) put("priority", d.priority, "priority", d.priority !== l!.priority);
    if (d.expectedCloseDate !== undefined) put("expectedCloseDate", d.expectedCloseDate, "expectedCloseDate", d.expectedCloseDate !== l!.expectedCloseDate);
    if (touchesValue) {
      const v = d.valueMinor !== undefined ? d.valueMinor : l!.valueMinor;
      const cu = d.currency !== undefined ? d.currency : l!.currency;
      if ((v == null) !== (cu == null)) return bad(400, "invalid_body", "Value and currency go together.");
      if (v !== l!.valueMinor || cu !== l!.currency) { set.valueMinor = v; set.currency = cu; changed.push("value"); }
    }
    if (d.primaryContactId !== undefined && d.primaryContactId !== l!.primaryContactId) {
      if (!(await loadContact(tx, workspaceId, d.primaryContactId))) return bad(400, "invalid_body", "The primary contact does not exist.");
      set.primaryContactId = d.primaryContactId; changed.push("primaryContact");
    }
    if (d.ownerUserId !== undefined && d.ownerUserId !== l!.ownerUserId) {
      const e = await validOwner(tx, c, d.ownerUserId);
      if (e) return bad(400, "invalid_body", e);
      set.ownerUserId = d.ownerUserId; changed.push("owner");
    }
    if (d.probability !== undefined && l!.outcome !== "open") return bad(400, "invalid_body", "Closed leads have a fixed probability.");
    if (d.resetProbability && l!.outcome === "open") {
      const st = await stageOf(tx, workspaceId, l!.stageId);
      set.probability = st!.defaultProbability; set.probabilityManual = false; changed.push("probability");
    } else if (d.probability !== undefined) { set.probability = d.probability; set.probabilityManual = true; changed.push("probability"); }
    if (!changed.length) return { ok: true, lead: (await loadDto(tx, c, id))! };
    await tx.update(schema.leads).set({ ...set, version: l!.version + 1, updatedAt: new Date() }).where(and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.id, id)));
    const contactId = set.primaryContactId ?? l!.primaryContactId;
    await recordActivity(tx, { workspaceId, contactId, leadId: id, kind: "lead.updated", actorUserId: userId, data: { fields: changed } });
    await audit(c, tx, "lead.updated", id, { fields: changed });
    if (changed.includes("owner") && set.ownerUserId) await emitEvent(tx, { workspaceId, type: "lead.owner_assigned", entityType: "lead", entityId: id, actorUserId: userId, payload: { ownerUserId: set.ownerUserId, previousOwnerUserId: l!.ownerUserId, leadTitle: set.title ?? l!.title } });
    return { ok: true, lead: (await loadDto(tx, c, id))! };
  }

  // ---------------------------------------------------------------- move
  type MoveOut = { ok: true; lead: LeadDto | null; changed: boolean } | { ok: false; status: ErrStatus; code: string; message?: string };
  const no = (status: ErrStatus, code: string, message?: string): MoveOut => ({ ok: false, status, code, message });
  /**
   * The one stage-move implementation: the single move and the bulk move both call it, so history, activity, audit, the lead.stage_changed event,
   * the CAPI Won hook and the permission rules are identical. expectedVersion undefined (bulk) means "whatever is current"; noReorder makes a move to the current stage a no-op.
   */
  async function moveLead(tx: Tx, c: SC, id: string, b: { expectedVersion?: number; stageId: string; lostReasonId?: string; beforeLeadId?: string; afterLeadId?: string }, noReorder = false): Promise<MoveOut> {
    const { workspaceId, userId } = wctx(c);
    const [cur] = (await tx.execute(sql`SELECT pipeline_id FROM leads WHERE workspace_id = ${workspaceId} AND id = ${id} AND deleted_at IS NULL FOR UPDATE`)).rows as { pipeline_id: string }[];
    if (!cur) return no(404, "not_found");
    if (!(await lockPipeline(tx, workspaceId, cur.pipeline_id, "share"))) return no(404, "not_found");
    const [l] = await tx.select().from(schema.leads).where(and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.id, id)));
    if (b.expectedVersion !== undefined && l!.version !== b.expectedVersion) return no(409, "version_conflict", "This lead was changed by someone else.");
    const to = await stageOf(tx, workspaceId, b.stageId);
    if (!to || to.pipelineId !== l!.pipelineId || to.archivedAt) return no(400, "invalid_body", "Choose an active stage of this lead's pipeline.");
    const [pl] = await tx.select({ a: schema.pipelines.archivedAt }).from(schema.pipelines).where(and(eq(schema.pipelines.workspaceId, workspaceId), eq(schema.pipelines.id, l!.pipelineId)));
    if (pl!.a) return no(409, "pipeline_archived", "This pipeline is archived.");
    const [contact] = await tx.select({ d: schema.contacts.deletedAt }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), eq(schema.contacts.id, l!.primaryContactId)));
    if (contact?.d) return no(409, "contact_deleted", "The primary contact was deleted; this lead is read-only history.");
    const wasClosed = l!.outcome !== "open";
    if (wasClosed && !can(c.get("role"), "lead.reopen", {})) return no(403, "forbidden", "You don't have permission to do that.");
    if (to.id === l!.stageId && noReorder) return { ok: true, lead: null, changed: false };
    if (to.kind === "lost" && !b.lostReasonId) return no(400, "lost_reason_required", "Choose a reason for losing this lead.");
    if (to.kind === "lost") {
      const [lr] = await tx.select({ a: schema.lostReasons.archivedAt }).from(schema.lostReasons).where(and(eq(schema.lostReasons.workspaceId, workspaceId), eq(schema.lostReasons.id, b.lostReasonId!)));
      if (!lr || lr.a) return no(400, "invalid_body", "Choose an active lost reason.");
    }
    if (to.id === l!.stageId) {
      // same column: only a re-order
      const rank = await rankBetween(tx, workspaceId, to.id, b.beforeLeadId, b.afterLeadId);
      await tx.update(schema.leads).set({ rank, version: l!.version + 1, updatedAt: new Date() }).where(and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.id, id)));
      return { ok: true, lead: await loadDto(tx, c, id), changed: false };
    }
    const closing = to.kind !== "open";
    // Probability: closing forces 100/0; an open stage keeps a manual override, otherwise takes the stage default; reopening resets (the closed value was forced).
    const keepManual = !closing && !wasClosed && l!.probabilityManual;
    const probability = closing ? to.defaultProbability : keepManual ? l!.probability : to.defaultProbability;
    const rank = await rankBetween(tx, workspaceId, to.id, b.beforeLeadId, b.afterLeadId);
    await tx.update(schema.leads).set({
      stageId: to.id, outcome: to.kind, rank, probability, probabilityManual: keepManual, closedAt: closing ? new Date() : null, lostReasonId: to.kind === "lost" ? b.lostReasonId! : null,
      version: l!.version + 1, updatedAt: new Date(),
    }).where(and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.id, id)));
    await transition(tx, c, l!, { stageId: l!.stageId, outcome: l!.outcome }, { stageId: to.id, outcome: to.kind }, to.kind === "lost" ? b.lostReasonId : null);
    const kind = wasClosed ? "lead.reopened" : to.kind === "won" ? "lead.won" : to.kind === "lost" ? "lead.lost" : "lead.stage_changed";
    await recordActivity(tx, { workspaceId, contactId: l!.primaryContactId, leadId: id, kind, actorUserId: userId, data: { fromStageId: l!.stageId, toStageId: to.id } });
    await audit(c, tx, kind, id, { fromStageId: l!.stageId, toStageId: to.id });
    await emitEvent(tx, { workspaceId, type: "lead.stage_changed", entityType: "lead", entityId: id, actorUserId: userId, payload: { fromStageId: l!.stageId, toStageId: to.id, outcome: to.kind, pipelineId: l!.pipelineId, contactId: l!.primaryContactId, leadTitle: l!.title } });
    await captureLeadTransition(tx, { workspaceId, leadId: id, contactId: l!.primaryContactId, fromStageId: l!.stageId, toStageId: to.id, fromOutcome: l!.outcome, outcome: to.kind as "open" | "won" | "lost", valueMinor: l!.valueMinor, currency: l!.currency }); // track:capi, the one CAPI hook (savepoints, never fails the move)
    return { ok: true, lead: await loadDto(tx, c, id), changed: true };
  }

  return { grantsFor, mayView, mayEditValue, dto, joined, loadDto, stageOf, nextRank, writer, createLeadIn, updateLeadIn, moveLead, audit };
}
export type LeadOps = ReturnType<typeof leadOps>;

export function leadRoutes(db: Db, ops: LeadOps = leadOps()) {
  const r = new Hono<ScopedEnv>();
  const { grantsFor, dto, joined, loadDto, stageOf, nextRank, writer, createLeadIn, updateLeadIn, moveLead, audit } = ops;

  // ---------------------------------------------------------------- list
  /** Filters shared by the list and the stage counts (the counts never get a stage filter). A ready response means the query was refused. */
  const baseFilters = (c: SC, q: Omit<LeadListQuery, "cursor" | "limit" | "sort" | "dir">, forCounts: boolean): SQL[] | Response => {
    const where: SQL[] = [eq(schema.leads.workspaceId, c.get("workspaceId")), q.deleted && !forCounts ? sql`leads.deleted_at IS NOT NULL` : isNull(schema.leads.deletedAt)];
    if (q.deleted && !forCounts && !can(c.get("role"), "lead.delete", {})) return forbidden(c);
    if ((q.minValue !== undefined || q.maxValue !== undefined) && !can(c.get("role"), "lead.value.view", {})) return forbidden(c);
    if (q.pipelineId) where.push(eq(schema.leads.pipelineId, q.pipelineId));
    if (!forCounts && q.stageId) where.push(eq(schema.leads.stageId, q.stageId));
    if (q.outcome) where.push(eq(schema.leads.outcome, q.outcome));
    if (q.ownerId) where.push(eq(schema.leads.ownerUserId, q.ownerId));
    if (q.contactId) where.push(eq(schema.leads.primaryContactId, q.contactId));
    if (q.source) where.push(eq(schema.leads.source, q.source));
    if (q.minValue !== undefined) where.push(sql`leads.value_minor >= ${q.minValue}`);
    if (q.maxValue !== undefined) where.push(sql`leads.value_minor <= ${q.maxValue}`);
    if (q.activeWithinDays) where.push(sql`leads.updated_at >= now() - (${Number(q.activeWithinDays)} * interval '1 day')`);
    if (q.q?.trim()) where.push(sql`leads.title ILIKE ${`%${escapeLike(q.q.trim())}%`}`);
    return where;
  };

  r.get("/leads", async (c) => {
    const q = query(c, LeadListQuery);
    if (!q.ok) return q.res;
    const sort = q.data.sort ?? "updated";
    const dir = q.data.dir ?? "desc";
    const limit = q.data.limit ?? 50;
    const key = sql.raw(SORT_EXPR[sort]);
    const where = baseFilters(c, q.data, false);
    if (!Array.isArray(where)) return where;
    if (q.data.cursor) {
      const cur = dec(q.data.cursor);
      if (!cur || cur.sort !== sort || cur.dir !== dir) return fail(c, 400, "invalid_query", "The cursor does not match this query");
      const cast = sort === "close" ? "date" : "timestamptz";
      where.push(sql`(${key}, leads.id) ${sql.raw(dir === "desc" ? "<" : ">")} (${cur.k}::${sql.raw(cast)}, ${cur.id}::uuid)`);
    }
    return withContext(db, wctx(c), async (tx) => {
      const rows = await joined(tx, and(...where)).orderBy(dir === "desc" ? desc(key) : asc(key), dir === "desc" ? desc(schema.leads.id) : asc(schema.leads.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      const g = await grantsFor(tx, c, page.map((x) => x.l.id));
      const last = page[page.length - 1];
      // full microsecond precision from Postgres: a millisecond ISO string skipped rows that share a millisecond with the page boundary
      const k = last ? (sort === "updated" ? last.ku : sort === "created" ? last.kc : (last.l.expectedCloseDate ?? "9999-12-31")) : "";
      return c.json({ items: page.map((j) => dto(c, g, j)), nextCursor: rows.length > limit && last ? enc({ k, id: last.l.id, sort, dir }) : null });
    });
  });

  /** One grouped query: lead counts per stage under the list's filters (minus stage). Registered before /leads/:leadId. */
  r.get("/leads/stage-counts", async (c) => {
    const q = query(c, LeadStageCountsQuery);
    if (!q.ok) return q.res;
    const where = baseFilters(c, q.data, true);
    if (!Array.isArray(where)) return where;
    return withContext(db, wctx(c), async (tx) => {
      const rows = await tx.select({ stageId: schema.leads.stageId, n: sql<number>`count(*)::int` }).from(schema.leads).where(and(...where)).groupBy(schema.leads.stageId);
      return c.json({ items: rows.map((x) => ({ stageId: x.stageId, count: x.n })), total: rows.reduce((t, x) => t + x.n, 0) });
    });
  });

  r.get("/leads/:leadId", async (c) => {
    const id = c.req.param("leadId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    return withContext(db, wctx(c), async (tx) => {
      const l = await loadDto(tx, c, id);
      if (!l || (l.deletedAt && !can(c.get("role"), "lead.delete", {}))) return fail(c, 404, "not_found");
      return c.json(l);
    });
  });

  r.post("/leads", async (c) => {
    if (!writer(c)) return forbidden(c);
    const b = await body(c, CreateLeadBody);
    if (!b.ok) return b.res;
    return withContext(db, wctx(c), async (tx) => {
      const out = await createLeadIn(tx, c, b.data);
      return out.ok ? c.json(out.lead, 201) : fail(c, out.status, out.code, out.message, out.details);
    });
  });

  r.patch("/leads/:leadId", async (c) => {
    if (!writer(c)) return forbidden(c);
    const id = c.req.param("leadId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, UpdateLeadBody);
    if (!b.ok) return b.res;
    return withContext(db, wctx(c), async (tx) => {
      const out = await updateLeadIn(tx, c, id, b.data);
      return out.ok ? c.json(out.lead) : fail(c, out.status, out.code, out.message);
    });
  });

  r.post("/leads/:leadId/move", async (c) => {
    if (!writer(c)) return forbidden(c);
    const id = c.req.param("leadId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, MoveLeadBody);
    if (!b.ok) return b.res;
    return withContext(db, wctx(c), async (tx) => {
      const out = await moveLead(tx, c, id, b.data);
      return out.ok ? c.json(out.lead) : fail(c, out.status, out.code, out.message);
    });
  });

  // ponytail: one transaction per lead, sequential (max 100); one shared transaction would let a single bad lead undo the rest.
  const bulkCalls = new WindowCounter(30, 60_000);
  r.post("/leads/bulk-stage", async (c) => {
    if (!writer(c)) return forbidden(c);
    if (!bulkCalls.allow(`${c.get("workspaceId")}:${c.get("userId")}`)) { c.header("Retry-After", "60"); return fail(c, 429, "rate_limited", "Too many bulk moves. Try again in a minute."); }
    const b = await body(c, BulkStageBody);
    if (!b.ok) return b.res;
    const ids = [...new Set(b.data.leadIds)];
    const results: { id: string; ok: boolean; code: string }[] = [];
    for (const id of ids) {
      try {
        const out = await withContext(db, wctx(c), (tx) => moveLead(tx, c, id, { stageId: b.data.stageId, lostReasonId: b.data.lostReasonId }, true));
        results.push({ id, ok: out.ok, code: out.ok ? (out.changed ? "ok" : "unchanged") : out.code });
      } catch {
        results.push({ id, ok: false, code: "internal_error" });
      }
    }
    return c.json({ results });
  });

  // ---------------------------------------------------------------- delete / restore
  r.delete("/leads/:leadId", async (c) => {
    if (!can(c.get("role"), "lead.delete", {})) return forbidden(c);
    const id = c.req.param("leadId");
    const q = query(c, LeadVersionQuery);
    if (!isUuid(id)) return fail(c, 404, "not_found");
    if (!q.ok) return q.res;
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const [l] = await tx.select().from(schema.leads).where(and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.id, id), isNull(schema.leads.deletedAt)));
      if (!l) return fail(c, 404, "not_found");
      if (l.version !== q.data.expectedVersion) return fail(c, 409, "version_conflict", "This lead was changed by someone else.");
      await tx.update(schema.leads).set({ deletedAt: new Date(), version: l.version + 1, updatedAt: new Date() }).where(and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.id, id)));
      await recordActivity(tx, { workspaceId, contactId: l.primaryContactId, leadId: id, kind: "lead.deleted", actorUserId: userId });
      await audit(c, tx, "lead.deleted", id, {});
      return c.json(await loadDto(tx, c, id));
    });
  });

  r.post("/leads/:leadId/restore", async (c) => {
    if (!can(c.get("role"), "lead.delete", {})) return forbidden(c);
    const id = c.req.param("leadId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, LeadVersionBody);
    if (!b.ok) return b.res;
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const [l] = await tx.select().from(schema.leads).where(and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.id, id), sql`deleted_at IS NOT NULL`));
      if (!l) return fail(c, 404, "not_found");
      if (l.version !== b.data.expectedVersion) return fail(c, 409, "version_conflict", "This lead was changed by someone else.");
      if (!(await loadContact(tx, workspaceId, l.primaryContactId))) return fail(c, 409, "contact_deleted", "Restore the primary contact first.");
      // The stage may have been archived while the lead was deleted: put it in the pipeline's first active open stage.
      const st = await stageOf(tx, workspaceId, l.stageId);
      let upd: Partial<typeof schema.leads.$inferInsert> = {};
      if (st?.archivedAt) {
        const [first] = await tx.select().from(schema.pipelineStages).where(and(eq(schema.pipelineStages.workspaceId, workspaceId), eq(schema.pipelineStages.pipelineId, l.pipelineId), eq(schema.pipelineStages.kind, "open"), isNull(schema.pipelineStages.archivedAt))).orderBy(asc(schema.pipelineStages.position)).limit(1);
        if (!first) return fail(c, 409, "no_active_stage", "This pipeline has no active stage.");
        upd = { stageId: first.id, probability: l.probabilityManual ? l.probability : first.defaultProbability, rank: await nextRank(tx, workspaceId, first.id) };
      }
      await tx.update(schema.leads).set({ ...upd, deletedAt: null, version: l.version + 1, updatedAt: new Date() }).where(and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.id, id)));
      await recordActivity(tx, { workspaceId, contactId: l.primaryContactId, leadId: id, kind: "lead.restored", actorUserId: userId });
      await audit(c, tx, "lead.restored", id, {});
      return c.json(await loadDto(tx, c, id));
    });
  });

  // ---------------------------------------------------------------- history, timeline
  r.get("/leads/:leadId/transitions", async (c) => {
    const id = c.req.param("leadId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (!(await loadDto(tx, c, id))) return fail(c, 404, "not_found");
      const rows = await tx.select({ t: schema.stageTransitions, name: user.name }).from(schema.stageTransitions).leftJoin(user, eq(user.id, schema.stageTransitions.actorUserId))
        .where(and(eq(schema.stageTransitions.workspaceId, workspaceId), eq(schema.stageTransitions.leadId, id))).orderBy(desc(schema.stageTransitions.occurredAt), desc(schema.stageTransitions.id)).limit(200);
      return c.json({ items: rows.map(({ t, name }) => ({ id: t.id, fromStageId: t.fromStageId, toStageId: t.toStageId, fromOutcome: t.fromOutcome, toOutcome: t.toOutcome, actor: t.actorUserId ? { id: t.actorUserId, name: name ?? "" } : null, lostReasonId: t.lostReasonId, occurredAt: t.occurredAt.toISOString() })) });
    });
  });

  r.get("/leads/:leadId/activities", async (c) => {
    const id = c.req.param("leadId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (!(await loadDto(tx, c, id))) return fail(c, 404, "not_found");
      const rows = await tx.select({ a: schema.activities, name: user.name }).from(schema.activities).leftJoin(user, eq(user.id, schema.activities.actorUserId))
        .where(and(eq(schema.activities.workspaceId, workspaceId), eq(schema.activities.leadId, id))).orderBy(desc(schema.activities.occurredAt), desc(schema.activities.id)).limit(200);
      return c.json({ items: rows.map(({ a, name }) => ({ id: a.id, kind: a.kind, actor: a.actorUserId ? { id: a.actorUserId, name: name ?? "" } : null, data: (a.data ?? {}) as Record<string, unknown>, occurredAt: a.occurredAt.toISOString() })) });
    });
  });

  // ---------------------------------------------------------------- lead value grants (owner/admin)
  const grantList = async (tx: Tx, workspaceId: string, leadId: string) =>
    (await tx.select({ g: schema.leadValueGrants, name: user.name }).from(schema.leadValueGrants).innerJoin(user, eq(user.id, schema.leadValueGrants.userId)).where(and(eq(schema.leadValueGrants.workspaceId, workspaceId), eq(schema.leadValueGrants.leadId, leadId))).orderBy(asc(user.name)))
      .map(({ g, name }) => ({ userId: g.userId, name, canEdit: g.canEdit }));

  r.get("/leads/:leadId/value-grants", async (c) => {
    if (!can(c.get("role"), "lead.delete", {})) return forbidden(c); // owner/admin
    const id = c.req.param("leadId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    return withContext(db, wctx(c), async (tx) => ((await loadDto(tx, c, id)) ? c.json({ items: await grantList(tx, c.get("workspaceId"), id) }) : fail(c, 404, "not_found")));
  });
  r.put("/leads/:leadId/value-grants/:userId", async (c) => {
    if (!can(c.get("role"), "lead.delete", {})) return forbidden(c);
    const id = c.req.param("leadId");
    const target = c.req.param("userId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, SetValueGrantBody);
    if (!b.ok) return b.res;
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (!(await loadDto(tx, c, id))) return fail(c, 404, "not_found");
      if (!(await activeMember(tx, workspaceId, target))) return fail(c, 400, "invalid_body", "The user must be an active member.");
      await tx.insert(schema.leadValueGrants).values({ workspaceId, leadId: id, userId: target, canEdit: b.data.canEdit, grantedBy: userId }).onConflictDoUpdate({ target: [schema.leadValueGrants.workspaceId, schema.leadValueGrants.leadId, schema.leadValueGrants.userId], set: { canEdit: b.data.canEdit, grantedBy: userId } });
      await audit(c, tx, "lead.value_access_granted", id, { userId: target, canEdit: b.data.canEdit });
      return c.json((await grantList(tx, workspaceId, id)).find((x) => x.userId === target));
    });
  });
  r.delete("/leads/:leadId/value-grants/:userId", async (c) => {
    if (!can(c.get("role"), "lead.delete", {})) return forbidden(c);
    const id = c.req.param("leadId");
    const target = c.req.param("userId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (!(await loadDto(tx, c, id))) return fail(c, 404, "not_found");
      await tx.delete(schema.leadValueGrants).where(and(eq(schema.leadValueGrants.workspaceId, workspaceId), eq(schema.leadValueGrants.leadId, id), eq(schema.leadValueGrants.userId, target)));
      await audit(c, tx, "lead.value_access_revoked", id, { userId: target });
      return c.json({ items: await grantList(tx, workspaceId, id) });
    });
  });

  return r;
}
