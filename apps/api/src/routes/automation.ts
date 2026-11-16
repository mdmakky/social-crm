import { Hono } from "hono";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { AutomationSettingsDto, CreateAutomationRuleBody, AutomationRunsQuery, UpdateAutomationRuleBody, type AutomationRunDto } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { schema, withContext, type Db, type Tx } from "@crm/db";
import { writeAudit } from "../audit.ts";
import { killSwitchOn } from "../automation/engine.ts";
import { actor, body, fail, forbidden, isUuid, query, wctx, type SC, type ScopedEnv } from "./scope.ts";

type RuleRow = typeof schema.automationRules.$inferSelect;
type RunRow = typeof schema.automationRuns.$inferSelect;
type StepRow = typeof schema.automationRunSteps.$inferSelect;

const ruleDto = (r: RuleRow) => ({ id: r.id, name: r.name, triggerType: r.triggerType, conditions: r.conditions, actions: r.actions, enabled: r.enabled, requiresApproval: r.requiresApproval, version: r.version, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() });
const runDto = (r: RunRow, ruleName: string, steps: StepRow[]) => ({
  id: r.id, ruleId: r.ruleId, ruleName, ruleVersion: r.ruleVersion, triggerType: r.triggerType, entityType: r.entityType, entityId: r.entityId, actions: r.actions, status: r.status, attempts: r.attempts,
  nextAttemptAt: r.status === "pending" ? r.nextAttemptAt.toISOString() : null, error: r.error, approvedBy: r.approvedBy, createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
  steps: steps.map((s) => ({ id: s.id, attempt: s.attempt, idx: s.idx, actionType: s.actionType, status: s.status, detail: s.detail as Record<string, unknown>, error: s.error, createdAt: s.createdAt.toISOString() })),
}) as AutomationRunDto;

