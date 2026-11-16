import { sql } from "drizzle-orm";
import { boolean, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./tenancy.ts";

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const workspaceId = () => uuid("workspace_id").notNull().references(() => workspaces.id);
const ts = (name: string) => timestamp(name, { withTimezone: true });

/** Hand-written migration 0027 is the source of truth; this mirrors it for typed queries. */
export const automationRules = pgTable(
  "automation_rules",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    triggerType: text("trigger_type").notNull(),
    conditions: jsonb("conditions").notNull().default({ op: "and", conditions: [] }),
    actions: jsonb("actions").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [unique("automation_rules_ws_id").on(t.workspaceId, t.id)],
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: id(),
    workspaceId: workspaceId(),
    ruleId: uuid("rule_id").notNull(),
    ruleVersion: integer("rule_version").notNull(),
    triggerEventId: uuid("trigger_event_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    triggerType: text("trigger_type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    /** Snapshot of the rule's actions at trigger time: what was approved is what runs, even if the rule is edited meanwhile. */
    actions: jsonb("actions").notNull(),
    context: jsonb("context").notNull().default({}),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    error: text("error"),
    approvedBy: text("approved_by"),
    decidedAt: ts("decided_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    unique("automation_runs_ws_id").on(t.workspaceId, t.id),
    unique("automation_runs_idem").on(t.workspaceId, t.ruleId, t.idempotencyKey),
    foreignKey({ columns: [t.workspaceId, t.ruleId], foreignColumns: [automationRules.workspaceId, automationRules.id] }),
    index("automation_runs_list_idx").on(t.workspaceId, t.createdAt, t.id),
  ],
);

export const automationRunSteps = pgTable(
  "automation_run_steps",
  {
    id: id(),
    workspaceId: workspaceId(),
    runId: uuid("run_id").notNull(),
    attempt: integer("attempt").notNull(),
    idx: integer("idx").notNull(),
    actionType: text("action_type").notNull(),
    status: text("status").notNull(),
    detail: jsonb("detail").notNull().default({}),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [foreignKey({ columns: [t.workspaceId, t.runId], foreignColumns: [automationRuns.workspaceId, automationRuns.id] })],
);

/** One row per workspace, created on first change; a missing row means the kill switch is off. */
export const automationSettings = pgTable("automation_settings", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id),
  killSwitch: boolean("kill_switch").notNull().default(false),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
