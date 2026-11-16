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
Status: slice 1 built (rules, idempotent runs, retries, default approval, kill switch, web rule list; idempotency, retry and approval flow covered by API tests). Playwright approval E2E met for web (`apps/web/e2e/automation-approval.spec.ts`, 6/6 on a private DB). Mobile approvals screen built (typechecked and unit tested, NOT run on a device, not covered by E2E). Open: device verification of mobile approvals, more triggers and actions.

## Phase 6: AI foundation
Provider abstraction, model config UI, reply suggestions, summaries, lead classification, run logging with tokens and cost, budgets, approval integration, mobile AI surfaces.
Gate: works with at least two providers through config; budget hard stop test; no AI key reachable from clients; evaluation fixtures run.

> Status (2026-11-16): slice 1 built on `feat/ai-foundation` (not merged): provider abstraction with mock and two real adapters (UNVERIFIED, fake fetch only), model config UI, reply suggestion (draft only), run logging with tokens and cost, monthly budget with hard stop (tested), no key reachable from clients (tested). Open: conversation summaries, lead classification, approval integration, mobile AI surfaces, evaluation fixtures, real-provider verification (a recorded real request per provider). Gate NOT met until those close.

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
| 5 | **Shared Typed API Client** used by both apps (approved 2026-11-13, replaces "generated API client") | **Met at code level; mobile runtime unverified** | Requirements: shared Zod request/response contracts; type-safe endpoint definitions; centralized auth, errors and timeout handling; cookie and bearer support; one package usable by web and mobile; contract-drift prevention (tests). OpenAPI generation is a future milestone. Delivered: `@crm/contracts` endpoint definitions (Zod request, query and response schemas) and `@crm/api-client` (typed calls, centralized errors and timeouts, cookie and bearer modes, `onUnauthorized`, credentials override for native clients). Web and mobile both call the API only through it. Drift guards (mutation-tested): the API test fails if a `/v1` route lacks an endpoint definition or the reverse, and a full scenario runs through the client against the real server in cookie and bearer modes validating every response. The mobile app type-checks and bundles with the client but has **not** run on a device. |
| 6 | Shell screens render with loading, empty and error states at 375, 768, 1440 | Mostly met; gaps listed | Covered now: browser tests for forbidden audit log and activity, not-found, server rule error, network failure, contract mismatch, 500 on save, failed load-more with retry, success clearing errors; component-render tests for all four loading skeletons (role=status), `ErrorState`, the workspace error boundary (internal error text hidden), `EmptyState`, empty and partial audit list. **Still uncovered:** a real server-side 5xx or timeout during page render reaching `error.tsx` end to end; skeletons observed during real streaming in a browser; the empty Members state (cannot occur: the owner always exists); retry button interaction in `ErrorState` (rendered, not clicked); screen-reader announcement of loading. |
| 7 | axe: no serious violations on shell and auth pages | Met | Zero violations (WCAG 2.2 AA tags) on login, register, onboarding, home, members, audit, settings at 3 sizes, the mobile drawer, command menu and role dialog. axe does not prove full accessibility; keyboard checks cover skip link, command menu and dialogs only. |
| 8 | Design critique findings addressed | Met with deferrals | Round 1 and round 2 (`critique-phase1-shell-round2.md`) each have a resolution table. Round 2 found 1 blocker, 7 majors, 15 minors and one regression (Members at 768); all blockers and the regression are fixed and tested. No third review; deferrals are listed in the tables. |
| 9 | Contrast checks for tokens pass in CI | Met (locally) | 42 contrast tests, light and dark. |
| 10 | iOS | Not a gate | Untested. |
| 11 | Workspace and membership foundation, audit log, tenant-table check | Met | API: 16 workspace tests; 9 permission tests. |
| 12 | Mailer and BlobStore interfaces | Met | Contract tests for MemoryMailer and FsBlobStore (traversal-safe). No production provider (D22 deferred). |
| 13 | Permission-aware navigation | Met | Unit tests per role and e2e tests for owner, admin, agent, viewer. |
| 14 | Forgot-password flow | **Built in Phase 2 (decision D36); production mail provider still deferred** | See "Password reset" below. |
| 15 | Responsive: drawer at 375, rail at 768, full sidebar at 1440 | Met | e2e assertions plus screenshots in `docs/design/screenshots/phase1-shell/`; a round-2 regression at 768 was found by review, fixed, and now guarded by a no-inner-scroll test. |


