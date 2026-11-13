import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "../auth-schema.ts";
import { contacts, tags } from "./crm.ts";
import { workspaces } from "./tenancy.ts";

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const workspaceId = () => uuid("workspace_id").notNull().references(() => workspaces.id);
const ts = (n: string) => timestamp(n, { withTimezone: true });

export const PIPELINE_KINDS = ["lead", "sales"] as const;
export const STAGE_KINDS = ["open", "won", "lost"] as const;
export const LEAD_PRIORITIES = ["low", "normal", "high"] as const;

export const pipelines = pgTable(
  "pipelines",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    defaultCurrency: text("default_currency").notNull().default("USD"),
    isDefault: boolean("is_default").notNull().default(false),
    position: integer("position").notNull(),
    version: integer("version").notNull().default(1),
    archivedAt: ts("archived_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("pipelines_ws_id").on(t.workspaceId, t.id),
    check("pipelines_name_len", sql`char_length(${t.name}) BETWEEN 1 AND 80`),
    check("pipelines_kind", sql`${t.kind} IN ('lead','sales')`),
    check("pipelines_currency", sql`${t.defaultCurrency} ~ '^[A-Z]{3}$'`),
    uniqueIndex("pipelines_one_default").on(t.workspaceId).where(sql`${t.isDefault} AND ${t.archivedAt} IS NULL`),
    uniqueIndex("pipelines_ws_name").on(t.workspaceId, sql`lower(${t.name})`).where(sql`${t.archivedAt} IS NULL`),
  ],
);

export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: id(),
    workspaceId: workspaceId(),
    pipelineId: uuid("pipeline_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("open"),
    defaultProbability: smallint("default_probability").notNull(),
    position: integer("position").notNull(),
    archivedAt: ts("archived_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.pipelineId], foreignColumns: [pipelines.workspaceId, pipelines.id] }),
    unique("stages_ws_id").on(t.workspaceId, t.id),
    unique("stages_ws_pipeline_id").on(t.workspaceId, t.pipelineId, t.id),
    unique("stages_ws_pipeline_id_kind").on(t.workspaceId, t.pipelineId, t.id, t.kind),
    check("stages_name_len", sql`char_length(${t.name}) BETWEEN 1 AND 60`),
    check("stages_kind", sql`${t.kind} IN ('open','won','lost')`),
    check("stages_prob_range", sql`${t.defaultProbability} BETWEEN 0 AND 100`),
    check("stages_won_100", sql`${t.kind} <> 'won' OR ${t.defaultProbability} = 100`),
    check("stages_lost_0", sql`${t.kind} <> 'lost' OR ${t.defaultProbability} = 0`),
    check("stages_terminal_not_archived", sql`${t.kind} = 'open' OR ${t.archivedAt} IS NULL`),
    uniqueIndex("stages_one_won").on(t.workspaceId, t.pipelineId).where(sql`${t.kind} = 'won'`),
    uniqueIndex("stages_one_lost").on(t.workspaceId, t.pipelineId).where(sql`${t.kind} = 'lost'`),
    index("stages_pipeline_pos").on(t.workspaceId, t.pipelineId, t.position).where(sql`${t.archivedAt} IS NULL`),
  ],
);

