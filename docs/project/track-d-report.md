# Track D report: global search foundation (Contacts only)

Branch `track/search`, database `crm_search`, ports 3413 / 8813. Design: `docs/architecture/global-search.md`.

## Scope delivered
1. Commit 1 (no behavior change): `filters()`, `Q`, `Parsed` moved from `routes/contacts.ts` to `apps/api/src/contact-query.ts`. All 133 existing API tests passed unchanged before anything else was built.
2. Provider registry `apps/api/src/search/` (`types.ts` contract, `registry.ts`, `contacts.ts`, `routes.ts`). Only registered providers appear anywhere; `requires(role)` hides a provider per role.
3. `GET /v1/workspaces/:workspaceId/search?q=&types=&limit=`: q trimmed 2..100, limit 1..20 per provider (default 5), grouped response, RLS via `withContext`, non-members 404, cookie and bearer.
4. Contract `packages/contracts/src/search.ts` (additive; `type` is an open string; covered by the existing route drift guard and used through the typed client in tests and in the web app).
5. Command palette: live "Contacts" group from 2 characters, 200 ms debounce, sequence-guarded (stale responses dropped), loading / no results / error with Retry, best hit pre-selected so Enter opens `/w/:id/contacts/:id`, name plus email/phone/company, merged with existing page and action items, no groups for entities that do not exist, focus returns to the opener, state resets on every opening.
6. Contacts ranking: exact email or phone, then name prefix, then substring, ties by `last_activity_at`.

## Tests (all run on `crm_search`)
- API `search.test.ts`, 11 tests: contract-validated shape; bearer through the shared client; ranking order; `%`, `_`, quotes and a `DROP TABLE` string treated literally (row count unchanged); case and unicode; 400 on short, long, empty and out-of-range limit; per-provider limit; `types` filter and unknown types never appear; a fake provider registered in-test with its own permission (visible to agent, hidden from viewer); another workspace's data invisible, non-members and bad ids 404; unauthenticated 401.
- Perf (inside `perf.test.ts`, 10,000 contacts, 40 runs): global search p95 name substring 24-29 ms, prefix 30-32, email 28-31, phone 32-36, company 34, two characters 43. Budget 300 ms. Existing list/search gates unchanged and passing.
- E2E `apps/web/e2e/search.spec.ts`, 5 tests: Ctrl+K, no request under 2 characters, live results with email and company, no fake headings, keyboard Enter opens contact, reset between openings; no results; API 500 with Retry and network abort; slow stale response ignored (delayed route); axe (wcag2a/aa/21/22) on the open palette at 1440, 768, 375 with results, no page overflow, option height and bounds, focus returns to trigger on Escape; touch tap opens a contact (hasTouch, 375).
- `pnpm exec turbo run lint typecheck test --continue --force`: lint and typecheck clean; tests pass. See "Open issues" for a load flake.
- Full Playwright run: see result line at the end of this file.

## Screenshots
`docs/design/screenshots/search/`: palette-results-1440, palette-no-results-1440, palette-error-1440, palette-1440, palette-768, palette-375.

## Files touched
New: `apps/api/src/contact-query.ts`, `apps/api/src/search/*`, `packages/contracts/src/search.ts`, `apps/api/test/search.test.ts`, `apps/web/e2e/search.spec.ts`, `docs/architecture/global-search.md`, screenshots.
Edited (owned): `apps/web/components/shell/command-menu.tsx`. Edited (outside ownership, minimal): `apps/api/src/routes/contacts.ts` (import from contact-query), `apps/api/test/perf.test.ts` (added global search gates), `apps/web/e2e/states-and-errors.spec.ts` (placeholder text only: "Search contacts, pages and actions"; assertion unchanged).

## Shared-file edits for the integrator (all marked `track:search`)
- `packages/contracts/src/index.ts`: import, `export * from "./search.ts"`, `...searchEndpoints` in `endpoints`.
- `apps/api/src/routes/workspaces.ts`: imports, `hooks.extraSearchProviders`, `scoped.route("/", searchRoutes(db, hooks.extraSearchProviders))`.
- `apps/api/src/app.ts`: `testHooks.extraSearchProviders` type plus import. No migrations, no schema, no permission actions added (uses `contact.view`).
- Overlap with Track A: `routes/contacts.ts` lost `filters()`; Track A fixes to `filters()` must be re-applied in `contact-query.ts`.

## Open issues
- Under heavy machine load (load average ~11 from parallel tracks sharing one Postgres) a turbo run showed `contacts-list` beforeAll timing out at 10 s and the existing list p95 at 427 ms; run alone the API suite passes 150/150 (list default 76 ms). Not caused by search, but the 10,000-row gates are load sensitive.
- Existing perf gates and mine share one file on purpose (two 10k seeds in parallel suites contended).
- Accents are not folded; no highlighting. A provider error fails the whole request.
- Palette keeps previous results visible while a new query loads (flagged "Searching…").
- `packages/design-tokens` had to be built (`pnpm --filter @crm/design-tokens build`) before `next build` worked in a fresh worktree.

## Skills used (honest)
Used: ponytail and caveman modes (session-level), context-mode tools to read large output. Not used: superpowers brainstorming/TDD/writing-plans skills, ui-ux-pro-max, impeccable critique, Context7, /code-review, /security-review (no Skill tool call was made for them). Playwright MCP not used; Playwright test runner used. cmdk behavior (force-mounted items not auto-selected) was found by running the e2e, not from docs.

## NOT done
Recent searches (deliberately), pagination, highlighting, typo tolerance, other providers, per-type icons, external engine, search analytics, /code-review and /security-review passes.

## Final verification
Full Playwright suite (all specs, ports 3413/8813, `crm_search`): 58 passed, 0 failed (3.6 min). API suite alone: 11 files, 150 passed. Turbo lint and typecheck: clean.
