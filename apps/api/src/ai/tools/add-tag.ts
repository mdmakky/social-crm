import { z } from "zod";
import { runAction } from "../../automation/actions.ts";
import { tool } from "./context.ts";

/** write: delegates to the automation action of the same name (same advisory lock as the contact route). */
export const addTag = tool({
  name: "crm.add_tag",
  description: "Add a tag to the current contact (the tag is created if it does not exist).",
  argsSchema: z.object({ tagName: z.string().trim().min(1).max(50) }).strict(),
  sensitivity: "write",
  requiredPermission: "contact.edit",
  execute: (c, a) => runAction({ tx: c.tx, workspaceId: c.workspaceId, actorUserId: c.userId, runId: c.ref, contactId: c.contactId }, { type: "add_tag", ...a }),
});
