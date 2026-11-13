# Contacts acceptance report

Date: 2026-11-13. Commit: main `8cc4e65` plus this report. Status: **evidence complete for review; NOT accepted.** Acceptance is the user's decision. Phase 1 stays OPEN (Android emulator login and SecureStore runtime unverified). Release gate D19 (full security review before any non-owner user) is not met: `cso` is Not assessed.

## What changed since the independent review
Three independent reviews (security, integrity, requirements) found 1 blocker, 19 major and 43 minor items. Resolution evidence is by commit; tests are in the files named.

| Finding | Sev | Resolution | Evidence |
|---|---|---|---|
| Sec B1 ReDoS in `normalizeEmail` | P0 | Length gate before a linear pattern; bounded phone and CSV cells | `0246174`; `packages/core/test/contacts.test.ts` (hostile input tests) |
| Sec M1 size, rate, quota on imports | P0 | Stream body limits (413), per-user and per-workspace rate limits, open-job cap, CSV cleared after commit | `4b2e391`, `0655138`; `imports-hardening.test.ts` |
| Sec M2 error logs carry SQL parameters | P0 | `app.onError` logs class, pg code, constraint only; NUL refused (400) | `0655138`; `contacts-hardening.test.ts` |
| Sec M3 import overwrote real name | P0 | Derived-name flag; update never replaces a real name | `0246174`, `4b2e391` |
| Sec M4 / m1 DB did not back the matrix | P0 | Migration 0008: audit_log, workspaces, contact soft delete, tasks, activities forgery; membership proven before workspace GUC is set | `04de015`; `packages/db/test/rls-matrix.test.ts` (13, mutation-checked) |
| Integrity M1 deleted contact's notes/tasks editable | P1 | 404 guards (notes, tasks) | `0655138`, `cb40b96` |
| Integrity M2, M4, M5, m15, m16 | P1 | Tag counts, stage lock, tag-delete timeline entries, tag race, restore uniqueness | `0655138` |
| Integrity M3 duplicate race | P1 | Advisory locks on create, PATCH, import | `0655138`, `4b2e391` |
| Integrity M7 41 s import | P1 | Batched writes; updates batched (5,000 updates 18.3 s to 1.1 s) | `4b2e391`, `532d011`; `docs/project/track-c-import-report.md` |
| Integrity M8 rollback proof | P1 | Real PostgreSQL failure test in an isolated database | `imports-integrity.test.ts` (4, needs `IMPORT_ISOLATED=1`) |
| Other minors m1, m2, m6, m8, m9, m10 | P1/P2 | NUL, cursor, strict dates, display phone, partial custom validation, request id | `0655138` |
| Req F1 to F23 | P1/P2 | WP-A, WP-B, WP-C | merges `cfa1b8f`, `635fccd`, `8cc4e65`; plan `docs/project/web-f1-f23-plan.md` |

## Verification (actual runs)
- Existing database: `crm` (25,470 contacts) upgraded 0007 to 0013 with `pnpm --filter @crm/db migrate`; 14 migrations recorded.
- Fresh database: 14 migrations; db, API suites pass on it.
- `pnpm exec turbo run lint typecheck test --env-mode=loose --force` on main: 22/22 tasks; design-tokens 42, core 71, api-client 16, db 71, web unit 34, API 310 passed and 10 skipped (opt-in benchmark and isolated-database tests).
- Playwright, full suite, integration branch, fresh database: 99 passed (5.2 min).
- Earlier on the pre-integration code: 3 consecutive full runs 22/22, API 195/195.

## Open findings (explicit)
- **Original shared-`crm` flake**: exact cause unproven. Reproduced mechanism (10 s hook timeout under CPU load, pool closed mid-hook) fixed by `hookTimeout: 60 s`; 5 of 5 runs passed after the fix.
- **perf.test.ts under CPU contention** (also tasks-perf): passes alone at load 11 to 15; failed twice when both perf files ran in parallel with other work. Budgets unchanged. Fix proposed, not done: run perf gates as their own serial task.
- **Static worst-case connection estimate about 121** across parallel test files, observed peak 37 to 44, `max_connections` 100.
- **memberships RLS**: `memberships_select` keeps a workspace-context branch (a policy cannot reference its own table without recursion). Mitigated by proving membership before the workspace GUC is set; not fully DB-enforced.
- **Owner/assignee not FK to memberships** (sec m1), not done: needs a member-removal flow change.
- **M6 export not lossless** for tags or options containing `,;|`; archived custom fields not exported; archived stage names not re-importable.
- Deferred P2: accent-insensitive search (m4), version semantics (m5), timeline gaps (m14), migration 0006 has no backfill (m17; applied, not edited), `x-forwarded-for` trust, import row-number convention (m10), extra list sort keys (needs API), Retry on a failed Load more.
- Import limits: 5,000-row timings measured on a near-idle host only; second-commit wait behaviour depends on host load.
- Rate limits are in-process (single API instance).
- `cso`: **Not assessed.** The launcher build failed (static glibc missing; fix is `sudo dnf install glibc-static`, then `bash ~/.claude/skills/gstack/scripts/build-cso.sh`).
- Android emulator login and SecureStore runtime: not verified (deferred by the user).
