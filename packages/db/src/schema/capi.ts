import { sql } from "drizzle-orm";
import { customType, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./tenancy.ts";

// Hand-written migration 0026 is the source of truth (checks, RLS, triggers); these definitions only type the columns.
const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const workspaceId = () => uuid("workspace_id").notNull().references(() => workspaces.id);
const ts = (n: string) => timestamp(n, { withTimezone: true });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const CAPI_EVENT_STATUSES = ["pending", "sent", "failed", "skipped_no_consent"] as const;

export const capiDatasets = pgTable("capi_datasets", {
  id: id(),
  workspaceId: workspaceId(),
  datasetId: text("dataset_id").notNull(),
  name: text("name").notNull(),
  mode: text("mode").notNull().default("mock"),
  status: text("status").notNull().default("active"),
  testEventCode: text("test_event_code"),
  events: text("events").array().notNull().default(sql`'{}'`),
  tokenLast4: text("token_last4").notNull(),
  createdBy: text("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Sealed dataset access token. The application role can INSERT but never read it; only the worker role does. */
export const capiDatasetSecrets = pgTable("capi_dataset_secrets", {
  id: id(),
  workspaceId: workspaceId(),
  datasetId: uuid("dataset_id").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  nonce: bytea("nonce").notNull(),
  keyId: text("key_id").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const consentRecords = pgTable("consent_records", {
  id: id(),
  workspaceId: workspaceId(),
  contactId: uuid("contact_id").notNull(),
  purpose: text("purpose").notNull().default("ad_measurement"),
  status: text("status").notNull(),
  source: text("source").notNull(),
  recordedBy: text("recorded_by"),
  recordedAt: ts("recorded_at").notNull().defaultNow(),
});

export const capiEvents = pgTable("capi_events", {
  id: id(),
  workspaceId: workspaceId(),
  datasetId: uuid("dataset_id").notNull(),
  contactId: uuid("contact_id"),
  eventName: text("event_name").notNull(),
  eventId: text("event_id").notNull(),
  crmEventRef: text("crm_event_ref").notNull(),
  eventTime: ts("event_time").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
  lastError: text("last_error"),
  fbtraceId: text("fbtrace_id"),
  sentAt: ts("sent_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
