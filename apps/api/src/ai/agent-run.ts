import { and, desc, eq, sql } from "drizzle-orm";
import type { AgentActionOutcome, AgentRunResult } from "@crm/contracts";
import { AGENT_REPLY_JSON_SCHEMA, AgentDefinition, composeNativeSystemPrompt, composeSystemPrompt, fenceData, getTool, grantedTools, parseAgentReply, parseNativeReply, toolSpecs, type ParsedReply, type PlannedAction, type ToolRegistry } from "@crm/ai";
import { can, type Role } from "@crm/core/permissions";
import { schema, withContext, type Db, type Tx } from "@crm/db";
import { writeAudit } from "../audit.ts";
import { killSwitchOn } from "../automation/kill-switch.ts";
import { PermanentError } from "../automation/actions.ts";
import { runAi, type AiDeps, type RunFailure, type RunVia } from "./run.ts";
import { TOOLS, type AttachToolDeps, type ToolCtx } from "./tools/index.ts";

export type AgentDeps = { db: Db; ai: AiDeps; tools?: ToolRegistry<ToolCtx>; /** Blob store and media service for the media tools. */ attach?: AttachToolDeps };
const rowsOf = (r: unknown) => (r as { rows: Record<string, unknown>[] }).rows;
const MESSAGES_CONTEXT = 12;
const MESSAGE_CHARS = 600;
const CONTEXT_CHARS = 6000;
export const AGENT_CAPABILITY = "agent";
export const AGENT_PROMPT_KEY = "agent";

/** A failure that retrying cannot fix prints its message; anything else is reduced to a generic line (driver errors can echo row values). */
export const errText = (e: unknown) => (e instanceof PermanentError ? e.message : "The action could not be completed.").slice(0, 500);

/** Newest messages win the character budget; every message is clipped. The transcript goes to the provider and is then dropped: never stored or logged. */
export async function conversationContext(tx: Tx, workspaceId: string, conversationId: string) {
  const conv = rowsOf(await tx.execute(sql`
    SELECT c.contact_id, ct.name AS contact_name, a.platform FROM conversations c
    JOIN integration_accounts a ON a.workspace_id = c.workspace_id AND a.id = c.integration_account_id
    JOIN contacts ct ON ct.workspace_id = c.workspace_id AND ct.id = c.contact_id
    WHERE c.workspace_id = ${workspaceId} AND c.id = ${conversationId}`))[0];
  if (!conv) return null;
  const msgs = rowsOf(await tx.execute(sql`SELECT direction, body FROM messages WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId} AND body IS NOT NULL AND body <> '' ORDER BY seq DESC LIMIT ${MESSAGES_CONTEXT}`));
  let left = CONTEXT_CHARS;
  const lines: string[] = [];
  for (const m of msgs) {
    const line = `${m.direction === "out" ? "Agent" : "Customer"}: ${(m.body as string).slice(0, MESSAGE_CHARS)}`;
    if (left - line.length < 0) break;
    left -= line.length;
    lines.unshift(line);
  }
  return { contactId: conv.contact_id as string, text: `Contact: ${(conv.contact_name as string).slice(0, 80)} (${conv.platform as string})\n${fenceData("Conversation (oldest first)", lines.join("\n"))}`, hasCustomerMessage: msgs.some((m) => m.direction !== "out") };
}

export async function contactContext(tx: Tx, workspaceId: string, contactId: string) {
  const [c] = await tx.select({ name: schema.contacts.name }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), eq(schema.contacts.id, contactId), sql`${schema.contacts.deletedAt} IS NULL`));
  return c ? `Contact: ${c.name.slice(0, 80)}` : null;
}

export type PrepareFailure = { ok: false; code: "not_found" | "inactive" | "kill_switch_on" | RunFailure };
export type Prepared = {
  ok: true; agent: { id: string; name: string }; versionId: string; versionNo: number; def: AgentDefinition; parsed: ParsedReply;
  run: { runId: string; provider: string; model: string; mock: boolean; usage: { inputTokens: number; outputTokens: number; costMicro: number }; /** How the model was asked: native tool calls, response_format json_schema, or the prompt-only JSON-in-text protocol. */ via: RunVia };
};

/**
 * Phases 1 and 2 of an agent run: load the version (short transaction as the user), then ONE model call through runAi (budget hard stop, retries, run log;
 * no transaction is open during the call). Returns the parsed plan; nothing is written yet except the ai_runs row.
 */
