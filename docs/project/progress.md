# Progress

Updated: 2026-11-13.

## Current phase
Phase 0, Discovery and Planning: documents drafted, awaiting user approval. No application code exists. Nothing has been installed, scaffolded or run.

## Completed in Phase 0
- Environment inspected: empty repository; Fedora; Node 26, pnpm 12, Postgres 18 client, Docker, Java 25; no Android SDK; no macOS.
- Skills, plugins, agents and MCP tools discovered; matrix written (`skill-utilization-matrix.md`); skill gaps recorded.
- Research (six parallel agents, retrieval 2026-11-13): competitor analysis, UI/UX, Meta messaging and leads, Meta CAPI, future integrations, technology decisions.
- PRD, architecture, database design, API strategy, CAPI architecture, AI/automation architecture, design direction, roadmap, decisions log.

## Remaining in Phase 0
- User review of documents and decisions.
- Strict review pass over the planning documents (an independent review agent was not run yet).
- Spot-check of research citations (not yet done).
- Re-check of unverified items listed in `known-limitations.md`.

## Next
Phase 1 after approval. See acceptance criteria in `roadmap.md`.

## Update 2026-11-13: audit, review, citation check
Feature completeness audit written. Independent review run (`phase0-review.md`) and its fixes applied to architecture, database, API, PRD, roadmap and decisions; `permissions.md` added. Meta citation spot-check run (`../research/citation-spot-check.md`); errata appended to the two Meta research files. Still pending: user approval of decisions D1 to D28, Phase 1 not started. The review's major findings were addressed in documents only; none are implemented or tested.

## Update 2026-11-13: Phase 1 started (stack spike)
Spike tasks 1 to 5 and 7 passed; task 6 (Android emulator run) deferred by the user so that web work comes first. See `spike-report.md`. Git: local repository initialized, commits authored as the user's GitHub noreply identity; no remote configured yet. Phase 1 is not complete: web shell, design system, auth UI, workspace foundation, and mobile run items remain.

## Update 2026-11-13: Phase 1 web shell built, Phase 1 not complete
Built and verified: workspaces, memberships, append-only audit log with forced RLS; permission matrix; Mailer and BlobStore ports; design tokens with contrast tests; component library; responsive Next.js shell; login, register, onboarding, Home, Members, Audit log, Settings; permission-aware navigation; ESLint. Local results: lint, typecheck and unit/integration 19 of 19 turbo tasks; 19 Playwright tests; axe clean. An independent design critique found 2 blockers and about 10 majors; they were fixed or explicitly deferred (`docs/design/critique-phase1-shell.md`).
Open before Phase 1 can close: Android emulator login and SecureStore verification (deferred by the user), generated API client decision, forgot-password, second design review. Phase 2 has not been started.

## Update 2026-11-13: decisions D34-D36 executed; Phase 1 remains OPEN
Done: shared typed API client with drift guards (item 5 met at code level); second independent design review and its fixes (open redirect, 768 regression, error and touch coverage, security headers); password reset slice of Phase 2. Phase 1 stays open: Android emulator login (item 2) and SecureStore runtime (item 4) are unverified; item 6 has listed coverage gaps; no third design review. Mobile readiness is not claimed. Phase 2 has started web-first: the next slice is contacts, tags, notes and the activity timeline.

## Update 2026-11-13: Contacts slice built; acceptance pending review
Data model, API, web UI, import and export, and settings are done and tested (see roadmap and testing report). The independent review failed on a usage limit and must be rerun before Contacts acceptance can be called passed. Leads and Pipeline are not started. Phase 1 remains OPEN. Next: run the review (resume or relaunch after the limit resets at 12:20pm Asia/Dhaka), fix findings, then close Contacts acceptance.

## Update 2026-11-13: Leads and Pipeline checkpoint (feature branch, not merged)
Branch `feat/leads-pipeline`, code HEAD `ef574f8`. Slices 0 to 7 of the approved sequence are built and tested (schema and RLS, pipeline configuration, lead CRUD, list, detail, board, tasks link, search and notifications, minimal reporting). Android verification is DEFERRED by user decision (emulator crashes with KVM on this machine; processes stopped; mobile source untouched; nothing mobile is claimed verified). Meta Inbox architecture plan written; implementation not started. See `leads-pipeline-acceptance-report.md` for the VERIFIED, UNVERIFIED, DEFERRED and BLOCKED lists.

## Update 2026-11-13: Leads and Pipeline merged to main
Merge commit `50bf5b6` (feature branch `feat/leads-pipeline`, code HEAD `ef574f8`). Fresh-database and upgrade-from-0013 migration checks passed (details in `leads-pipeline-acceptance-report.md`). Android remains DEFERRED / UNVERIFIED. Meta Inbox is planned only (`docs/architecture/meta-inbox-plan.md`), no implementation.

