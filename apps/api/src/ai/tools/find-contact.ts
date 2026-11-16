import { and, eq, ilike, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@crm/db";
import { tool } from "./context.ts";

/** read: finds contacts by name, email or phone fragment. Returns ids and names only. */
export const findContact = tool({
  name: "crm.find_contact",
  description: "Find contacts by name, email or phone fragment. Returns up to 5 matches (id and name).",
  argsSchema: z.object({ query: z.string().trim().min(2).max(80) }).strict(),
  sensitivity: "read",
  requiredPermission: "contact.view",
  async execute({ tx, workspaceId }, { query }) {
    const like = `%${query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = await tx.select({ id: schema.contacts.id, name: schema.contacts.name }).from(schema.contacts)
      .where(and(eq(schema.contacts.workspaceId, workspaceId), isNull(schema.contacts.deletedAt), or(ilike(schema.contacts.name, like), ilike(schema.contacts.email, like), ilike(schema.contacts.phone, like))))
      .limit(5);
    return { matches: rows };
  },
});
