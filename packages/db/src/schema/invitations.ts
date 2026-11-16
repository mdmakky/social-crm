import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "../auth-schema.ts";
import { workspaceRole, workspaces } from "./tenancy.ts";

/** Hand-written migration 0035 is the source of truth; this mirrors it for typed queries. Only the SHA-256 of the token is stored. */
export const workspaceInvitations = pgTable(
  "workspace_invitations",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    email: text("email").notNull(),
    role: workspaceRole("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status").notNull().default("pending"),
    invitedBy: text("invited_by").notNull().references(() => user.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now() + interval '7 days'`),
    acceptedBy: text("accepted_by").references(() => user.id),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workspace_invitations_pending_uq").on(t.workspaceId, t.email).where(sql`${t.status} = 'pending'`), index("workspace_invitations_list_idx").on(t.workspaceId, t.createdAt.desc(), t.id.desc())],
);
