import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { AutomationAction, AUTOMATION_TRIGGERS } from "@crm/contracts";
import { evaluateCondition, MAX_RUN_ATTEMPTS, retryDelayMs, type Condition } from "@crm/core";
import { schema, withContext, type Db, type Tx } from "@crm/db";
import { withSystem, type Consumer, type EventRow } from "../events.ts";
import { prepareForAutomation, type AgentDeps, type Prepared, type PrepareFailure } from "../ai/agent-run.ts";
import { PermanentError, runAction } from "./actions.ts";
import { killSwitchOn } from "./kill-switch.ts";

export { killSwitchOn };

/**
 * Trigger side: turns a domain event into runs. Idempotent: the unique (workspace, rule, idempotency key) makes a replayed event a no-op,
 * so the dispatcher's at-least-once delivery yields exactly one run per rule and event. Honours the kill switch (no runs are created).
 * Conditions are evaluated against { type, entityType, entityId, actorUserId, ...payload }.
 */
export const automationConsumer: Consumer = {
  name: "automation",
  async handle(tx: Tx, ev: EventRow) {
    if (!(ev.type in AUTOMATION_TRIGGERS)) return;
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    if (payload.viaAutomation) return; // loop guard: events produced by an automation never trigger one
    if (await killSwitchOn(tx, ev.workspaceId)) return;
    const rules = await tx.select().from(schema.automationRules).where(and(eq(schema.automationRules.workspaceId, ev.workspaceId), eq(schema.automationRules.triggerType, ev.type), eq(schema.automationRules.enabled, true), isNull(schema.automationRules.deletedAt)));
    const context: Record<string, unknown> = { ...payload, type: ev.type, entityType: ev.entityType, entityId: ev.entityId, actorUserId: ev.actorUserId };
    context.contactId = ev.entityType === "contact" ? ev.entityId : typeof payload.contactId === "string" ? payload.contactId : null;
    for (const rule of rules) {
      if (!evaluateCondition(rule.conditions as Condition, context)) continue;
      await tx
        .insert(schema.automationRuns)
        .values({ workspaceId: ev.workspaceId, ruleId: rule.id, ruleVersion: rule.version, triggerEventId: ev.id, idempotencyKey: `event:${ev.id}`, triggerType: ev.type, entityType: ev.entityType, entityId: ev.entityId, actions: rule.actions, context, status: rule.requiresApproval ? "awaiting_approval" : "pending" })
        .onConflictDoNothing();
    }
  },
};

class StepError extends Error {
  constructor(readonly idx: number, readonly actionType: string, readonly permanent: boolean, message: string) { super(message); }
}
const clip = (s: string) => s.slice(0, 900);
/** drizzle wraps driver errors ("Failed query: ... params: ..."); the cause is the readable part and carries no row values. */
const errText = (e: unknown) => clip(e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e instanceof PermanentError ? e.message : e.cause === undefined ? e.message : "Database error") : String(e));

export type ExecuteResult = "none" | "killed" | "succeeded" | "retry" | "failed" | "skipped";

/**
 * Executes the oldest due pending run of a workspace. Actions run in ONE transaction as the approving member (or the rule's author for
 * auto-run rules), so RLS applies to every effect and a failure rolls all of them back. The failure and its step are then recorded in a
 * second transaction, with exponential backoff until MAX_RUN_ATTEMPTS. No network call exists in this slice, so nothing here waits on I/O.
 */