## Update 2026-11-13: UX track (Quiet Precision) applied to the web app
Role tokens, Home dashboard, settings sub-nav, shared tabs, contacts value hierarchy, contact Deals panel and notifications restyled. Details and evidence: `docs/design/ux-track.md`. Phase status unchanged. Meta Inbox Slice 3 not started.

## Update 2026-11-14: Smart Messenger CRM slices (merged to main)
Hosted free-tier stack (Vercel web, Render API, Neon DB) is live for dev/demo; real Messenger delivery and name/profile-picture enrichment were verified on it (Meta permission: see known-limitations). Built on `feat/smart-messenger-crm`: profile enrichment (`43b75f6`), phone extraction (`d986656`), email extraction (`773d2e1`), correct/remove detected methods (`de5f4f1`), Contact Details detected section (`39e7f4e`), audit of privileged note edits/deletes (`d9a8367`), Playwright spec and docs (this merge). Migrations 0021 (profile enrichment), 0022 (contact_methods), 0023 (method corrections). Decisions D46 to D49. Hosted verification of extraction and corrections is NOT done (mock and local only). Remaining slices: duplicate detection (5), tagging rules (6), AI summary and intent (7), lead scoring and sentiment (8), follow-up suggestions (9). Send (outbound) is still not started.

Outbound Messenger replies (2026-11-14, branch `feat/messenger-outbound`, not pushed, not deployed): API `POST /conversations/:id/messages` and `.../messages/:id/delivery`, composer in the Inbox thread, recovery of stuck sends, echo adoption. No migration. Decisions D50 to D53. Real-Meta verification pending (manual hosted test).

Instagram messaging (2026-11-14, branch `feat/instagram-messaging` from main `32f4cf7`; not pushed, not deployed): connect picker with Instagram details, inbound routing by signed object, Instagram enrichment, Instagram text replies via the existing pipeline, composer enabled for Instagram. No migration. Decisions D54 to D57. Needs the manual Meta Dashboard steps and the hosted test in `docs/integrations/instagram-messaging.md`.

Direct Instagram connection without a Page (2026-11-14, branch `feat/instagram-unified-login`, not merged, not deployed): Unified Login (the only route available to this app). Migration 0024 (`auth_method`). Decisions D58 to D61. Needs the Instagram-compatible configuration id (`META_IG_CONFIG_ID`) and the dashboard steps in `docs/integrations/instagram-messaging.md` (Method C). The earlier `feat/instagram-login` branch is obsolete for this app.

