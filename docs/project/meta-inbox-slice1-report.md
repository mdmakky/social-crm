# Meta Inbox, Slice 1 report (database schema, RLS, permissions)

Date: 2026-11-13. Branch `feat/meta-inbox-slice1` (not merged). Slice 2 and Slice 3 are not started.

## Independent security review (Part B) and what was done
The review was done by a separate read-only agent against commit `73bd92b`; it ran no exploit and no tests (catalog queries only). 17 findings plus test-quality remarks. Disposition:

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | P1 | API role could insert any account id (Page squatting), key held forever | **Fixed**: no INSERT for the API role; worker-only creation; release procedure still to design (Slice 3) |
| 2 | P1 | API role could set `status`, scopes, token fields, `connected_by` | **Fixed**: column grant `display_name` only |
| 3 | P2 | Ingress role could enumerate every tenant's accounts | **Fixed**: no access to accounts |
| 4 | P2 | Worker could stamp any workspace on any event | **Fixed**: trigger binds workspace to the account owner |
| 5 | P2 | Worker could move `unknown -> failed` (D-G) | **Fixed** (worker `unknown -> sent` only) |
| 6 | P2 | Retry with the same client id allowed | **Fixed** (trigger) |
| 7 | P2 | 10-minute window not enforced; `failure_code` writable anywhere | **Fixed** (`state_changed_at` clock and trigger; `failure_code` only with state) |
| 8 | P2 | Assignee not checked as a member; agents could assign anyone | **Fixed** (composite FK, trigger; test found a NULL logic bug in the first fix) |
| 9a | P2 | Echo without `mid` duplicates | **Fixed** (CHECK) |
| 9b | P2 | No read/delivery watermarks | **Fixed** (`contact_delivered_at`, `contact_read_at`, forward-only) |
| 9c | P2 | `last_message_at` could move backwards | **Fixed** (trigger) |
| 9d | P3 | A webhook batch is one row | Accepted: safe because messages are unique per platform id; to be covered in Slice 2 tests |
| 10 | P2 | Unread model inconsistent | **Fixed** by the approved per-user cursor design |
| 11 | P3 | External id format variants | **Fixed** (digits only; to be reconfirmed with the real app) |
| 12 | P3 | Unique violation is a cross-tenant oracle | Documented; the API must map it to a generic error (Slice 3) |
| 13 | P3 | `occurred_at` forgeable | **Fixed** (database default, not writable by the API role) |
| 14 | P3 | Worker reads ciphertext directly; error detail can echo bytes | Documented, accepted for owner-only development |
| 15 | P3 | Conversation and identity contact can drift | **Fixed** (composite FK with `ON UPDATE CASCADE`) |
| 16 | P3 | Purge also drops unprocessed bodies; unbounded rejected inserts | Documented (30 day rule is strict by decision D-E); ingress rate limit in Slice 2 |
| 17 | P3 | Migrator owns tables and can disable triggers | Documented |
Test-quality remarks fixed: the vacuous state assertion now uses `RETURNING`; policy versus grant failures are asserted with specific messages; the ingress test now proves it cannot read accounts at all. One more real defect was found by the new tests and fixed: a NULL comparison let an agent unassign a conversation from someone else.

## Per-user unread (approved)
Implemented as described in `docs/architecture/meta-inbox-plan.md` section 9b: per-user cursor `last_read_seq`, derived counts, per-conversation `seq` assigned under the conversation row lock, no shared counter. Tests: independent cursors (Agent A reading never clears Agent B or a viewer), own outbound and pending, failed, unknown, sent messages never count, cursor only forward and never past the last message, private per user and workspace, concurrent mark-read while messages arrive (6 rounds, exact counts), and commit-order sequencing with a slow earlier transaction.

## Migrations
0017 `inbox_schema` (tables, constraints, indexes) and 0018 `inbox_rls` (roles check, forced RLS, column grants, 46 policies, triggers, `conversation_unread_count`, `purge_webhook_event_bodies`). Revised once after the review while unmerged and applied only to throwaway databases; the `when` journal order is 0016 < 0017 < 0018.