export async function executeNextRun(db: Db, workspaceId: string, now = new Date(), ai?: AgentDeps["ai"]): Promise<ExecuteResult> {
  const peek = await withSystem(db, workspaceId, async (tx) => {
    if (await killSwitchOn(tx, workspaceId)) return "killed" as const;
    const [r] = await tx.select({ id: schema.automationRuns.id, approvedBy: schema.automationRuns.approvedBy, ruleId: schema.automationRuns.ruleId, actions: schema.automationRuns.actions, context: schema.automationRuns.context, triggerType: schema.automationRuns.triggerType, entityType: schema.automationRuns.entityType, entityId: schema.automationRuns.entityId }).from(schema.automationRuns).where(and(eq(schema.automationRuns.workspaceId, workspaceId), eq(schema.automationRuns.status, "pending"), lte(schema.automationRuns.nextAttemptAt, now))).orderBy(asc(schema.automationRuns.nextAttemptAt), asc(schema.automationRuns.id)).limit(1);
    if (!r) return null;
    const [rule] = await tx.select({ createdBy: schema.automationRules.createdBy }).from(schema.automationRules).where(and(eq(schema.automationRules.workspaceId, workspaceId), eq(schema.automationRules.id, r.ruleId)));
    let contactId = typeof (r.context as Record<string, unknown>).contactId === "string" ? ((r.context as Record<string, unknown>).contactId as string) : null;
    if (!contactId && r.entityType === "lead") contactId = (await tx.select({ c: schema.leads.primaryContactId }).from(schema.leads).where(and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.id, r.entityId))))[0]?.c ?? null;
    return { id: r.id, actor: r.approvedBy ?? rule!.createdBy, actions: Array.isArray(r.actions) ? r.actions : [], contactId, triggerType: r.triggerType };
  });
  if (peek === "killed") return "killed";
  if (!peek) return "none";

  // run_ai_agent: the model call happens HERE, outside any transaction; the action transaction below only writes the result.
  const agentRuns = new Map<number, Prepared | PrepareFailure>();
  if (ai && peek.contactId) {
    for (const [idx, raw] of peek.actions.entries()) {
      const a = AutomationAction.safeParse(raw);
      if (a.success && a.data.type === "run_ai_agent") agentRuns.set(idx, await prepareForAutomation({ db, ai }, { workspaceId, userId: peek.actor, agentId: a.data.agentId, contactId: peek.contactId, triggerType: peek.triggerType }));
    }
  }
  let failure: StepError | null = null;
  try {
    const out = await withContext(db, { userId: peek.actor, workspaceId }, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.system', 'dispatcher', true)`);
      const [run] = await tx.select().from(schema.automationRuns).where(and(eq(schema.automationRuns.workspaceId, workspaceId), eq(schema.automationRuns.id, peek.id), eq(schema.automationRuns.status, "pending"), lte(schema.automationRuns.nextAttemptAt, now))).for("update", { skipLocked: true });
      if (!run) return "none" as const; // another executor took it
      if (await killSwitchOn(tx, workspaceId)) return "killed" as const;
      const [rule] = await tx.select({ enabled: schema.automationRules.enabled, deletedAt: schema.automationRules.deletedAt }).from(schema.automationRules).where(and(eq(schema.automationRules.workspaceId, workspaceId), eq(schema.automationRules.id, run.ruleId)));
      const attempt = run.attempts + 1;
      if (!rule?.enabled || rule.deletedAt) {
        await tx.update(schema.automationRuns).set({ status: "skipped", error: "The rule was disabled or deleted before this run executed.", finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(schema.automationRuns.workspaceId, workspaceId), eq(schema.automationRuns.id, run.id)));
        return "skipped" as const;
      }
      const ctx = run.context as Record<string, unknown>;
      let contactId = typeof ctx.contactId === "string" ? ctx.contactId : null;
      if (!contactId && run.entityType === "lead") contactId = (await tx.select({ c: schema.leads.primaryContactId }).from(schema.leads).where(and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.id, run.entityId))))[0]?.c ?? null;
      const actions = Array.isArray(run.actions) ? run.actions : [];
      for (const [idx, raw] of actions.entries()) {
        const parsed = AutomationAction.safeParse(raw);
        if (!parsed.success) throw new StepError(idx, String((raw as { type?: unknown })?.type ?? "unknown"), true, "The stored action is not valid.");
        try {
          const detail = await runAction({ tx, workspaceId, actorUserId: peek.actor, runId: run.id, contactId, idx, agentRun: agentRuns.get(idx) ?? null }, parsed.data);
          await tx.insert(schema.automationRunSteps).values({ workspaceId, runId: run.id, attempt, idx, actionType: parsed.data.type, status: "succeeded", detail });
        } catch (e) {
          throw new StepError(idx, parsed.data.type, e instanceof PermanentError, errText(e));
        }
      }
      await tx.update(schema.automationRuns).set({ status: "succeeded", attempts: attempt, error: null, finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(schema.automationRuns.workspaceId, workspaceId), eq(schema.automationRuns.id, run.id)));
      return "succeeded" as const;
    });
    return out;
  } catch (e) {
    failure = e instanceof StepError ? e : new StepError(0, "unknown", false, errText(e));
  }

  // The action transaction rolled back; record what happened and schedule the retry (or give up).
  return withSystem(db, workspaceId, async (tx) => {
    const [run] = await tx.select().from(schema.automationRuns).where(and(eq(schema.automationRuns.workspaceId, workspaceId), eq(schema.automationRuns.id, peek.id), eq(schema.automationRuns.status, "pending"))).for("update", { skipLocked: true });
    if (!run) return "none" as const;
    const attempts = run.attempts + 1;
    const giveUp = failure!.permanent || attempts >= MAX_RUN_ATTEMPTS;
    await tx.insert(schema.automationRunSteps).values({ workspaceId, runId: run.id, attempt: attempts, idx: failure!.idx, actionType: failure!.actionType, status: "failed", error: failure!.message });
    await tx.update(schema.automationRuns).set(giveUp ? { status: "failed", attempts, error: failure!.message, finishedAt: new Date(), updatedAt: new Date() } : { attempts, error: failure!.message, nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)), updatedAt: new Date() }).where(and(eq(schema.automationRuns.workspaceId, workspaceId), eq(schema.automationRuns.id, run.id)));
    return giveUp ? ("failed" as const) : ("retry" as const);
  });
}

/** Runs due work for every workspace (bounded per call). `now` is injectable so tests can step past a backoff without sleeping. */
export async function processRuns(db: Db, opts: { now?: Date; workspaceIds?: string[]; perWorkspace?: number; ai?: AgentDeps["ai"] } = {}): Promise<number> {
  const all = await withSystem(db, undefined, (tx) => tx.select({ id: schema.workspaceEventCounters.workspaceId }).from(schema.workspaceEventCounters));
  let done = 0;
  for (const ws of all) {
    if (opts.workspaceIds && !opts.workspaceIds.includes(ws.id)) continue;
    for (let i = 0; i < (opts.perWorkspace ?? 20); i++) {
      const r = await executeNextRun(db, ws.id, opts.now, opts.ai);
      if (r === "none" || r === "killed") break;
      done++;
    }
  }
  return done;
}
