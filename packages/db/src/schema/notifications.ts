import { sql } from "drizzle-orm";
import { bigint, boolean, index, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "../auth-schema.ts";
import { workspaces } from "./tenancy.ts";

const workspaceId = () => uuid("workspace_id").notNull().references(() => workspaces.id);

/** Durable, append-only event log (architecture B1/B2). `seq` is gapless per workspace via workspace_event_counters. */
export const domainEvents = pgTable(
  "domain_events",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: workspaceId(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    actorUserId: text("actor_user_id"),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("domain_events_ws_seq").on(t.workspaceId, t.seq), index("domain_events_created_idx").on(t.createdAt)],
);

/** One row per workspace; incremented with UPDATE ... RETURNING in the emitting transaction, so the row lock serializes seq assignment. */
export const workspaceEventCounters = pgTable("workspace_event_counters", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
});

/** Per (consumer, workspace) offset; advanced in the same transaction as the consumer's effects. */
export const eventConsumers = pgTable(
  "event_consumers",
  {
    consumer: text("consumer").notNull(),
    workspaceId: workspaceId(),
    lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.consumer, t.workspaceId] })],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: workspaceId(),
    userId: text("user_id").notNull().references(() => user.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    data: jsonb("data").notNull().default({}),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    unique("notifications_dedupe").on(t.workspaceId, t.userId, t.dedupeKey),
    index("notifications_user_idx").on(t.workspaceId, t.userId, t.id),
    index("notifications_unread_idx").on(t.workspaceId, t.userId).where(sql`read_at IS NULL`),
  ],
);

/** Per-kind delivery preference. Defaults on when no row exists. Channel extension point: add `email`/`push` boolean columns beside `in_app`. */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    workspaceId: workspaceId(),
    userId: text("user_id").notNull().references(() => user.id),
    kind: text("kind").notNull(),
    inApp: boolean("in_app").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId, t.kind] })],
);
