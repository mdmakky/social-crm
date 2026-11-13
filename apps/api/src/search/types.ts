import type { Role } from "@crm/core/permissions";
import type { Tx } from "@crm/db";
import type { SearchHit } from "@crm/contracts";

export type SearchCtx = { workspaceId: string; userId: string; role: Role };

/**
 * One searchable entity. A provider owns its query, its ranking and its permission rule.
 * `search` runs inside the request's withContext transaction, so RLS scopes every row to the workspace.
 */
export type SearchProvider = {
  /** stable id used in `types=` and in results; never rename once shipped */
  type: string;
  /** group heading shown to users */
  label: string;
  /** false hides the provider entirely for this role (no group, no error) */
  requires(role: Role): boolean;
  /** `query` is trimmed, 2..100 chars. Return at most `limit` hits, best first. */
  search(tx: Tx, ctx: SearchCtx, query: string, limit: number): Promise<SearchHit[]>;
};