## Phase 1 remains formally OPEN (user decision 2026-11-13)
Phase 2 may proceed web-first, but Phase 1 is **not** passed. These items stay mandatory and open until verified: Android emulator register/login/logout against the same API (item 2); SecureStore runtime verification (item 4); Shared Typed API Client used by both apps with drift tests (item 5); incomplete loading/empty/error-state test coverage (item 6); second independent design review (item 8). Mobile readiness is not declared until mobile authentication tests pass. All shared contracts and API changes must stay mobile-compatible (bearer auth, no cookie-only assumptions, additive changes, versioned `/v1`).

## Phase 2 scope, web-first (approved to begin 2026-11-13)
Core CRM per the PRD (FR-5 to FR-9, FR-30 to FR-35, FR-44) plus password reset (FR-1, decision D36). Sequence: (1) shared typed API client; (2) password reset; (3) contacts, tags, notes, activity timeline; (4) leads, pipelines and stages, Kanban; (5) tasks; (6) custom fields; (7) search and filters; (8) CSV import and export; (9) dashboard. Each slice closes only with passing tests, browser inspection and docs. Mobile counterparts follow after the Android verification items above.


## Phase 2 progress (2026-11-13)

**Slice 1: shared typed API client** (Phase 1 item 5): done, see item 5 above.

**Slice 2: password reset (D36): done and tested; not usable in production until a mail provider exists (D22).** API: `request-password-reset` and `reset-password` via Better Auth with single-use tokens that expire after 30 minutes; only the newest link works (older tokens deleted); all sessions revoked on reset; per-email (3/hour) and per-IP (10/hour) throttling that returns the normal success body so limits leak nothing; token-guess throttle (20 per 10 minutes per IP, 429); identical status and body for known and unknown addresses; password policy enforced (10+ characters); every workspace the user belongs to gets an `auth.password_reset` audit entry; the server refuses to start in production without a mail provider. Web: Forgot password link, request screen (same confirmation for any address), reset screen with confirm field, invalid and expired link states, success notice on sign-in. Tests: 15 API tests, 6 mail-adapter tests, 6 browser tests (full flow, revoked second device, reuse, newer link wins, unknown address, open-redirect abuse, axe). **Security finding fixed during testing:** Better Auth followed an attacker-supplied `redirectTo` and appended the reset token, which would let an attacker harvest a victim's token through the genuine email link; redirect targets are now allow-listed (request and link callback). Not covered: timing equality between known and unknown addresses (sending is non-blocking, not measured), multi-instance throttling (counters are in-process), email deliverability, HTML mail, account lockout policy.

**Remaining Phase 2 slices, in order:** contacts with tags, notes and activity timeline; leads, pipelines and stages with Kanban; tasks; custom fields; search and filters; CSV import and export; dashboard. Not started.


## Phase 2, slice 3: Contacts (2026-11-13). Status: built and tested; acceptance NOT yet closed (independent review did not complete)

**Delivered:** data model (contacts, lifecycle stages, tags, contact tags, custom field definitions, notes, append-only activities, tasks, saved views, import jobs) with forced RLS, role policies, composite foreign keys and trigram search indexes; contact domain logic; 30 typed endpoints; web list, detail, import wizard and contact settings. Lifecycle stage lives on the contact and is configurable (rename, add, reorder, archive); it is independent of pipeline stage, and no Lead or Deal table exists (D20 preserved; the optional deal fields on a lead arrive with the Leads slice).

