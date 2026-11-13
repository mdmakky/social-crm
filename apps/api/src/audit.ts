import { schema, type Tx } from "@crm/db";

export type AuditInput = {
  workspaceId: string;
  actorUserId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  summary?: Record<string, unknown>;
  requestId?: string;
  ip?: string;
};

/** Writes inside the caller's transaction so the audit entry commits or rolls back with the change. */
export async function writeAudit(tx: Tx, e: AuditInput) {
  await tx.insert(schema.auditLog).values({
    workspaceId: e.workspaceId,
    actorUserId: e.actorUserId,
    action: e.action,
    entityType: e.entityType ?? null,
    entityId: e.entityId ?? null,
    summary: e.summary ?? {},
    requestId: e.requestId ?? null,
    ip: e.ip ?? null,
  });
}
