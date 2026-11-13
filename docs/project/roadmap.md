# Development Roadmap

Version 0.1 (Phase 0). Web, mobile, CAPI and AI are merged into one sequence. A phase closes only when every gate item has evidence recorded in `testing-report.md`. Estimates are intentionally omitted until a spike measures velocity.

## Standing quality gate (every phase)
Type check, lint, unit tests, integration tests (Testcontainers Postgres), Playwright web tests where UI exists, Maestro or emulator tests for mobile where UI exists, browser inspection of the real UI at desktop and mobile widths, accessibility check, security review of the changes, fix findings, update docs (`progress`, `decisions`, `known-limitations`, `testing-report`, this roadmap, CLAUDE.md).

## Phase 0: Discovery and planning (current)
Deliverables: research docs (6 + CAPI), PRD, architecture, database design, API strategy, CAPI architecture, AI/automation architecture, design direction, skill matrix, this roadmap.
Gate: user reviews and approves; decisions in `decisions.md` resolved. Status: documents drafted, approval pending.

## Phase 1: Foundation, design system, shell (web + mobile)
Scope: stack spike (Expo 58 + Hono + Better Auth + Drizzle compile and run in the monorepo); monorepo; design tokens and component library; web app shell and navigation; mobile shell with tabs; auth on both; workspace foundation; DB with RLS and tenant helper; OpenAPI client generation; CI scripts; Android SDK and emulator setup.
Acceptance (measurable): 1) `pnpm typecheck`, `lint`, `test` pass from clean checkout; 2) register, login, logout work on web and on an Android emulator against the same API; 3) a user in workspace A gets 0 rows from workspace B in an automated RLS suite covering every tenant table; 4) token stored in secure storage on mobile and no auth token in AsyncStorage; 5) generated API client used by both apps; 6) shell screens render with loading, empty and error states at 375, 768, 1440 px; 7) axe finds no serious violations on shell and auth pages; 8) design critique findings addressed and recorded; 9) contrast checks for tokens pass in CI; 10) iOS is not a pass criterion for Phase 1; its status (untested or EAS build result) is recorded in the testing report. iOS becomes a gate in Phase 4, when push and device behavior matter, and requires an Apple developer account.

## Phase 2: Core CRM (web, with mobile read/write for key flows)
Contacts, profiles, tags, notes, merge, leads, pipelines and Kanban, search and filters, saved views, activity timeline, tasks (in-app and email-free notifications only; push arrives in Phase 4), lifecycle stage, custom fields, CSV import and export, global search, dashboard. Mobile: Home, Contacts, Leads, Profile, lead status and follow-up.
Gate: all via real DB; list p95 under 300 ms and search p95 under 500 ms on 10,000 seeded contacts; E2E for create contact, create lead, move stage on web; same lead change visible on mobile; pagination and search performance measured on a seeded 10k contact set.

## Phase 3: Integration layer and Meta (mock first)
Adapter interface, capability registry, mock adapter with signed fixtures, webhook endpoint (verification, signature, idempotent persistence, job processing), Meta OAuth, Page and Instagram connection, Lead Ads retrieval, token lifecycle and health monitor, send pipeline with window rules.
Gate: full inbound and outbound flow green on mock; signature tampering and duplicate delivery tests; live checks run only with real credentials and each is recorded as verified or not verified; setup guide written. Live Meta verification is blocked on the user creating a Meta developer app and test accounts.

## Phase 4: Unified inbox and realtime (web + mobile)
Conversation list, thread, composer, status, read/unread, assignment, search, filters, contact context, SSE with resume, mobile inbox and thread, optimistic send with idempotency, push notifications with deep links, offline cache and outbox.
Gate: cross-client sync tests (action on one client visible on the other under 2 s p95 locally); duplicate and reconnection tests; push received on an Android device or emulator via Expo Push (iOS only if a device and Apple account exist); offline scenario tests.

## Phase 5: Automation foundation
Workflow model, trigger system, condition engine, action registry, execution log, retries, approvals (web and mobile), kill switches. Rule-list builder UI.
Gate: idempotency tests (replayed trigger yields one run), retry and failure tests, approval flow E2E.

## Phase 6: AI foundation
Provider abstraction, model config UI, reply suggestions, summaries, lead classification, run logging with tokens and cost, budgets, approval integration, mobile AI surfaces.
Gate: works with at least two providers through config; budget hard stop test; no AI key reachable from clients; evaluation fixtures run.

