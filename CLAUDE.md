# Social CRM

Premium multi-platform Social CRM: Next.js web, Expo (React Native) Android and iOS app, shared Hono API and worker, PostgreSQL with row level security. Meta first (Messenger, Instagram, Lead Ads, Conversions API); TikTok, WhatsApp, LinkedIn later through adapters. AI and automation are foundations, human approval by default.

## Status
Phase 1 in progress: stack spike and web shell done; Android emulator verification (deferred by the user), generated API client and forgot-password still open. Phase 2 not started. See `docs/project/progress.md` and the Phase 1 status table in `docs/project/roadmap.md`.

## Architecture (proposed, pending approval)
Monorepo: apps/web, apps/mobile, apps/api, apps/worker; packages/contracts, db, core, integrations, capi, ai, design-tokens. Details: `docs/architecture/architecture.md`.

## Commands
Node 24 (`.nvmrc`), pnpm 12. Postgres 18 via `pnpm db:up` (port 5436; roles and grants: `packages/db/sql/001_roles_and_probe.sql`, then `pnpm --filter @crm/db migrate`).
- Checks: `pnpm exec turbo run lint typecheck test`
- API: `pnpm --filter @crm/api dev` (needs `.env`, see `.env.example`); web: `pnpm --filter @crm/web dev`
- Browser tests: `cd apps/web && pnpm exec playwright test` (starts both servers on ports 3217/8791)
- Tokens: `pnpm --filter @crm/design-tokens build` (runs automatically before web dev/build)

## Conventions
- Every tenant table has workspace_id and RLS; never query without workspace context.
- Platform tokens and API keys stay server-side, encrypted; never log them.
- Never claim an integration works without a recorded real request. Mock mode is labeled as mock.
- Never mark a task complete without running the relevant checks.
- No dead buttons; every screen has loading, empty and error states.
- Web and mobile share contracts and tokens, not UI components.
- Tenant tables need `workspace_id`, forced RLS and a policy; `packages/db/test/tenancy.test.ts` fails otherwise.
- Web talks to the API only through the same-origin proxy; browser code never sees tokens other than the session cookie.
- Keep docs in sync: roadmap, progress, decisions, known-limitations, testing-report.

## Docs
PRD `docs/project/prd.md`; roadmap `docs/project/roadmap.md`; decisions `docs/project/decisions.md`; skills `docs/project/skill-utilization-matrix.md`; research `docs/research/`; DB `docs/architecture/database-design.md`; API `docs/architecture/api-strategy.md`; CAPI `docs/architecture/capi-architecture.md`; AI `docs/architecture/ai-automation-architecture.md`; design `docs/design/design-system.md`.
