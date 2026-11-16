import { z } from "zod";
import { endpoint } from "./endpoint.ts";

export const AUTOMATION_TRIGGERS = {
  "contact.created": { label: "A contact is created" },
  "lead.stage_changed": { label: "A lead moves to another stage" },
  "contact.owner_assigned": { label: "A contact gets an owner" },
  "lead.owner_assigned": { label: "A lead gets an owner" },
} as const;
export type AutomationTrigger = keyof typeof AUTOMATION_TRIGGERS;
export const AutomationTriggerSchema = z.enum(Object.keys(AUTOMATION_TRIGGERS) as [AutomationTrigger, ...AutomationTrigger[]]);

const Scalar = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);
const Field = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/, "Use a field name like source or toStageId").max(80);

export type ConditionInput = { op: "and" | "or"; conditions: ConditionInput[] } | { op: "equals"; field: string; value: string | number | boolean | null } | { op: "in"; field: string; values: (string | number | boolean | null)[] } | { op: "contains"; field: string; value: string };
const ConditionNode: z.ZodType<ConditionInput> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(["and", "or"]), conditions: z.array(ConditionNode).max(10) }).strict(),
    z.object({ op: z.literal("equals"), field: Field, value: Scalar }).strict(),
    z.object({ op: z.literal("in"), field: Field, values: z.array(Scalar).min(1).max(20) }).strict(),
    z.object({ op: z.literal("contains"), field: Field, value: z.string().min(1).max(200) }).strict(),
  ]),
);
const shape = (c: ConditionInput, depth = 1): { nodes: number; depth: number } =>
  c.op === "and" || c.op === "or" ? c.conditions.reduce((a, x) => { const s = shape(x, depth + 1); return { nodes: a.nodes + s.nodes, depth: Math.max(a.depth, s.depth) }; }, { nodes: 1, depth }) : { nodes: 1, depth };
/** Same limits as @crm/core MAX_CONDITION_NODES / MAX_CONDITION_DEPTH. */
export const AutomationCondition = ConditionNode.refine((c) => { const s = shape(c); return s.nodes <= 20 && s.depth <= 4; }, "Condition is too large (max 20 conditions, 4 levels).");

export const AutomationAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_task"), title: z.string().trim().min(1).max(200), description: z.string().trim().max(2000).optional(), dueInHours: z.number().int().min(1).max(8760).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), assigneeUserId: z.string().min(1).max(100).optional() }).strict(),
  z.object({ type: z.literal("add_tag"), tagName: z.string().trim().min(1).max(50) }).strict(),
  z.object({ type: z.literal("assign_owner"), ownerUserId: z.string().min(1).max(100) }).strict(),
  /** Runs an active AI agent over the trigger's contact; records a draft note and queues proposed tool calls for approval. Never sends a message. */
  z.object({ type: z.literal("run_ai_agent"), agentId: z.string().uuid() }).strict(),
]);
export type AutomationAction = z.infer<typeof AutomationAction>;
export const AUTOMATION_ACTION_TYPES = { create_task: "Create a task", add_tag: "Add a tag", assign_owner: "Assign the contact's owner", run_ai_agent: "Run an AI agent (draft note and proposed actions)" } as const;

const Name = z.string().trim().min(1, "Give the rule a name").max(120);
const Actions = z.array(AutomationAction).min(1, "Add at least one action").max(5);
export const AutomationRuleDto = z.object({
  id: z.string().uuid(),
  name: z.string(),
  triggerType: AutomationTriggerSchema,
  conditions: AutomationCondition,
  actions: z.array(AutomationAction),
  enabled: z.boolean(),
  requiresApproval: z.boolean(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AutomationRuleDto = z.infer<typeof AutomationRuleDto>;

export const CreateAutomationRuleBody = z.object({ name: Name, triggerType: AutomationTriggerSchema, conditions: AutomationCondition.optional(), actions: Actions, enabled: z.boolean().optional(), requiresApproval: z.boolean().optional() }).strict();
export type CreateAutomationRuleBody = z.input<typeof CreateAutomationRuleBody>;
export const UpdateAutomationRuleBody = z
  .object({ name: Name.optional(), triggerType: AutomationTriggerSchema.optional(), conditions: AutomationCondition.optional(), actions: Actions.optional(), enabled: z.boolean().optional(), requiresApproval: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
export type UpdateAutomationRuleBody = z.input<typeof UpdateAutomationRuleBody>;

export const AUTOMATION_RUN_STATUS = ["pending", "awaiting_approval", "running", "succeeded", "failed", "cancelled", "skipped"] as const;
export const AutomationRunStep = z.object({ id: z.string().uuid(), attempt: z.number().int(), idx: z.number().int(), actionType: z.string(), status: z.enum(["succeeded", "failed"]), detail: z.record(z.string(), z.unknown()), error: z.string().nullable(), createdAt: z.string() });
export const AutomationRunDto = z.object({
  id: z.string().uuid(),
  ruleId: z.string().uuid(),
  ruleName: z.string(),
  ruleVersion: z.number().int(),
  triggerType: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  actions: z.array(AutomationAction),
  status: z.enum(AUTOMATION_RUN_STATUS),
  attempts: z.number().int(),
  nextAttemptAt: z.string().nullable(),
  error: z.string().nullable(),
  approvedBy: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  steps: z.array(AutomationRunStep),
});
export type AutomationRunDto = z.infer<typeof AutomationRunDto>;
export const AutomationRunPage = z.object({ items: z.array(AutomationRunDto), nextCursor: z.string().nullable() });
export const AutomationRunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().uuid().optional(), status: z.enum(AUTOMATION_RUN_STATUS).optional() });
export type AutomationRunsQuery = z.input<typeof AutomationRunsQuery>;

export const AutomationSettingsDto = z.object({ killSwitch: z.boolean() });
export type AutomationSettingsDto = z.infer<typeof AutomationSettingsDto>;

const W = "/v1/workspaces/:workspaceId/automations";
export const automationEndpoints = {
  listAutomationRules: endpoint({ method: "GET", path: `${W}/rules`, response: z.array(AutomationRuleDto) }),
  createAutomationRule: endpoint({ method: "POST", path: `${W}/rules`, body: CreateAutomationRuleBody, response: AutomationRuleDto }),
  updateAutomationRule: endpoint({ method: "PATCH", path: `${W}/rules/:ruleId`, body: UpdateAutomationRuleBody, response: AutomationRuleDto }),
  deleteAutomationRule: endpoint({ method: "DELETE", path: `${W}/rules/:ruleId`, response: z.undefined() }),
  listAutomationRuns: endpoint({ method: "GET", path: `${W}/runs`, query: AutomationRunsQuery, response: AutomationRunPage }),
  approveAutomationRun: endpoint({ method: "POST", path: `${W}/runs/:runId/approve`, response: AutomationRunDto }),
  rejectAutomationRun: endpoint({ method: "POST", path: `${W}/runs/:runId/reject`, response: AutomationRunDto }),
  getAutomationSettings: endpoint({ method: "GET", path: `${W}/settings`, response: AutomationSettingsDto }),
  updateAutomationSettings: endpoint({ method: "PUT", path: `${W}/settings`, body: AutomationSettingsDto, response: AutomationSettingsDto }),
} as const;
