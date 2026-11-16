import { sql } from "drizzle-orm";
import { bigint, boolean, customType, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
