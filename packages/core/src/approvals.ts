import { can, type Role } from "./permissions.ts";

/** Pure helpers for the approvals queue (mobile and any other client). Structural types so this file does not depend on @crm/contracts. */
export type ApprovalAction = { type: "create_task"; title: string } | { type: "add_tag"; tagName: string } | { type: "assign_owner"; ownerUserId: string };

/** Only owner/admin may approve or reject runs (`approval.decide`). Agents and viewers get a read-only list. */
export const canDecideApprovals = (role: Role): boolean => can(role, "approval.decide", {});

export const describeApprovalAction = (a: ApprovalAction, memberName?: (id: string) => string | undefined): string =>
  a.type === "create_task" ? `Create task "${a.title}"` : a.type === "add_tag" ? `Add tag "${a.tagName}"` : `Assign owner ${memberName?.(a.ownerUserId) ?? "(unknown member)"}`;

export const summarizeApprovalActions = (actions: ApprovalAction[], memberName?: (id: string) => string | undefined): string =>
  actions.length === 0 ? "No actions" : actions.map((a) => describeApprovalAction(a, memberName)).join(", ");

// Mirrors AUTOMATION_TRIGGERS in @crm/contracts (keep in sync; unknown triggers fall back to the raw key).
export const TRIGGER_LABELS: Record<string, string> = {
  "contact.created": "A contact is created",
  "lead.stage_changed": "A lead moves to another stage",
  "contact.owner_assigned": "A contact gets an owner",
  "lead.owner_assigned": "A lead gets an owner",
};
export const triggerLabel = (t: string): string => TRIGGER_LABELS[t] ?? t;