## Tests actually run
- `packages/db/test/inbox-schema.test.ts`: **42 of 42** (run 3 times: stable). Covers constraints and composite FKs, per-role RLS and column grants, secret protection, ingress and worker role limits, routing binding, raw body purge, state graph (including superuser), append-only records, the review fixes, per-user unread, and concurrency (12 parallel identical messages give one row; two workspaces racing for one Page give one winner; a human decision racing the worker's echo gives one winner; a double-clicked send creates one message).
- `@crm/db` whole suite: 143 of 143 on a fresh database and 143 of 143 on a database upgraded from 0013 with representative data.
- Upgrade check: all 13 pre-existing tables byte-identical before and after migrating 0013 to 0018 (md5 fingerprints); schema dump, all 136 policies and all grants identical to the fresh database.
- API (contacts, tasks, leads, pipelines, reports, lead tasks, contract, workspaces, search, notifications): 147 of 147 on the upgraded database and 147 of 147 on a fresh database; `@crm/core` 73 of 73. The guarded `upgrade-verify.test.ts` passed on the freshly upgraded database earlier in the session and was not re-run on it after the revision (it is one-shot per database).
- Not run: the full turbo suite and the Playwright suite (no web or API code changed in this slice).

## Unexplained intermittent failure
Several times, API test files `contacts.test.ts` and `tasks.test.ts` failed to collect when 11 test files ran together against a freshly created database; the error text was not captured and they pass when rerun or when 10 files run. The most likely cause is the known connection ceiling (each harness opens two pools, Postgres `max_connections` is 100). Not proven.

## Main development database
Not touched. Read-only checks show the roles `crm_ingest` and `crm_worker` already exist cluster-wide (created by earlier throwaway-database setups), both can connect to `crm` and use schema `public` through default PUBLIC privileges, and `crm` is at 17 migrations. So applying 0017 and 0018 to `crm` needs only the normal `pnpm --filter @crm/db migrate` as `crm_migrator`; no superuser step is required on this machine. On a new machine or CI, run `packages/db/sql/001_roles_and_probe.sql` once as a superuser first (idempotent; creates the two roles with development passwords and grants). Impact of re-running it on an existing database: none beyond re-granting; it recreates nothing that holds data. Waiting for your instruction before touching `crm`.

## Status
Slice 1 implementation complete and tested; review findings integrated. **C8 (Instagram webhook publication requirement) remains UNVERIFIED** until tested with the real Meta app. Slice 2 (webhook ingress against the mock adapter) and Slice 3 (OAuth) are not started; Slice 3 additionally waits for the confirmed tunnel domain.

## Integration (2026-11-13)
- Merged `feat/meta-inbox-slice1` into `main` as merge commit `65cf409` (no history rewrite; tree clean before merge).
- `pnpm --filter @crm/db migrate` run on the main dev database `crm` as `crm_migrator`; roles setup script NOT run. 0017 and 0018 applied: 19 migrations recorded, 9 inbox tables with forced RLS, 122 policies and 128 app/ingest/worker table grants in `crm`, identical to the earlier upgrade-path database.
- Focused tests on `crm`: `@crm/db` inbox-schema and tenancy 55/55; API full run 346 passed, 14 skipped (3 consecutive runs).
- Intermittent API test-collection failure: ROOT CAUSE FOUND (not connection exhaustion). `test/harness.ts` built unique e-mails from `Date.now().toString(36)`; two vitest workers loading the harness in the same millisecond produced the same address, `user_email_unique` (23505) failed in `beforeAll`, `afterAll` then closed the pool and the other concurrent sign-ups reported "Cannot use a pool after calling end". Reproduced on a fresh database (1 failure in 3 runs, contacts + tasks suites), fixed by adding a random suffix (harness, password-reset, events tests); 1 further full run green on the same database. Test-only change; no product code affected.
