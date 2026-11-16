import { toolRegistry } from "@crm/ai";
import { addNote } from "./add-note.ts";
import { addTag } from "./add-tag.ts";
import { assignOwner } from "./assign-owner.ts";
import { createTask } from "./create-task.ts";
import { findContact } from "./find-contact.ts";
import type { ToolCtx } from "./context.ts";

/**
 * The tool registry. Adding a tool = one file in this folder plus one line here.
 * TODO(knowledge-base): register `knowledge.search` (read) here once `searchKnowledge` from feat/ai-knowledge-base is on main; it needs only a ToolCtx and a query.
 */
export const TOOLS = toolRegistry<ToolCtx>([findContact, addNote, createTask, addTag, assignOwner]);
export type { ToolCtx };
