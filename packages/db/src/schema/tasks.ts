import { sql } from "drizzle-orm";
import { foreignKey, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "../auth-schema.ts";
import { contacts } from "./crm.ts";
import { workspaces } from "./tenancy.ts";

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const workspaceId = () => uuid("workspace_id").notNull().references(() => workspaces.id);

/** open and in_progress are "active"; done and cancelled are closed. Only done sets completed_at. */
export const taskStatus = pgEnum("task_status", ["open", "done", "in_progress", "cancelled"]);
/** Declaration order is the sort order (low < normal < high < urgent), so ORDER BY priority works and is indexable. */
export const taskPriority = pgEnum("task_priority", ["low", "normal", "high", "urgent"]);
/** Allow-list of link targets. Adding an entity is one new value here plus one CHECK/validation trigger; see docs/architecture/tasks.md. */
export const TASK_LINK_ENTITY_TYPES = ["contact", "lead"] as const;

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    workspaceId: workspaceId(),
    /** Optional primary related contact (composite FK keeps it in the same workspace). */
    contactId: uuid("contact_id"),
    title: text("title").notNull(),
    description: text("description"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    status: taskStatus("status").notNull().default("open"),
    priority: taskPriority("priority").notNull().default("normal"),
    assigneeUserId: text("assignee_user_id").references(() => user.id),
    createdBy: text("created_by").notNull().references(() => user.id),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete: task_events is append-only and must keep its parent row. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    unique("tasks_ws_id").on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.contactId], foreignColumns: [contacts.workspaceId, contacts.id] }),
    index("tasks_contact_idx").on(t.workspaceId, t.contactId, t.status),
    index("tasks_assignee_due_idx").on(t.workspaceId, t.assigneeUserId, t.status, t.dueAt),
    // Expression indexes match the list's "due date, undated last in both directions" ordering exactly.
    index("tasks_ws_due_idx").on(t.workspaceId, sql`coalesce(${t.dueAt}, 'infinity'::timestamptz)`, t.id),
    index("tasks_ws_due_desc_idx").on(t.workspaceId, sql`coalesce(${t.dueAt}, '-infinity'::timestamptz) DESC`, sql`${t.id} DESC`),
    index("tasks_ws_created_idx").on(t.workspaceId, t.createdAt.desc(), t.id),
    index("tasks_ws_updated_idx").on(t.workspaceId, t.updatedAt.desc(), t.id),
    index("tasks_ws_priority_idx").on(t.workspaceId, t.priority, t.id),
  ],
);

/** Generic task to entity links. tasks.contact_id stays the canonical contact link and is mirrored here by a trigger. */
export const taskLinks = pgTable(
  "task_links",
  {
    workspaceId: workspaceId(),
    taskId: uuid("task_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.taskId, t.entityType, t.entityId] }),
    foreignKey({ columns: [t.workspaceId, t.taskId], foreignColumns: [tasks.workspaceId, tasks.id] }),
    index("task_links_entity_idx").on(t.workspaceId, t.entityType, t.entityId),
  ],
);

export const TASK_EVENT_KINDS = ["created", "updated", "status_changed", "completed", "reopened", "assignee_changed", "due_date_changed", "priority_changed", "contact_changed", "deleted"] as const;

/** Immutable task history. Append-only for every role including the table owner (trigger), like activities. */
export const taskEvents = pgTable(
  "task_events",
  {
    id: id(),
    workspaceId: workspaceId(),
    taskId: uuid("task_id").notNull(),
    kind: text("kind").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id),
    /** { from, to } for changes; for "updated" the list of changed fields. */
    data: jsonb("data").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.taskId], foreignColumns: [tasks.workspaceId, tasks.id] }),
    index("task_events_task_idx").on(t.workspaceId, t.taskId, t.id),
  ],
);
