# Product Requirements Document: Social CRM

Version 0.1 (Phase 0 draft, awaiting approval). Date: 2026-11-13.

## 1. Vision

A premium social-media CRM ecosystem made of a web application, a native-feeling Android and iOS application, and one shared backend. Users connect social accounts (Meta first), receive conversations in a unified inbox, capture leads from messages and lead ads, manage contacts and a sales pipeline, report conversions back to Meta, and over time automate work with rule-based workflows and AI under human control.

## 2. Users and usage model

- **Now:** one user (the owner) using personal developer accounts and their own Pages and Instagram professional account. No registered company. Development-mode Meta access only.
- **Later:** multi-user, multi-workspace SaaS where businesses sign up, connect accounts, assign conversations to teammates, and run automations.
- The data model and permission checks are multi-tenant from day one. Billing, subscriptions and enterprise features are out of scope.

### Personas
1. **Owner-operator (primary now):** answers DMs, tracks leads, wants one inbox on phone and desktop.
2. **Agent (future):** handles assigned conversations, mostly on mobile.
3. **Manager/Admin (future):** configures integrations, automations, AI, CAPI mappings, team.

## 3. Goals, non-goals, anti-goals

**Goals:** reliable unified inbox; real CRM data model; two cohesive purpose-designed clients; secure credential handling; adapter-based platform integration; automation and AI foundations that need no CRM rewrite; CAPI as a first-class module.

**Non-goals (MVP):** billing, white-labeling, microservices, a full AI agent platform, live TikTok/WhatsApp/LinkedIn integrations, email/SMS channels, a native (Swift/Kotlin) rewrite.

**Anti-goals:** generic admin-template look; decorative buttons; claiming API success that was not verified; sending sensitive messages automatically; sending customer data to Meta without consent and configuration.

## 4. Platform access reality (drives scope)

Per `docs/research/meta-api-research.md`: apps used only by people holding an app role can use messaging, webhooks, comments and lead retrieval on their own Pages and Instagram accounts in Development mode, without App Review or Business Verification. Serving other people's accounts requires Advanced Access (Business Verification plus App Review). Whether a sole proprietor can pass Business Verification without a company is unverified. Consequence: the MVP is built and proven against the owner's own accounts and a mock adapter; going live for third parties is a separate, externally gated milestone that does not block development.

## 5. Functional requirements

Priority: P0 = MVP core, P1 = MVP complete, P2 = foundation only.

### 5.1 Identity, workspaces, permissions
- FR-1 (P0) Email/password registration, login, password reset, email verification; sessions on web (cookie) and mobile (bearer token in secure storage).
- FR-2 (P0) Workspace with owner; membership with roles owner, admin, agent, viewer; every row workspace-scoped.
- FR-3 (P1) Device session list and remote revoke; secure logout.
- FR-4 (P2) Invitations and multi-workspace switching.

### 5.2 Contacts and leads
- FR-5 (P0) Contacts: create, edit, merge duplicates, tags, notes, custom fields, channel identities (one contact, many platform identities), activity timeline.
- FR-6 (P0) Leads linked to contacts: status, priority, owner, value, source, follow-up date.
- FR-7 (P0) Pipelines and stages, Kanban with drag between stages, stage history.
- FR-8 (P0) Search, filter, saved views, bulk actions on tables.
- FR-9 (P1) Follow-up reminders surfaced on dashboard and by push.

### 5.3 Unified inbox
- FR-10 (P0) Conversation list with platform badge, unread state, status (open, pending, resolved), assignee, search, filters.
- FR-11 (P0) Message history with attachments (where supported), delivery state.
- FR-12 (P0) Reply composer enforcing platform sendability (for example the 24-hour window) with a clear, honest explanation when sending is blocked.
- FR-13 (P0) Contact context panel; link conversation to lead.
- FR-14 (P0) Assignment, read/unread and status stay consistent across web and mobile in real time.
- FR-15 (P1) Quick replies / saved snippets.

### 5.4 Integrations
- FR-16 (P0) Integration layer with adapter interface, capability registry, per-account health, mock adapter.
- FR-17 (P0) Meta: OAuth connect, Page and Instagram account connection, webhook verification and signature check, message sync, idempotent webhook processing, token lifecycle with health monitoring, Lead Ads retrieval.
- FR-18 (P2) TikTok, WhatsApp, LinkedIn adapter foundations and registry entries, flagged as gated.

