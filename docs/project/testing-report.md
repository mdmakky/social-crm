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
