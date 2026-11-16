import { toolRegistry } from "@crm/ai";
import { addNote } from "./add-note.ts";
import { addTag } from "./add-tag.ts";
import { assignOwner } from "./assign-owner.ts";
import { createTask } from "./create-task.ts";
import { findContact } from "./find-contact.ts";
import { knowledgeSearch } from "./knowledge-search.ts";
import type { ToolCtx } from "./context.ts";

/**
 * The tool registry. Adding a tool = one file in this folder plus one line here.
 */
export const TOOLS = toolRegistry<ToolCtx>([findContact, addNote, createTask, addTag, assignOwner, knowledgeSearch]);
export type { ToolCtx };
