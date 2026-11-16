import { z } from "zod";
import { AgentDefinition, GRANT_MODES, SENSITIVITIES, ToolGrant } from "@crm/ai/agent";
import { endpoint } from "./endpoint.ts";

const W = "/v1/workspaces/:workspaceId";
const Micro = z.number().int().min(0).max(1_000_000_000_000_000);

export { AgentDefinition, ToolGrant, GRANT_MODES };
export const MAX_ACTIVE_AGENTS = 20;
export const MAX_AGENTS = 50;
export const AGENT_STATUSES = ["draft", "active", "archived"] as const;
export const AGENT_ACTION_STATUSES = ["pending", "approved", "rejected", "executed", "failed"] as const;
/** What happened to a proposed tool call in one run. would_* only appears in a dry run, where nothing is written. */
export const AGENT_ACTION_RESULT_STATUSES = ["would_execute", "would_pend", "executed", "pending", "failed", "rejected"] as const;

const Name = z.string().trim().min(1, "Give the agent a name").max(80);
const Description = z.string().trim().max(300);

export const AgentVersionDto = z.object({
  id: z.string().uuid(), version: z.number().int(), instructions: z.string(), personality: z.string(), language: z.string(), responseStyle: z.string(),
  provider: z.string().nullable(), model: z.string().nullable(), temperature: z.number(), maxOutputTokens: z.number().int(), toolGrants: z.array(ToolGrant),
  createdAt: z.string(), createdBy: z.string(),
});
export type AgentVersionDto = z.infer<typeof AgentVersionDto>;

export const AgentDto = z.object({
  id: z.string().uuid(), key: z.string(), name: z.string(), description: z.string(), status: z.enum(AGENT_STATUSES),
  activeVersionId: z.string().uuid().nullable(), activeVersion: z.number().int().nullable(), latestVersion: z.number().int(),
  createdAt: z.string(), updatedAt: z.string(),
  /** Newest first. */
  versions: z.array(AgentVersionDto),
});
export type AgentDto = z.infer<typeof AgentDto>;
export const AgentList = z.object({ items: z.array(AgentDto), activeCount: z.number().int(), maxActive: z.number().int() });

export const CreateAgentBody = AgentDefinition.safeExtend({ name: Name, description: Description.optional() });
export type CreateAgentBody = z.input<typeof CreateAgentBody>;
export const UpdateAgentBody = z.object({ name: Name.optional(), description: Description.optional() }).refine((v) => v.name !== undefined || v.description !== undefined, "Nothing to update");
export type UpdateAgentBody = z.input<typeof UpdateAgentBody>;
/** A new version is a full definition; versions are never edited in place. */
export const CreateAgentVersionBody = AgentDefinition;
export type CreateAgentVersionBody = z.input<typeof CreateAgentVersionBody>;
/** Omit the version to activate the newest; pass an older one to roll back. */
export const ActivateAgentBody = z.object({ versionId: z.string().uuid().optional() });

export const AgentToolDto = z.object({ name: z.string(), description: z.string(), sensitivity: z.enum(SENSITIVITIES), requiredPermission: z.string() });
export type AgentToolDto = z.infer<typeof AgentToolDto>;
export const AgentToolList = z.object({ items: z.array(AgentToolDto) });

export const AgentTestBody = z.object({
  input: z.string().trim().min(1, "Write something for the agent to answer").max(4000),
  contactId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  /** Default true: write tools are shown as "would execute" and nothing is changed. Read tools still run. */
  dryRun: z.boolean().optional(),
  /** Test a specific (for example not yet active) version. Owner/admin only. */
  versionId: z.string().uuid().optional(),
});
export const AgentRunBody = z.object({ conversationId: z.string().uuid() });

