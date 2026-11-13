import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { schema, withContext, type Db } from "@crm/db";
import { writeAudit } from "./audit.ts";

/** Only the newest reset link works: remove every other pending reset token for this user. */
export async function invalidateOtherResetTokens(db: Db, userId: string, currentToken: string) {
  await db.execute(sql`DELETE FROM verification WHERE value = ${userId} AND identifier LIKE 'reset-password:%' AND identifier <> ${`reset-password:${currentToken}`}`);
}

/** The audit log is per workspace, so record the reset in every workspace the user belongs to. */
export async function auditPasswordReset(db: Db, userId: string) {
  const workspaces = await withContext(db, { userId }, (tx) => tx.select({ id: schema.memberships.workspaceId }).from(schema.memberships).where(eq(schema.memberships.userId, userId)));
  for (const w of workspaces) {
    await withContext(db, { userId, workspaceId: w.id }, (tx) => writeAudit(tx, { workspaceId: w.id, actorUserId: userId, action: "auth.password_reset", entityType: "user", entityId: userId }));
  }
}

export const resetEmail = (url: string, ttlMinutes: number) => ({
  subject: "Reset your Social CRM password",
  text: `Someone asked to reset the password for this account.\n\nOpen this link within ${ttlMinutes} minutes to choose a new password:\n${url}\n\nIf you didn't ask for this, ignore this email. Your password won't change.`,
});
