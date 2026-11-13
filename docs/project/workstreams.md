# Parallel Workstreams (Phase 2)

Created 2026-11-13 from the user's Parallel Development Directive. Phase 1 stays formally OPEN. Production Leads/Pipeline code does not start until Contacts acceptance passes.

## Tracks, branches and resources

| Track | Scope | Branch (worktree) | Test database | E2E ports (web / api) | Owner |
|---|---|---|---|---|---|
| A | Contacts acceptance review and remediation (security, integrity, requirements) | `main` | `crm` | 3217 / 8791 | review agents (read-only) then integrator |
| B | Workspace-level tasks | `track/tasks` | `crm_tasks` | 3411 / 8811 | track B agent |
| C | In-app notifications and the event outbox | `track/notifications` | `crm_notif` | 3412 / 8812 | track C agent |
| D | Global search foundation (Contacts only) | `track/search` | `crm_search` | 3413 / 8813 | track D agent |
| E | Leads/Pipeline design only (documents, no code) | `track/design-leads` | none | none | track E agent |

Dev demo servers on `main`: web 3300, API 8788 (demo data). Do not use these ports.

Isolation: `scripts/db-create.sh <name>` creates a database with the same roles, grants, extensions and migrations. Tests read `CRM_DB_NAME`; Playwright reads `E2E_WEB_PORT` and `E2E_API_PORT`. Example: `CRM_DB_NAME=crm_tasks pnpm exec turbo run test`.

## File ownership

| Area | Owner | Rule |
|---|---|---|
| `packages/db/src/schema/tasks.ts`, `apps/api/src/routes/tasks.ts`, `packages/contracts/src/tasks.ts`, `apps/web/app/w/[workspaceId]/tasks/**`, task e2e | B | B may change the existing `tasks` table definition (moving it out of `crm.ts`) and the task handlers in `contacts.ts` only as one isolated commit. |
| `packages/db/src/schema/notifications.ts`, `apps/api/src/events.ts`, `apps/api/src/routes/notifications.ts`, `packages/contracts/src/notifications.ts`, `apps/web/components/notifications/**`, notification pages, `app-shell.tsx` | C | C does NOT edit `contacts.ts`, `imports.ts`, `tasks.ts` or `crm-config.ts`. It exports `emitEvent(tx, ...)` and documents call sites; the integrator wires them. |
| `apps/api/src/search/**`, `packages/contracts/src/search.ts`, `command-menu.tsx`, `docs/architecture/global-search.md` | D | D extracts the contact query code from `routes/contacts.ts` into `apps/api/src/contact-query.ts` as one separate first commit; the integrator resolves any overlap with Track A fixes. |
| `docs/design/leads-pipeline/**` | E | Documents only. No code, no migrations, no contracts. |
| `docs/project/roadmap.md`, `progress.md`, `decisions.md`, `known-limitations.md`, `testing-report.md`, `skill-utilization-matrix.md`, `integration-conflicts.md` | integrator | Tracks write their own `docs/project/track-<x>-report.md` instead of editing these. |

## Shared files (conflicts expected, resolved by the integrator)

Each track adds only the minimum, in a clearly marked block:
- `packages/db/src/schema/index.ts`: one `export *` line per track.
- `packages/contracts/src/index.ts`: one `export * from "./<track>.ts"` line and one `...<track>Endpoints` spread into `endpoints`.
- `apps/api/src/routes/workspaces.ts`: one `scoped.route("/", <track>Routes(db))` line.
- `packages/core/src/permissions.ts`: new actions inside `// --- track:<name> ---` comment markers.
- `apps/web/lib/nav.ts`: Track B adds the Tasks item only.
- Migrations: do NOT edit `drizzle/meta/_journal.json` or other tracks' files. Generate migrations in your own branch with a track suffix in the name (`drizzle-kit generate --name <track>_...`), and put RLS SQL in a separate custom migration (`--custom --name <track>_rls`). The integrator discards track migration numbering and regenerates one combined migration from the merged schema, then re-applies each track's RLS SQL, so keep the RLS SQL self-contained.

## Rules for every track
1. Work only in your worktree and branch; commit small and often (work survives if a session is cut off).
2. Tests first for logic and API; isolation and permission tests for every new tenant table (the tenant-table CI check in `packages/db/test/tenancy.test.ts` must keep passing: `workspace_id`, forced RLS, at least one policy).
3. RLS policies call helpers as `(SELECT app_has_role(...))` and `(SELECT app_workspace_id())` (decision D45).
4. All new endpoints are defined in shared contracts and covered by the drift guard; mobile (bearer) compatible; additive only.
5. UI: use the design system and component library, include loading, empty, error and success states, test 375/768/1440, axe, touch targets (see `apps/web/e2e/contacts-responsive.spec.ts` for the pattern), and save screenshots under `docs/design/screenshots/<track>/` (set `UPDATE_SCREENSHOTS`).
6. Run lint, typecheck and the full test suites against your own database before reporting.
7. Final output: `docs/project/track-<x>-report.md` with scope delivered, tests (counts and what they prove), screenshots, files touched, shared-file edits for the integrator, open issues, skills used (honestly), and what is NOT done.
8. Never claim something works without having run it. Never weaken or skip tests.
