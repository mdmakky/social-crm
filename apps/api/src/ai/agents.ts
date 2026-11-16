import { Hono } from "hono";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ActivateAgentBody, AgentActionsQuery, AgentRunBody, AgentRunsQuery, AgentTestBody, CreateAgentBody, CreateAgentVersionBody, MAX_ACTIVE_AGENTS, MAX_AGENTS, UpdateAgentBody, type AgentActionDto, type AgentDto, type AgentRunResult, type AgentVersionDto } from "@crm/contracts";
import { fenceData, getTool, providerDef, type ToolRegistry } from "@crm/ai";
import { can } from "@crm/core/permissions";
import { schema, withContext, type Db, type Tx } from "@crm/db";
import { writeAudit } from "../audit.ts";
import { killSwitchOn } from "../automation/kill-switch.ts";
import { actor, body, fail, forbidden, isUuid, query, wctx, type SC, type ScopedEnv } from "../routes/scope.ts";
import { WindowCounter } from "../throttle.ts";
import { applyPlan, contactContext, conversationContext, executeTool, prepareAgentRun, type AgentDeps } from "./agent-run.ts";
import type { AiDeps } from "./run.ts";
import { TOOLS, type ToolCtx } from "./tools/index.ts";

export type AgentRouteDeps = { ai?: AiDeps; runsPerUser?: number; tools?: ToolRegistry<ToolCtx> };
type AgentRow = typeof schema.aiAgents.$inferSelect;
type VersionRow = typeof schema.aiAgentVersions.$inferSelect;
const uniqueViolation = (e: unknown) => (e as { cause?: { code?: string } })?.cause?.code === "23505";

const versionDto = (v: VersionRow): AgentVersionDto => ({
  id: v.id, version: v.version, instructions: v.instructions, personality: v.personality, language: v.language, responseStyle: v.responseStyle, provider: v.provider, model: v.model,
  temperature: v.temperature, maxOutputTokens: v.maxOutputTokens, toolGrants: v.toolGrants as AgentVersionDto["toolGrants"], createdAt: v.createdAt.toISOString(), createdBy: v.createdBy,
});
const agentDto = (a: AgentRow, versions: VersionRow[], withVersions: boolean): AgentDto => ({
  id: a.id, key: a.key, name: a.name, description: a.description, status: a.status as AgentDto["status"], activeVersionId: a.activeVersionId,
  activeVersion: versions.find((v) => v.id === a.activeVersionId)?.version ?? null, latestVersion: versions.reduce((m, v) => Math.max(m, v.version), 0),
  createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(), versions: withVersions ? [...versions].sort((x, y) => y.version - x.version).map(versionDto) : [],
});
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36).replace(/^[^a-z]+/, "") || "agent";

/**
 * AI agent builder. owner/admin (ai.configure) manage agents, versions, approvals and see runs; members with ai.use run test/run on ACTIVE agents.
 * Every model call goes through runAi (budget hard stop, run log). Replies are drafts: nothing here sends a message.
 */
