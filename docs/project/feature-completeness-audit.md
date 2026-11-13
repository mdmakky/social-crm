# Product Feature Completeness Audit

Date: 2026-11-13. Scope: Phase 0 documents (`prd.md`, `roadmap.md`, `architecture.md`, `database-design.md`, `api-strategy.md`, `capi-architecture.md`, `ai-automation-architecture.md`). Method: each requested feature was searched for in all four layers (requirements, architecture, database, API and screens). Status values: **Fully Planned**, **Partially Planned**, **Missing**, **Not Applicable**. Release tags: **MVP** (needed before the product is usable day to day by the owner), **R2** (second release, after Phase 8), **Later**. Existing technology decisions are preserved; the only structural change proposed is naming-level (A2 below).

Result summary: 69 feature rows audited (counted from the tables below). Fully Planned 29, Partially Planned 27, Missing 12, Not Applicable 1 (billing, MVP). No technology change is needed. Six architecture amendments (A1 to A6) and the approval items in the final report follow.

## 1. Core CRM

| Feature | Status | Release | Gap and required additions |
|---|---|---|---|
| Contacts | Fully Planned | MVP | none |
| Leads | Fully Planned | MVP | none |
| Customer lifecycle | Missing | MVP | Add `contacts.lifecycle_stage` (subscriber, lead, qualified, customer, churned, other) with history in `activities`. Needed by dashboards, CAPI mappings and AI classification. |
| Pipelines | Fully Planned | MVP | Add `pipelines.kind` (see deals) |
| Deals | Partially Planned | MVP decision | `leads` carries value, stage and owner, so it already works as an opportunity. Decision A1: keep a single entity, call it "lead" in UI, add `pipelines.kind` (`lead` or `sales`) so a qualified lead can move into a sales pipeline without a second table. A separate `deals` table is deferred to R2 only if reporting needs it. |
| Tasks | Missing | MVP | `reminders` exists but is a single due date. Replace with `tasks` (workspace_id, title, description, due_at, status open/done/cancelled, priority, assignee_id, created_by, entity_type, entity_id, completed_at, recurrence nullable). Reminders become tasks with a notification. API `/tasks`; screens: Tasks list (web and mobile), task widget on dashboard, contact and lead detail. Permission: agent edits own and assigned, admin edits all. |
| Follow-ups | Partially Planned | MVP | Covered by `leads.follow_up_at` and reminders. Subsumed by tasks; keep `follow_up_at` as a denormalized "next task due" field for sorting. |
| Custom fields | Partially Planned | MVP | `contacts.custom jsonb` has no definitions, types or validation. Add `custom_field_definitions` (workspace_id, entity_type contact/lead, key, label, type text/number/date/select/multiselect/boolean/url, options jsonb, required, position). Values stay in the jsonb column validated against definitions. API `/custom-fields`; Settings screen. |
| Tags | Fully Planned | MVP | add `leads` tags (`lead_tags`) |
| Activity timeline | Fully Planned | MVP | none |
| Import | Missing | MVP (CSV contacts) | `import_jobs` (workspace_id, entity_type, file_ref, mapping jsonb, status, counts, error_report_ref), dedupe by email/phone, dry-run preview, worker job. API `/imports`; screen: Import wizard (web only). Permission admin. |
| Export | Missing | MVP (CSV contacts and leads) | `export_jobs`, signed expiring download; see data export in section 8. |

## 2. Meta integrations

