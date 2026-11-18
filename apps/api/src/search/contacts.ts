import { sql } from "drizzle-orm";
import { escapeLike } from "@crm/core";
import { can } from "@crm/core/permissions";
import { filters } from "../contact-query.ts";
import type { SearchProvider } from "./types.ts";

type Row = { id: string; name: string; email: string | null; phone: string | null; company: string | null };

/** Same matching as the contacts list `search` filter; ranked: exact email/phone, then name prefix, then substring, ties by recency. */
export const contactsProvider: SearchProvider = {
  type: "contacts",
  label: "Leads",
  requires: (role) => can(role, "contact.view", {}),
  async search(tx, ctx, query, limit) {
    const f = filters(ctx.workspaceId, ctx.userId, { search: query });
    const q = query.trim().toLowerCase();
    const digits = /^[+\d\s().-]+$/.test(q) ? q.replace(/\D/g, "") : "";
    const exactPhone = digits.length >= 3 ? sql`c.phone_normalized = ${digits}` : sql`false`;
    const rank = sql`CASE WHEN c.email_normalized = ${q} OR ${exactPhone} THEN 0 WHEN lower(c.name) LIKE ${escapeLike(q) + "%"} ESCAPE '\\' THEN 1 ELSE 2 END`;
    const rows = (await tx.execute(sql`SELECT c.id, c.name, c.email, c.phone, c.company FROM contacts c WHERE ${sql.join(f.where, sql` AND `)} ORDER BY ${rank}, c.last_activity_at DESC, c.id LIMIT ${limit}`)).rows as Row[];
    return rows.map((r) => ({
      id: r.id,
      type: "contacts",
      title: r.name,
      subtitle: [r.email, r.phone, r.company].filter(Boolean).join(" · ") || undefined,
      href: `/w/${ctx.workspaceId}/contacts/${r.id}`,
      meta: Object.fromEntries(Object.entries({ email: r.email, phone: r.phone, company: r.company }).filter((e): e is [string, string] => !!e[1])),
    }));
  },
};
