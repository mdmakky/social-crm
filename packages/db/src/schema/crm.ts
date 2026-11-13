import { sql } from "drizzle-orm";
import { foreignKey, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "../auth-schema.ts";
import { workspaces } from "./tenancy.ts";

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
    kind: text("kind").notNull(),
    actorType: text("actor_type").notNull().default("user"),
    actorUserId: text("actor_user_id"),
    data: jsonb("data").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.contactId], foreignColumns: [contacts.workspaceId, contacts.id] }),
    index("activities_contact_idx").on(t.workspaceId, t.contactId, t.id),
  ],
);

export const taskStatus = pgEnum("task_status", ["open", "done"]);

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    workspaceId: workspaceId(),
    contactId: uuid("contact_id").notNull(),
    title: text("title").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    status: taskStatus("status").notNull().default("open"),
    assigneeUserId: text("assignee_user_id").references(() => user.id),
    createdBy: text("created_by").notNull().references(() => user.id),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.contactId], foreignColumns: [contacts.workspaceId, contacts.id] }),
    index("tasks_contact_idx").on(t.workspaceId, t.contactId, t.status),
    index("tasks_assignee_due_idx").on(t.workspaceId, t.assigneeUserId, t.status, t.dueAt),
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
