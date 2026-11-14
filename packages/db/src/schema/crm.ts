import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "../auth-schema.ts";
import { workspaces } from "./tenancy.ts";
import { leads } from "./leads.ts";

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const workspaceId = () => uuid("workspace_id").notNull().references(() => workspaces.id);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Customer lifecycle (New, Engaged, ...). Workspace-configurable and independent of any sales pipeline. */
export const lifecycleStages = pgTable(
  "lifecycle_stages",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [unique("lifecycle_stages_ws_id").on(t.workspaceId, t.id)],
);

export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    email: text("email"),
    emailNormalized: text("email_normalized"),
    phone: text("phone"),
    phoneNormalized: text("phone_normalized"),
    company: text("company"),
    ownerUserId: text("owner_user_id").references(() => user.id),
    lifecycleStageId: uuid("lifecycle_stage_id").notNull(),
    source: text("source").notNull().default("manual"),
    custom: jsonb("custom").notNull().default({}),
    version: integer("version").notNull().default(1),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    unique("contacts_ws_id").on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.lifecycleStageId], foreignColumns: [lifecycleStages.workspaceId, lifecycleStages.id] }),
    index("contacts_ws_created_idx").on(t.workspaceId, t.createdAt.desc(), t.id),
    index("contacts_ws_activity_idx").on(t.workspaceId, t.lastActivityAt.desc(), t.id),
    index("contacts_ws_name_idx").on(t.workspaceId, t.name, t.id),
    index("contacts_ws_email_idx").on(t.workspaceId, t.emailNormalized),
    index("contacts_ws_phone_idx").on(t.workspaceId, t.phoneNormalized),
    index("contacts_ws_owner_idx").on(t.workspaceId, t.ownerUserId),
    index("contacts_name_trgm").using("gin", sql`lower(${t.name}) gin_trgm_ops`),
    index("contacts_email_trgm").using("gin", sql`${t.emailNormalized} gin_trgm_ops`),
    index("contacts_phone_trgm").using("gin", sql`${t.phoneNormalized} gin_trgm_ops`),
    index("contacts_company_trgm").using("gin", sql`lower(${t.company}) gin_trgm_ops`),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    color: text("color").notNull().default("neutral"),
    createdAt: createdAt(),
  },
  (t) => [unique("tags_ws_id").on(t.workspaceId, t.id), unique("tags_ws_name").on(t.workspaceId, t.name)],
);

export const contactTags = pgTable(
  "contact_tags",
  {
    workspaceId: workspaceId(),
    contactId: uuid("contact_id").notNull(),
    tagId: uuid("tag_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.contactId, t.tagId] }),
    foreignKey({ columns: [t.workspaceId, t.contactId], foreignColumns: [contacts.workspaceId, contacts.id] }),
    foreignKey({ columns: [t.workspaceId, t.tagId], foreignColumns: [tags.workspaceId, tags.id] }).onDelete("cascade"),
    index("contact_tags_tag_idx").on(t.workspaceId, t.tagId),
  ],
);

export const customFieldType = pgEnum("custom_field_type", ["text", "number", "date", "select", "multiselect", "boolean", "url"]);

export const customFieldDefinitions = pgTable(
  "custom_field_definitions",
  {
    id: id(),
    workspaceId: workspaceId(),
    entityType: text("entity_type").notNull().default("contact"),
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: customFieldType("type").notNull(),
    options: jsonb("options").notNull().default([]),
    required: integer("required").notNull().default(0),
    position: integer("position").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [unique("custom_fields_ws_key").on(t.workspaceId, t.entityType, t.key)],
);

export const notes = pgTable(
  "notes",
  {
    id: id(),
    workspaceId: workspaceId(),
    contactId: uuid("contact_id").notNull(),
    authorUserId: text("author_user_id").notNull().references(() => user.id),
    body: text("body").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.contactId], foreignColumns: [contacts.workspaceId, contacts.id] }),
    index("notes_contact_idx").on(t.workspaceId, t.contactId, t.id),
  ],
);

/** User-visible contact timeline. Append-only for the application role. */
export const activities = pgTable(
  "activities",
  {
    id: id(),
    workspaceId: workspaceId(),
    contactId: uuid("contact_id").notNull(),
    /** Set for lead timeline entries; contactId is then the lead's primary contact (activities.contact_id is NOT NULL). */
    leadId: uuid("lead_id"),
    kind: text("kind").notNull(),
    actorType: text("actor_type").notNull().default("user"),
    actorUserId: text("actor_user_id"),
    data: jsonb("data").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.contactId], foreignColumns: [contacts.workspaceId, contacts.id] }),
    index("activities_contact_idx").on(t.workspaceId, t.contactId, t.id),
    foreignKey({ columns: [t.workspaceId, t.leadId], foreignColumns: [leads.workspaceId, leads.id] }),
    index("activities_lead_idx").on(t.workspaceId, t.leadId, t.id).where(sql`${t.leadId} IS NOT NULL`),
  ],
);

/** Saved table configuration. userId null means shared with the whole workspace (admins only). */
export const savedViews = pgTable(
  "saved_views",
  {
    id: id(),
    workspaceId: workspaceId(),
    userId: text("user_id").references(() => user.id),
    entityType: text("entity_type").notNull().default("contact"),
    name: text("name").notNull(),
    config: jsonb("config").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("saved_views_ws_idx").on(t.workspaceId, t.entityType)],
);

export const importStatus = pgEnum("import_status", ["uploaded", "committed", "failed"]);

export const importJobs = pgTable("import_jobs", {
  id: id(),
  workspaceId: workspaceId(),
  entityType: text("entity_type").notNull().default("contact"),
  filename: text("filename").notNull(),
  csv: text("csv").notNull(),
  status: importStatus("status").notNull().default("uploaded"),
  summary: jsonb("summary"),
  createdBy: text("created_by").notNull().references(() => user.id),
  createdAt: createdAt(),
  committedAt: timestamp("committed_at", { withTimezone: true }),
});

/** Phones and emails of a contact with provenance. The legacy contacts.phone/email remain the human-entered primary values; see migration 0022. */
export const contactMethods = pgTable(
  "contact_methods",
  {
    id: id(),
    workspaceId: workspaceId(),
    contactId: uuid("contact_id").notNull(),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    rawValue: text("raw_value"),
    source: text("source").notNull(),
    sourceConversationId: uuid("source_conversation_id"),
    sourceMessageId: uuid("source_message_id"),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default("1"),
    verified: boolean("verified").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: text("verified_by"),
    isPrimary: boolean("is_primary").notNull().default(false),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
    correctedBy: text("corrected_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("contact_methods_unique").on(t.workspaceId, t.contactId, t.kind, t.value),
    foreignKey({ columns: [t.workspaceId, t.contactId], foreignColumns: [contacts.workspaceId, contacts.id] }).onDelete("cascade"),
    check("contact_methods_kind", sql`${t.kind} IN ('phone','email')`),
    check("contact_methods_source", sql`${t.source} IN ('messenger','instagram','manual','import','other')`),
    check("contact_methods_confidence", sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
    check("contact_methods_value_len", sql`length(${t.value}) BETWEEN 3 AND 254 AND (raw_value IS NULL OR length(raw_value) <= 200)`),
    index("contact_methods_contact_idx").on(t.workspaceId, t.contactId),
    index("contact_methods_value_idx").on(t.workspaceId, t.kind, t.value),
    uniqueIndex("contact_methods_one_primary").on(t.workspaceId, t.contactId, t.kind).where(sql`${t.isPrimary}`),
  ],
);
