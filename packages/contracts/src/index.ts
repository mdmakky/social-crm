import { z } from "zod";
import { endpoint } from "./endpoint.ts";
import { crmEndpoints } from "./crm.ts";
// --- track:tasks ---
import { tasksEndpoints } from "./tasks.ts";

export * from "./endpoint.ts";
export * from "./crm.ts";
// --- track:tasks ---
export * from "./tasks.ts";

export const PASSWORD_MIN_LENGTH = 10;
export const RESET_TOKEN_TTL_SECONDS = 30 * 60;

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

export const OkResponse = z.object({ ok: z.literal(true) });
export const MemberRoleResponse = z.object({ userId: z.string(), role: Role });
export const AuditQuery = z.object({ limit: z.number().int().min(1).max(100).optional(), cursor: z.string().uuid().optional() });

/**
 * Every public /v1 route. The API test suite fails if a route exists without an entry here (or the reverse),
 * and the typed client in @crm/api-client is the only way the apps call the API.
 */
const coreEndpoints = {
  me: endpoint({ method: "GET", path: "/v1/me", response: MeResponse }),
  listWorkspaces: endpoint({ method: "GET", path: "/v1/workspaces", response: z.array(WorkspaceSummary) }),
  createWorkspace: endpoint({ method: "POST", path: "/v1/workspaces", body: CreateWorkspaceBody, response: WorkspaceSummary }),
  getWorkspace: endpoint({ method: "GET", path: "/v1/workspaces/:workspaceId", response: WorkspaceDetail }),
  updateWorkspace: endpoint({ method: "PATCH", path: "/v1/workspaces/:workspaceId", body: UpdateWorkspaceBody, response: OkResponse }),
  listMembers: endpoint({ method: "GET", path: "/v1/workspaces/:workspaceId/members", response: z.array(Member) }),
  updateMember: endpoint({ method: "PATCH", path: "/v1/workspaces/:workspaceId/members/:userId", body: UpdateMemberBody, response: MemberRoleResponse }),
  removeMember: endpoint({ method: "DELETE", path: "/v1/workspaces/:workspaceId/members/:userId", response: z.undefined() }),
  auditLog: endpoint({ method: "GET", path: "/v1/workspaces/:workspaceId/audit-log", query: AuditQuery, response: AuditPage }),
} as const;

export const endpoints = { ...coreEndpoints, ...crmEndpoints, ...tasksEndpoints } as const;
