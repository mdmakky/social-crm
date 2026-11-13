# Phase 1 Stack Spike Implementation Plan

> For agentic workers: use superpowers:executing-plans (native execution chosen by the user's approval to proceed directly). Steps use checkboxes.

**Goal:** Prove, by running it, that Expo 58 + Hono + Better Auth + Drizzle + Postgres 18 + pg-boss work together in a pnpm/Turborepo monorepo on Node 24, and record what each piece actually does, before any Phase 1 scaffolding is treated as final.

**Architecture:** pnpm workspace with `apps/api` (Hono + Better Auth + Drizzle), `apps/mobile` (Expo), `packages/db`, local Postgres 18 in Docker. Spike code lives in the real structure so passing work is kept; failures are recorded in `docs/project/spike-report.md`.

**Tech Stack:** Node 24 LTS, pnpm, Turborepo, TypeScript, Hono, Better Auth + @better-auth/expo, Drizzle, Postgres 18, pg-boss, Expo SDK 58, Vitest.

**Spec:** `docs/architecture/architecture.md`, `docs/research/technology-decisions.md`, roadmap Phase 1.

## Global Constraints
- Node 24 LTS primary (`.nvmrc`, `engines`); Node 26 tested separately and reported.
- Verify versions with the npm registry/Context7 before pinning; pin exact versions.
- No secrets committed; `.env` gitignored, `.env.example` committed.
- A step passes only on observed command output; installation alone is not a pass.

## Review Focus
- Mobile bearer token flow: where the token is stored, how it expires, whether refresh rotates (record actual behavior).
- Cookie vs bearer on the same API, cross-origin web requests blocked/allowed as designed.
- Database role split: request path connects as non-owner role and cannot bypass RLS.
- pg-boss enqueue inside an application transaction (supported or not).
- Metro bundling a monorepo with workspace packages.

### Task 1: Workspace and toolchain
**Files:** `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `.gitignore`, `tsconfig.base.json`, `docker-compose.yml`, `.env.example`
- [ ] Pin Node 24; create workspace with `apps/*` and `packages/*`.
- [ ] `docker compose up -d` Postgres 18; verify `psql` connects.
- [ ] Verify: `pnpm -v`, `node -v` = v24, `docker compose ps` healthy.

### Task 2: DB package with roles and RLS probe
**Files:** `packages/db/*`, SQL migration creating roles `crm_migrator`, `crm_app` and a probe table with `workspace_id` + forced RLS.
- Produces: `createDb(url): Db`, `withWorkspace(db, workspaceId, fn)` setting `app.workspace_id` with `set_config(..., true)`.
- [ ] Test (Vitest + real Postgres): rows from workspace A invisible under workspace B context; `crm_app` cannot disable RLS.
- [ ] Run, expect pass.

### Task 3: API with Better Auth
**Files:** `apps/api/src/*`
- Produces: Hono app on `/api/auth/*` (Better Auth, email+password, bearer + expo plugins, Drizzle adapter), `GET /v1/me`.
- [ ] Test: register, login, `/v1/me` with cookie and with bearer; invalid token returns 401.
- [ ] Record: session expiry fields, whether refresh tokens rotate.

### Task 4: pg-boss in-transaction enqueue
- [ ] Test: enqueue within a transaction; rollback leaves no job; commit leaves one. Record result (supported / needs dispatcher).

### Task 5: Expo app compiles
**Files:** `apps/mobile/*`
- [ ] Create Expo SDK 58 app with expo-router, expo-secure-store, Better Auth client; import a workspace package to test Metro monorepo resolution.
- [ ] Verify: `npx expo export --platform android` bundles; typecheck passes. Emulator run deferred to Task 6.

### Task 6: Android toolchain and run
- [ ] Check JDK support for Expo 58/RN 0.88 (Java 25 may be unsupported); install the supported JDK and Android SDK + emulator only after confirming size/steps. Run the app on the emulator, register and log in against the API, confirm token is in SecureStore.

### Task 7: Node 26 and report
- [ ] Re-run Tasks 2 to 5 tests under Node 26; write `docs/project/spike-report.md` (versions, results, deviations, blockers); update `decisions.md`, skill matrix and progress.