export async function prepareAgentRun(
  deps: AgentDeps,
  p: { workspaceId: string; userId: string; agentId: string; versionId?: string; requireActive: boolean; live: boolean; userContent: string; entity?: { type: string; id: string } },
): Promise<Prepared | PrepareFailure> {
  const tools = deps.tools ?? TOOLS;
  const loaded = await withContext(deps.db, { userId: p.userId, workspaceId: p.workspaceId }, async (tx) => {
    if (p.live && (await killSwitchOn(tx, p.workspaceId))) return "kill_switch_on" as const;
    const [agent] = await tx.select().from(schema.aiAgents).where(and(eq(schema.aiAgents.workspaceId, p.workspaceId), eq(schema.aiAgents.id, p.agentId)));
    if (!agent) return null;
    if (p.requireActive && (agent.status !== "active" || !agent.activeVersionId)) return "inactive" as const;
    // A draft agent can be tried (owner/admin, requireActive false): the newest version stands in for the missing active one.
    const versionId = p.versionId ?? agent.activeVersionId ?? (await tx.select({ id: schema.aiAgentVersions.id }).from(schema.aiAgentVersions).where(and(eq(schema.aiAgentVersions.workspaceId, p.workspaceId), eq(schema.aiAgentVersions.agentId, agent.id))).orderBy(desc(schema.aiAgentVersions.version)).limit(1))[0]?.id;
    if (!versionId) return "inactive" as const;
    const [v] = await tx.select().from(schema.aiAgentVersions).where(and(eq(schema.aiAgentVersions.workspaceId, p.workspaceId), eq(schema.aiAgentVersions.agentId, agent.id), eq(schema.aiAgentVersions.id, versionId)));
    return v ? { agent, v } : null;
  });
  if (loaded === null) return { ok: false, code: "not_found" };
  if (loaded === "kill_switch_on" || loaded === "inactive") return { ok: false, code: loaded };
  const { agent, v } = loaded;
  const def = AgentDefinition.parse({ instructions: v.instructions, personality: v.personality, language: v.language, responseStyle: v.responseStyle, provider: v.provider, model: v.model, temperature: v.temperature, maxOutputTokens: v.maxOutputTokens, toolGrants: v.toolGrants });
  // The default is the JSON-in-text protocol. runAi upgrades it ONLY when the chosen model's stored flags allow: native tool calls (when the agent has granted tools) or response_format json_schema.
  // Either way the model's output is parsed and validated by the same rules (grants, approvals, dry run, max actions).
  const res = await runAi(deps.ai, {
    workspaceId: p.workspaceId, userId: p.userId, capability: AGENT_CAPABILITY, promptKey: AGENT_PROMPT_KEY, vars: {}, system: composeSystemPrompt(def, tools), input: p.userContent,
    entity: p.entity, maxOutputTokens: def.maxOutputTokens, temperature: def.temperature, provider: def.provider, model: def.model, agent: { id: agent.id, version: v.version },
    ...(grantedTools(def.toolGrants, tools).length ? { native: { tools: toolSpecs(def.toolGrants, tools), system: composeNativeSystemPrompt(def, tools) } } : {}),
    responseSchema: { name: "agent_reply", schema: AGENT_REPLY_JSON_SCHEMA },
  });
  if (!res.ok) return { ok: false, code: res.code };
  const parsed = res.via === "native_tools" ? parseNativeReply(res.text, res.toolCalls, def.toolGrants, tools, res.finishReason) : parseAgentReply(res.text, def.toolGrants, tools);
  return { ok: true, agent: { id: agent.id, name: agent.name }, versionId: v.id, versionNo: v.version, def, parsed, run: { runId: res.runId, provider: res.provider, model: res.model, mock: res.mock, usage: res.usage, via: res.via } };
}

/** Automation: runs the agent over the trigger's contact (name only; the trigger names what happened). The caller records the outcome; nothing is sent or executed. */
export async function prepareForAutomation(deps: AgentDeps, p: { workspaceId: string; userId: string; agentId: string; contactId: string; triggerType: string }): Promise<Prepared | PrepareFailure> {
  const ctx = await withContext(deps.db, { userId: p.userId, workspaceId: p.workspaceId }, (tx) => contactContext(tx, p.workspaceId, p.contactId));
  if (!ctx) return { ok: false, code: "not_found" };
  return prepareAgentRun(deps, { workspaceId: p.workspaceId, userId: p.userId, agentId: p.agentId, requireActive: true, live: true, userContent: `${ctx}\nEvent: ${p.triggerType}\nDraft a short internal note for the team about this event.`, entity: { type: "contact", id: p.contactId } });
}

