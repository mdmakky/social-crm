import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@crm/db";
import { recordActivity } from "../../crm-service.ts";
import { PermanentError } from "../../automation/actions.ts";
import { tool } from "./context.ts";

/** write: adds an internal note to the contact in context. Notes are never sent to the customer. */
export const addNote = tool({
  name: "crm.add_note",
  description: "Add an internal note (not visible to the customer) to the current contact.",
  argsSchema: z.object({ body: z.string().trim().min(1).max(2000) }).strict(),
  sensitivity: "write",
  requiredPermission: "contact.edit",
  async execute({ tx, workspaceId, userId, contactId, ref }, { body }) {
    if (!contactId) throw new PermanentError("There is no contact in this context.");
    const [c] = await tx.select({ id: schema.contacts.id }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), eq(schema.contacts.id, contactId), isNull(schema.contacts.deletedAt)));
    if (!c) throw new PermanentError("The contact no longer exists.");
    const [n] = await tx.insert(schema.notes).values({ workspaceId, contactId, authorUserId: userId, body }).returning({ id: schema.notes.id });
    await recordActivity(tx, { workspaceId, contactId, kind: "note.added", actorUserId: userId, data: { noteId: n!.id, preview: body.slice(0, 120), via: "ai_agent", ref } });
    return { noteId: n!.id, contactId };
  },
});