export function agentRoutes(db: Db, deps: AgentRouteDeps = {}) {
  const r = new Hono<ScopedEnv>();
  const tools = deps.tools ?? TOOLS;
  const runs = new WindowCounter(deps.runsPerUser ?? 20, 60_000);
  const manage = (c: SC) => can(c.get("role"), "ai.configure", {});
  const audit = (c: SC, tx: Tx, action: string, id: string, summary: Record<string, unknown> = {}) => writeAudit(tx, { ...actor(c), workspaceId: c.get("workspaceId"), action, entityType: "ai_agent", entityId: id, summary });

  const versionsOf = (tx: Tx, workspaceId: string, ids: string[]) => ids.length ? tx.select().from(schema.aiAgentVersions).where(and(eq(schema.aiAgentVersions.workspaceId, workspaceId), inArray(schema.aiAgentVersions.agentId, ids))) : Promise.resolve([] as VersionRow[]);
  const detail = async (tx: Tx, workspaceId: string, id: string) => {
    const [a] = await tx.select().from(schema.aiAgents).where(and(eq(schema.aiAgents.workspaceId, workspaceId), eq(schema.aiAgents.id, id)));
    return a ? agentDto(a, await versionsOf(tx, workspaceId, [id]), true) : null;
  };
  const checkGrants = (c: SC, d: { toolGrants: { tool: string }[]; provider: string | null }) => {
    const bad = d.toolGrants.find((g) => !getTool(tools, g.tool));
    if (bad) return fail(c, 400, "unknown_tool", `Unknown tool ${bad.tool}.`);
    if (d.provider && !providerDef(d.provider)) return fail(c, 400, "unknown_provider", "Unknown provider.");
    return null;
  };
  const defValues = (d: ReturnType<typeof CreateAgentVersionBody.parse>) => ({ instructions: d.instructions, personality: d.personality, language: d.language, responseStyle: d.responseStyle, provider: d.provider, model: d.model, temperature: d.temperature, maxOutputTokens: d.maxOutputTokens, toolGrants: d.toolGrants });

  r.get("/ai/tools", (c) => manage(c) ? c.json({ items: Object.values(tools).map((t) => ({ name: t.name, description: t.description, sensitivity: t.sensitivity, requiredPermission: t.requiredPermission })) }) : forbidden(c));

  r.get("/ai/agents", async (c) => {
    if (!manage(c)) return forbidden(c);
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const agents = await tx.select().from(schema.aiAgents).where(eq(schema.aiAgents.workspaceId, workspaceId)).orderBy(desc(schema.aiAgents.id));
      const vs = await versionsOf(tx, workspaceId, agents.map((a) => a.id));
      return c.json({ items: agents.map((a) => agentDto(a, vs.filter((v) => v.agentId === a.id), true)), activeCount: agents.filter((a) => a.status === "active").length, maxActive: MAX_ACTIVE_AGENTS });
    });
  });

  r.post("/ai/agents", async (c) => {
    if (!manage(c)) return forbidden(c);
    const b = await body(c, CreateAgentBody);
    if (!b.ok) return b.res;
    const bad = checkGrants(c, b.data);
    if (bad) return bad;
    const { workspaceId, userId } = wctx(c);
    try {
      return await withContext(db, wctx(c), async (tx) => {
        const existing = await tx.select({ key: schema.aiAgents.key }).from(schema.aiAgents).where(eq(schema.aiAgents.workspaceId, workspaceId));
        if (existing.length >= MAX_AGENTS) return fail(c, 409, "agent_limit", `A workspace can have at most ${MAX_AGENTS} agents. Archive or reuse an existing one.`);
        const base = slug(b.data.name);
        const keys = new Set(existing.map((e) => e.key));
        let key = base;
        for (let i = 2; keys.has(key); i++) key = `${base}-${i}`;
        const [a] = await tx.insert(schema.aiAgents).values({ workspaceId, key, name: b.data.name, description: b.data.description ?? "", createdBy: userId }).returning();
        await tx.insert(schema.aiAgentVersions).values({ workspaceId, agentId: a!.id, version: 1, ...defValues(b.data), createdBy: userId });
        await audit(c, tx, "ai.agent.created", a!.id, { key });
        return c.json((await detail(tx, workspaceId, a!.id))!, 201);
      });
    } catch (e) {
      if (uniqueViolation(e)) return fail(c, 409, "busy", "Someone else just created an agent. Try again.");
      throw e;
    }
  });

  r.get("/ai/agents/:agentId", async (c) => {
    if (!manage(c)) return forbidden(c);
    const id = c.req.param("agentId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const dto = await withContext(db, wctx(c), (tx) => detail(tx, c.get("workspaceId"), id));
    return dto ? c.json(dto) : fail(c, 404, "not_found");
  });

  r.patch("/ai/agents/:agentId", async (c) => {
    if (!manage(c)) return forbidden(c);
    const id = c.req.param("agentId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, UpdateAgentBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const [row] = await tx.update(schema.aiAgents).set({ ...(b.data.name !== undefined && { name: b.data.name }), ...(b.data.description !== undefined && { description: b.data.description }), updatedAt: new Date() }).where(and(eq(schema.aiAgents.workspaceId, workspaceId), eq(schema.aiAgents.id, id))).returning({ id: schema.aiAgents.id });
      if (!row) return fail(c, 404, "not_found");
      await audit(c, tx, "ai.agent.updated", id, { fields: Object.keys(b.data) });
      return c.json((await detail(tx, workspaceId, id))!);
    });
  });

  r.post("/ai/agents/:agentId/versions", async (c) => {
    if (!manage(c)) return forbidden(c);
    const id = c.req.param("agentId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, CreateAgentVersionBody);
    if (!b.ok) return b.res;
    const bad = checkGrants(c, b.data);
    if (bad) return bad;
    const { workspaceId, userId } = wctx(c);
    try {
      return await withContext(db, wctx(c), async (tx) => {
        const [a] = await tx.select({ id: schema.aiAgents.id }).from(schema.aiAgents).where(and(eq(schema.aiAgents.workspaceId, workspaceId), eq(schema.aiAgents.id, id)));
        if (!a) return fail(c, 404, "not_found");
        const [last] = await tx.select({ v: sql<number>`coalesce(max(${schema.aiAgentVersions.version}), 0)::int` }).from(schema.aiAgentVersions).where(and(eq(schema.aiAgentVersions.workspaceId, workspaceId), eq(schema.aiAgentVersions.agentId, id)));
        const version = (last?.v ?? 0) + 1;
        await tx.insert(schema.aiAgentVersions).values({ workspaceId, agentId: id, version, ...defValues(b.data), createdBy: userId });
        await tx.update(schema.aiAgents).set({ updatedAt: new Date() }).where(and(eq(schema.aiAgents.workspaceId, workspaceId), eq(schema.aiAgents.id, id)));
        await audit(c, tx, "ai.agent.version_created", id, { version });
        return c.json((await detail(tx, workspaceId, id))!, 201);
      });
    } catch (e) {
      if (uniqueViolation(e)) return fail(c, 409, "busy", "Someone else just saved a version. Reload and try again.");
      throw e;
    }
  });

  /** Activate the newest version, or an older one (rollback). Versions are never modified: only the pointer moves. */
  r.post("/ai/agents/:agentId/activate", async (c) => {
    if (!manage(c)) return forbidden(c);
    const id = c.req.param("agentId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, ActivateAgentBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ai-agents:${workspaceId}`}, 0))`); // two activations must not both pass the cap
      const [a] = await tx.select().from(schema.aiAgents).where(and(eq(schema.aiAgents.workspaceId, workspaceId), eq(schema.aiAgents.id, id)));
      if (!a) return fail(c, 404, "not_found");
      const vs = await versionsOf(tx, workspaceId, [id]);
      const target = b.data.versionId ? vs.find((v) => v.id === b.data.versionId) : [...vs].sort((x, y) => y.version - x.version)[0];
      if (!target) return fail(c, 404, "not_found");
      if (a.status !== "active") {
        const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.aiAgents).where(and(eq(schema.aiAgents.workspaceId, workspaceId), eq(schema.aiAgents.status, "active")));
        if ((n?.n ?? 0) >= MAX_ACTIVE_AGENTS) return fail(c, 409, "active_agent_limit", `At most ${MAX_ACTIVE_AGENTS} agents can be active. Archive one first.`);
      }
      await tx.update(schema.aiAgents).set({ status: "active", activeVersionId: target.id, updatedAt: new Date() }).where(and(eq(schema.aiAgents.workspaceId, workspaceId), eq(schema.aiAgents.id, id)));
      await audit(c, tx, "ai.agent.activated", id, { version: target.version, rollback: !!a.activeVersionId && vs.find((v) => v.id === a.activeVersionId)!.version > target.version });
      return c.json((await detail(tx, workspaceId, id))!);
    });
  });

  r.post("/ai/agents/:agentId/archive", async (c) => {
    if (!manage(c)) return forbidden(c);
    const id = c.req.param("agentId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const [row] = await tx.update(schema.aiAgents).set({ status: "archived", updatedAt: new Date() }).where(and(eq(schema.aiAgents.workspaceId, workspaceId), eq(schema.aiAgents.id, id))).returning({ id: schema.aiAgents.id });
      if (!row) return fail(c, 404, "not_found");
      await audit(c, tx, "ai.agent.archived", id);
      return c.json((await detail(tx, workspaceId, id))!);
    });
  });

  // ----- test and run -----
  const failure = (c: SC, code: string) => {
    switch (code) {
      case "not_found": return fail(c, 404, "not_found");
      case "inactive": return fail(c, 409, "agent_inactive", "This agent is not active.");
      case "kill_switch_on": return fail(c, 409, "kill_switch_on", "Automations are paused for this workspace, so agents cannot make changes. Turn the kill switch off in Settings, Automations.");
      case "not_configured": return fail(c, 409, "ai_not_configured", "No AI provider (or model) is set up for this agent. An owner or admin can add one in Settings, AI.");
      case "budget_exceeded": return fail(c, 409, "budget_exceeded", "The monthly AI budget is used up. An owner or admin can raise it in Settings, AI.");
      case "rate_limit": return fail(c, 429, "ai_busy", "The AI provider is busy. Try again in a moment.");
      case "auth": case "key_unavailable": return fail(c, 502, "ai_key_rejected", "The AI provider key was rejected or cannot be read. An owner or admin should check it in Settings, AI.");
      default: return fail(c, 502, "ai_unavailable", "The agent could not answer. Try again.");
    }
  };
  const agentDeps = (): AgentDeps => ({ db, ai: deps.ai!, tools });

  async function execute(c: SC, o: { source: "test" | "run"; dryRun: boolean; content: (tx: Tx) => Promise<{ text: string; contactId: string | null; conversationId: string | null } | "not_found" | "no_customer_message">; versionId?: string }) {
    if (!can(c.get("role"), "ai.use", {})) return forbidden(c);
    const agentId = c.req.param("agentId");
    if (!isUuid(agentId)) return fail(c, 404, "not_found");
    if (!deps.ai) return fail(c, 503, "ai_not_configured", "AI is not configured on this server.");
    if (!runs.allow(`${c.get("workspaceId")}:${c.get("userId")}`)) { c.header("Retry-After", "60"); return fail(c, 429, "rate_limited", "Too many agent runs. Try again in a minute."); }
    const { workspaceId, userId } = wctx(c);
    const ctx = await withContext(db, wctx(c), o.content);
    if (ctx === "not_found") return fail(c, 404, "not_found");
    if (ctx === "no_customer_message") return fail(c, 422, "no_customer_message", "There is no customer message to reply to yet.");
    const canManage = manage(c);
    const prep = await prepareAgentRun(agentDeps(), { workspaceId, userId, agentId, versionId: canManage ? o.versionId : undefined, requireActive: !canManage || o.source === "run", live: !o.dryRun, userContent: ctx.text, entity: ctx.conversationId ? { type: "conversation", id: ctx.conversationId } : ctx.contactId ? { type: "contact", id: ctx.contactId } : undefined });
    if (!prep.ok) return failure(c, prep.code);
    const out: AgentRunResult = await withContext(db, wctx(c), (tx) => applyPlan(tx, agentDeps(), prep, { workspaceId, userId, role: c.get("role"), source: o.source, dryRun: o.dryRun, contactId: ctx.contactId, conversationId: ctx.conversationId, ...actor(c) }));
    return c.json(out);
  }

  r.post("/ai/agents/:agentId/test", async (c) => {
    const b = await body(c, AgentTestBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return execute(c, {
      source: "test", dryRun: b.data.dryRun ?? true, versionId: b.data.versionId,
      content: async (tx) => {
        let ctxText = "", contactId: string | null = null, conversationId: string | null = null;
        if (b.data.conversationId) {
          const cv = await conversationContext(tx, workspaceId, b.data.conversationId);
          if (!cv) return "not_found";
          ctxText = cv.text + "\n"; contactId = cv.contactId; conversationId = b.data.conversationId;
        } else if (b.data.contactId) {
          const t = await contactContext(tx, workspaceId, b.data.contactId);
          if (!t) return "not_found";
          ctxText = t + "\n"; contactId = b.data.contactId;
        }
        return { text: ctxText + fenceData("Customer message", b.data.input), contactId, conversationId };
      },
    });
  });

  /** A real run on a conversation: a draft reply plus actions per the grants. Still sends nothing. */
  r.post("/ai/agents/:agentId/run", async (c) => {
    const b = await body(c, AgentRunBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return execute(c, {
      source: "run", dryRun: false,
      content: async (tx) => {
        const cv = await conversationContext(tx, workspaceId, b.data.conversationId);
        if (!cv) return "not_found";
        if (!cv.hasCustomerMessage) return "no_customer_message";
        return { text: cv.text, contactId: cv.contactId, conversationId: b.data.conversationId };
      },
    });
  });

  r.get("/ai/agents/:agentId/runs", async (c) => {
    if (!manage(c)) return forbidden(c);
    const id = c.req.param("agentId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const q = query(c, AgentRunsQuery);
    if (!q.ok) return q.res;
    const { workspaceId } = wctx(c);
    const rows = await withContext(db, wctx(c), (tx) => tx.select().from(schema.aiRuns).where(and(eq(schema.aiRuns.workspaceId, workspaceId), eq(schema.aiRuns.agentId, id))).orderBy(desc(schema.aiRuns.id)).limit(q.data.limit ?? 25));
    return c.json({ items: rows.map((x) => ({ id: x.id, createdAt: x.createdAt.toISOString(), status: x.status as "ok" | "error" | "blocked_budget", agentVersion: x.agentVersion ?? 0, provider: x.provider, model: x.model, inputTokens: x.inputTokens, outputTokens: x.outputTokens, costMicro: x.costMicro, latencyMs: x.latencyMs, errorCode: x.errorCode })) });
  });

  // ----- approvals -----
  const actionDtos = async (tx: Tx, workspaceId: string, where: ReturnType<typeof and>, limit: number): Promise<AgentActionDto[]> => {
    const rows = await tx.select({ a: schema.aiAgentActions, name: schema.aiAgents.name, version: schema.aiAgentVersions.version }).from(schema.aiAgentActions)
      .innerJoin(schema.aiAgents, and(eq(schema.aiAgents.workspaceId, schema.aiAgentActions.workspaceId), eq(schema.aiAgents.id, schema.aiAgentActions.agentId)))
      .innerJoin(schema.aiAgentVersions, and(eq(schema.aiAgentVersions.workspaceId, schema.aiAgentActions.workspaceId), eq(schema.aiAgentVersions.id, schema.aiAgentActions.agentVersionId)))
      .where(and(eq(schema.aiAgentActions.workspaceId, workspaceId), where)).orderBy(desc(schema.aiAgentActions.id)).limit(limit);
    return rows.map(({ a, name, version }) => ({
      id: a.id, agentId: a.agentId, agentName: name, agentVersion: version, tool: a.tool, args: a.args as Record<string, unknown>, reason: a.reason as AgentActionDto["reason"], status: a.status as AgentActionDto["status"], source: a.source as AgentActionDto["source"],
      contactId: a.contactId, requestedBy: a.requestedBy, decidedBy: a.decidedBy, result: (a.result as Record<string, unknown> | null) ?? null, error: a.error, createdAt: a.createdAt.toISOString(), decidedAt: a.decidedAt?.toISOString() ?? null,
    }));
  };

  r.get("/ai/agent-actions", async (c) => {
    if (!manage(c)) return forbidden(c);
    const q = query(c, AgentActionsQuery);
    if (!q.ok) return q.res;
    const { workspaceId } = wctx(c);
    return c.json({ items: await withContext(db, wctx(c), (tx) => actionDtos(tx, workspaceId, q.data.status ? eq(schema.aiAgentActions.status, q.data.status) : undefined, q.data.limit ?? 50)) });
  });

  /**
   * Approve executes the stored call ONCE: the pending -> approved claim is a conditional UPDATE, so a second approve (or a race) finds nothing to claim.
   * The tool runs in a savepoint as the approver (RLS applies); success records executed, failure records failed and undoes only that tool's writes.
   */
  async function decide(c: SC, approve: boolean) {
    if (!can(c.get("role"), "approval.decide", {})) return forbidden(c);
    const id = c.req.param("actionId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (approve && (await killSwitchOn(tx, workspaceId))) return fail(c, 409, "kill_switch_on", "Automations are paused for this workspace. Turn the kill switch off to approve actions.");
      const now = new Date();
      const [row] = await tx.update(schema.aiAgentActions).set({ status: approve ? "approved" : "rejected", decidedBy: userId, decidedAt: now, updatedAt: now }).where(and(eq(schema.aiAgentActions.workspaceId, workspaceId), eq(schema.aiAgentActions.id, id), eq(schema.aiAgentActions.status, "pending"))).returning();
      if (!row) {
        const [cur] = await tx.select({ status: schema.aiAgentActions.status }).from(schema.aiAgentActions).where(and(eq(schema.aiAgentActions.workspaceId, workspaceId), eq(schema.aiAgentActions.id, id)));
        return cur ? fail(c, 409, "not_pending", `This action is already ${cur.status}.`) : fail(c, 404, "not_found");
      }
      let summary: Record<string, unknown> = { tool: row.tool, agentId: row.agentId };
      if (approve) {
        const def = getTool(tools, row.tool);
        let res: { ok: true; result: Record<string, unknown> } | { ok: false; error: string };
        if (def && !can(c.get("role"), def.requiredPermission as "contact.edit", {})) res = { ok: false, error: "You don't have permission to run this tool." };
        else res = await executeTool(tx, tools, { db, workspaceId, userId, contactId: row.contactId, ref: row.id }, row.tool, row.args as Record<string, unknown>);
        await tx.update(schema.aiAgentActions).set(res.ok ? { status: "executed", result: res.result, updatedAt: new Date() } : { status: "failed", error: res.error, updatedAt: new Date() }).where(and(eq(schema.aiAgentActions.workspaceId, workspaceId), eq(schema.aiAgentActions.id, id)));
        summary = { ...summary, outcome: res.ok ? "executed" : "failed" };
      }
      await writeAudit(tx, { ...actor(c), workspaceId, action: approve ? "ai.agent.action_approved" : "ai.agent.action_rejected", entityType: "ai_agent_action", entityId: id, summary });
      return c.json((await actionDtos(tx, workspaceId, eq(schema.aiAgentActions.id, id), 1))[0]!);
    });
  }
  r.post("/ai/agent-actions/:actionId/approve", (c) => decide(c, true));
  r.post("/ai/agent-actions/:actionId/reject", (c) => decide(c, false));

  return r;
}