**Quality gates, measured locally:** RLS tests for all 10 new tables (17); contact logic unit tests (24); API tests 133 total including isolation on every operation, role matrix, optimistic concurrency, duplicate detection, pagination across every sort, search and wildcard escaping, filters, import preview, duplicate resolution, atomic rollback (tested with an injected mid-import failure), double-commit race, CSV formula-injection guard both ways, mobile (bearer) path; performance with 10,000 contacts (in-process, local Postgres): list p95 66 ms (default sort; gate 300), 32 ms by name, 21 ms deep page; search p95 36 to 41 ms (gate 500). These are after a fix: the first measurement was 264 to 410 ms for the default list because RLS policies called `app_has_role()` once per row; wrapping the calls in scalar subqueries (migration 0007) evaluates them once per query. Web: 34 unit tests, 53 browser tests including axe on every screen and dialog at 375/768/1440, touch target and 16px-input checks, permission UI per role.

**Not met or not verified:**
- **Independent review of this slice did not complete** (the review agent hit a usage limit). `docs/project/review-contacts-slice.md` does not exist. Acceptance cannot honestly be called passed until it runs; per your rule the Leads slice has not been started.
- Related conversations and pipeline records on the contact are honest placeholders (no such entities exist yet).
- Tasks are a minimal per-contact model; the cross-contact task list and reminders belong to the later Tasks slice.
- Mobile app screens for contacts are not built; only the API contract is mobile-compatible and tested through bearer auth.
- Import keeps the uploaded CSV text in `import_jobs.csv` (admin-only via RLS) with no retention job yet.
- No merge of duplicate contacts (only warn, skip, update or create anyway).
- Custom fields support text, number, date, select, multiselect, boolean and URL; no per-field permissions.
- Search is substring with trigram indexes; ranking and fuzzy matching are not implemented.
- Not measured at 100,000 rows or over a real network; the earlier workspace, membership and audit policies still call the helper functions per row and have not been rewritten (small tables).
- Phase 1 remains OPEN (Android emulator login and SecureStore runtime unverified).

## Phase 2, slice 4: Leads and Pipeline (2026-11-13). Status: built, tested and MERGED to `main` (merge commit `50bf5b6`, 2026-11-13) after the fresh and upgrade migration checks; conditionally accepted by the user
Code HEAD at checkpoint: `ef574f8`; merge commit `50bf5b6` on `main` (base `ba27c75`). Migration checks: see the acceptance report. Full report: `docs/project/leads-pipeline-acceptance-report.md`.
- **VERIFIED (commands ran green):** schema, forced RLS, composite FKs, append-only history, stage immutability (db tests); pipeline configuration, lead CRUD, move, close, reopen, delete, restore, list, history, deal-value grants, reporting, search provider, `lead.owner_assigned` notification, tasks link and `next_activity_at` trigger (api tests); web pipeline settings, lead list, lead detail, board with drag and drop, reports, closed Won/Lost columns (Playwright in Chromium, axe WCAG 2.2 AA, 375/768/1024/1440, reduced motion).
- **UNVERIFIED:** touch drag on a real device, screen reader output, Firefox and Safari, dark mode, performance with 10,000 leads or 500 board cards, lead search at scale, upgrade of a database that already holds lead data.
- **DEFERRED (by user decision):** Android runtime, login, SecureStore, session restore, logout, expired session and 401 handling; mobile Leads (slice 8). Phase 1 stays formally OPEN.
- **BLOCKED / security-readiness blockers for external users:** deal value is protected by the API only, with no database-level protection (documented in `known-limitations.md`); Meta App Review and Business Verification; the open `cso` findings (email verification before invites, trusted client IP and authenticated rate limits, separate role for the system path); no production hosting decision.
- **Not built in this slice:** lead tags and custom fields, UI to link an existing task to a lead, task events or audit rows for link and unlink, forecasting, AI scoring, commissions (out of scope by decision).
Next phase: Meta Inbox. Slice 1 (schema, RLS, per-user unread) merged to `main` (`65cf409`) and migrated on the dev database; Slice 2 (webhook ingress on a mock adapter) in progress. Plan: `docs/architecture/meta-inbox-plan.md`. Real Meta testing and C8 remain UNVERIFIED.
