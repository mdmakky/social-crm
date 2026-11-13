import { sql } from "drizzle-orm";
import { escapeLike } from "@crm/core";
import { can } from "@crm/core/permissions";
import type { SearchProvider } from "./types.ts";

type Row = { id: string; title: string; contact_name: string; stage_name: string; outcome: string };

/**
 * Title substring match, prefix first. Soft-deleted leads are excluded; leads of deleted contacts stay searchable (read-only history).
 * Deal value is deliberately never selected or returned: search results must not leak what a viewer may not see.
 */
export const leadsProvider: SearchProvider = {
  type: "leads",
  label: "Leads",
  requires: (role) => can(role, "lead.view", {}),
  async search(tx, ctx, query, limit) {
    const q = query.trim().toLowerCase();
    const rows = (await tx.execute(sql`SELECT l.id, l.title, c.name AS contact_name, s.name AS stage_name, l.outcome
      FROM leads l JOIN contacts c ON c.workspace_id = l.workspace_id AND c.id = l.primary_contact_id JOIN pipeline_stages s ON s.workspace_id = l.workspace_id AND s.id = l.stage_id
      WHERE l.workspace_id = ${ctx.workspaceId} AND l.deleted_at IS NULL AND l.title ILIKE ${"%" + escapeLike(q) + "%"} ESCAPE '\\'
      ORDER BY CASE WHEN lower(l.title) LIKE ${escapeLike(q) + "%"} ESCAPE '\\' THEN 0 ELSE 1 END, l.updated_at DESC, l.id LIMIT ${limit}`)).rows as Row[];
    return rows.map((r) => ({
      id: r.id,
      type: "leads",
      title: r.title,
      subtitle: [r.contact_name, r.stage_name].join(" · "),
      href: `/w/${ctx.workspaceId}/leads/${r.id}`,
      meta: { contact: r.contact_name, stage: r.stage_name, outcome: r.outcome },
    }));
  },
};
