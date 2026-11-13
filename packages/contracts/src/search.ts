import { z } from "zod";
import { endpoint } from "./endpoint.ts";

export const SEARCH_Q_MIN = 2;
export const SEARCH_Q_MAX = 100;
export const SEARCH_LIMIT_MAX = 20;

/** `type` is an open string so a new provider is additive for existing clients (they ignore types they cannot render). */
export const SearchHit = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  /** Web path; native clients route on `type` + `id` instead. */
  href: z.string(),
  meta: z.record(z.string(), z.string()).optional(),
});
export type SearchHit = z.infer<typeof SearchHit>;
export const SearchGroup = z.object({ type: z.string(), label: z.string(), hits: z.array(SearchHit) });
export type SearchGroup = z.infer<typeof SearchGroup>;
export const SearchResponse = z.object({ groups: z.array(SearchGroup) });
export type SearchResponse = z.infer<typeof SearchResponse>;

export const SearchQuery = z.object({
  q: z.string().trim().min(SEARCH_Q_MIN, `Type at least ${SEARCH_Q_MIN} characters`).max(SEARCH_Q_MAX),
  /** comma-separated provider types; unknown or unpermitted types are ignored */
  types: z.string().max(200).optional(),
  /** per provider */
  limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
});
export type SearchQuery = z.input<typeof SearchQuery>;

export const searchEndpoints = {
  search: endpoint({ method: "GET", path: "/v1/workspaces/:workspaceId/search", query: SearchQuery, response: SearchResponse }),
} as const;