### 5.5 Meta Conversions API
- FR-19 (P1) Connect Dataset, store token encrypted, test connection, send test events.
- FR-20 (P1) Per-workspace event mapping of CRM lifecycle events to Meta events; opt-in per event.
- FR-21 (P1) Asynchronous delivery with stable event IDs, retries, deduplication, delivery log, failure inspection, manual retry.
- FR-22 (P1) Consent and eligibility gate before any send; data minimization; documented payload contents.
- FR-23 (P1) Health and delivery dashboard that reports delivery status only, never attribution.
Full detail: `docs/architecture/capi-architecture.md`.

### 5.6 Automation and AI
- FR-24 (P1) Workflow model: trigger, condition, action, delay, human approval, notification; rule-based execution, idempotent steps, retries, execution log, global and per-workflow disable switch.
- FR-25 (P1) AI provider abstraction, model configuration, reply suggestions, conversation summaries, lead classification, execution log with tokens and cost, budgets.
- FR-26 (P0 rule) AI output never sends automatically unless a workspace-level policy explicitly allows that action type; default is human approval.

### 5.7 Notifications and sync
- FR-27 (P1) Push for new message, new lead, assignment, reminder, automation events; per-user preferences; deep links; privacy-preserving lock-screen text by default.
- FR-28 (P0) Realtime events to web and mobile with resumable cursors and no duplicates.
- FR-29 (P1) Mobile offline cache and safe retry of queued actions, with version-checked writes: a queued edit made against a stale version is never applied silently; the client keeps the server version and asks the user to re-apply (append-only items such as messages and notes replay by idempotency key).

### 5.8 Analytics
- FR-30 (P1) Dashboard: new leads, unread conversations, response time, pipeline value by stage, source breakdown, recent activity.

## 6. Screens

**Web:** Authentication, Onboarding, Dashboard, Unified Inbox, Conversation Details, Contacts, Contact Profile, Leads, Lead Details, Pipeline, Integrations (including CAPI), Automation, AI Assistant, Settings, Workspace Management.
**Mobile (bottom tabs: Home, Inbox, Contacts, Leads, Profile):** Auth flows, Dashboard, Inbox and conversation, Contacts and detail, Leads and detail with status/priority/follow-up, AI assistant surfaces inside conversation and lead, Settings (account, workspace, notifications, connected accounts, security, logout).
Every screen needs loading, empty, error and responsive states. No control without behaviour.

## 7. Non-functional requirements (measurable)

| Area | Target |
|---|---|
| Webhook ack | HTTP 200 within 2 s p95 (Meta requires 5 s); processing is asynchronous |
| Realtime | Event visible on a second client within 2 s p95, measured with 10 concurrent clients, 1 KB payloads, a 50 ms RTT / 10 Mbps network profile |
| Web performance | Lighthouse performance >= 90, accessibility >= 95 on key screens (measured, Phase 8) |
| Accessibility | WCAG 2.2 AA; touch targets >= 44 pt iOS / 48 dp Android |
| Security | RLS enforced on all tenant tables; zero cross-tenant reads in the automated leak suite; secrets encrypted at rest; no secrets in clients or logs |
| Reliability | Webhook and CAPI handlers idempotent; failed jobs retried with backoff and visible in a dead-letter view |
| Mobile cold start | Under 3 s to interactive on a mid-range Android device (measured when a device is available) |
| Test | Type check, lint, unit, integration and E2E green before any phase is closed |

## 8. Out of scope until approvals exist
Live TikTok, WhatsApp, LinkedIn; Meta Live mode for third parties; WhatsApp or TikTok billing; CAPI Business Messaging events for a direct CRM (fit unverified).

## 9. Risks (summary; full register in roadmap)
1. Meta approval and Business Verification for non-owner accounts (external, unverified for sole proprietors).
2. Fast-moving library majors (Expo 58, AI SDK 7, Vitest 5, TypeScript 7): mitigated by a compile-and-run spike before scaffolding.
3. iOS cannot be built or tested locally (no macOS): EAS cloud builds; iOS testing claims limited to what is actually run.
4. Realtime duplicate or out-of-order events: cursor-based replay, idempotent client reducers.
5. Privacy: sending customer identifiers to Meta without consent: consent gate and per-event opt-in.

## 10. Open decisions
Listed for approval in the Phase 0 report and in `docs/project/decisions.md`.

## 11. Amendments from the feature completeness audit (2026-11-13)

Source: `feature-completeness-audit.md` and `phase0-review.md`. Release tags: MVP = needed for daily use by the owner (Release 1), R2 = second release, Later. Roadmap placement is in `roadmap.md`.

