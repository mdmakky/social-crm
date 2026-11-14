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

## Update 2026-11-13: Pipeline board (slice 4)
`e2e/pipeline-board.spec.ts`, 4 Playwright tests pass (26 s): mouse drag between stages (persisted after reload), reorder inside a column, drop on Lost opens the reason dialog, keyboard-reachable Move to menu, a failed move (network abort) rolls the card back with an error toast, viewers get a read-only board with hidden values, axe WCAG 2.2 AA and no page overflow at 375, 768, 1024, 1440. Web typecheck and lint clean. Screenshots at 1440 and 375 inspected.
Dependency added: `@dnd-kit/core` and `@dnd-kit/utilities` (approved). `@tanstack/react-virtual` and `@dnd-kit/sortable` were not needed: columns render the first 50 cards with Show more, the board loads at most 500 open leads.
Not tested: real touch-drag on a device (touch sensor configured with a 220 ms press delay; the Move to menu is the touch alternative), reduced-motion rendering, screen reader announcements (configured, not heard), 500-card performance, won/lost cards on the board (closed leads are not shown, only drop targets).

## Update 2026-11-13: Integration checkpoint 2 (slices 5 to 7 and UI checks, branch feat/leads-pipeline)
Integrated: Slice 5 tasks to leads (`4108f01`, `71f39a5`: migration 0016 trigger deriving `next_activity_at`, link endpoints, detail Tasks panel) and Slice 6 search and `lead.owner_assigned` (`d15fbd9`), both built by separate agents in worktrees and cherry-picked; no overlapping files, journal order 0014 < 0015 < 0016 verified, migration applied on the main dev database.
Slice 7 minimal reporting: `GET /lead-reports/overview` and `/w/:id/reports` (stage distribution, won/lost counts and values, lost reasons, win rate, average days to win, expected closing buckets; no forecasting or weighting). Deal values are computed only for owner/admin; for agents and viewers every value field is null and the value queries are not run, so a grant on one lead cannot leak through an aggregate (API test asserts no amount appears in the raw payload; browser test asserts none in the rendered HTML).
Board: Won and Lost columns now list leads closed in the last 30 days as links and "View all" opens the list filtered by status.
Single full run: `turbo lint typecheck test` 22 of 22 tasks (core 73, api-client 18, web unit 34, db 101, api 346 with 10 skipped, design-tokens 42). Playwright full suite: 113 of 114 passed in the first run; the one failure was my own stale locator in the board spec after the Won/Lost column label change, fixed, and board and leads specs re-run: 8 of 8 pass. Not re-run in full after that one-line fix.
UI checks (leads-reports-and-checks.spec.ts, 5 tests): reports for owner versus agent, reports loading (dimmed stale content, aria-busy) and error with retry, closed Won/Lost visibility and navigation, reduced motion (no transition or animation longer than 50 ms on pipeline, lead detail and reports), 375 and 768 layouts of reports, board, list, settings and detail with no overflow and axe clean. Screenshots at 375 inspected for board, reports, list and settings.
Defects found and fixed this round: `set-state-in-effect` lint error in the agent-written lead-tasks panel; stale web nav unit tests; stale board locator.
Not tested: real touch drag, screen reader output, Firefox and Safari, dark mode, 10,000-lead performance, reports with large data. Known gaps from slice 5: no UI to link an existing task, link and unlink write no task event or audit row.

## UX track verification 2026-11-13
`pnpm exec turbo run lint typecheck test`: 25 of 25 tasks successful. `pnpm exec playwright test` (apps/web, incl. new `e2e/ux-audit.spec.ts`: 15 screens at 1440, 768 and 375, horizontal overflow and axe critical/serious): 115 passed, 0 failed. Earlier on the same branch: 7 failures in the first run (class-name selectors, settings overflow at 375, Home timezone line, overlay contrast); 3 contrast failures reproduced on untouched HEAD and were fixed; one pre-existing race in `leads.spec.ts` fixed in the test.