| Feature | Status | Release | Gap and required additions |
|---|---|---|---|
| Messenger | Fully Planned | MVP | none |
| Instagram DM | Fully Planned | MVP | Choose Instagram Login vs Facebook Login per account kind (research); `integration_accounts` already allows it. |
| Facebook and Instagram comments | Missing | MVP-lite (receive, reply, hide where permitted); private reply R2 | The PRD never mentions comments, though research shows a comments webhook and Private Replies (750/h). Add `conversations.kind` (`dm`, `comment_thread`), `messages.parent_external_id` and `messages.kind` (`message`, `comment`, `reply`, `note`), `posts` cache (workspace_id, integration_account_id, external_id, permalink, caption excerpt). Capability flags `comments.read`, `comments.reply`, `comments.hide`, `comments.private_reply`. Permissions to be confirmed by the citation check. |
| Story interactions | Partially Planned | R2 | Story replies and mentions arrive as messages with a story attachment in Instagram messaging webhooks per research; unconfirmed here. Add message `attachments[].kind = story_mention | story_reply` rendering; no dedicated entity. Mark "where supported" in capability registry. |
| Lead Ads | Partially Planned | MVP | Retrieval and webhook covered. Missing: `lead_forms` (workspace_id, integration_account_id, form_id, name, questions jsonb, last_synced_at), `lead_submissions` raw payload table for idempotency and replay, field-mapping from form questions to contact/lead/custom fields (`lead_form_mappings`), backfill of missed leads after outage (poll by form). Screens: Lead forms list and mapping editor under Integrations. |
| Multiple Pages and accounts | Partially Planned | MVP | Data model supports it. Missing: connect flow listing all Pages from `/me/accounts`, per-account enable and disable of webhook subscription, and a per-account inbox filter. Add to FR-17. |
| Webhooks | Fully Planned | MVP | Add the Meta data-deletion callback and deauthorize callback endpoints (section 8). |
| Token lifecycle | Fully Planned | MVP | Add scheduled refresh job and reconnect prompts; `integration_credentials` already holds expiry. |

## 3. Unified inbox

| Feature | Status | Release | Gap and required additions |
|---|---|---|---|
| Assignment | Fully Planned | MVP | none |
| Internal notes | Partially Planned | MVP | `notes` is entity-level. In-thread internal notes need `messages.kind = note` (never sent to the platform, visible only to members). Compose toggle "Reply / Note". |
| Saved replies | Fully Planned | MVP | `quick_replies` exists; add variables ({{first_name}}) and scope (personal/workspace). |
| Collision prevention | Missing | MVP | Add ephemeral presence: `POST /conversations/{id}/presence` heartbeat (viewing/typing) broadcast through the existing SSE stream and held in memory or a short-TTL table; UI shows "Maya is replying". Soft warning, not a hard lock. Also guard on send: server rejects reply if an agent-assignee changed since composer load (If-Match on conversation version). |
| Conversation ownership | Partially Planned | MVP | `assignee_id` exists. Missing: assignment history (`conversation_events`: assigned, status changed, merged), auto-assignment rules (round robin) is R2, teams are R2 (`teams`, `team_members`). |
| Search | Fully Planned | MVP | none |
| Filters | Fully Planned | MVP | add saved inbox views (`saved_views` exists) |
| SLA and response-time tracking | Partially Planned | MVP basics, SLA policies R2 | Dashboard lists response time but no source columns. Add `conversations.first_response_at`, `first_inbound_at`, `resolved_at`, `messages.sent_by_user_id` (to separate human from automation replies), `workspaces.business_hours jsonb`. Add SLA policies in R2 (`sla_policies`, breach events). |

## 4. Conversion tracking

| Feature | Status | Release | Gap and required additions |
|---|---|---|---|
| Meta CAPI | Fully Planned | MVP (Phase 6b) | none |
| Configurable event mapping | Fully Planned | MVP | none |
| Multiple datasets | Fully Planned | MVP | Mapping is per dataset already. |
| Custom events | Partially Planned | MVP | Mapping lets the user type any `meta_event_name`; add validation that standard events use their documented parameters and a "custom event" flag, and custom_data field templates. |
| Deduplication | Fully Planned | MVP | none |
| Testing | Fully Planned | MVP | none |
| Delivery logs | Fully Planned | MVP | none |
| Future TikTok Events API | Partially Planned | Later | Tables are named `capi_*` and Meta-specific. Amendment A2: name the generic layer `conversion_destinations`, `conversion_event_mappings`, `conversion_events`, `conversion_delivery_attempts` with a `destination_kind` (`meta_capi`, later `tiktok_events`), keeping `packages/capi` as the Meta adapter behind a `ConversionDestination` interface. Doing this now costs nothing; later it needs a data migration. |

## 5. AI

