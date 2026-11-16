import { z } from "zod";
import { endpoint } from "./endpoint.ts";

export const INVITATION_TTL_DAYS = 7;
export const MAX_PENDING_INVITATIONS = 100;
const InviteRole = z.enum(["admin", "agent", "viewer"]);
export const INVITATION_STATUSES = ["pending", "accepted", "revoked", "expired"] as const;

export const CreateInvitationBody = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: InviteRole });
export type CreateInvitationBody = z.infer<typeof CreateInvitationBody>;

/** Never carries the token: the raw token exists only in the create and resend responses. `status` is "expired" when a pending invitation is past its expiry. */
export const InvitationDto = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: InviteRole,
  status: z.enum(INVITATION_STATUSES),
  invitedByName: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
  acceptedAt: z.string().nullable(),
});
export type InvitationDto = z.infer<typeof InvitationDto>;

/** One-time secret link; `emailSent` is true only when a mailer is configured and accepted the message. */
export const InvitationIssued = z.object({ invitation: InvitationDto, link: z.string(), emailSent: z.boolean() });
export type InvitationIssued = z.infer<typeof InvitationIssued>;

export const InvitationPreview = z.object({ workspaceName: z.string(), role: InviteRole, inviterName: z.string(), emailMasked: z.string(), expiresAt: z.string() });
export type InvitationPreview = z.infer<typeof InvitationPreview>;

export const AcceptInvitationBody = z.object({ token: z.string().min(20).max(200) });
export const AcceptInvitationResponse = z.object({ workspaceId: z.string().uuid(), role: z.enum(["owner", "admin", "agent", "viewer"]) });

export const invitationEndpoints = {
  listInvitations: endpoint({ method: "GET", path: "/v1/workspaces/:workspaceId/invitations", response: z.array(InvitationDto) }),
  createInvitation: endpoint({ method: "POST", path: "/v1/workspaces/:workspaceId/invitations", body: CreateInvitationBody, response: InvitationIssued }),
  revokeInvitation: endpoint({ method: "POST", path: "/v1/workspaces/:workspaceId/invitations/:invitationId/revoke", response: InvitationDto }),
  resendInvitation: endpoint({ method: "POST", path: "/v1/workspaces/:workspaceId/invitations/:invitationId/resend", response: InvitationIssued }),
  previewInvitation: endpoint({ method: "GET", path: "/v1/invitations/preview", query: z.object({ token: z.string().min(1).max(200) }), response: InvitationPreview }),
  acceptInvitation: endpoint({ method: "POST", path: "/v1/invitations/accept", body: AcceptInvitationBody, response: AcceptInvitationResponse }),
} as const;
