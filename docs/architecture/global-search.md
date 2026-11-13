# Global search

Status: foundation built (Track D). Only **Contacts** is searchable today. This document is the contract future entities follow.

## Shape

```
command palette ──GET /v1/workspaces/:id/search?q=&types=&limit=──▶ searchRoutes
                                                                   │ role from the workspace membership (404 for non-members)
                                                                   │ providers = registry.filter(requires(role) && in types)
                                                                   ▼ one withContext transaction (RLS), providers run in order
                                                       { groups: [{ type, label, hits: [{ id, type, title, subtitle?, href, meta? }] }] }
```

Files: `apps/api/src/search/{types,registry,contacts,routes}.ts`, `apps/api/src/contact-query.ts` (shared with the contacts list), `packages/contracts/src/search.ts`, `apps/web/components/shell/command-menu.tsx`.

## Provider contract

```ts
type SearchProvider = {
  type: string;                    // stable id, used in `types=`; never rename
  label: string;                   // group heading
  requires(role): boolean;         // false = provider invisible to this role (no group, no error)
  search(tx, ctx, query, limit): Promise<SearchHit[]>;  // best first, at most `limit`
};
```

Rules a provider must follow:
1. Query only through `tx` (the request transaction). RLS scopes rows to the workspace; the provider must still add `workspace_id = ctx.workspaceId` (belt and braces, and it lets the planner use tenant indexes).
2. Escape user text with `escapeLike`; never build SQL by string concatenation.
3. Own the ranking and return hits already ordered.
4. Return only what the palette needs (id, title, short subtitle, `href`, small `meta`); never whole rows.
5. `href` is a web path; native clients route on `type` + `id`.

The endpoint and UI never mention a concrete entity. A provider that is not in `registry.ts` does not exist anywhere: no group, no heading, no placeholder. Unknown or unpermitted `types` are silently ignored (no existence leak). `type` is an open string in the contract, so adding a provider is additive for released mobile builds.

## API rules

| Input | Rule |
|---|---|
| `q` | trimmed, 2 to 100 characters, else 400 |
| `limit` | per provider, 1 to 20, default 5 |
| `types` | comma-separated provider types, optional |
| auth | cookie or bearer, same as every `/v1` route; non-members and unknown workspaces get 404 |

## Ranking (Contacts)

Matching is the existing contacts list filter (`filters()` in `contact-query.ts`): trigram `ILIKE` over name, normalized email, company, and phone digits (digits count only when the whole query looks like a phone number and has at least 3 digits). Order:

1. exact normalized email, or exact phone digits;
2. name prefix;
3. any substring match (name, email, company, phone);
4. ties by `last_activity_at DESC`, then `id`.

No fuzzy matching, typo tolerance, highlighting or weighting beyond this. Accents are not folded (`e` does not match `é`); case is.

## Performance budget

p95 < 300 ms at 10,000 contacts, measured by `the `global search` cases in `apps/api/test/perf.test.ts`` (in-process, local Postgres, 40 runs per query, same 10,000-row dataset as the list gates after warm-up, includes auth, membership lookup and RLS). Measured on the dev machine: name substring 30 ms, name prefix 33, email exact 26, phone 23, company 24, two-character query 25. Policy helper calls stay scalar subqueries (decision D45); a regression in that shows up here first. Network and browser time are not included.

## Scaling path (do only when measurements demand it)

1. Per-provider `limit` already bounds work. Providers run sequentially in one transaction; if the provider count grows past ~4, run them in `Promise.all` on separate pooled transactions and keep a per-provider timeout that drops only that group.
2. A provider whose `ILIKE` stops meeting budget moves to Postgres full text (`tsvector` generated column + GIN) behind the same `search()`. No endpoint or UI change.
3. Beyond one Postgres (millions of rows per tenant, cross-entity relevance), put an external engine behind the provider interface. Index asynchronously from the event outbox only at that point; until then queries read the source tables, so there is no index lag or reindex job.
4. Cursor pagination per provider (`type`+cursor) is the planned addition for a full results page. Not built; the palette shows the top hits only.

## Security

- RLS first: all reads run inside `withContext`, the same transaction mechanism as every other route. Isolation tests cover another workspace's data, non-members and invalid ids.
- Per-type permission: each provider declares `requires(role)` (Contacts: `can(role, "contact.view")`). Hidden providers return nothing, not 403, so the palette degrades by role.
- No query logging: the endpoint does not log `q`. If search analytics are added, log provider, hit count and latency, never the query text or hit contents (queries contain names, emails and phone numbers).
- Input is length-bounded and LIKE-escaped; the SQL-metacharacter and wildcard tests prove literal matching.
- Provider failure fails the request (500) rather than returning a partial group silently; the palette shows "Search failed" with Retry.

## Adding a provider

1. Create `apps/api/src/search/<entity>.ts` exporting a `SearchProvider`; add it to `registry.ts`. Add a permission action in `packages/core/src/permissions.ts` if one does not exist and use it in `requires`.
2. Tests: isolation (other workspace, non-member), permission (role that must not see it), ranking, wildcard escape. `search.test.ts` shows the in-test registration of a fake provider.
3. Migration needs, per entity:

| Provider | Source | Migration |
|---|---|---|
| tasks | `tasks.title` | trigram GIN on `lower(title)` (workspace_id leading btree already used for scoping); `requires` = `task.view` |
| conversations | contact name via join plus last message preview | none to start (search by participant); trigram on message text only if message search is added |
| pipeline records | record title, linked contact | trigram GIN on `lower(title)` |
| messages | message body | trigram or FTS GIN on body, partitioning or retention review before enabling (largest table); likely the first candidate for the FTS or external-engine step |

The palette needs no change: it renders every returned group with `label`, title and subtitle, and opens `href`. Only a per-type icon is a UI addition (currently one generic icon).

## Palette behavior

Opens on Ctrl/Cmd+K. From 2 characters it waits 200 ms, then calls the endpoint through the typed `browserApi` client. Each request gets a sequence number and only the latest may update state, so a slow earlier response is discarded. States: loading (`role=status`), no results, error with Retry, results. Live hits sit beside the static page and action items (cmdk filters those locally; live hits are force-mounted). The best live hit is pre-selected so Enter opens it. Focus returns to the element that opened the palette.

## Not built

Recent searches, search history, saved searches, highlighting, typo tolerance, accent folding, results page with pagination, per-user result personalization, external engine, async indexing.
