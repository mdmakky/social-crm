import { sql } from "drizzle-orm";
import { bigint, boolean, customType, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./tenancy.ts";

// Hand-written migration 0030 is the source of truth (checks, RLS, grants, triggers); these definitions only type the columns.
const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const workspaceId = () => uuid("workspace_id").notNull().references(() => workspaces.id);
const ts = (n: string) => timestamp(n, { withTimezone: true });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const AI_RUN_STATUSES = ["ok", "error", "blocked_budget"] as const;

export const aiProviderConfigs = pgTable("ai_provider_configs", {
  id: id(),
  workspaceId: workspaceId(),
  provider: text("provider").notNull(),
  baseUrl: text("base_url"),
  defaultModel: text("default_model"),
  enabled: boolean("enabled").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  keyLast4: text("key_last4"),
  modelPrices: jsonb("model_prices").notNull().default({}),
  createdBy: text("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Sealed provider key. The application role can INSERT but never read it; only the worker role does. */
export const aiProviderSecrets = pgTable("ai_provider_secrets", {
  id: id(),
  workspaceId: workspaceId(),
  configId: uuid("config_id").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  nonce: bytea("nonce").notNull(),
  keyId: text("key_id").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const aiPrompts = pgTable("ai_prompts", {
  id: id(),
  workspaceId: workspaceId(),
  key: text("key").notNull(),
  version: integer("version").notNull(),
  template: text("template").notNull(),
  active: boolean("active").notNull().default(false),
  createdBy: text("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const aiRuns = pgTable("ai_runs", {
  id: id(),
  workspaceId: workspaceId(),
  capability: text("capability").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptKey: text("prompt_key").notNull(),
  promptVersion: integer("prompt_version").notNull(),
  status: text("status").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costMicro: bigint("cost_micro", { mode: "number" }).notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  errorCode: text("error_code"),
  requestedBy: text("requested_by"),
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  inputHash: text("input_hash"),
  summary: text("summary"),
  /** Set for agent runs (migration 0032): which agent and which version made the call. */
  agentId: uuid("agent_id"),
  agentVersion: integer("agent_version"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const aiBudgets = pgTable("ai_budgets", {
  id: id(),
  workspaceId: workspaceId(),
  monthlyCapMicro: bigint("monthly_cap_micro", { mode: "number" }),
  hardStop: boolean("hard_stop").notNull().default(true),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Migration 0045: one pinned model per job; no row = automatic. */
export const aiJobModels = pgTable("ai_job_models", {
  workspaceId: workspaceId(),
  job: text("job").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.job] })]);

export const AI_AGENT_STATUSES = ["draft", "active", "archived"] as const;
export const AI_ACTION_STATUSES = ["pending", "approved", "rejected", "executed", "failed"] as const;

/** Migration 0032 is the source of truth (checks, RLS, grants, guards). */
export const aiAgents = pgTable("ai_agents", {
  id: id(),
  workspaceId: workspaceId(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("draft"),
  activeVersionId: uuid("active_version_id"),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const aiAgentVersions = pgTable("ai_agent_versions", {
  id: id(),
  workspaceId: workspaceId(),
  agentId: uuid("agent_id").notNull(),
  version: integer("version").notNull(),
  instructions: text("instructions").notNull(),
  personality: text("personality").notNull().default(""),
  language: text("language").notNull().default("auto"),
  responseStyle: text("response_style").notNull().default("concise"),
  provider: text("provider"),
  model: text("model"),
  temperature: real("temperature").notNull().default(0.4),
  maxOutputTokens: integer("max_output_tokens").notNull().default(600),
  toolGrants: jsonb("tool_grants").notNull().default([]),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const aiAgentActions = pgTable("ai_agent_actions", {
  id: id(),
  workspaceId: workspaceId(),
  agentId: uuid("agent_id").notNull(),
  agentVersionId: uuid("agent_version_id").notNull(),
  source: text("source").notNull(),
  sourceRef: text("source_ref"),
  idx: integer("idx").notNull().default(0),
  contactId: uuid("contact_id"),
  conversationId: uuid("conversation_id"),
  tool: text("tool").notNull(),
  args: jsonb("args").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("pending"),
  requestedBy: text("requested_by").notNull(),
  decidedBy: text("decided_by"),
  decidedAt: ts("decided_at"),
  result: jsonb("result"),
  error: text("error"),
  aiRunId: uuid("ai_run_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
