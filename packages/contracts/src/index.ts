import { z } from "zod";

export const Role = z.enum(["owner", "admin", "agent", "viewer"]);
export type Role = z.infer<typeof Role>;

export const MeResponse = z.object({ id: z.string(), email: z.string().email(), name: z.string() });
export type MeResponse = z.infer<typeof MeResponse>;

export const ApiError = z.object({ error: z.object({ code: z.string(), message: z.string().optional() }) });
export type ApiError = z.infer<typeof ApiError>;

export const WorkspaceName = z.string().trim().min(2, "Use at least 2 characters").max(60, "Use at most 60 characters");

export const CreateWorkspaceBody = z.object({ name: WorkspaceName });
export type CreateWorkspaceBody = z.infer<typeof CreateWorkspaceBody>;

export const UpdateWorkspaceBody = z.object({ name: WorkspaceName.optional(), timezone: z.string().min(1).max(64).optional() }).refine((v) => v.name !== undefined || v.timezone !== undefined, "Nothing to update");
export type UpdateWorkspaceBody = z.infer<typeof UpdateWorkspaceBody>;

export const WorkspaceSummary = z.object({ id: z.string().uuid(), name: z.string(), slug: z.string(), role: Role });
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const WorkspaceDetail = WorkspaceSummary.extend({ timezone: z.string(), memberCount: z.number().int(), createdAt: z.string() });
export type WorkspaceDetail = z.infer<typeof WorkspaceDetail>;

export const Member = z.object({ userId: z.string(), name: z.string(), email: z.string(), role: Role, status: z.enum(["active", "deactivated"]), joinedAt: z.string() });
export type Member = z.infer<typeof Member>;

export const UpdateMemberBody = z.object({ role: Role });
export type UpdateMemberBody = z.infer<typeof UpdateMemberBody>;

export const AuditEntry = z.object({
  id: z.string(),
  action: z.string(),
  actorUserId: z.string().nullable(),
  actorName: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  summary: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
export const AuditPage = z.object({ items: z.array(AuditEntry), nextCursor: z.string().nullable() });
export type AuditPage = z.infer<typeof AuditPage>;