Inbox redesign, option A "Focus" (2026-11-14, branch `feat/inbox-redesign` from main, not pushed, not deployed): list tabs (All, Unread, Mine, Unassigned) and a filter menu for status and teammates; search with `/`; day groups; solid-indigo replies with sender and time once per run; "Latest" jump button; composer card with a 24h window chip; contact panel closed by default and slid open (`C`, remembered), a sheet below lg; lead stage control in the header and the panel (moves the contact's lead through `moveLead`, a reason is required for Lost, one Undo); conversation status moved to the "More actions" menu. Motion uses the existing tokens and never changes opacity (axe samples mid-animation). Design options and the chosen mockup: `docs/design/inbox-redesign/`.
WhatsApp slice 1, webhook foundation (2026-11-14, branch `feat/whatsapp-foundation`, not pushed, not merged, not deployed). Migration 0025, decisions D64 to D67, `docs/integrations/whatsapp-cloud-api.md`. Receiving only: no connect form, no sending. Next: slice 2 (manual onboarding) needs a WABA, a number and a system-user token.

WhatsApp slice 2, manual connection (2026-11-16, branch `feat/whatsapp-connect`, not merged, not deployed). Verified read-only on Neon: migration 0025 applied (26 migrations, `whatsapp_accounts` with forced RLS, platform CHECKs include whatsapp). Added: Graph port methods `listWhatsAppNumbers`/`subscribeWaba`, routes `POST /integrations/whatsapp/numbers` and `/connect`, orphan replay on connect, WhatsApp panel on the Integrations page, decisions D68 to D70.

- WhatsApp slice 2 hardening (2026-11-16): rate limit on connect/lookup, fail-closed app id, disconnect row lock, E2E flow (7/7 on fresh DB). Review confirmed whatsapp_accounts has 4 RLS policies (wa_select, wa_worker_select, wa_worker_insert, wa_worker_update). Not merged, not deployed.

WhatsApp slice 3, outbound text (2026-11-16, branch `feat/whatsapp-send`, not merged, not deployed, no migration): Graph port `sendText` for `whatsapp` (mock and real, real never run), send route allows WhatsApp with the 24 h window (`422 window_closed`), web composer enabled when the window is open. Decision D73. Templates, media and status-driven message state are not built.
## Phase 5 Automation foundation, slice 1 (2026-11-16, `feat/automation-foundation`, not merged)
Built: migration 0027 (rules, runs, steps, kill switch; forced RLS), condition engine in `@crm/core`, action registry (create_task, add_tag, assign_owner), `automation` consumer and executor with idempotent runs, retry/backoff, default human approval, kill switch, owner/admin API, Settings > Automations web page. New domain events `contact.created`, `lead.stage_changed`. Approval flow E2E (Playwright, web) added on `feat/automation-approval-e2e`: 6/6 pass, gate line met for web. Remaining for the Phase 5 gate: mobile approvals, more triggers/actions. See D73 to D75.
Phase 6b Meta CAPI, slice 1 mock-first (2026-11-16, branch `feat/capi-foundation`, not merged, not deployed). `packages/capi`, migration 0026, API + queue worker, Integrations panel, decisions D77 to D82. MOCK ONLY: no real Meta request, no recorded Test Events delivery. See `docs/architecture/capi-architecture.md` (status) and known-limitations.

Mobile automation approvals (2026-11-16, branch `feat/mobile-automation-approvals`, not merged): Approvals screen in `apps/mobile` (list runs awaiting approval, rule, trigger, plain-language actions, time; Approve/Reject behind a confirm; pull to refresh; loading/empty/error; read-only kill-switch banner). Owner/admin only via `canDecideApprovals` (`@crm/core/approvals`); others see no entry. Minimal workspace list added as the entry point (the mobile app had no navigation). Typechecked, linted and unit tested, NOT run on a device or emulator. Reject sends no reason because the API has no reason field.
CAPI consent UI (2026-11-16, branch `feat/capi-consent-ui`, not merged, no migration): contact page panel Ad measurement consent (state, who/when/source, history, confirm dialog for grant and withdrawal, read-only for roles without consent.edit); GET ad-consent now returns append-only history (last 20) and recordedBy; note on the CAPI panel. Mobile control not built.
CAPI contact cleanup (2026-11-16, branch `feat/capi-contact-cleanup`, not merged, not deployed). Migration 0029: contact soft delete cancels pending CAPI events and purges payloads of the rest (delivery metadata kept); consent_records untouched. Decisions D83 to D85. Removes the "deletion does not purge queue rows" limitation.
Phase 6 AI foundation, slice 1 mock-first (2026-11-16, branch `feat/ai-foundation`, not merged, not deployed). `packages/ai` (port, registry, mock, Anthropic and OpenAI-compatible adapters on fake fetch, catalog, cost math, templates, log helpers), migration 0030 (`ai_provider_configs`, `ai_provider_secrets`, `ai_prompts`, `ai_runs`, `ai_budgets`), API (providers, prompts, budget, usage, status, `runAi` with hard stop), Settings > AI page and Suggest reply in the inbox composer (draft only). Decisions D86 to D96. Real providers UNVERIFIED; open: summaries, lead classification, mobile AI surfaces, evaluation fixtures, real-provider verification.

AI Studio knowledge base, slice 1 (2026-11-16, branch `feat/ai-knowledge-base`, not merged, not deployed). Migration 0031 (journal idx 30, `when` 1794930224233; reconcile order with 0030 at merge), `packages/knowledge` (normaliser, chunker, HTML to text, extractor registry, SSRF-safe fetch), API routes under `/knowledge`, retrieval function `searchKnowledge`, Settings > Knowledge page (sources table, add dialog, delete confirm, re-index, test retrieval). Decisions D100 to D109. No AI provider call, no vectors.

AI Studio agent builder and tool registry, slice 1 (2026-11-16, branch `feat/ai-agent-builder`, not merged, not deployed). Migration 0032 (journal idx 32, `when` 1794930284233): `ai_agents`, append-only `ai_agent_versions`, `ai_agent_actions` (approval queue), `ai_runs.agent_id/agent_version`. `@crm/ai`: AgentDefinition, prompt composer, tool registry types, strict-JSON tool-call protocol. API tools (`crm.find_contact`, `crm.add_note`, `crm.create_task`, `crm.add_tag`, `crm.assign_owner`, `knowledge.search`), agent CRUD/versions/activate/rollback/archive, dry-run test and live run, approvals, per-agent runs, automation action `run_ai_agent`. Web: Settings > AI Agents and an agent picker in the rule builder. Mock provider only; real providers UNVERIFIED. Decisions D110 to D119.
