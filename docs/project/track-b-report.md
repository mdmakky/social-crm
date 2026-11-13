# Track B report: workspace-level Tasks

Branch `track/tasks` worktree, database `crm_tasks`, ports 3411/8811. Design and rules: `docs/architecture/tasks.md`.

## Scope delivered
- Schema: `tasks` extended (nullable `contact_id` with composite FK, `description`, `priority`, `version`, soft `deleted_at`, statuses open/in_progress/done/cancelled), `task_events` (append-only, trigger plus revoked grants), `task_links` (allow-list `contact`, validation trigger, sync trigger from `tasks.contact_id`). RLS: all roles read, owner/admin write all, agent writes own (assignee or creator), viewer none; scalar-subquery helpers.
- API (`apps/api/src/routes/tasks.ts`, `packages/contracts/src/tasks.ts`): list with filters (assignee me/unassigned/member, status, priority, due range, contact, search), sort (due, priority, created, updated, both directions), keyset cursor with total; summary counts; create; get; history (paged); patch with `expectedVersion` (optional for old clients) and one history event per change; soft delete. Views: overdue, today, upcoming, no_date, completed with explicit `asOf` and IANA `tz`. Contact timeline and `last_activity_at` kept in step (adds `task.cancelled`, `task.deleted`, `task.linked`, `task.unlinked`).
- Core: `dueState`, `dayBounds`, `canEditTask` (`packages/core/src/tasks.ts`).
- Web: `/w/:id/tasks` with view tabs and counts, filter bar (search, assignee, status, priority, contact picker, due range), sort, table on desktop and cards on mobile, New/Edit dialog, detail dialog with history timeline, quick complete checkbox with Undo, loading/empty/error/success states, permission-aware controls, nav item. Contact page TasksPanel adjusted for in_progress and creator ownership.

## Tests (all run against `crm_tasks`)
| Suite | Count | What it proves |
|---|---|---|
| `packages/db/test/tasks-rls.test.ts` | 13 | isolation on tasks, task_events, task_links; composite FKs; role boundaries; agent own rule and hand-over; no hard delete; append-only even for the table owner; link mirroring, allow-list, target validation |
| `packages/core/test/tasks.test.ts` | 13 | day bounds incl. 23h and 25h DST days, Auckland, New York; due-state boundaries; edit permissions |
| `apps/api/test/tasks.test.ts` | 51 | validation (title, description, dates, enums, assignee active member, contact workspace), isolation on every operation, matrix per role, one history entry per change and none for no-ops, concurrency (stale version, race), filters, keyset paging for all 4 sorts x 2 directions with ties, cursor mismatch, views and boundaries, UTC/Auckland/New York/DST-day, summary, contact timeline and last activity, contact-scoped endpoints, bearer path, 401 |
| `apps/api/test/tasks-perf.test.ts` | 18 | 10,000 tasks as an agent through RLS: every list variant p95 < 300 ms. Measured p95: 18 to 54 ms (due asc 44, priority 30, search 43, deep cursor page 40, summary 18) |
| Drift guard (`contract.test.ts`) | existing | covers every new route automatically (all endpoints in `endpoints`) |
| `apps/web/e2e/tasks.spec.ts` | 6 | create, edit, complete (keyboard), undo, reopen, history, contact link and timeline, delete, stale-edit conflict, views and counts, filters, sorting, due range, URL state, paging, error and retry, permissions for owner/admin/agent/viewer |
| `apps/web/e2e/tasks-responsive.spec.ts` | 2 | 375/768/1440: no overflow, axe clean (empty, list, overdue, completed, no-match, filters open, dialogs, detail), mobile cards vs table, touch targets >= 44 px on Pixel 7 emulation |

Totals from the final full run: core 60, db 49, api 202, api-client 16, web unit 34, design-tokens 42 (all pass); Playwright 27 passed (tasks 6 + responsive 2 + contacts, contacts-responsive, permissions suites re-run because I touched shared files). One earlier `turbo run` had `contacts-list.test.ts` hit its 10 s `beforeAll` timeout while my 10k perf test seeded in parallel; it passes alone and in `pnpm test`; not weakened, but turbo's parallelism can still trigger it. Turbo needs `--env-mode=loose` for `CRM_DB_NAME` to reach the tests (strict mode drops it; my first turbo run therefore hit the shared `crm` database and failed on the missing columns, leaving only unique-named test users and workspaces there).

## Screenshots
`docs/design/screenshots/tasks/` (empty, list, overdue, completed, no-match, filters, new task with picker, detail with history, edit; at 375, 768, 1440).

## Files touched
New: `packages/db/src/schema/tasks.ts`, migrations `0008_tasks_schema`, `0009_tasks_rls`, `0010_tasks_due_indexes`, `apps/api/src/routes/tasks.ts`, `packages/contracts/src/tasks.ts`, `packages/core/src/tasks.ts`, `apps/web/app/w/[workspaceId]/tasks/**`, `apps/web/components/tasks/**`, `apps/web/lib/tasks.ts`, tests and docs listed above.
Changed outside the owned area: `packages/db/src/schema/crm.ts` (tasks moved out), `apps/api/src/routes/contacts.ts` (task handlers removed), `apps/api/src/crm-service.ts` (openTaskCount: active and not deleted), `apps/web/lib/contacts.ts` (4 timeline labels), `contact-detail.tsx` (TasksPanel: in_progress and creator), `apps/web/test/lib.test.ts` (Tasks added to expected nav lists), `packages/core/package.json` (`./tasks` export).

## Shared-file edits for the integrator
- `packages/db/src/schema/index.ts`: `export * from "./tasks.ts"` (marked `track:tasks`).
- `packages/contracts/src/index.ts`: import, `export *`, and `...tasksEndpoints` in `endpoints`.
- `apps/api/src/routes/workspaces.ts`: import and `scoped.route("/", taskRoutes(db))`.
- `apps/web/lib/nav.ts`: Tasks item.
- `packages/core/src/index.ts` and `package.json`: tasks export. No `permissions.ts` change was needed (`task.edit` already fits).
- Migrations: regenerate one combined migration; re-apply `0009_tasks_rls.sql` (self-contained; it assumes the tables and enum values exist and does not use the new enum values). Note drizzle-kit emitted the `tasks_ws_id` unique constraint after the FKs that need it; I reordered it by hand in 0008. Also keep the two expression indexes from 0010 (drizzle represents them from the schema file). `drizzle/meta/_journal.json` and snapshots changed by generate; discard.
- Track C: `emitEvent` call sites would go in `routes/tasks.ts` create/patch (assignment, due) when the integrator wires them.

## Open issues and NOT done
- Mobile app screens (contracts are bearer-tested only).
- Contract nuance: `Task.contactId` is nullable and `status` has two new values; old mobile builds that assume otherwise need updating.
- Due input uses the browser time zone while display and "today" use the workspace time zone.
- No trigram index for search; no bulk actions, saved task views, recurring tasks, reminders or comments.
- Tasks that existed before the migration have no `created` event.
- `task_events` insert policy does not check task ownership (API does).
- Visual critique with the impeccable `critique` skill was not run; layout was checked via screenshots and axe only.

## Skills used (honest)
Used: Playwright (via the project's e2e suite), drizzle-kit, the repository's own patterns. ponytail and caveman modes were active as instructions. NOT used: ui-ux-pro-max searches, superpowers test-driven-development (tests were written alongside code, not strictly first), superpowers verification-before-completion (I ran the real builds and suites instead), impeccable critique, Context7. The impeccable design hook scanned each UI file on write and reported nothing.
