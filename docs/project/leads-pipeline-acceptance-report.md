# Leads and Pipeline: acceptance report (evidence for review, not accepted)

Date: 2026-11-13. Branch `feat/leads-pipeline`, base `main` `ba27c75`. Code HEAD at the time the tests ran: `ef574f8` (a documentation-only commit follows it). **Not merged to `main`. Acceptance is the user's decision.**

## Commits (oldest first)
`7021525` schema, RLS, permissions (migrations 0014, 0015) · `5071715` pipeline configuration API · `aca826f` lead API · `2990544` Meta readiness doc (cherry-picked) · `90aceed`-derived api-client mock tests and Android runbook (cherry-picked) · `599f974` web settings, list, detail · `e8003a4` board · `d15fbd9` search and `lead.owner_assigned` (agent, cherry-picked) · `4108f01` and `71f39a5` tasks link and `next_activity_at` trigger, migration 0016 (agent, cherry-picked) · `ef574f8` reporting, closed Won/Lost columns, UI checks.

## Test evidence (commands that ran green)
| Command | Result |
|---|---|
| `pnpm exec turbo run lint typecheck test --env-mode=loose` | 22 of 22 tasks. db 101, core 73, api 346 (10 skipped), api-client 18, web unit 34, design-tokens 42 |
| `cd apps/web && pnpm exec playwright test` (Chromium, whole suite, after the stale-locator fix) | **114 passed (6.5 min)**, 0 failed |
Earlier in the same checkpoint one full run had 113 of 114 passed; the failure was a stale locator in my own board spec after the Won/Lost column change. It was corrected, not weakened (the test still drags a card onto the Lost column and asserts the reason dialog). A db test file (`crm-rls`) failed to collect once in a parallel run while an emulator was running and passed alone and in the final run; cause not established (CPU contention suspected).

## VERIFIED (a real command or test ran)
- Schema: every CHECK and composite FK (stage belongs to pipeline, outcome equals stage kind, won=100, lost=0 with reason, value and currency pairing), forced RLS per role and command, append-only `stage_transitions`, immutable stage kind, one default pipeline, `task_links` lead allow-list, trigger deriving `next_activity_at`. Fresh and upgrade migrations applied (0014 to 0016, journal order checked).
- API: pipeline configuration; lead create, update, move, close, reopen (admin only), soft delete and restore; optimistic concurrency; rank ordering with renumbering; cursor list and filters; duplicate warning; deal-value masking with per-lead grants; probability rules (manual override preserved, reset); stage-archive versus lead-move race (mutation-checked: fails without the lock); tenant isolation; reporting with no value in aggregates for agents and viewers (raw payload asserted); search provider; owner notification; tasks link.
- Web: pipeline settings, lead list (filters, sort, paging, cards on mobile), lead detail, board (mouse drag, reorder, drop on Lost, menu alternative, rollback on failed move, read-only for viewers, closed columns and navigation), reports, loading and error states, reduced motion, axe WCAG 2.2 AA and no overflow at 375, 768, 1024, 1440 (Chromium). Screenshots inspected at 1440 and 375.

## UNVERIFIED
Touch drag on a device; screen reader output; Firefox and Safari; dark mode; performance at 10,000 leads and 500 board cards; reports on large data; upgrading a database that already contains leads; lead search at scale; keyboard walkthrough of every control.

## DEFERRED (user decision)
Android runtime, login, SecureStore, session restore, logout, expired session, 401 handling, and mobile Leads. The emulator was stopped; mobile source and configuration are unchanged; nothing mobile is claimed. See `android-verification.md`. Phase 1 stays OPEN.

## BLOCKED (external users)
Deal value is protected by the API only; the database does not hide the column (`known-limitations.md`). Also: email verification before invites, trusted client IP and authenticated rate limits, separate database role for the system path (open `cso` findings), Meta App Review and Business Verification, production hosting.

## Known gaps in this slice
Lead tags and custom fields not built; no UI to link an existing task; link and unlink write no task event or audit row; board shows at most 500 open leads and the first 20 closed in the last 30 days; probability of a closed lead is forced and a manual value is not restored on reopen (by design, documented in the move handler).

## Decisions applied (approved by the user)
Lead or Deal wording by pipeline kind; primary contact mandatory; manual probability preserved with explicit reset; `@dnd-kit` approved (installed `core` and `utilities` only; `react-virtual` not needed); deal value separate view and edit permission with explicit grants; erasure anonymises rather than deletes (not yet implemented, no erasure flow exists in the app).
