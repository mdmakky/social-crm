# Testing Report

Updated: 2026-11-13. All results are from local runs on this machine (Fedora, Node 24.22.3, Postgres 18.7 in Docker, Chromium via Playwright 1.65). There is no hosted CI yet.

## Phase 0
No code existed; documents were independently reviewed (`phase0-review.md`) and Meta citations spot-checked (`../research/citation-spot-check.md`).

## Phase 1 (stack spike and web shell)

| Suite | Command | Result |
|---|---|---|
| Lint, typecheck, unit and integration | `pnpm exec turbo run lint typecheck test --force` | 19 of 19 tasks pass |
| DB and RLS (real Postgres) | `@crm/db` | 19 tests: roles, tenant isolation, workspaces and memberships policies, append-only audit log (role denial and owner trigger), tenant-table CI check |
| Permissions and ports | `@crm/core` | 18 tests: matrix, member change rules (last owner, admin limits), Mailer and BlobStore contracts incl. path traversal |
| API (real Postgres, real Better Auth) | `@crm/api` | 27 tests: auth (cookie and bearer, origin check, 30-day sliding session, no refresh-token column), pg-boss transactional enqueue, workspace/member/audit endpoints incl. cross-tenant 404s |
| Design tokens | `@crm/design-tokens` | 42 WCAG contrast assertions (light and dark) |
| Web units | `@crm/web` | 10 tests: audit text, nav permissions, initials, time-zone formatting |
| Browser e2e | `pnpm exec playwright test` (apps/web) | 19 tests pass: auth flows and validation, duplicate registration, shell and keyboard (skip link, command menu), workspace switcher, per-role navigation, restricted pages, rename and time zone, role change and member removal with audit trail, audit pagination, responsive layout at 375/768/1440 with no horizontal overflow, axe on every screen and overlay |
| Mobile | `expo export --platform android`, `expo-doctor` | Bundles (762 modules); doctor 20/20. **Not run on a device or emulator.** |
| Node 26 | same pipeline under Node 26.13.0 | Passed at the spike stage (before the web shell); not re-run for the web shell |

### Defects found by testing and fixed
Overflow from an `sr-only` element escaping a scroll container; members table hiding Role and Actions at 375 px; three WCAG 2.5.3 label-in-name failures (workspace switcher, account button, command button, disabled nav); `apiGet` treating error bodies as data (caused a server RangeError on non-member workspaces); drizzle-kit migrate failing silently; owner-level audit tampering not caught by a row-level trigger.

### Not tested
Android emulator and SecureStore runtime; iOS; real Meta; Firefox and Safari; screen reader use; keyboard traversal of every control; load or performance (no Lighthouse run yet); dark mode rendering; the drawer's resize behavior; route skeletons and the error boundary; email flows.

## Update 2026-11-13 (shared client, round-2 fixes, password reset)
Local runs: `pnpm exec turbo run lint typecheck test --force`: 22 of 22 tasks pass. API 46 tests (new: 15 password reset, 3 contract drift); api-client 15; core 22; db 19; design-tokens 42; web unit 34. Browser: 35 Playwright tests pass (adds failure and error states, touch emulation, security headers, open-redirect, drawer resize, focus indicator, password reset). The drift guards were mutation-tested (renaming a route and changing a response schema each failed the suite, then were restored). Mobile: Android bundle (764 modules) builds with the shared client; still not run on a device.
Defects found by this round's tests and fixed: member-removal test passed before the action finished (an open dialog hides the page from the accessibility tree); FileMailer ordering within the same millisecond; reset token leakage through an attacker-controlled `redirectTo`; server-side 5xx rendering as "not found"; Members table clipping at 768 px.
Still not tested: Android and iOS runtime; real mail delivery; throttling across instances; real browser engines other than Chromium; screen readers.

