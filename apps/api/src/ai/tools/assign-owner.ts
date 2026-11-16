import { z } from "zod";
import { runAction } from "../../automation/actions.ts";
import { tool } from "./context.ts";

/** sensitive: changing who owns a contact always waits for a human, whatever the grant says. */
export const assignOwner = tool({
  name: "crm.assign_owner",
  description: "Assign the current contact to a workspace member (by user id). Always needs human approval.",
  argsSchema: z.object({ ownerUserId: z.string().trim().min(1).max(100) }).strict(),
  sensitivity: "sensitive",
  requiredPermission: "contact.edit",
  execute: (c, a) => runAction({ tx: c.tx, workspaceId: c.workspaceId, actorUserId: c.userId, runId: c.ref, contactId: c.contactId }, { type: "assign_owner", ...a }),
});
