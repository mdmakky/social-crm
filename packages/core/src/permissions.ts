export const ROLES = ["owner", "admin", "agent", "viewer"] as const;
export type Role = (typeof ROLES)[number];

type Rule = true | false | "self" | "own" | "named" | "granted";
const A = (owner: Rule, admin: Rule, agent: Rule, viewer: Rule): Record<Role, Rule> => ({ owner, admin, agent, viewer });

/** Source of truth for docs/architecture/permissions.md. A string rule means "allowed when the qualifier holds". */
const MATRIX = {
  "workspace.view": A(true, true, true, true),
  "contact.view": A(true, true, true, true),
  "contact.edit": A(true, true, true, false),
  "contact.delete": A(true, true, false, false),
  "note.edit": A(true, true, "own", false),
  "view.share": A(true, true, false, false),
  "conversation.view": A(true, true, true, true),
  "conversation.reply": A(true, true, true, false),
  "conversation.assign": A(true, true, "self", false),
  "lead.view": A(true, true, true, true),
  "lead.edit": A(true, true, true, false),
  "lead.delete": A(true, true, false, false),
  "lead.reopen": A(true, true, false, false),
  /** Lead value: owner/admin always; an agent only with an explicit per-lead grant (isGranted); viewers never. */
  "lead.value.view": A(true, true, "granted", false),
  "lead.value.edit": A(true, true, "granted", false),
  "task.edit": A(true, true, "own", false),
  "data.import": A(true, true, false, false),
  "data.export": A(true, true, false, false),
  "schema.manage": A(true, true, false, false),
  "integration.manage": A(true, true, false, false),
  "integration.view": A(true, true, true, false),
  "capi.manage": A(true, true, false, false),
  "capi.view": A(true, true, false, false),
  "workflow.manage": A(true, true, false, false),
  "approval.decide": A(true, true, "named", false),
  "ai.configure": A(true, true, false, false),
  "ai.use": A(true, true, true, false),
  "member.invite": A(true, true, false, false),
  "member.manage": A(true, true, false, false),
  "workspace.settings": A(true, true, false, false),
  "workspace.transfer": A(true, false, false, false),
  "workspace.delete": A(true, false, false, false),
  "audit.view": A(true, true, false, false),
  "consent.edit": A(true, true, true, false),
  "dsr.manage": A(true, true, false, false),
} as const satisfies Record<string, Record<Role, Rule>>;

export type Action = keyof typeof MATRIX;
export const ACTIONS = Object.keys(MATRIX) as Action[];
export type Qualifiers = { isSelf?: boolean; isOwn?: boolean; isNamedApprover?: boolean; isGranted?: boolean };

export function can(role: Role, action: Action, q: Qualifiers): boolean {
  const rule: Rule = MATRIX[action][role];
  if (typeof rule === "boolean") return rule;
  return rule === "self" ? !!q.isSelf : rule === "own" ? !!q.isOwn : rule === "granted" ? !!q.isGranted : !!q.isNamedApprover;
}

export type MemberChange = { role: Role } | { remove: true };
export type MemberDecision = { ok: true } | { ok: false; reason: "not_allowed" | "admin_cannot_change_owner" | "admin_cannot_grant_owner" | "last_owner" };

export function memberChangeAllowed(i: { actor: Role; target: Role; change: MemberChange; ownerCount: number }): MemberDecision {
  if (!can(i.actor, "member.manage", {})) return { ok: false, reason: "not_allowed" };
  if (i.actor === "admin" && i.target === "owner") return { ok: false, reason: "admin_cannot_change_owner" };
  if (i.actor === "admin" && "role" in i.change && i.change.role === "owner") return { ok: false, reason: "admin_cannot_grant_owner" };
  const demotesOwner = i.target === "owner" && ("remove" in i.change || i.change.role !== "owner");
  if (demotesOwner && i.ownerCount <= 1) return { ok: false, reason: "last_owner" };
  return { ok: true };
}
