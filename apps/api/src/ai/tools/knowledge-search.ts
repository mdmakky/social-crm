import { z } from "zod";
import { searchKnowledge } from "../../knowledge/search.ts";
import { tool } from "./context.ts";

/** read: top chunks of this workspace's knowledge base with a source reference each. Uses the same retrieval function as the HTTP endpoint (no AI call). */
export const knowledgeSearch = tool({
  name: "knowledge.search",
  description: "Search the workspace knowledge base (FAQs, policies, product info). Returns up to 5 snippets with their source title and reference.",
  argsSchema: z.object({ query: z.string().trim().min(2).max(200), limit: z.number().int().min(1).max(5).optional() }).strict(),
  sensitivity: "read",
  requiredPermission: "contact.view",
  async execute({ db, workspaceId, userId }, { query, limit }) {
    const hits = await searchKnowledge(db, { workspaceId, userId }, query, { limit: limit ?? 5 });
    return { hits: hits.map((h) => ({ source: h.title, sourceRef: h.sourceRef, position: h.position, snippet: h.snippet.slice(0, 400) })) };
  },
});
