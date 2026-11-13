# Social CRM

Premium multi-platform Social CRM: Next.js web, Expo (React Native) Android and iOS app, shared Hono API and worker, PostgreSQL with row level security. Meta first (Messenger, Instagram, Lead Ads, Conversions API); TikTok, WhatsApp, LinkedIn later through adapters. AI and automation are foundations, human approval by default.

## Status
Phase 0 (planning) complete in draft, awaiting user approval. No code yet. See `docs/project/progress.md`.

## Architecture (proposed, pending approval)
Monorepo: apps/web, apps/mobile, apps/api, apps/worker; packages/contracts, db, core, integrations, capi, ai, design-tokens. Details: `docs/architecture/architecture.md`.

## Commands
None yet. Phase 1 will add pnpm scripts: typecheck, lint, test, dev.

## Conventions
- Every tenant table has workspace_id and RLS; never query without workspace context.
- Platform tokens and API keys stay server-side, encrypted; never log them.
- Never claim an integration works without a recorded real request. Mock mode is labeled as mock.
- Never mark a task complete without running the relevant checks.
- No dead buttons; every screen has loading, empty and error states.
- Web and mobile share contracts and tokens, not UI components.
- Keep docs in sync: roadmap, progress, decisions, known-limitations, testing-report.

## Docs
PRD `docs/project/prd.md`; roadmap `docs/project/roadmap.md`; decisions `docs/project/decisions.md`; skills `docs/project/skill-utilization-matrix.md`; research `docs/research/`; DB `docs/architecture/database-design.md`; API `docs/architecture/api-strategy.md`; CAPI `docs/architecture/capi-architecture.md`; AI `docs/architecture/ai-automation-architecture.md`; design `docs/design/design-system.md`.