| Feature | Status | Release | Gap and required additions |
|---|---|---|---|
| Reply suggestions | Fully Planned | MVP | none |
| Summaries | Fully Planned | MVP | none |
| Lead qualification | Fully Planned | MVP | none beyond approval gating |
| Scoring | Partially Planned | R2 | Only `leads.ai_score`. Add score history and rationale via `ai_insights`. |
| Intent detection | Partially Planned | R2 | No storage. Add `ai_insights` (workspace_id, entity_type, entity_id, kind intent/sentiment/score/summary/next_action, value jsonb, confidence, ai_run_id, status current/superseded, created_at) so all derived AI output lives in one reviewable table instead of ad hoc columns. |
| Sentiment | Partially Planned | R2 | Same table. |
| Follow-up suggestions | Partially Planned | MVP | Define as `ai_insights.kind = next_action` that can create a task after approval. |
| Knowledge base | Partially Planned | R2 | `knowledge_sources` only. Needs `knowledge_chunks` with embeddings. Decision: use pgvector (extension availability depends on hosting; Docker Postgres supports it). Added to approval list. |
| AI-assisted automation | Fully Planned | MVP | none |

## 6. Mobile

| Feature | Status | Release | Gap and required additions |
|---|---|---|---|
| Dashboard | Fully Planned | MVP | none |
| Inbox | Fully Planned | MVP | none |
| Contacts | Fully Planned | MVP | add create/edit contact and quick call/message actions |
| Leads | Fully Planned | MVP | none |
| Tasks | Missing | MVP | Tasks tab content in Home plus lead/contact detail; create, complete, snooze; reminder push. |
| Notifications | Partially Planned | MVP | Push exists; no in-app notification center. Add `notifications` table (user_id, workspace_id, kind, entity ref, read_at) with bell/inbox on web and mobile, and an API `/notifications`. |
| AI assistant | Fully Planned | MVP | none |
| Pipeline | Missing | MVP | PRD mobile scope has no pipeline view. Add stage-grouped horizontal board or segmented list with change-stage action sheet (no drag required). |
| Essential CRM operations | Partially Planned | MVP | Add create contact, create lead, add note, change owner, log call. Web keeps heavy admin (import, mappings, workflow builder, CAPI). |

## 7. SaaS readiness

| Feature | Status | Release | Gap and required additions |
|---|---|---|---|
| Workspaces | Fully Planned | MVP | none |
| Invitations | Partially Planned | MVP basics | Table exists, no API, UI, or email. Needs transactional email (new infrastructure decision A3). Endpoints `/invitations` (create, resend, revoke, accept). |
| RBAC | Partially Planned | MVP | Four roles named, no permission matrix. Add `docs/architecture/permissions.md` with role-by-capability matrix, single `can(user, action, resource)` policy function used by API and UI, and per-role tests. Custom roles are Later. |
| Subscription plans and billing | Not Applicable (MVP) | Later | Explicit non-goal in the PRD. Keep it that way. |
| Usage limits | Missing | MVP minimal | AI budgets exist, nothing else. Add `workspace_limits` (key, limit) and `usage_counters` (key, period, value) enforced in services for AI spend, seats, connected accounts, CAPI events. Plans, prices and Stripe are Later; limits are needed anyway to protect the solo operator from runaway cost. |
| Workspace settings | Partially Planned | MVP | `workspaces.settings jsonb` has no defined content. Define: timezone, business hours, default currency, default pipeline, auto-send policy, retention periods, branding. |
| Account lifecycle | Missing | MVP minimal | Add: deactivate member (revoke sessions, keep history), transfer ownership, delete workspace (soft delete with grace period then purge job, revoke integrations, remove tokens, Meta deauthorize), delete user account, email change. Endpoints and Settings screens. |

## 8. Platform foundations

| Feature | Status | Release | Gap and required additions |
|---|---|---|---|
| Global search | Partially Planned | MVP | Search per entity exists. Add `GET /search?q=` across contacts, leads, conversations, tasks feeding the command menu (web) and a search screen (mobile). |
| Notifications | Partially Planned | MVP | See mobile row; email notifications R2. |
| Audit logs | Partially Planned | MVP | Table exists. Add API `/audit-log` (admin/owner only, read only, no edits), UI table with filters, retention setting. List of audited actions in permissions doc. |
| Data export | Missing | MVP | Per-contact export (subject access) and workspace export (CSV/JSON zip) via `export_jobs`, owner only, audited, expiring signed URL. Requires object storage (A3). |
| Backup and recovery | Missing | MVP | Define RPO and RTO targets, nightly logical dump plus WAL or provider point-in-time recovery, encrypted backups, quarterly restore test recorded in the testing report. Provider-dependent; part of the deployment doc in Phase 8, with a local `pg_dump` script from Phase 1. Key backup: the KEK must be backed up separately or credentials become unrecoverable. |
| Privacy | Partially Planned | MVP | Generalize consent: `consent_records` is purpose-based (including messaging, marketing, ad measurement) not CAPI-only. Add privacy policy and terms pages (Meta requires a privacy policy URL for Live mode per research, to confirm), data-processing documentation, retention settings. |
| Consent | Partially Planned | MVP | See privacy. Add UI to view/edit consent on contact profile and capture source (form checkbox, manual, import). |
| Data deletion | Partially Planned | MVP | Contact erasure covers CAPI queue only. Add a `deletion_requests` workflow: erase contact and identities, messages anonymized or deleted by policy, notes, tasks, AI insights, CAPI queue, search index, backups age-out documented. Meta data-deletion callback endpoint `POST /v1/webhooks/meta/data-deletion` (signed_request parse, returns status URL and confirmation code) and `POST /v1/webhooks/meta/deauthorize`. |