## UX option D rollout verification 2026-11-13
`pnpm exec turbo run lint typecheck test`: 25 of 25 successful. `next build`: compiled successfully. `pnpm exec playwright test` (apps/web, ports 3519/9093): 115 passed, 0 failed, including `ux-audit.spec.ts` (15 screens at 1440, 768 and 375: no horizontal overflow, no axe critical or serious violations). The first full run of this state had 2 failures: the command palette kept its typed text on a quick reopen (fixed), and a touch-size test that measured before the page had streamed in (test now waits).

## Integrations option B + Inbox Slice 4 end to end (2026-11-13)
`apps/web/e2e/inbox.spec.ts` (7 tests) and `apps/web/e2e/integrations.spec.ts` (5 tests), both serial, sharing `e2e/channel-helpers.ts`. **Mock Meta only** (`E2E_META_MOCK=1` makes the e2e API use the in-memory Graph; nothing here proves real Meta behaviour) and **mock inbox fixtures** (`apps/api/dev/seed-inbox.mts`).
- Run it in its own copy of the repo and on a FRESH database (mock Page ids are globally unique, events are append-only): `scripts/db-create.sh e2e_inbox`, then from `apps/web`: `E2E_WEB_PORT=3417 E2E_API_PORT=8991 CRM_DB_NAME=e2e_inbox E2E_META_MOCK=1 pnpm exec playwright test e2e/inbox.spec.ts e2e/integrations.spec.ts`. Drop and recreate the database before a rerun. The config builds Next in the working directory, so do not run it where another `next dev` uses the same `.next`.
- Covers: channel rail and coming-soon channels, mock connect flow, webhook subscription, activity events, token check, disconnect dialog (keyboard, focus return), inbox list and unread, per-user read cursor (agent reading never clears the owner), disabled composer with no send request, truthful delivery labels, status and assignment (including the agent self-assign rule), 375 px layouts, axe (critical and serious) on every screen, and tenant isolation through the UI and API.
- Bugs this run found and fixed: focus was lost after closing the Disconnect dialog; two quick edits (status then assignee) both sent the same stale `expectedVersion`, so the second was refused as a conflict.
- Known failing, NOT caused by this work: `responsive-and-a11y.spec.ts` "screens hold at 375, 768 and 1440": axe `color-contrast` (serious) on a role dropdown menu item (`components/ui/overlays.tsx`, from the committed design rollout). Failed identically before the latest sync.

## Contact detection, correction and notes audit (2026-11-14)
Local and mock only; nothing here proves real Meta behaviour for extraction. Fresh isolated databases (`scripts/db-create.sh`).
- `apps/api` (files run one at a time on a fresh DB): 452 passed, 14 skipped. New: `contact-methods.test.ts` (phone/email extraction through the real ingress and worker), `contact-method-edit.test.ts` (correct/delete, RBAC, RLS), `notes-audit.test.ts`, `profile.test.ts`. In parallel file mode a few files that drain the global event queue can interfere with each other on a shared database; re-run the file alone first.
- `packages/core` 98 passed (extractor units), `packages/integrations` 24 passed, `packages/db` 143 passed (one run showed rls-matrix/crm-rls failing to start with duplicate `user_email_unique` when both started in the same millisecond; pre-existing), `apps/web` unit 39 passed. Lint and typecheck clean (18 tasks).
- Playwright, full suite, `E2E_META_MOCK=1`, fresh DB: 131 passed, 2 failed. `responsive-and-a11y` "screens hold at 375, 768 and 1440" fails on axe color-contrast of a dropdown item (pre-existing, see the Inbox e2e entry above). `contacts-import-settings` "custom field ... validation" failed once in the full run and passed when the two contact specs were re-run alone (flaky, not investigated further). New `e2e/contact-methods.spec.ts`: 6/6 passed on the final build (also re-run alone: 12/12 with `contacts-import-settings`).
- Playwright needs ports 8791/3217 free: a stale e2e server from an earlier run was blocking them and was stopped.

