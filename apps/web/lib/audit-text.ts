import type { AuditEntry } from "@crm/contracts";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const ROLE: Record<string, string> = { owner: "owner", admin: "admin", agent: "agent", viewer: "viewer" };

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
    default: return `${who}: ${e.action}`;
  }
}