export const AgentActionOutcome = z.object({
  tool: z.string(), args: z.record(z.string(), z.unknown()), status: z.enum(AGENT_ACTION_RESULT_STATUSES),
  /** Why it was held, rejected or failed (a short code or sentence, never customer text). */
  detail: z.string().nullable(), result: z.record(z.string(), z.unknown()).nullable(), actionId: z.string().uuid().nullable(),
});
export type AgentActionOutcome = z.infer<typeof AgentActionOutcome>;
export const AgentRunResult = z.object({
  /** A DRAFT. Nothing is ever sent to the customer. */
  reply: z.string(), malformed: z.boolean(), dryRun: z.boolean(), actions: z.array(AgentActionOutcome),
  agentVersion: z.number().int(), provider: z.string(), model: z.string(), mock: z.boolean(), runId: z.string(),
  /** How the model was asked: native tool calls, response_format json_schema, or the prompt-only JSON-in-text protocol. */
  via: z.enum(["native_tools", "json_schema", "text"]).optional(),
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int(), costMicro: Micro }),
});
export type AgentRunResult = z.infer<typeof AgentRunResult>;

export const AgentActionDto = z.object({
  id: z.string().uuid(), agentId: z.string().uuid(), agentName: z.string(), agentVersion: z.number().int(), tool: z.string(), args: z.record(z.string(), z.unknown()),
  reason: z.enum(["approval_granted", "sensitive"]), status: z.enum(AGENT_ACTION_STATUSES), source: z.enum(["test", "run", "automation"]), contactId: z.string().uuid().nullable(),
  requestedBy: z.string(), decidedBy: z.string().nullable(), result: z.record(z.string(), z.unknown()).nullable(), error: z.string().nullable(), createdAt: z.string(), decidedAt: z.string().nullable(),
});
export type AgentActionDto = z.infer<typeof AgentActionDto>;
export const AgentActionsQuery = z.object({ status: z.enum(AGENT_ACTION_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
export const AgentActionList = z.object({ items: z.array(AgentActionDto) });

export const AgentRunRow = z.object({
  id: z.string().uuid(), createdAt: z.string(), status: z.enum(["ok", "error", "blocked_budget"]), agentVersion: z.number().int(), provider: z.string(), model: z.string(),
  inputTokens: z.number().int(), outputTokens: z.number().int(), costMicro: Micro, latencyMs: z.number().int(), errorCode: z.string().nullable(),
});
export type AgentRunRow = z.infer<typeof AgentRunRow>;
export const AgentRunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });
export const AgentRunList = z.object({ items: z.array(AgentRunRow) });

export const aiAgentEndpoints = {
  listAiTools: endpoint({ method: "GET", path: `${W}/ai/tools`, response: AgentToolList }),
  listAiAgents: endpoint({ method: "GET", path: `${W}/ai/agents`, response: AgentList }),
  createAiAgent: endpoint({ method: "POST", path: `${W}/ai/agents`, body: CreateAgentBody, response: AgentDto }),
  getAiAgent: endpoint({ method: "GET", path: `${W}/ai/agents/:agentId`, response: AgentDto }),
  updateAiAgent: endpoint({ method: "PATCH", path: `${W}/ai/agents/:agentId`, body: UpdateAgentBody, response: AgentDto }),
  createAiAgentVersion: endpoint({ method: "POST", path: `${W}/ai/agents/:agentId/versions`, body: CreateAgentVersionBody, response: AgentDto }),
  activateAiAgent: endpoint({ method: "POST", path: `${W}/ai/agents/:agentId/activate`, body: ActivateAgentBody, response: AgentDto }),
  archiveAiAgent: endpoint({ method: "POST", path: `${W}/ai/agents/:agentId/archive`, response: AgentDto }),
  testAiAgent: endpoint({ method: "POST", path: `${W}/ai/agents/:agentId/test`, body: AgentTestBody, response: AgentRunResult }),
  runAiAgent: endpoint({ method: "POST", path: `${W}/ai/agents/:agentId/run`, body: AgentRunBody, response: AgentRunResult }),
  listAiAgentRuns: endpoint({ method: "GET", path: `${W}/ai/agents/:agentId/runs`, query: AgentRunsQuery, response: AgentRunList }),
  listAiAgentActions: endpoint({ method: "GET", path: `${W}/ai/agent-actions`, query: AgentActionsQuery, response: AgentActionList }),
  approveAiAgentAction: endpoint({ method: "POST", path: `${W}/ai/agent-actions/:actionId/approve`, response: AgentActionDto }),
  rejectAiAgentAction: endpoint({ method: "POST", path: `${W}/ai/agent-actions/:actionId/reject`, response: AgentActionDto }),
} as const;