## Phase 6b: Meta CAPI module
Per `capi-architecture.md`: dataset connection, mappings, consent gate, hashing with test vectors, queue and retries, delivery history UI, health dashboard, mock adapter, then one real test event to Meta's test events tool if the user has a Dataset.
Gate: all CAPI tests listed in the brief pass on mock; live status claimed only with a recorded real test event. (Sequencing: after the core CRM event system exists, as the brief requires; may swap with Phase 6 by approval.)

## Phase 7: Future platform readiness
Adapter stubs and registry entries for TikTok, WhatsApp, LinkedIn with gating metadata and permission handling. No live integration without approvals. WhatsApp Cloud API test-number integration is a candidate stretch because it needs no verification to start (see research).

## Phase 8: Quality, security, production readiness
Full security audit (cso, security-review, code-review), tenant isolation, API and webhook security, authentication tests, DB integrity, accessibility audit, Lighthouse, responsive, end-to-end suites on web and mobile, Android testing (emulator and device if available), iOS testing only as far as real tooling allows, production builds, deployment docs, release prep (store accounts are the user's responsibility).

## Risk and dependency register

| ID | Risk or dependency | Impact | Mitigation | Owner |
|---|---|---|---|---|
| R1 | Meta Live mode and Advanced Access need Business Verification and App Review | Cannot serve third-party accounts | Develop in Development mode on own accounts; mock adapter; treat go-live as an external milestone | User |
| R2 | Sole proprietor eligibility for verification unverified | Unknown | Ask Meta support or test in dashboard | User |
| R3 | New library majors postdate common knowledge | Wasted time | Phase 1 spike; Context7 checks | Claude |
| R4 | No macOS, no local iOS | iOS untested locally | EAS cloud builds, Apple Developer account, TestFlight device; report limits honestly | User |
| R5 | Android toolchain missing; Java 25 may not be supported | Blocks mobile testing | Install Android SDK and supported JDK in Phase 1 | Claude with user approval for system installs |
| R6 | Realtime duplicates and ordering | Wrong inbox state | Cursor replay, idempotent reducers, tests | Claude |
| R7 | Privacy: sending customer data to Meta | Legal and trust | Consent gate, default-off, documentation | Claude + user |
| R8 | CAPI details unverified (opt_out, consent fields, sensitive data policy) | Wrong payloads | Read remaining official pages before Phase 6b | Claude |
| R9 | TikTok and LinkedIn messaging access unverified for individuals | Roadmap fiction | Re-verify before Phase 7 | Claude |
| R10 | Provider costs for AI | Surprise spend | Budgets and hard stops, defaults off | Claude |
| R11 | Solo-maintainer complexity | Burnout | Modular monolith, Postgres-only queue, minimal infra | Both |
| R12 | Competitor and UX research for mobile apps partly unverified | Weak design inputs | Hands-on audit and HIG/M3 recheck before design sign-off | Claude |

## Amendments (2026-11-13) from review and audit

**Proposed release cut line (needs approval, see decisions D19).**
- **Release 1, daily-use CRM:** Phases 1 to 4 plus the audit's MVP items (tasks, comments, lead forms, internal notes, saved replies, presence, search, invitations, export, deletion and Meta compliance endpoints). Meta runs in Development mode on the owner's accounts.
- **Release 2:** Phases 5, 6 and 6b (automation, AI, CAPI), then Phase 8's full security audit before any non-owner user is added.
- **Release 3:** Phase 7 platform foundations after re-verifying TikTok, WhatsApp, LinkedIn access. Phase 7 is demoted from fixed scope to "if access exists", since stubs without access are speculative.
- No calendar estimates yet. The Phase 1 spike measures velocity; estimates are added to this file after it.

**Additional Phase 1 items.** Local infrastructure via Docker Compose (Postgres with pgvector extension available, MinIO for blobs, a mail catcher), `Mailer` and `BlobStore` interfaces, three database roles, `workspace_event_counters` event log, permissions matrix implemented with tests, tenant-table CI check (every table has `workspace_id` and RLS), audit log append-only, idempotency table.

**Additional Phase 3 items.** A public HTTPS URL for webhooks during development (tunnel, for example Cloudflare Tunnel or ngrok) and a staging environment; hosting decision D16 is due at the start of Phase 3. Comments, lead forms and backfill, Meta data-deletion and deauthorize callbacks, outbound send state machine (`sending`/`unknown`, echo reconciliation), per-conversation ordering lock.

**Phase 4 additions.** Push for task reminders and assignments; presence and collision prevention; in-app notification centre; iOS gate (EAS build plus a real device or recorded as not met).

**Phase 6b reference fix.** The phase gate refers to this roadmap and `capi-architecture.md`, not to an external brief. Gate list: payload validation, hashing vectors, event id stability, deduplication, retry and batch bisection, invalid credentials, API errors, workspace isolation, consent re-check at send time, one real Test Events delivery or the status "mock only".

**Phase 8 exit criteria.** Zero open critical or high findings; restore drill passed; tenant leak suite green for every table; Lighthouse thresholds met on named screens; Android E2E suite green on emulator.

## Phase 1 status (2026-11-13)

Phase 1 is **not complete**. Web foundation items pass; mobile and a few cross-cutting items are open. Status of the original acceptance items, plus items added by the web shell scope:

| # | Acceptance item | Status | Evidence or gap |
|---|---|---|---|
| 1 | Typecheck, lint, test pass from a clean checkout | Met (locally) | `pnpm exec turbo run lint typecheck test --force`: 19 of 19 tasks green. No hosted CI exists yet; this is a local run. |
| 2 | Register, login, logout work on web and on an Android emulator against the same API | **Open** | Web: 9 e2e tests pass. Android emulator run deferred by the user; SDK and AVD are installed but the app has not been run. |
| 3 | RLS suite: workspace A gets 0 rows from workspace B on every tenant table | Met | 19 db tests including a CI check that every non-auth table has RLS enabled, forced, a policy and `workspace_id`. Covers `workspaces`, `memberships`, `audit_log`; new tables must pass the same check. |
| 4 | Mobile token stored in secure storage, none in AsyncStorage | **Open** | Code uses expo-secure-store and the bundle compiles; runtime verification not done. |
| 5 | **Shared Typed API Client** used by both apps (approved 2026-11-13, replaces "generated API client") | **Open (in progress)** | Requirements: shared Zod request/response contracts; type-safe endpoint definitions; centralized auth, errors and timeout handling; cookie and bearer support; one package usable by web and mobile; contract-drift prevention (tests). OpenAPI generation is a future milestone. Not marked met until both apps use the package and drift tests pass. |
| 6 | Shell screens render with loading, empty and error states at 375, 768, 1440 | Partly met | Screens verified at all three widths. Error boundaries, route skeletons and empty/forbidden states exist; only some are exercised by tests (forbidden audit log, forbidden activity, not-found). Route skeletons and the error boundary have no automated test. |
| 7 | axe: no serious violations on shell and auth pages | Met | Zero violations (WCAG 2.2 AA tags) on login, register, onboarding, home, members, audit, settings at 3 sizes, the mobile drawer, command menu and role dialog. axe does not prove full accessibility; keyboard checks cover skip link, command menu and dialogs only. |
| 8 | Design critique findings addressed | Met with deferrals | See `docs/design/critique-phase1-shell.md` resolution table. No second review after fixes. |
| 9 | Contrast checks for tokens pass in CI | Met (locally) | 42 contrast tests, light and dark. |
| 10 | iOS | Not a gate | Untested. |
| 11 | Workspace and membership foundation, audit log, tenant-table check | Met | API: 16 workspace tests; 9 permission tests. |
| 12 | Mailer and BlobStore interfaces | Met | Contract tests for MemoryMailer and FsBlobStore (traversal-safe). No production provider (D22 deferred). |
| 13 | Permission-aware navigation | Met | Unit tests per role and e2e tests for owner, admin, agent, viewer. |
| 14 | Forgot-password flow | **Not built** | Needs Mailer wired to a provider. |
| 15 | Responsive: drawer at 375, rail at 768, full sidebar at 1440 | Met | e2e assertions plus screenshots in `docs/design/screenshots/phase1-shell/`. |


## Phase 1 remains formally OPEN (user decision 2026-11-13)
Phase 2 may proceed web-first, but Phase 1 is **not** passed. These items stay mandatory and open until verified: Android emulator register/login/logout against the same API (item 2); SecureStore runtime verification (item 4); Shared Typed API Client used by both apps with drift tests (item 5); incomplete loading/empty/error-state test coverage (item 6); second independent design review (item 8). Mobile readiness is not declared until mobile authentication tests pass. All shared contracts and API changes must stay mobile-compatible (bearer auth, no cookie-only assumptions, additive changes, versioned `/v1`).

## Phase 2 scope, web-first (approved to begin 2026-11-13)
Core CRM per the PRD (FR-5 to FR-9, FR-30 to FR-35, FR-44) plus password reset (FR-1, decision D36). Sequence: (1) shared typed API client; (2) password reset; (3) contacts, tags, notes, activity timeline; (4) leads, pipelines and stages, Kanban; (5) tasks; (6) custom fields; (7) search and filters; (8) CSV import and export; (9) dashboard. Each slice closes only with passing tests, browser inspection and docs. Mobile counterparts follow after the Android verification items above.