/** Runs one tool in a savepoint: a failure undoes only that tool's writes. */
export async function executeTool(tx: Tx, tools: ToolRegistry<ToolCtx>, ctx: Omit<ToolCtx, "tx">, name: string, args: Record<string, unknown>): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string }> {
  const t = getTool(tools, name);
  if (!t) return { ok: false, error: "This tool no longer exists." };
  if (ctx.pre) return ctx.pre;
  try {
    const result = await tx.transaction((sp) => t.execute({ ...ctx, tx: sp }, args as never));
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

export type ApplyInput = { workspaceId: string; userId: string; role: Role; source: "test" | "run"; dryRun: boolean; contactId: string | null; conversationId: string | null; requestId?: string; ip?: string };

/**
 * Phase 3: one transaction as the requesting user. Read tools run and return their result. In a dry run write tools only report "would execute" / "would pend" and change nothing.
 * Live: auto write tools execute here (once, in this transaction); approval-granted and sensitive ones are stored as pending for a human. Rejected actions are only reported.
 */
export type MediaPre = Map<number, NonNullable<ToolCtx["pre"]>>;
export const isMediaTool = (name: string) => name.startsWith("media.");

/**
 * Runs the media tools of a plan (blob read + provider call) BEFORE any transaction is open, keyed by the action's index. applyOne then only records the stored result.
 * Network and blob I/O never run inside a database transaction, and no tool holds a second pool connection while a transaction waits.
 */
export async function precomputeMedia(deps: AgentDeps, prep: Prepared, a: ApplyInput): Promise<MediaPre> {
  const tools = deps.tools ?? TOOLS;
  const out: MediaPre = new Map();
  for (const [idx, act] of prep.parsed.planned.entries()) {
    if (!isMediaTool(act.tool) || act.disposition === "pending") continue;
    const def = getTool(tools, act.tool);
    if (!def || !can(a.role, def.requiredPermission as "contact.edit", {})) continue;
    out.set(idx, await runToolOutsideTx(deps, tools, { workspaceId: a.workspaceId, userId: a.userId, contactId: a.contactId, conversationId: a.conversationId }, act.tool, act.args));
  }
  return out;
}
export async function runToolOutsideTx(deps: AgentDeps, tools: ToolRegistry<ToolCtx>, c: { workspaceId: string; userId: string; contactId: string | null; conversationId: string | null }, name: string, args: Record<string, unknown>): Promise<NonNullable<ToolCtx["pre"]>> {
  const t = getTool(tools, name)!;
  try {
    return { ok: true, result: await t.execute({ db: deps.db, ref: "media", attach: deps.attach, tx: undefined as never, ...c }, args as never) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

export async function applyPlan(tx: Tx, deps: AgentDeps, prep: Prepared, a: ApplyInput, pre?: MediaPre): Promise<AgentRunResult> {
  const tools = deps.tools ?? TOOLS;
  const outcomes: AgentActionOutcome[] = prep.parsed.rejected.map((r) => ({ tool: r.tool, args: {}, status: "rejected", detail: r.reason, result: null, actionId: null }));
  for (const [idx, act] of prep.parsed.planned.entries()) outcomes.push(await applyOne(tx, deps.db, tools, prep, a, act, idx, deps.attach, pre?.get(idx)));
  return {
    reply: prep.parsed.reply, malformed: prep.parsed.malformed, dryRun: a.dryRun, actions: outcomes, agentVersion: prep.versionNo, provider: prep.run.provider, model: prep.run.model, mock: prep.run.mock, runId: prep.run.runId, usage: prep.run.usage, via: prep.run.via,
  };
}

async function applyOne(tx: Tx, db: Db, tools: ToolRegistry<ToolCtx>, prep: Prepared, a: ApplyInput, act: PlannedAction, idx: number, attach?: AttachToolDeps, pre?: ToolCtx["pre"]): Promise<AgentActionOutcome> {
  const base = { tool: act.tool, args: act.args };
  const def = getTool(tools, act.tool)!;
  if (!can(a.role, def.requiredPermission as "contact.edit", {})) return { ...base, status: "rejected", detail: "forbidden", result: null, actionId: null };
  const ctx = { db, workspaceId: a.workspaceId, userId: a.userId, contactId: a.contactId, ref: prep.run.runId, conversationId: a.conversationId, attach, pre };
  if (act.disposition === "pending") {
    if (a.dryRun) return { ...base, status: "would_pend", detail: act.pendingReason, result: null, actionId: null };
    const [row] = await tx.insert(schema.aiAgentActions).values({
      workspaceId: a.workspaceId, agentId: prep.agent.id, agentVersionId: prep.versionId, source: a.source, idx, contactId: a.contactId, conversationId: a.conversationId, tool: act.tool, args: act.args,
      reason: act.pendingReason ?? "approval_granted", requestedBy: a.userId, aiRunId: prep.run.runId || null,
    }).returning({ id: schema.aiAgentActions.id });
    await writeAudit(tx, { workspaceId: a.workspaceId, actorUserId: a.userId, action: "ai.agent.action_proposed", entityType: "ai_agent_action", entityId: row!.id, summary: { agentId: prep.agent.id, tool: act.tool, reason: act.pendingReason }, requestId: a.requestId, ip: a.ip });
    return { ...base, status: "pending", detail: act.pendingReason, result: null, actionId: row!.id };
  }
  if (a.dryRun && act.sensitivity !== "read") return { ...base, status: "would_execute", detail: null, result: null, actionId: null };
  const r = await executeTool(tx, tools, ctx, act.tool, act.args);
  if (!r.ok) return { ...base, status: "failed", detail: r.error, result: null, actionId: null };
  if (!a.dryRun && act.sensitivity !== "read") await writeAudit(tx, { workspaceId: a.workspaceId, actorUserId: a.userId, action: "ai.agent.action_executed", entityType: "ai_agent", entityId: prep.agent.id, summary: { tool: act.tool, runId: prep.run.runId, auto: true }, requestId: a.requestId, ip: a.ip });
  return { ...base, status: "executed", detail: null, result: r.result, actionId: null };
}
