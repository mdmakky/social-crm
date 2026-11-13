# Phase 1 Stack Spike Report

Date: 2026-11-13. Plan: `docs/superpowers/plans/2026-11-13-phase1-stack-spike.md`. Every result below comes from a command that was actually run; "not done" means not done.

## Verdict
The server side of the stack works end to end and is verified. The mobile side compiles and bundles but has not been run on a device or emulator. The mobile run was deferred by the user (web first), so Phase 1 acceptance items that need a running mobile app remain open.

## Results by task
| Task | Result | Evidence |
|---|---|---|
| 1 Workspace and toolchain | Passed | Node 24.22.3 pinned (`.nvmrc`, `engines`), pnpm 12.16.1, Turborepo 2.11.11, Postgres 18.7 in Docker (healthy). |
| 2 DB roles and RLS | Passed | 6 Vitest tests against real Postgres: tenant A sees only A rows, no context fails closed, cross-tenant insert rejected by RLS, update/delete of other tenant's rows affect 0 rows, `crm_app` is not superuser/BYPASSRLS and cannot disable RLS, workspace setting does not leak on pooled connections. |
| 3 Hono + Better Auth + Drizzle | Passed | 8 tests: register, weak password rejected, sign-in returns cookie and `set-auth-token` bearer, `/v1/me` works with cookie and with bearer, 401 for none or bad token, untrusted Origin rejected, session expiry is 30 days. Live curl against a running server also passed. |
| 4 pg-boss transactional enqueue | Passed | 3 tests: enqueue inside a Drizzle transaction commits one job and rolls back none; the request-path role `crm_app` is denied access to the `pgboss` schema by default. |
| 5 Expo compiles | Passed | Expo SDK 58.0.25 / RN 0.88.1 app typechecks; `expo export --platform android` bundled 762 modules (2.4 MB Hermes bytecode) including the `@crm/contracts` workspace package and expo-secure-store; `expo-doctor` 20/20 checks passed. |
| 6 Android emulator run | **Not done (deferred by user)** | JDK 17 and Android SDK 36 installed under `~/Android`; AVD `crm_pixel` created; emulator launched but boot was not confirmed (RAM pressure) and was stopped. App not run on a device. SecureStore token storage not verified at runtime. |
| 7 Node 26 | Passed | Full `turbo typecheck test` under Node 26.13.0: all 6 tasks green (6 db and 11 api tests). Node 24 stays the baseline per D14. |

## Findings that change or refine the design
1. **Better Auth has no rotating refresh token.** The session table has no refresh-token column; sessions use a sliding expiry (`expiresIn` 30 days, `updateAge` 1 day). This matches decision D27; mobile uses a bearer session token with server-side revocation. Test asserts the column is absent.
2. **Origin check gap.** Better Auth's default CSRF origin check only applies when cookies are sent, so a cookie-less sign-in from an untrusted origin returned 200. A Hono middleware now rejects mutating requests whose `Origin` is not allowed (native apps send no Origin).
3. **`getCookie()` is async in 1.7.22**, unlike older docs. Caught by the TypeScript check, not by a runtime test.
4. **pg-boss can enqueue inside an application transaction** (`fromDrizzle(tx, sql)`). The request-path role must not touch the `pgboss` schema, so the dispatcher design in architecture amendment B2 stands; direct enqueue from request handlers needs an explicit grant decision, not a default.
5. **Migration role needs `CREATE` on the database** to create Drizzle's bookkeeping schema. `drizzle-kit migrate` failed silently when it lacked this; the programmatic migrator (`packages/db/src/migrate.ts`) surfaces the error. Use the programmatic migrator.
6. **Paths with spaces:** `URL.pathname` percent-encodes the repository path ("Client Project"); use `fileURLToPath`.
7. **pnpm 12 blocks dependency build scripts by default** and enforces a minimum release age. `esbuild` is explicitly allowed (`allowBuilds`); pnpm also wrote `minimumReleaseAgeExclude` entries for freshly published versions of better-auth, @better-auth/*, expo and @hono/node-server. These exclusions weaken the release-age protection for those packages and should be reviewed when versions age past the window.
8. **TypeScript versions differ:** the Expo template pins TypeScript ~6.0.3 in `apps/mobile`; other packages use ~5.9.3. TypeScript 7.0.2 exists but was not adopted. Align deliberately later.
9. **Port 5434 was taken** by another local project; this project's Postgres uses 5436. Other local databases (5432, 5433) were not touched.
10. **Resources:** the machine has 15 GB RAM with only about 2 GB available during the run; the Android emulator will need other applications closed. KVM is available. Android SDK, JDK and emulator images use about 8.7 GB.

## Open items carried forward
- Run the Expo app on the Android emulator, register and sign in against the API, and confirm the token is stored in SecureStore (Phase 1 mobile acceptance items 2 and 4).
- Decide the RN styling library (D11) when mobile UI work starts.
- Review the `minimumReleaseAgeExclude` entries.
