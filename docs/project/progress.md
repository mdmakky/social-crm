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
