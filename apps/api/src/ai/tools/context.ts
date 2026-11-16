import { defineTool, type Sensitivity } from "@crm/ai";
import type { z } from "zod";
import type { Db, Tx } from "@crm/db";

/** What a tool may touch. `tx` runs as the acting user (RLS applies); a tool never receives a connection, a token or the request. */
export type ToolCtx = { tx: Tx; /** For read tools that already own their transaction (searchKnowledge). */ db: Db; workspaceId: string; userId: string; contactId: string | null; /** Id of the run or action the call belongs to; stored in activity data for traceability. */ ref: string };

/** A tool in this API: a pure definition (name, args, sensitivity, permission) plus execute(ToolCtx, args). */
export const tool = <S extends z.ZodType>(t: { name: string; description: string; argsSchema: S; sensitivity: Sensitivity; requiredPermission: "contact.view" | "contact.edit"; execute: (ctx: ToolCtx, args: z.output<S>) => Promise<Record<string, unknown>> }) => defineTool<ToolCtx, S>(t);