## Outbound Messenger replies (2026-11-14, branch feat/messenger-outbound)
Mock Graph and fake fetch only; no real Meta request was made, no real message was sent.
- `apps/api/test/send.test.ts` (16 tests, local Postgres): happy path (Page token, recipient, text, attempt row exists in `sending` state during the call), repeated and concurrent client ids (one Graph call), 24 h window boundaries, no inbound, Instagram, reauth_required, input validation, viewer/outsider/cross-workspace refusal, 503 when unconfigured, 4xx refusal -> failed, timeout -> unknown and never re-sent, crashed `sending` -> unknown by recovery, missing token, 10-minute human decision with audit, echo adoption (unknown and in-flight race), external echo.
- `packages/integrations/test/send.test.ts` (3): request shape (no tag, token only in header), error classification, ambiguity cases.
- `apps/web/test/inbox.test.ts` (+4): Enter/Shift+Enter/IME, failure sentences, 10-minute decision gate.
- Full run: web 43, integrations 27, core 98, db 143, api-client 18, design-tokens 48 all passed; API 468 passed, 14 skipped (pre-existing skips) in clean runs. The API suite shares one database across parallel files and is flaky at a ~1-in-3 rate on unrelated profile/ingress tests (pre-existing; reproduced without the new file); each file passes alone. `pnpm exec turbo run lint typecheck` green.

## Instagram messaging (2026-11-14, branch feat/instagram-messaging)
Mock Graph and fake fetch only; no real Meta request, no real message.
- `apps/api/test/instagram.test.ts` (19): connect picker with username/picture, token sealed and never returned, fallback names, one workspace per Instagram account, role/tenant checks on disconnect; inbound DM creates an Instagram conversation, duplicate delivery, phone/email detection, bad signature, channel from signed object on either URL, unsupported media/read/reaction/postback/garbage events, Messenger regression, cross-workspace isolation; profile enrichment; outbound via the Instagram channel with attempt persisted before the call, echo adoption, UNKNOWN then echo, duplicate client ids, 24h window, reauth_required, viewer/outsider, 1000-byte limit (Bengali), error subcodes, Messenger send regression.
- `packages/integrations` (+5): Instagram send request shape, error classification, profile fields, getInstagramAccount failure modes, webhook parsing.
- `apps/web` (+2): per-channel limits, failure sentences.
- Updated `inbox-ingress` test: a Messenger object on the Instagram URL is now stored as Messenger (channel from payload); removed the unreachable "unsupported channel" case from send.test.
- Results: see the delivery report; the API suite is flaky ~1 in 3 runs on unrelated ingress/profile tests (pre-existing, shared database across parallel files); every file passes alone.

## Direct Instagram connection, Unified Login (2026-11-14, branch feat/instagram-unified-login)
Mock Graph and fake fetch only. No real Meta request, no real message, no Playwright.
- `apps/api/test/instagram-unified.test.ts` (20): login URL and role gate, 503 unconfigured; state validation (tampered, nonce, other user, expired, Facebook-flow state, Instagram state at the Facebook callback); connect (exchange order, sealed token, expiry from debug_token, subscription, audit, no token in any response), never-expiring token, several accounts / one taken / none shared / all taken, exchange failure, refused subscription, denial, storage failure, simultaneous connect from two workspaces, reconnect and method switch, disconnect and role/tenant checks; Check token, Re-check subscription; inbound DM, duplicates, bad signature; send via `/{ig-id}/messages`, dedupe, echo adoption, UNKNOWN then echo, refusal, window, 1000 bytes, roles, tenants, missing token; enrichment; Page-based Instagram regression; DB constraints and grants.
- `packages/integrations/test/send.test.ts` (+3): unified send request, account listing, error kind.
- Results in the delivery report.
### Pre-merge review of feat/instagram-unified-login (2026-11-14)
Fixed and regression-tested: a storage failure for one of several shared accounts was silently reported as success (now "partial", retry connects the rest without duplicates); accounts beyond the 10-per-login cap are reported; reconnect after a rejected token keeps the account, conversations and messages and replying works again. See the delivery report for counts.
