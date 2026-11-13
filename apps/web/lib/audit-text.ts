import type { AuditEntry } from "@crm/contracts";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const ROLE: Record<string, string> = { owner: "owner", admin: "admin", agent: "agent", viewer: "viewer" };

/** Plain verbs for audit actions whose summary needs no extra detail. Anything not listed falls back to the raw key. */
const KNOWN: Record<string, string> = {
  "auth.password_reset": "reset their password", "contact.deleted": "deleted a contact", "data.exported": "exported data", "data.imported": "imported data",
  "lead.created": "created a lead", "lead.updated": "updated a lead", "lead.deleted": "deleted a lead", "lead.restored": "restored a lead",
  "lead.value_access_granted": "granted deal value access", "lead.value_access_revoked": "revoked deal value access",
  "custom_field.created": "added a custom field", "custom_field.updated": "updated a custom field", "lifecycle_stage.created": "added a lifecycle stage", "lifecycle_stage.reordered": "reordered lifecycle stages",
  "lost_reason.created": "added a lost reason", "lost_reason.updated": "updated a lost reason", "tag.deleted": "deleted a tag",
  "pipeline.created": "created a pipeline", "pipeline.updated": "updated a pipeline", "pipeline.archived": "archived a pipeline",
  "pipeline.stage_created": "added a pipeline stage", "pipeline.stage_updated": "updated a pipeline stage", "pipeline.stage_archived": "archived a pipeline stage", "pipeline.stages_reordered": "reordered pipeline stages",
};

/** Human sentence for an audit entry. Unknown actions fall back to the raw action key so nothing is hidden. */
export function describeAudit(e: Pick<AuditEntry, "action" | "actorName" | "summary">): string {
  const who = e.actorName ?? "System";
  const s = e.summary;
  switch (e.action) {
    case "workspace.created": return `${who} created the workspace`;
    case "workspace.updated": {
      const parts = [s.name !== undefined ? "name" : "", s.timezone !== undefined ? "time zone" : ""].filter(Boolean);
      return `${who} updated the workspace ${parts.join(" and ") || "settings"}`;
    }
    case "member.role_changed": return `${who} changed ${str(s.name) || "a member"}'s role from ${ROLE[str(s.from)] ?? str(s.from)} to ${ROLE[str(s.to)] ?? str(s.to)}`;
    case "member.removed": return `${who} removed ${str(s.name) || "a member"} from the workspace`;
    default: return KNOWN[e.action] ? `${who} ${KNOWN[e.action]}` : `${who}: ${e.action}`;
  }
}