export const lostReasons = pgTable(
  "lost_reasons",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    archivedAt: ts("archived_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [unique("lost_reasons_ws_id").on(t.workspaceId, t.id), check("lost_reasons_name_len", sql`char_length(${t.name}) BETWEEN 1 AND 80`)],
);

/** One entity for leads and deals (D20). `outcome` mirrors the stage kind through the composite FK. */
export const leads = pgTable(
  "leads",
  {
    id: id(),
    workspaceId: workspaceId(),
    title: text("title").notNull(),
    description: text("description"),
    primaryContactId: uuid("primary_contact_id").notNull(),
    pipelineId: uuid("pipeline_id").notNull(),
    stageId: uuid("stage_id").notNull(),
    outcome: text("outcome").notNull().default("open"),
    /** Position inside a board column (fractional index; C collation so byte order is the sort order). */
    rank: text("rank").notNull(),
    valueMinor: bigint("value_minor", { mode: "number" }),
    currency: text("currency"),
    expectedCloseDate: date("expected_close_date", { mode: "string" }),
    probability: smallint("probability").notNull(),
    probabilityManual: boolean("probability_manual").notNull().default(false),
    closedAt: ts("closed_at"),
    lostReasonId: uuid("lost_reason_id"),
    /** Derived from linked open tasks; never written by users. */
    nextActivityAt: ts("next_activity_at"),
    priority: text("priority").notNull().default("normal"),
    source: text("source").notNull().default("manual"),
    ownerUserId: text("owner_user_id").references(() => user.id),
    custom: jsonb("custom").notNull().default({}),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by").references(() => user.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    unique("leads_ws_id").on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.primaryContactId], foreignColumns: [contacts.workspaceId, contacts.id] }),
    foreignKey({ columns: [t.workspaceId, t.pipelineId, t.stageId, t.outcome], foreignColumns: [pipelineStages.workspaceId, pipelineStages.pipelineId, pipelineStages.id, pipelineStages.kind] }),
    foreignKey({ columns: [t.workspaceId, t.lostReasonId], foreignColumns: [lostReasons.workspaceId, lostReasons.id] }),
    check("leads_title_len", sql`char_length(${t.title}) BETWEEN 1 AND 160`),
    check("leads_description_len", sql`${t.description} IS NULL OR char_length(${t.description}) <= 5000`),
    check("leads_outcome", sql`${t.outcome} IN ('open','won','lost')`),
    check("leads_value_range", sql`${t.valueMinor} IS NULL OR ${t.valueMinor} BETWEEN 0 AND 9007199254740991`),
    check("leads_currency_fmt", sql`${t.currency} IS NULL OR ${t.currency} ~ '^[A-Z]{3}$'`),
    check("leads_value_currency_pair", sql`(${t.valueMinor} IS NULL) = (${t.currency} IS NULL)`),
    check("leads_close_date_range", sql`${t.expectedCloseDate} IS NULL OR ${t.expectedCloseDate} BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'`),
    check("leads_prob_range", sql`${t.probability} BETWEEN 0 AND 100`),
    check("leads_closed_at_matches_outcome", sql`(${t.outcome} = 'open') = (${t.closedAt} IS NULL)`),
    check("leads_lost_reason_only_when_lost", sql`${t.outcome} = 'lost' OR ${t.lostReasonId} IS NULL`),
    check("leads_lost_needs_reason", sql`${t.outcome} <> 'lost' OR ${t.lostReasonId} IS NOT NULL`),
    check("leads_won_prob", sql`${t.outcome} <> 'won' OR ${t.probability} = 100`),
    check("leads_lost_prob", sql`${t.outcome} <> 'lost' OR ${t.probability} = 0`),
    check("leads_priority", sql`${t.priority} IN ('low','normal','high')`),
    index("leads_board_idx").on(t.workspaceId, t.pipelineId, t.stageId, sql`${t.rank} COLLATE "C"`, t.id).where(sql`${t.deletedAt} IS NULL`),
    index("leads_contact_idx").on(t.workspaceId, t.primaryContactId).where(sql`${t.deletedAt} IS NULL`),
    index("leads_owner_idx").on(t.workspaceId, t.ownerUserId, t.outcome).where(sql`${t.deletedAt} IS NULL`),
    index("leads_ws_updated_idx").on(t.workspaceId, t.updatedAt.desc(), t.id).where(sql`${t.deletedAt} IS NULL`),
    index("leads_ws_close_idx").on(t.workspaceId, t.expectedCloseDate, t.id).where(sql`${t.deletedAt} IS NULL`),
  ],
);

export const leadTags = pgTable(
  "lead_tags",
  { workspaceId: workspaceId(), leadId: uuid("lead_id").notNull(), tagId: uuid("tag_id").notNull() },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.leadId, t.tagId] }),
    foreignKey({ columns: [t.workspaceId, t.leadId], foreignColumns: [leads.workspaceId, leads.id] }),
    foreignKey({ columns: [t.workspaceId, t.tagId], foreignColumns: [tags.workspaceId, tags.id] }),
    index("lead_tags_tag_idx").on(t.workspaceId, t.tagId, t.leadId),
  ],
);

/** Append-only. History rows carry ids only, never personal data (erasure-safe). */
export const stageTransitions = pgTable(
  "stage_transitions",
  {
    id: id(),
    workspaceId: workspaceId(),
    leadId: uuid("lead_id").notNull(),
    pipelineId: uuid("pipeline_id").notNull(),
    fromStageId: uuid("from_stage_id"),
    toStageId: uuid("to_stage_id").notNull(),
    fromOutcome: text("from_outcome"),
    toOutcome: text("to_outcome").notNull(),
    actorUserId: text("actor_user_id"),
    lostReasonId: uuid("lost_reason_id"),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.leadId], foreignColumns: [leads.workspaceId, leads.id] }),
    foreignKey({ columns: [t.workspaceId, t.toStageId], foreignColumns: [pipelineStages.workspaceId, pipelineStages.id] }),
    check("stage_transitions_to_outcome", sql`${t.toOutcome} IN ('open','won','lost')`),
    index("stage_transitions_lead_idx").on(t.workspaceId, t.leadId, t.occurredAt, t.id),
    index("stage_transitions_stage_idx").on(t.workspaceId, t.pipelineId, t.toStageId, t.occurredAt),
  ],
);

/** Explicit per-lead grant to read/write deal value for an assigned team member (owner/admin always can). */
export const leadValueGrants = pgTable(
  "lead_value_grants",
  {
    workspaceId: workspaceId(),
    leadId: uuid("lead_id").notNull(),
    userId: text("user_id").notNull().references(() => user.id),
    canEdit: boolean("can_edit").notNull().default(false),
    grantedBy: text("granted_by").notNull().references(() => user.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.leadId, t.userId] }),
    foreignKey({ columns: [t.workspaceId, t.leadId], foreignColumns: [leads.workspaceId, leads.id] }),
  ],
);
