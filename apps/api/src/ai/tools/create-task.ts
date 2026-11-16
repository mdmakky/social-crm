import { z } from "zod";
import { runAction } from "../../automation/actions.ts";
import { tool } from "./context.ts";

/** write: delegates to the automation action of the same name, so a task is created exactly one way. */
export const createTask = tool({
  name: "crm.create_task",
  description: "Create a follow-up task on the current contact. Optional dueInHours (1-8760) and priority.",
  argsSchema: z.object({ title: z.string().trim().min(1).max(200), description: z.string().trim().max(2000).optional(), dueInHours: z.number().int().min(1).max(8760).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional() }).strict(),
  sensitivity: "write",
  requiredPermission: "contact.edit",
  execute: (c, a) => runAction({ tx: c.tx, workspaceId: c.workspaceId, actorUserId: c.userId, runId: c.ref, contactId: c.contactId }, { type: "create_task", ...a }),
});
