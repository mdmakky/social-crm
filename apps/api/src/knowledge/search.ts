import { sql } from "drizzle-orm";
import { withContext, type Db, type Tx } from "@crm/db";

export type KnowledgeScope = { workspaceId: string; userId: string };
export type KnowledgeHit = { sourceId: string; title: string; sourceRef: string | null; position: number; snippet: string; score: number };

export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 20;

/**
 * Retrieval API of the knowledge base: the top chunks of this workspace's live sources for a free-text query, with a source reference for each.
 * This is the function future AI agents call as a tool (alongside the HTTP endpoint); it calls no AI provider.
 *
 * Isolation: runs under the caller's workspace context, so row-level security limits it to that workspace (and to members), and the query also filters on
 * the workspace id itself. Matching uses Postgres full-text search with the 'simple' configuration (no stemming, any language that separates words with spaces);
 * websearch syntax is supported ("quoted phrase", -excluded, or); a plain multi-word query that matches nothing is retried as "any of the words". Ranking is ts_rank_cd. The snippet is plain text taken around the match, without markup.
 */
export async function searchKnowledge(db: Db, scope: KnowledgeScope, query: string, opts: { limit?: number } = {}): Promise<KnowledgeHit[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? SEARCH_DEFAULT_LIMIT), 1), SEARCH_MAX_LIMIT);
  const run = (tx: Tx, text: string) => tx.execute(sql`
      WITH q AS (SELECT websearch_to_tsquery('simple', ${text}) AS tsq)
      SELECT t.source_id, t.title, t.source_ref, t.position, t.score,
             ts_headline('simple', t.content, q.tsq, 'StartSel=, StopSel=, MaxWords=40, MinWords=20, ShortWord=1, MaxFragments=1') AS snippet
      FROM (
        SELECT c.id, c.source_id, c.position, c.content, s.title, s.source_ref, ts_rank_cd(c.tsv, q.tsq) AS score
        FROM knowledge_chunks c
        JOIN knowledge_sources s ON s.workspace_id = c.workspace_id AND s.id = c.source_id
        CROSS JOIN q
        WHERE c.workspace_id = ${scope.workspaceId}::uuid AND s.deleted_at IS NULL AND c.tsv @@ q.tsq
        ORDER BY score DESC, c.source_id, c.position
        LIMIT ${limit}
      ) t CROSS JOIN q
      ORDER BY t.score DESC, t.source_id, t.position`);
  return withContext(db, scope, async (tx) => {
    // The inner query ranks and limits; ts_headline (costly) runs only on the winners.
    let res = await run(tx, q);
    // 'simple' has no stop words, so a plain question ("what is your refund policy") rarely has all its words in one chunk. When the exact query finds
    // nothing and uses no operators, retry matching ANY of its longer words; ranking still puts chunks with more of them first.
    if (!res.rows.length && !/["\-]|\bor\b/i.test(q)) {
      const words = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}\p{M}]{3,}/gu) ?? [])].slice(0, 12);
      if (words.length > 1) res = await run(tx, words.join(" or "));
    }
    return (res.rows as { source_id: string; title: string; source_ref: string | null; position: number; score: number | string; snippet: string }[]).map((r) => ({
      sourceId: r.source_id, title: r.title, sourceRef: r.source_ref, position: r.position, snippet: r.snippet.trim(), score: Number(r.score),
    }));
  });
}
