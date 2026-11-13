import { Hono } from "hono";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { ArchivePipelineBody, ArchivePipelineStageBody, CreateLostReasonBody, CreatePipelineBody, CreatePipelineStageBody, ReorderPipelineStagesBody, UpdateLostReasonBody, UpdatePipelineBody, UpdatePipelineStageBody, type PipelineDto, type StageDto, type LostReasonDto } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { schema, withContext, type Db, type Tx } from "@crm/db";
import { writeAudit } from "../audit.ts";
import { DEFAULT_PIPELINE_STAGES, ensureDefaultPipeline } from "../crm-service.ts";
import { actor, body, fail, forbidden, isUuid, wctx, type SC, type ScopedEnv } from "./scope.ts";

type PipelineRow = typeof schema.pipelines.$inferSelect;
type StageRow = typeof schema.pipelineStages.$inferSelect;

export const pgCode = (e: unknown): string | undefined => (e as { cause?: { code?: string }; code?: string })?.cause?.code ?? (e as { code?: string })?.code;
const stageDto = (s: StageRow): StageDto => ({ id: s.id, pipelineId: s.pipelineId, name: s.name, kind: s.kind as StageDto["kind"], defaultProbability: s.defaultProbability, position: s.position, archived: !!s.archivedAt });
const pipelineDto = (p: PipelineRow, stages: StageRow[]): PipelineDto => ({
  id: p.id, name: p.name, kind: p.kind as PipelineDto["kind"], defaultCurrency: p.defaultCurrency, isDefault: p.isDefault, position: p.position, version: p.version, archived: !!p.archivedAt,
  stages: stages.filter((s) => s.pipelineId === p.id).sort((a, b) => a.position - b.position).map(stageDto),
});
const reasonDto = (r: typeof schema.lostReasons.$inferSelect): LostReasonDto => ({ id: r.id, name: r.name, position: r.position, archived: !!r.archivedAt });

export async function loadPipelineDto(tx: Tx, workspaceId: string, id: string): Promise<PipelineDto | null> {
  const [p] = await tx.select().from(schema.pipelines).where(and(eq(schema.pipelines.workspaceId, workspaceId), eq(schema.pipelines.id, id)));
  if (!p) return null;
  const stages = await tx.select().from(schema.pipelineStages).where(and(eq(schema.pipelineStages.workspaceId, workspaceId), eq(schema.pipelineStages.pipelineId, id)));
  return pipelineDto(p, stages);
}

/** Locks the pipeline row so archive, stage edits and lead writes into it serialise (leads take FOR SHARE). */
export const lockPipeline = async (tx: Tx, workspaceId: string, id: string, mode: "update" | "share" = "update") => {
  const q = mode === "update" ? sql`FOR UPDATE` : sql`FOR SHARE`;
  const rows = await tx.execute(sql`SELECT id FROM pipelines WHERE workspace_id = ${workspaceId} AND id = ${id} ${q}`);
  return rows.rows.length > 0;
};

