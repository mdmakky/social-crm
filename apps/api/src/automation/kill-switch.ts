import { eq } from "drizzle-orm";
import { schema, type Tx } from "@crm/db";

/** One row per workspace (missing = off). Shared by the automation engine, the approval routes and the AI agent runner. */
export const killSwitchOn = async (tx: Tx, workspaceId: string) =>
  !!(await tx.select({ k: schema.automationSettings.killSwitch }).from(schema.automationSettings).where(eq(schema.automationSettings.workspaceId, workspaceId)))[0]?.k;