Not Applicable in the MVP: billing (see section 7). White-labeling is a non-goal and not audited.

## 9. Missing infrastructure surfaced by the audit
1. **Transactional email** (verification, password reset, invitations, digests). Nothing in the architecture sends email. Provider needed (decision A3), with a dev mailbox in local mode.
2. **Object storage** (S3-compatible) for attachment copies (Meta media URLs expire, per general behavior to confirm), CSV imports, exports, avatars. Local MinIO in development.
3. **pgvector** if the knowledge base is built (R2).
4. **Scheduled jobs** list: token refresh, health checks, retention, reminders, SLA breach, lead backfill (pg-boss cron covers it).

## 10. Architecture decisions that could make later work hard
| ID | Issue | Fix now (cheap) | Cost if deferred |
|---|---|---|---|
| A1 | Lead vs deal ambiguity | Single entity plus `pipelines.kind`; document in PRD | Data migration and UI rewrite |
| A2 | `capi_*` naming bakes Meta into a generic conversion layer | Rename to `conversion_*` with `destination_kind` | Table rename and API break |
| A3 | No email, no object storage in architecture | Add providers behind interfaces (`Mailer`, `BlobStore`) | Retrofitting touches auth, imports, exports |
| A4 | `domain_events.cursor bigserial` can expose events out of commit order: a transaction that took a lower number may commit after a higher one, so a client resuming from the higher cursor permanently skips it | Stream only events below `pg_snapshot_xmin(pg_current_snapshot())` using a txid column, or serialize per-workspace allocation with a counter row; add a test with concurrent transactions | Silent missed messages in inbox, hard to reproduce |
| A5 | Conversations assume 1:1 DM threads | `conversations.kind` and `messages.kind`/`parent_external_id` for comments | Schema redesign of the most important tables |
| A6 | Meta deletion and deauthorize callbacks absent | Add endpoints and tests in Phase 3 | Blocks Live-mode submission |

## 11. Not added on purpose
Teams and round robin, SLA policies, custom roles, email channel, Stripe billing, scoring models, knowledge base, visual workflow canvas, WhatsApp/TikTok live. These are R2 or Later and appear in the roadmap as such, so the audit does not inflate the MVP.

## 12. Review and citation results
See `docs/project/phase0-review.md` (independent review) and `docs/research/citation-spot-check.md`. Their findings are summarized in the section below once complete.

## 13. Review and citation results (completed 2026-11-13)
- Independent review (`phase0-review.md`): 6 blockers, 21 major, 14 minor. Blockers B1 (event cursor), B2 (outbox relay), B3 (outbound duplicate sends), B4 (RLS versus webhook and worker access), B5 (permissions matrix) and B6 (Meta deletion callbacks) are resolved in the documents by architecture amendments, `permissions.md` and the PRD and roadmap amendments. Majors are addressed in the same amendments except where noted as open decisions. Minor items m1 to m7 are applied or recorded; several acceptance thresholds were made numeric in the PRD.
- Citation check (`citation-spot-check.md`): 35 confirmed, 4 contradicted and corrected by errata, 3 unverifiable. Corrections affect webhook signature handling (hash exact bytes), subscription loss detection (messaging webhooks auto-unsubscribe after 1 hour of failures), Graph API version (v27.0), and Live-mode requirements. Comment and story permissions are now documented in the Meta errata, which supports FR-36.