export function pipelineRoutes(db: Db) {
  const r = new Hono<ScopedEnv>();
  const mayManage = (c: SC) => can(c.get("role"), "schema.manage", {});
  const audit = (c: SC, tx: Tx, action: string, entityType: string, entityId: string, summary: Record<string, unknown>) => writeAudit(tx, { ...actor(c), workspaceId: c.get("workspaceId"), action, entityType, entityId, summary });
  const dupName = (c: SC) => fail(c, 409, "name_taken", "That name is already used.");

  r.get("/pipelines", async (c) => {
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (mayManage(c)) await ensureDefaultPipeline(tx, workspaceId); // older workspaces get the defaults on first visit by an admin
      const [ps, st, lr] = await Promise.all([
        tx.select().from(schema.pipelines).where(eq(schema.pipelines.workspaceId, workspaceId)).orderBy(asc(schema.pipelines.position), asc(schema.pipelines.id)),
        tx.select().from(schema.pipelineStages).where(eq(schema.pipelineStages.workspaceId, workspaceId)),
        tx.select().from(schema.lostReasons).where(eq(schema.lostReasons.workspaceId, workspaceId)).orderBy(asc(schema.lostReasons.position), asc(schema.lostReasons.id)),
      ]);
      return c.json({ pipelines: ps.map((p) => pipelineDto(p, st)), lostReasons: lr.map(reasonDto) });
    });
  });

  r.post("/pipelines", async (c) => {
    if (!mayManage(c)) return forbidden(c);
    const b = await body(c, CreatePipelineBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    try {
      return await withContext(db, wctx(c), async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pipelines-seed:${workspaceId}`}, 0))`);
        const n = ((await tx.execute(sql`SELECT coalesce(max(position), -1) + 1 AS n FROM pipelines WHERE workspace_id = ${workspaceId}`)).rows as { n: number }[])[0]!.n;
        if (b.data.isDefault) await tx.update(schema.pipelines).set({ isDefault: false, updatedAt: new Date() }).where(and(eq(schema.pipelines.workspaceId, workspaceId), eq(schema.pipelines.isDefault, true), isNull(schema.pipelines.archivedAt)));
        const [first] = await tx.select({ id: schema.pipelines.id }).from(schema.pipelines).where(and(eq(schema.pipelines.workspaceId, workspaceId), isNull(schema.pipelines.archivedAt))).limit(1);
        const [p] = await tx.insert(schema.pipelines).values({ workspaceId, name: b.data.name, kind: b.data.kind, defaultCurrency: b.data.defaultCurrency ?? "USD", isDefault: b.data.isDefault || !first, position: Number(n) }).returning();
        const open = b.data.kind === "sales" ? DEFAULT_PIPELINE_STAGES.slice(0, 3) : DEFAULT_PIPELINE_STAGES.slice(0, 2);
        await tx.insert(schema.pipelineStages).values([
          ...open.map((s, i) => ({ workspaceId, pipelineId: p!.id, name: s.name, kind: "open", defaultProbability: s.p, position: i })),
          { workspaceId, pipelineId: p!.id, name: "Won", kind: "won", defaultProbability: 100, position: open.length },
          { workspaceId, pipelineId: p!.id, name: "Lost", kind: "lost", defaultProbability: 0, position: open.length + 1 },
        ]);
        await audit(c, tx, "pipeline.created", "pipeline", p!.id, { name: p!.name, kind: p!.kind });
        return c.json(await loadPipelineDto(tx, workspaceId, p!.id), 201);
      });
    } catch (e) {
      if (pgCode(e) === "23505") return dupName(c);
      throw e;
    }
  });

  r.patch("/pipelines/:pipelineId", async (c) => {
    if (!mayManage(c)) return forbidden(c);
    const id = c.req.param("pipelineId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, UpdatePipelineBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    try {
      return await withContext(db, wctx(c), async (tx) => {
        if (!(await lockPipeline(tx, workspaceId, id))) return fail(c, 404, "not_found");
        const [p] = await tx.select().from(schema.pipelines).where(and(eq(schema.pipelines.workspaceId, workspaceId), eq(schema.pipelines.id, id)));
        if (p!.archivedAt) return fail(c, 409, "pipeline_archived", "This pipeline is archived.");
        if (p!.version !== b.data.expectedVersion) return fail(c, 409, "version_conflict", "This pipeline was changed by someone else.");
        if (b.data.isDefault) await tx.update(schema.pipelines).set({ isDefault: false }).where(and(eq(schema.pipelines.workspaceId, workspaceId), eq(schema.pipelines.isDefault, true), isNull(schema.pipelines.archivedAt)));
        await tx.update(schema.pipelines).set({ ...(b.data.name !== undefined ? { name: b.data.name } : {}), ...(b.data.defaultCurrency ? { defaultCurrency: b.data.defaultCurrency } : {}), ...(b.data.isDefault ? { isDefault: true } : {}), version: p!.version + 1, updatedAt: new Date() }).where(and(eq(schema.pipelines.workspaceId, workspaceId), eq(schema.pipelines.id, id)));
        await audit(c, tx, "pipeline.updated", "pipeline", id, { fields: Object.keys(b.data).filter((k) => k !== "expectedVersion") });
        return c.json(await loadPipelineDto(tx, workspaceId, id));
      });
    } catch (e) {
      if (pgCode(e) === "23505") return dupName(c);
      throw e;
    }
  });

  r.post("/pipelines/:pipelineId/archive", async (c) => {
    if (!mayManage(c)) return forbidden(c);
    const id = c.req.param("pipelineId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, ArchivePipelineBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (!(await lockPipeline(tx, workspaceId, id))) return fail(c, 404, "not_found");
      const [p] = await tx.select().from(schema.pipelines).where(and(eq(schema.pipelines.workspaceId, workspaceId), eq(schema.pipelines.id, id)));
      if (p!.archivedAt) return fail(c, 409, "pipeline_archived", "This pipeline is already archived.");
      if (p!.version !== b.data.expectedVersion) return fail(c, 409, "version_conflict", "This pipeline was changed by someone else.");
      if (p!.isDefault) return fail(c, 409, "pipeline_is_default", "Make another pipeline the default before archiving this one.");
      const [open] = (await tx.execute(sql`SELECT count(*)::int AS n FROM leads WHERE workspace_id = ${workspaceId} AND pipeline_id = ${id} AND outcome = 'open' AND deleted_at IS NULL`)).rows as { n: number }[];
      if (open!.n > 0) return fail(c, 409, "pipeline_not_empty", `${open!.n} open lead(s) are still in this pipeline. Move or close them first.`);
      await tx.update(schema.pipelines).set({ archivedAt: new Date(), version: p!.version + 1, updatedAt: new Date() }).where(and(eq(schema.pipelines.workspaceId, workspaceId), eq(schema.pipelines.id, id)));
      await audit(c, tx, "pipeline.archived", "pipeline", id, { name: p!.name });
      return c.json(await loadPipelineDto(tx, workspaceId, id));
    });
  });

  r.post("/pipelines/:pipelineId/stages", async (c) => {
    if (!mayManage(c)) return forbidden(c);
    const id = c.req.param("pipelineId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, CreatePipelineStageBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (!(await lockPipeline(tx, workspaceId, id))) return fail(c, 404, "not_found");
      const [p] = await tx.select().from(schema.pipelines).where(and(eq(schema.pipelines.workspaceId, workspaceId), eq(schema.pipelines.id, id)));
      if (p!.archivedAt) return fail(c, 409, "pipeline_archived", "This pipeline is archived.");
      const [m] = (await tx.execute(sql`SELECT coalesce(max(position), -1) + 1 AS n FROM pipeline_stages WHERE workspace_id = ${workspaceId} AND pipeline_id = ${id} AND kind = 'open'`)).rows as { n: number }[];
      const at = Number(m!.n);
      await tx.update(schema.pipelineStages).set({ position: sql`position + 1` }).where(and(eq(schema.pipelineStages.workspaceId, workspaceId), eq(schema.pipelineStages.pipelineId, id), gt(schema.pipelineStages.position, at - 1), sql`kind <> 'open'`));
      const [s] = await tx.insert(schema.pipelineStages).values({ workspaceId, pipelineId: id, name: b.data.name, kind: "open", defaultProbability: b.data.defaultProbability, position: at }).returning();
      await audit(c, tx, "pipeline.stage_created", "pipeline", id, { stageId: s!.id, name: s!.name });
      return c.json(stageDto(s!), 201);
    });
  });

  r.put("/pipelines/:pipelineId/stage-order", async (c) => {
    if (!mayManage(c)) return forbidden(c);
    const id = c.req.param("pipelineId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, ReorderPipelineStagesBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (!(await lockPipeline(tx, workspaceId, id))) return fail(c, 404, "not_found");
      const open = await tx.select().from(schema.pipelineStages).where(and(eq(schema.pipelineStages.workspaceId, workspaceId), eq(schema.pipelineStages.pipelineId, id), eq(schema.pipelineStages.kind, "open"), isNull(schema.pipelineStages.archivedAt)));
      const want = new Set(b.data.stageIds);
      if (want.size !== b.data.stageIds.length || want.size !== open.length || !open.every((s) => want.has(s.id))) return fail(c, 400, "invalid_body", "List every active open stage exactly once.");
      for (const [i, sid] of b.data.stageIds.entries()) await tx.update(schema.pipelineStages).set({ position: i }).where(and(eq(schema.pipelineStages.workspaceId, workspaceId), eq(schema.pipelineStages.id, sid)));
      // archived open stages and the terminal stages stay after the active ones
      await tx.execute(sql`UPDATE pipeline_stages SET position = position + ${open.length + 1000} WHERE workspace_id = ${workspaceId} AND pipeline_id = ${id} AND position < ${open.length + 1000} AND (kind <> 'open' OR archived_at IS NOT NULL)`);
      await tx.execute(sql`WITH r AS (SELECT id, ${open.length}::int + row_number() OVER (ORDER BY (kind = 'lost'), (kind = 'won') DESC, archived_at NULLS FIRST, position) - 1 AS np FROM pipeline_stages WHERE workspace_id = ${workspaceId} AND pipeline_id = ${id} AND (kind <> 'open' OR archived_at IS NOT NULL)) UPDATE pipeline_stages s SET position = r.np FROM r WHERE s.id = r.id AND s.workspace_id = ${workspaceId}`);
      await audit(c, tx, "pipeline.stages_reordered", "pipeline", id, {});
      return c.json(await loadPipelineDto(tx, workspaceId, id));
    });
  });

  r.patch("/stages/:stageId", async (c) => {
    if (!mayManage(c)) return forbidden(c);
    const id = c.req.param("stageId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, UpdatePipelineStageBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const [s] = await tx.select().from(schema.pipelineStages).where(and(eq(schema.pipelineStages.workspaceId, workspaceId), eq(schema.pipelineStages.id, id)));
      if (!s) return fail(c, 404, "not_found");
      if (b.data.defaultProbability !== undefined && s.kind !== "open") return fail(c, 400, "invalid_body", "Won and Lost stages have a fixed probability.");
      if (s.archivedAt) return fail(c, 409, "stage_archived", "This stage is archived.");
      const [u] = await tx.update(schema.pipelineStages).set({ ...(b.data.name !== undefined ? { name: b.data.name } : {}), ...(b.data.defaultProbability !== undefined ? { defaultProbability: b.data.defaultProbability } : {}) }).where(and(eq(schema.pipelineStages.workspaceId, workspaceId), eq(schema.pipelineStages.id, id))).returning();
      await audit(c, tx, "pipeline.stage_updated", "pipeline", s.pipelineId, { stageId: id, fields: Object.keys(b.data) });
      return c.json(stageDto(u!));
    });
  });

  r.post("/stages/:stageId/archive", async (c) => {
    if (!mayManage(c)) return forbidden(c);
    const id = c.req.param("stageId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, ArchivePipelineStageBody);
    if (!b.ok) return b.res;
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const [s0] = await tx.select().from(schema.pipelineStages).where(and(eq(schema.pipelineStages.workspaceId, workspaceId), eq(schema.pipelineStages.id, id)));
      if (!s0) return fail(c, 404, "not_found");
      if (!(await lockPipeline(tx, workspaceId, s0.pipelineId))) return fail(c, 404, "not_found");
      const [s] = await tx.select().from(schema.pipelineStages).where(and(eq(schema.pipelineStages.workspaceId, workspaceId), eq(schema.pipelineStages.id, id)));
      if (s!.kind !== "open") return fail(c, 409, "stage_terminal", "Won and Lost stages cannot be archived.");
      if (s!.archivedAt) return fail(c, 409, "stage_archived", "This stage is already archived.");
      const [t] = await tx.select().from(schema.pipelineStages).where(and(eq(schema.pipelineStages.workspaceId, workspaceId), eq(schema.pipelineStages.id, b.data.moveToStageId)));
      if (!t || t.pipelineId !== s!.pipelineId || t.kind !== "open" || t.archivedAt || t.id === s!.id) return fail(c, 400, "invalid_body", "Choose another active open stage of this pipeline to move its leads to.");
      const moved = await tx.execute(sql`INSERT INTO stage_transitions (workspace_id, lead_id, pipeline_id, from_stage_id, to_stage_id, from_outcome, to_outcome, actor_user_id)
        SELECT workspace_id, id, pipeline_id, stage_id, ${t.id}, 'open', 'open', ${userId} FROM leads WHERE workspace_id = ${workspaceId} AND stage_id = ${s!.id} AND outcome = 'open' AND deleted_at IS NULL`);
      await tx.execute(sql`UPDATE leads SET stage_id = ${t.id}, probability = CASE WHEN probability_manual THEN probability ELSE ${t.defaultProbability}::smallint END, version = version + 1, updated_at = now()
        WHERE workspace_id = ${workspaceId} AND stage_id = ${s!.id} AND outcome = 'open'`);
      const [u] = await tx.update(schema.pipelineStages).set({ archivedAt: new Date() }).where(and(eq(schema.pipelineStages.workspaceId, workspaceId), eq(schema.pipelineStages.id, id))).returning();
      await audit(c, tx, "pipeline.stage_archived", "pipeline", s!.pipelineId, { stageId: id, movedTo: t.id, movedLeads: moved.rowCount ?? 0 });
      return c.json(stageDto(u!));
    });
  });

  r.post("/lost-reasons", async (c) => {
    if (!mayManage(c)) return forbidden(c);
    const b = await body(c, CreateLostReasonBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const [m] = (await tx.execute(sql`SELECT coalesce(max(position), -1) + 1 AS n FROM lost_reasons WHERE workspace_id = ${workspaceId}`)).rows as { n: number }[];
      const [row] = await tx.insert(schema.lostReasons).values({ workspaceId, name: b.data.name, position: Number(m!.n) }).returning();
      await audit(c, tx, "lost_reason.created", "lost_reason", row!.id, { name: row!.name });
      return c.json(reasonDto(row!), 201);
    });
  });

  r.patch("/lost-reasons/:lostReasonId", async (c) => {
    if (!mayManage(c)) return forbidden(c);
    const id = c.req.param("lostReasonId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, UpdateLostReasonBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const [row] = await tx.update(schema.lostReasons).set({ ...(b.data.name !== undefined ? { name: b.data.name } : {}), ...(b.data.archived !== undefined ? { archivedAt: b.data.archived ? new Date() : null } : {}) }).where(and(eq(schema.lostReasons.workspaceId, workspaceId), eq(schema.lostReasons.id, id))).returning();
      if (!row) return fail(c, 404, "not_found");
      await audit(c, tx, "lost_reason.updated", "lost_reason", id, { fields: Object.keys(b.data) });
      return c.json(reasonDto(row));
    });
  });

  return r;
}