## Update 2026-11-13: Contacts slice
Local runs: `pnpm exec turbo run lint typecheck test --force`: 22 of 22 tasks pass. db 36 (17 new RLS tests), core 48 (24 contact logic), api 133 (isolation, permissions, list, config, import, export, perf), web unit 34. Browser: 53 Playwright tests pass (contacts list, detail, import wizard, settings, permissions, responsive, axe, touch).
Performance (10,000 contacts, in-process, local Docker Postgres): list p95 66 ms, name sort 32, filtered 39, deep page 21; search 36 to 41. First measurement was 264 to 410 ms (and failed the gate under parallel load): RLS helper functions ran per row. Fixed in migration 0007 by wrapping them in scalar subqueries; isolation tests unchanged. A `psql` EXPLAIN as superuser showed 7 ms, which is why the cost was invisible until measured through the application role.
Defects found by these tests and fixed: per-row RLS function evaluation (a 4x to 6x slowdown); tag filter 500 (array parameter expansion); search for "100%" wrongly treated as phone digits; export owner column broke re-import; export formula guard broke re-import of phone numbers starting with "+" (importer now removes it); lost "Saved." confirmation after a lint-driven refactor; nested button inside a menu item was invisible to assistive technology (replaced by a menu item); low-contrast empty-cell text; contact table pushed key columns off-screen; BOM literal in a regex.
Not tested: Android and iOS; real mail; 100,000-row workspaces; concurrent imports across workspaces; browsers other than Chromium; screen readers.
The independent review of the slice did not run (usage limit); it is outstanding.

## Update 2026-11-13: Leads/Pipeline slices 1 to 3 (API and database; branch feat/leads-pipeline)
Local runs: `pnpm exec turbo run lint typecheck test --env-mode=loose`: db 97 (26 new: every CHECK, composite FK, role-by-command RLS, append-only history, stage immutability, task_links lead allow-list), core 73 (permission actions), api 333 (new: 9 pipeline configuration, 16 leads incl. deal-value visibility, probability rules, move/close/reopen, rank renumbering, cursor list, tenant isolation, archive guards, stage-archive versus lead-move race). The race test fails when the pipeline lock is removed (mutation-checked: 3 leads stranded).
One failure in the parallel full run: `perf.test.ts` list p95 (6.9 s) while a second agent was running; it passes alone (15/15). This is the known CPU-contention finding, budgets unchanged.
Not done in slices 1 to 3: web screens (pipeline settings, lead list and detail), lead tags and custom fields, list p95 at 10,000 leads not yet measured, `lead_value_grants` hides value in the API only (RLS is row level, so a direct SQL client with the app role could read the column).

## Update 2026-11-13: Leads web screens (pipeline settings, lead list, lead detail)
Playwright `e2e/leads.spec.ts`, 4 tests pass (39 s): pipeline settings (add, rename, reorder with buttons and persistence after reload, archive stage with a move target, create and archive a pipeline); lead lifecycle (create from the dialog with a contact picker and a decimal value, move stage, manual probability then reset, lose with a reason, stage history, status and search filters, empty states); deal value hidden for an agent (not in the list, rendered HTML or API response; an admin grant reveals it); responsive and axe (WCAG 2.2 AA) on list, detail and settings at 375, 768, 1024 and 1440 with no horizontal overflow, mobile shows cards not a table. Related specs re-run after the nav change: auth-and-shell, permissions-and-members, search: 23 pass. Web typecheck and lint clean.
Screenshots of list, detail and settings were inspected at 1440 and 375 (detail and settings at 375 only in part). Defects found by these tests and fixed: a body-text link without underline (axe `link-in-text-block`), ambiguous accessible names for "Archive" on pipeline versus lost-reason buttons, a misleading "No leads yet" when only closed leads existed.
Not tested: drag interactions (no board yet), reduced-motion rendering, keyboard-only walkthrough of every control, screen reader use, Firefox and Safari, dark mode, list performance with 10,000 leads.