### Added or clarified functional requirements
| ID | Requirement | Release |
|---|---|---|
| FR-31 | Tasks: title, due date, priority, assignee, link to contact or lead, complete/snooze; replaces simple reminders; push and in-app notification when due | MVP |
| FR-32 | Contact lifecycle stage (subscriber, lead, qualified, customer, churned) with history in the timeline | MVP |
| FR-33 | Custom field definitions (text, number, date, select, multiselect, boolean, URL) for contacts and leads, validated | MVP |
| FR-34 | CSV import of contacts with column mapping, dry-run preview, dedupe, error report; CSV/JSON export of contacts and leads | MVP |
| FR-35 | Lead and deal model: one entity ("lead") with a pipeline of kind `lead` or `sales`; a qualified lead moves to a sales pipeline; separate deals table deferred | MVP decision |
| FR-36 | Facebook and Instagram comments: receive, reply, hide where the API permits; private reply to a commenter; shown as comment threads in the inbox | MVP-lite (private reply and story interactions R2) |
| FR-37 | Lead Ads: lead form list, field mapping to contact, lead and custom fields, raw submission retained, missed-lead backfill | MVP |
| FR-38 | Multiple Pages and Instagram accounts: list all granted Pages on connect, enable or disable each, filter inbox by account | MVP |
| FR-39 | Internal notes in a conversation thread, never sent to the platform | MVP |
| FR-40 | Saved replies with variables; personal and workspace scope | MVP |
| FR-41 | Collision prevention: presence ("viewing", "replying") via the realtime stream, soft warning, and server rejection of a reply composed on a stale assignment | MVP |
| FR-42 | Response-time metrics: first response time, resolution time, business-hours aware; SLA policies and breach alerts | metrics MVP; SLA policies R2 |
| FR-43 | In-app notification centre on web and mobile; email notifications | centre MVP; email R2 |
| FR-44 | Global search across contacts, leads, conversations and tasks; command menu on web; search screen on mobile | MVP |
| FR-45 | Audit log viewer for owners and admins, append-only | MVP |
| FR-46 | Invitations by email, accept flow, resend and revoke; transactional email through a `Mailer` interface | MVP |
| FR-47 | Permission matrix (`docs/architecture/permissions.md`) enforced by one policy function in API and UI | MVP |
| FR-48 | Usage limits per workspace (AI spend, seats, connected accounts, CAPI events); plans and billing are out of scope | MVP limits; billing Later |
| FR-49 | Account lifecycle: deactivate member, transfer ownership, delete workspace (30-day grace then purge, tokens revoked), delete user account | MVP |
| FR-50 | Data export per contact and per workspace; erasure workflow for contacts; consent capture and display on the contact profile | MVP |
| FR-51 | Meta compliance: data-deletion callback, deauthorize callback, status page, privacy policy and terms pages. Official Live-mode fields per spot-check: display name, contact email, Terms of Service URL, app icon, category, app purpose; privacy policy and deletion URLs are documented but not marked required | MVP (needed before Live mode) |
| FR-52 | Backup and recovery: RPO 24 hours and RTO 4 hours targets for the owner's deployment, encrypted nightly backups, key backup separate from data, a restore drill recorded in the testing report | MVP (documented in Phase 8, script from Phase 1) |
| FR-53 | Conversion destinations are generic: Meta CAPI first, TikTok Events API later | design MVP; TikTok Later |
| FR-54 | AI insights: intent, sentiment, score, next action stored as reviewable records; knowledge base with retrieval | next action MVP; the rest R2 |
| FR-55 | Mobile: tasks, pipeline view (segmented stage list with change-stage action), create contact and lead, add note, change owner | MVP |

### Measurable thresholds added (responding to review m4)
- List endpoints with 10,000 contacts seeded: p95 under 300 ms; search p95 under 500 ms (local Docker Postgres, single user).
- Webhook ack p95 under 2 s with 20 concurrent deliveries.
- AI evaluation fixtures: at least 90 percent of fixtures meet their rubric for each feature before release; the rubric is written with the fixtures.
- Lighthouse run on named screens (login, dashboard, inbox, contacts) in a desktop profile and a throttled mobile profile.
- Phase 8 exit: zero open critical or high security findings; medium findings each have a recorded decision.
- Mobile cold start target (3 s on a mid-range Android) is measured on the emulator first and on a physical device when one exists; the result states which.

### Not in scope (confirmed)
Billing and plans, teams and round robin, custom roles, email channel, visual workflow canvas, live TikTok/WhatsApp/LinkedIn.
