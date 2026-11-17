import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "../auth-schema.ts";
import { workspaces } from "./tenancy.ts";

/** Hand-written migration 0038 is the source of truth (constraints, RLS, the key lookup function); this mirrors the columns for typed queries. */
export const chatWidgets = pgTable("chat_widgets", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  integrationAccountId: uuid("integration_account_id").notNull(),
  publicKey: text("public_key").notNull().unique(),
  name: text("name").notNull(),
  allowedOrigins: text("allowed_origins").array().notNull().default(sql`'{}'::text[]`),
  enabled: boolean("enabled").notNull().default(true),
  greeting: text("greeting"),
  offlineMessage: text("offline_message"),
  color: text("color").notNull().default("#2563eb"),
  prechatForm: boolean("prechat_form").notNull().default(false),
  createdBy: text("created_by").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** An anonymous visitor's session. Only the SHA-256 of the token is stored. */
export const chatVisitorSessions = pgTable("chat_visitor_sessions", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  widgetId: uuid("widget_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  visitorRef: text("visitor_ref").notNull(),
  contactId: uuid("contact_id"),
  conversationId: uuid("conversation_id"),
  ipHash: text("ip_hash"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now() + interval '30 days'`),
});