/** Rules, runs, approvals and the kill switch. Everything here is owner/admin only (`workflow.manage` / `approval.decide`). */
export function automationRoutes(db: Db) {
  const r = new Hono<ScopedEnv>();
  const manage = (c: SC) => can(c.get("role"), "workflow.manage", {});
  const audit = (c: SC, tx: Tx, action: string, entityType: string, id: string, summary: Record<string, unknown> = {}) => writeAudit(tx, { ...actor(c), workspaceId: c.get("workspaceId"), action, entityType, entityId: id, summary });

  async function loadRuns(tx: Tx, workspaceId: string, where: ReturnType<typeof and>, limit: number) {
    const rows = await tx
      .select({ run: schema.automationRuns, ruleName: schema.automationRules.name })
      .from(schema.automationRuns)
      .innerJoin(schema.automationRules, and(eq(schema.automationRules.workspaceId, schema.automationRuns.workspaceId), eq(schema.automationRules.id, schema.automationRuns.ruleId)))
      .where(where)
      .orderBy(desc(schema.automationRuns.id))
      .limit(limit);
    const ids = rows.map((x) => x.run.id);
    const steps = ids.length ? await tx.select().from(schema.automationRunSteps).where(and(eq(schema.automationRunSteps.workspaceId, workspaceId), inArray(schema.automationRunSteps.runId, ids))).orderBy(asc(schema.automationRunSteps.id)) : [];
    return rows.map((x) => runDto(x.run, x.ruleName, steps.filter((s) => s.runId === x.run.id)));
  }

  // ----- rules -----
  r.get("/automations/rules", async (c) => {
    if (!manage(c)) return forbidden(c);
    return withContext(db, wctx(c), async (tx) => c.json((await tx.select().from(schema.automationRules).where(and(eq(schema.automationRules.workspaceId, c.get("workspaceId")), isNull(schema.automationRules.deletedAt))).orderBy(desc(schema.automationRules.id))).map(ruleDto)));
  });

  r.post("/automations/rules", async (c) => {
    if (!manage(c)) return forbidden(c);
    const b = await body(c, CreateAutomationRuleBody);
    if (!b.ok) return b.res;
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const [row] = await tx.insert(schema.automationRules).values({ workspaceId, name: b.data.name, triggerType: b.data.triggerType, conditions: b.data.conditions ?? { op: "and", conditions: [] }, actions: b.data.actions, enabled: b.data.enabled ?? false, requiresApproval: b.data.requiresApproval ?? true, createdBy: userId }).returning();
      await audit(c, tx, "automation.rule_created", "automation_rule", row!.id, { name: row!.name, triggerType: row!.triggerType, enabled: row!.enabled, requiresApproval: row!.requiresApproval });
      return c.json(ruleDto(row!), 201);
    });
  });

  r.patch("/automations/rules/:ruleId", async (c) => {
    if (!manage(c)) return forbidden(c);
    const id = c.req.param("ruleId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, UpdateAutomationRuleBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    const d = b.data;
    return withContext(db, wctx(c), async (tx) => {
      // A change to what the rule does bumps the version; a plain enable/disable does not. Runs already created keep their own snapshot.
      const material = d.name !== undefined || d.triggerType !== undefined || d.conditions !== undefined || d.actions !== undefined || d.requiresApproval !== undefined;
      const [row] = await tx
        .update(schema.automationRules)
        .set({ ...(d.name !== undefined && { name: d.name }), ...(d.triggerType !== undefined && { triggerType: d.triggerType }), ...(d.conditions !== undefined && { conditions: d.conditions }), ...(d.actions !== undefined && { actions: d.actions }), ...(d.enabled !== undefined && { enabled: d.enabled }), ...(d.requiresApproval !== undefined && { requiresApproval: d.requiresApproval }), ...(material && { version: sql`${schema.automationRules.version} + 1` }), updatedAt: new Date() })
        .where(and(eq(schema.automationRules.workspaceId, workspaceId), eq(schema.automationRules.id, id), isNull(schema.automationRules.deletedAt)))
        .returning();
      if (!row) return fail(c, 404, "not_found");
      await audit(c, tx, "automation.rule_updated", "automation_rule", id, { fields: Object.keys(d) });
      return c.json(ruleDto(row));
    });
  });

  r.delete("/automations/rules/:ruleId", async (c) => {
    if (!manage(c)) return forbidden(c);
    const id = c.req.param("ruleId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const [row] = await tx.update(schema.automationRules).set({ deletedAt: new Date(), enabled: false, updatedAt: new Date() }).where(and(eq(schema.automationRules.workspaceId, workspaceId), eq(schema.automationRules.id, id), isNull(schema.automationRules.deletedAt))).returning({ id: schema.automationRules.id });
      if (!row) return fail(c, 404, "not_found");
      await audit(c, tx, "automation.rule_deleted", "automation_rule", id);
      return c.body(null, 204);
    });
  });

  // ----- runs and approvals -----
  r.get("/automations/runs", async (c) => {
    if (!manage(c)) return forbidden(c);
    const q = query(c, AutomationRunsQuery);
    if (!q.ok) return q.res;
    const { workspaceId } = wctx(c);
    const limit = q.data.limit ?? 25;
    return withContext(db, wctx(c), async (tx) => {
      const items = await loadRuns(tx, workspaceId, and(eq(schema.automationRuns.workspaceId, workspaceId), q.data.status ? eq(schema.automationRuns.status, q.data.status) : undefined, q.data.cursor ? lt(schema.automationRuns.id, q.data.cursor) : undefined), limit + 1);
      const page = items.slice(0, limit);
      return c.json({ items: page, nextCursor: items.length > limit ? page[page.length - 1]!.id : null });
    });
  });

  async function decide(c: SC, approve: boolean) {
    if (!can(c.get("role"), "approval.decide", {})) return forbidden(c);
    const id = c.req.param("runId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (approve && (await killSwitchOn(tx, workspaceId))) return fail(c, 409, "kill_switch_on", "Automations are paused for this workspace. Turn the kill switch off to approve runs.");
      const now = new Date();
      const [row] = await tx
        .update(schema.automationRuns)
        .set(approve ? { status: "pending", approvedBy: userId, decidedAt: now, nextAttemptAt: now, updatedAt: now } : { status: "cancelled", approvedBy: userId, decidedAt: now, error: "Rejected", finishedAt: now, updatedAt: now })
        .where(and(eq(schema.automationRuns.workspaceId, workspaceId), eq(schema.automationRuns.id, id), eq(schema.automationRuns.status, "awaiting_approval")))
        .returning();
      if (!row) {
        const [cur] = await tx.select({ status: schema.automationRuns.status }).from(schema.automationRuns).where(and(eq(schema.automationRuns.workspaceId, workspaceId), eq(schema.automationRuns.id, id)));
        return cur ? fail(c, 409, "not_awaiting_approval", `This run is already ${cur.status.replace("_", " ")}.`) : fail(c, 404, "not_found");
      }
      await audit(c, tx, approve ? "automation.run_approved" : "automation.run_rejected", "automation_run", id, { ruleId: row.ruleId });
      const [dto] = await loadRuns(tx, workspaceId, and(eq(schema.automationRuns.workspaceId, workspaceId), eq(schema.automationRuns.id, id)), 1);
      return c.json(dto);
    });
  }
  r.post("/automations/runs/:runId/approve", (c) => decide(c, true));
  r.post("/automations/runs/:runId/reject", (c) => decide(c, false));

  // ----- kill switch -----
  r.get("/automations/settings", async (c) => {
    if (!manage(c)) return forbidden(c);
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => c.json({ killSwitch: await killSwitchOn(tx, workspaceId) }));
  });

  r.put("/automations/settings", async (c) => {
    if (!manage(c)) return forbidden(c);
    const b = await body(c, AutomationSettingsDto);
    if (!b.ok) return b.res;
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      await tx.insert(schema.automationSettings).values({ workspaceId, killSwitch: b.data.killSwitch, updatedBy: userId }).onConflictDoUpdate({ target: schema.automationSettings.workspaceId, set: { killSwitch: b.data.killSwitch, updatedBy: userId, updatedAt: new Date() } });
      await audit(c, tx, "automation.kill_switch", "workspace", workspaceId, { killSwitch: b.data.killSwitch });
      return c.json({ killSwitch: b.data.killSwitch });
    });
  });

  return r;
}
