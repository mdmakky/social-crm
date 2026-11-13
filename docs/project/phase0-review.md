# Phase 0 Independent Review

Reviewer: independent strict pass, 2026-11-13. Scope: CLAUDE.md, PRD, roadmap, decisions, architecture, database design, API strategy, CAPI, AI/automation, design system, skill matrix, known limitations; research docs skimmed for consistency. Findings only. Severity: blocker = must be resolved before Phase 1 scaffolding or the stated design cannot work; major = will cause a defect, leak or rework if not fixed in Phase 0/1; minor = fix when touched.

Counts: 6 blockers, 21 major, 14 minor.

## Blockers

### B1. SSE cursor from `bigserial` can skip events
- Where: architecture.md section 6; database-design.md "Realtime and jobs"; api-strategy.md "Realtime contract".
- Problem: `bigserial` values are allocated at INSERT, not at COMMIT. Transaction A takes cursor 10, transaction B takes 11 and commits first. A reader that has delivered 11 and resumes with `id > 11` never sees 10. Same flaw hits any consumer (automations, CAPI) that reads `domain_events` by cursor. The docs also say the cursor is "per workspace" in research but the table has one global sequence.
- Fix: choose one: (a) per-workspace counter row updated inside the writing transaction (`UPDATE workspace_seq SET n = n+1 RETURNING n`; serialises writers per workspace, acceptable at this scale) or (b) store `xid8` (`pg_current_xact_id()`) with the id and have readers only read rows with `xid < pg_snapshot_xmin(pg_current_snapshot())`. Document which; add a concurrency test that interleaves two commits and asserts no gap is ever skipped.

### B2. No defined relay from `domain_events`/outbox to jobs and consumers
- Where: architecture.md principle 5 and section 6; ai-automation-architecture.md section 1 step 1; capi-architecture.md section 1.
- Problem: three different consumers (SSE, workflow triggers, CAPI mapping) are all said to read "the outbox", and push/automation jobs are "fed by a transactional outbox". Nothing defines: the outbox table (is `domain_events` the outbox? it is pruned at 7 days, so an unconsumed automation event can be deleted), the relay process, per-consumer cursor/offset storage, or how a pg-boss job is enqueued in the same transaction (pg-boss must be given the same DB connection/transaction, which conflicts with the per-request tenant-scoped tx helper). Retention pruning vs slow or down consumers is a silent data-loss path.
- Fix: add a section "Event pipeline": one `outbox` table (transactional, never pruned until all registered consumers have acked), `consumer_offsets(consumer, last_id)`, one relay that enqueues pg-boss jobs with `singletonKey = event id`. Keep `domain_events` (SSE replay) separate with its own retention. State that pg-boss is at-least-once and that jobs exceeding their expiry can run twice; every handler must be idempotent (already claimed, but make it an acceptance test).

### B3. Outbound send can duplicate customer messages
- Where: architecture.md section 2/5; database-design.md `messages`, `outbound_deliveries`; ai-automation section 1 step 3; roadmap Phase 3/4.
- Problem: flow is queued row -> job -> Meta Send API -> update status. Meta's Send API has no idempotency key. If the worker crashes or times out after Meta accepted the message but before the status write, retry sends it again. `client_nonce` only dedupes client-to-API, not API-to-Meta. Also the echo webhook for our own message can arrive before the Send response is persisted, creating a second `messages` row (the unique `(workspace_id, conversation_id, external_id)` does not help while `external_id` is still null).
- Fix: add status `sending` written (committed) before the Graph call with the attempt id; on ambiguous outcome (timeout, crash) mark `unknown` and reconcile via the echo webhook/mid lookup instead of blind retry; retry automatically only on provably-not-sent errors (4xx before accept, connection refused). Echo handling: upsert by `external_id` and, if absent, match to the pending outbound by `client_nonce`/attempt. Add acceptance test "kill worker after Graph 200, before commit: exactly one message visible".

### B4. Webhook and worker tenancy cannot satisfy "RLS on every table"
- Where: architecture.md sections 4 and 5; database-design.md `webhook_events`, `memberships`, `integration_credentials`; technology-decisions.md section on tenancy (mentions a `worker` role; architecture drops it).
- Problem: (1) The public webhook must map Meta `page_id`/IG id to a workspace before any tenant context exists. With forced RLS and a non-owner role that lookup returns nothing. `webhook_events.workspace_id` is nullable, so no RLS policy can cover it. (2) Validating `X-Workspace-Id` requires reading `memberships`, whose policy is presumably keyed on `app.workspace_id`, which is not yet set (chicken and egg). (3) Token refresh/health jobs scan all workspaces. (4) pg-boss tables live outside RLS, and the "dead-letter view in the UI" (PRD NFR, architecture section 11) would list jobs from all tenants unless app code filters, which contradicts "RLS not only app code".
- Fix: define three DB roles (`app_user`, `worker`, `webhook_resolver`) and name every exception: a `SECURITY DEFINER` function `resolve_integration_account(platform, external_id)` returning only `workspace_id, account_id` (owner-owned, `search_path` pinned); a memberships policy keyed on `app.user_id`; the worker role gets explicit audited policies, not BYPASSRLS; per-tenant dead-letter view reads from a tenant-scoped `job_failures` table written by the worker, not from pg-boss tables. Put all of this in the RLS leak suite.

### B5. Roles and permissions are not specified anywhere
- Where: PRD FR-2; database-design.md `memberships`; api-strategy.md; architecture.md section 8.
- Problem: four roles exist, but no matrix says who can do what: connect/disconnect integrations, view or change CAPI mappings and AI keys, approve auto-send policy, approve a workflow step, see all conversations vs only assigned ones, export/delete contacts, change roles. RLS is workspace-wide only, so agent-level visibility rules exist only in app code with no spec to test. The Phase 1 gate covers cross-workspace leaks only, not privilege escalation inside a workspace.
- Fix: add `docs/architecture/permissions.md`: resource x action x role table, default agent visibility (all vs assigned), approval authority, owner-only actions (credentials, deletion, policy changes). Generate a test per cell. Add `permission denied` to the Phase 1 gate.

### B6. Meta data-deletion and deauthorize callbacks are missing from the build plan
- Where: PRD section 5.4 (FR-16 to FR-18), api-strategy.md resource groups, database-design.md, roadmap Phase 3 scope and gate; meta-api-research.md sections 7, 8, 10.
- Problem: the research says Live mode needs a Privacy Policy URL, a deletion mechanism and a Data Use Checkup, and lists a `signed_request` fixture for the mock. None of this appears as an FR, endpoint, table, or gate item. There is no `deletion_requests` table with confirmation code and status page, no deauthorize handler (user removes the app: tokens must be invalidated and the integration set to `needs_reauth`), and no privacy policy/ToS deliverable (the solo dev has no company, so who is the controller is also undefined).
- Fix: add FR "Meta compliance endpoints" (P1, Phase 3): `POST /v1/webhooks/meta/data-deletion` (HMAC-SHA256 verify, expiry check, returns `{url, confirmation_code}`), `POST /v1/webhooks/meta/deauthorize`, public status page `GET /v1/deletion-status/{code}`, table `deletion_requests`, and a defined deletion scope (see M8). Add privacy policy and terms as Phase 3 deliverables. Mark them blockers for any non-role user.

## Major

### M1. Realtime and API contradictions on workspace selection and SSE auth
- api-strategy.md says the workspace comes from `X-Workspace-Id`; the browser `EventSource` cannot send headers (technology-decisions.md says so), and `/v1/events/stream?cursor=` carries no workspace. Use a path prefix `/v1/workspaces/{id}/...` for everything, or require fetch-streaming on web.
- The stream is long-lived: membership removal, role change, session revoke and token expiry are not re-checked mid-stream (research text says "re-check", architecture omits it). Close streams on revoke via a domain event and re-validate on a timer.
- Web uses cookie auth against an API on a different host (Vercel/Cloudflare web vs container API, architecture section 11). No CSRF, CORS, SameSite or shared-parent-domain plan. Require same-site custom domain and a CSRF token or custom-header rule for cookie-authenticated mutations.

### M2. "Rotating refresh tokens" is unsupported
- architecture.md section 8 and api-strategy.md "Auth" claim rotating refresh. technology-decisions.md describes the Better Auth Expo plugin persisting the session token in SecureStore; it never mentions refresh-token rotation. Verify against Better Auth (Context7) in the Phase 1 spike. If absent, specify the actual model (session expiry, sliding renewal, revoke list) and what happens to a stolen bearer token. Also missing: biometric/app lock decision, deep-link/OAuth redirect hijack protection (PKCE, scheme vs universal link), certificate pinning decision. Skill matrix admits a mobile security audit gap but no phase owns it.

### M3. Email delivery has no owner
- PRD FR-1 requires email verification and password reset. No email provider, sender domain (SPF/DKIM) or template decision exists in decisions.md or the architecture. `notification_preferences` has an `email` channel that contradicts the "email/SMS channels" non-goal wording. Add a decision (e.g. transactional provider) and a Phase 1 task; Phase 1 gate says register/login only, so verification is untested.

### M4. No file/object storage for attachments
- PRD FR-11 and `messages.attachments jsonb`. Meta attachment URLs are temporary and require tokens; nothing downloads, scans, size-limits or stores them (no bucket, no `/attachments` endpoint, no signed-URL strategy, no avatar storage). Add a storage decision (S3-compatible), a media ingest job, MIME/size limits, and a malware/type policy. Hosting is deferred (D16) but this is a hard dependency of Phase 4.

### M5. Per-conversation ordering is not guaranteed
- pg-boss processes jobs concurrently with no ordering. Two inbound messages or an inbound and an outbound for one conversation can be applied out of order, corrupting `last_inbound_at`, `window_expires_at`, `unread_count`, and message `status` (read before delivered). Fix: monotonic updates (`GREATEST`, status rank check), atomic `unread_count = unread_count + 1`, and serialise per conversation (pg-boss group concurrency or `pg_advisory_xact_lock(conversation_id)`). Window rule must derive from the latest inbound by Meta timestamp, not receipt time.

### M6. Webhook handling details are underspecified
- `delivery_key` unique: Meta batches many `entry[]`/`messaging[]` items in one POST and provides no delivery id. A body hash dedupes only byte-identical retries; correct dedupe is per event (`mid`, `leadgen_id`, `watermark`). Split the batch into per-event rows.
- Signature is over the raw body: Hono middleware must read the raw bytes before JSON parsing; Instagram Business Login and Facebook Login apps may use different app secrets; specify the secret lookup and a test for each.
- The ack target (2 s p95, PRD NFR) is met only if the insert is the sole work; state it, and exempt `/webhooks/*` from the IP/user rate limiter in api-strategy.md (a limiter will drop Meta retries).
- Unknown page/unresolvable events: status, TTL, and alert are not defined.
- `webhook_events.payload jsonb` stores full message bodies and PII with only "retention-limited": give a number (e.g. 7-14 days) and enforce it in the retention job.

### M7. Token lifecycle and KEK handling are thin
- database-design.md `integration_credentials` and architecture section 4: refresh races (two jobs refresh the same account; one overwrites a newer token) need `singletonKey` per account plus a row lock. Specify Page token derivation (exchange long-lived user token for Page tokens) and what happens at 60-day expiry; research marks refresh endpoints and system-user lifetimes unverified.
- D13 puts the KEK in an env var next to the process that holds the DB credentials; a single host compromise yields everything. Minimum: KEK not in the repo/CI logs, separate from DB backups, documented rotation (re-wrap DEKs) with a test, and a trigger for moving to KMS (first third-party customer). `ai_providers` keys, CAPI dataset tokens, app secrets and Better Auth secret must be listed in one secret inventory; app secrets are not tenant data and are not addressed.
- `devices.push_token_enc`: say which key encrypts it and whether it needs encryption at all.

### M8. Deletion and retention are incomplete and unquantified
- database-design.md "Indexing and integrity notes": "deletion cascades to identities, notes and CAPI queue entries". Missing: messages, conversations, attachments, activities, `ai_runs` inputs/outputs, conversation summaries, `webhook_events` payloads, `audit_log` before/after summaries, `notification_deliveries`, backups. Soft-delete columns and ON DELETE CASCADE interact badly with composite FKs.
- Retention values are "bounded" or "configured" everywhere (webhook_events, domain_events, capi_events payload, ai_runs, notification_deliveries). Put numbers in a table, in one doc, with the job that enforces each and a test.
- No data export, no workspace delete, no user account delete (Apple requires in-app account deletion for apps with account creation; verify guideline 5.1.1(v) before store submission).

### M9. Consent model cannot work for DM-sourced contacts
- capi-architecture.md section 5 and PRD FR-22: default `require_consent=true` and per-contact `consent_records`, but no feature captures consent (no UI, no import, no Meta-sourced signal), so every event from a Messenger/Instagram contact will be `skipped: no_consent`. Lead-ad forms may carry a consent field; DMs do not. Decide: how consent is recorded (manual, form checkbox, workspace-level attestation), who attests, and the lawful basis. Also consent must be re-checked at send time (hashing happens at send time; withdrawal after enqueue must cancel), and on contact merge (take the most restrictive).
- Research (meta-capi-research.md) says GDPR consent parameters and the sensitive-category policy were not found. The doc admits this but PRD FR-22 is still P1; add a "read policy before Phase 6b" gate with named pages.

### M10. CAPI mapping disagrees with the research for Lead stages
- capi-architecture.md section 2 maps "Lead qualified" to "custom event or Lead with `custom_data.lead_event_source`". meta-capi-research.md rows 103/132 say Conversion Leads takes free-form CRM stage names, `action_source=system_generated`, requires `lead_id`, and wants all stages including the initial one, with eligibility 200 leads/month. Align the table, or state that Conversion Leads is out of scope for a one-person account (volume is unreachable).
- DM-sourced leads have no `lead_id`; `business_messaging` is unverified for a direct CRM; so the DM lead event will usually carry only hashed email/phone that DM leads often lack. State expected match quality and make "no usable identifier" a skip reason.
- Batch of up to 1000: one invalid event fails the whole request. Add split-on-failure (bisect) so one poisoned event does not block 999.
- `event_id` is `sha256(workspace|dataset|crm_event|name)` but section 3 also requires reusing the browser Pixel `event_id`; define precedence. A lead that moves Won -> Open -> Won must not collapse or re-fire silently; define the crm_event identity.
- Test events "still feed targeting and measurement" (research): sending `test_event_code` to a real production dataset is not harmless; recommend a dedicated test Dataset in the Phase 6b gate.

### M11. Offline and conflict semantics contradict each other
- PRD FR-29 and D10 say "server wins"; api-strategy.md says `If-Match` with 409 returning the current record. These are different behaviours (silent drop vs surfaced conflict). Also no `version` column exists on mutable tables in database-design.md (only `updated_at`, which has timestamp-collision risk).
- Not specified: replay order and dependent ops (create lead, then edit it using a client temp id), time-to-live for queued mutations vs `Idempotency-Key` retention, queued reply sent hours later after the 24 h window closed or after a teammate replied, queued approval decisions, deleted-while-offline entities, and what UI shows for rejected replays.
- Fix: pick one rule ("409 with field-level merge for non-overlapping fields, otherwise show the server value and ask"), add `version int` to mutable entities, add a per-mutation `max_age`, re-run `checkSendability` at send time, and write the offline test matrix before Phase 4.

### M12. Idempotency infrastructure is referenced but not designed
- api-strategy.md promises `Idempotency-Key` on all mutations; database-design.md has no `idempotency_keys` table. Specify scope (workspace, user, route), request-hash mismatch behaviour (422), stored response, TTL, and concurrent same-key requests (second waits or gets 409). `messages.client_nonce` unique across the workspace is stricter than necessary and not tied to a user.

### M13. Tenant columns missing on child tables
- The convention says every tenant table has `workspace_id` + RLS, yet these have none listed: `contact_tags`, `pipeline_stages`, `lead_stage_history`, `conversation_reads`, `outbound_deliveries`, `workflow_run_steps`, `capi_delivery_attempts`, `tags`. Child tables without `workspace_id` cannot be forced by RLS without joins (slow, and joins can leak through policies). Add `workspace_id` plus composite FKs and include each in the leak suite. Also composite FKs require `UNIQUE (workspace_id, id)` on parents; not stated.
- `leads.status` duplicates `pipeline_stages.kind`; define which is derived.

### M14. Phase sequencing conflicts with requirements
- FR-9 reminders "by push" (Phase 2) but push exists only in Phase 4. Reminders P1 should move or ship in-app only first.
- FR-27 push and FR-29 offline are P1, yet are Phase 4 gate items alongside P0 inbox. Either promote or split Phase 4.
- Meta webhooks require a public HTTPS endpoint and Expo push/EAS require accounts; hosting (D16), Apple/Google (D17) and Meta app (D18) are "open", and no deployed environment exists until Phase 8. Phase 3 live verification and Phase 4 device push are impossible without staging. Add a minimal staging deploy (or tunnel + stable domain) to Phase 1/3 and make D16-D18 decided before Phase 3.
- Expo Go no longer supports remote push on Android in recent SDKs (verify for SDK 58); Android push on an emulator needs a Google Play image and FCM credentials (a Firebase project). The Phase 4 gate and D9 ("no APNs key handling") omit the FCM requirement.

### M15. Scope is unrealistic for one developer with no estimates
- Two production clients, offline sync, SSE, workflows, AI, CAPI, and compliance in 9 phases; roadmap states estimates are "intentionally omitted until a spike measures velocity". Phase 1 alone bundles stack spike, token system, two shells, two auth flows, RLS, OpenAPI generation, CI, Android SDK setup and ten acceptance items.
- The owner (sole current user) receives the first working inbox in Phase 4, after a full CRM and integration layer. Define an MVP cut line: first usable vertical slice (Meta DM in -> inbox on web -> reply) by Phase 3/4 for web only; mobile parity after.
- FR-18/Phase 7 build adapter stubs for TikTok/WhatsApp/LinkedIn whose gating is unverified (R9). Delete Phase 7 from the plan; keep only the adapter interface. Ponytail: no speculative registry entries.
- Roadmap risk R11 acknowledges solo burnout with only "modular monolith"; add a hard rule: mobile screens limited to Inbox, Leads, Contacts read/write until web is accepted.

### M16. Phase gates reference an absent document
- roadmap.md Phase 6b gate "all CAPI tests listed in the brief pass" and decisions D15 "per the brief" cite a brief that is not in the repo. The gate is unverifiable by anyone but the author. Copy the test list into `capi-architecture.md` as numbered tests.

### M17. Workflow engine lacks loop and cancellation rules
- ai-automation-architecture.md section 1: actions emit domain events which can trigger workflows (assign -> trigger -> assign). No recursion depth, per-run event provenance, per-contact rate limit, or global cap. Add `caused_by_run_id` on events and refuse to trigger from automation-origin events unless explicitly allowed; cap sends per contact per day.
- Disabling a workflow or `global_enabled=false` must cancel waiting runs, scheduled delay jobs and pending approvals; not stated. Behaviour for in-flight runs when a new version is saved is also undefined.
- Approval execution must re-check state: conversation resolved, window expired, new inbound message arrived, approver role. Approvals need an atomic claim (approve twice = one send).

### M18. AI privacy and prompt-injection exposure
- ai-automation-architecture.md section 3: inbound customer text is untrusted input to an LLM that has read tools. No statement on prompt injection, output sanitising (links, markup in suggested replies), or cross-contact data leakage through retrieval tools (a tool call that crosses contacts or workspaces). Run tools under the same RLS context and per-conversation scope.
- Customer messages go to third-party model providers with no stated lawful basis, DPA/terms review, or Meta platform-terms check for sending Messenger/Instagram data to AI providers (unverified; add to known-limitations). Workspace AI default must be off, per-provider.
- Budgets: `ai_budgets.spent_micros` increments after the call race under concurrency, and streaming cost is unknown up front. Use reserve-then-settle in one transaction; hard stop must be tested with parallel calls.

### M19. Push payload design leaves gaps
- architecture.md section 7: content-free text is good, but data payload (deep link, conversation id, workspace id) transits Expo's servers; list the allowed fields. Notification tap must re-authorise (user may have been removed or logged out). Opt-in previews put message text on the lock screen and through Expo; show a warning and exclude sensitive content. Devices are workspace-independent while notifications are workspace-scoped: define behaviour on membership removal and on shared devices (user A logs out, user B logs in).

### M20. Contact merge and identity semantics are undefined
- `merged_into_id` only. Missing: how identities, conversations, leads, notes, consent, CAPI events and reminders move; reversibility; behaviour when two conversations on the same integration account collide; concurrent edit during merge; in-flight webhooks resolving to the merged-away contact (must follow the pointer). Required before FR-5 can be built.

### M21. Missing endpoints and entities
- Resource groups omit: `/search`, `/tags`, `/notes`, `/activities`, `/reminders`, `/saved-views`, `/consent`, `/audit-log`, `/sessions` and `/devices` (FR-3), `/attachments`, `/export`, `/health`, Meta compliance endpoints (B6), `/me`. No `lead_forms`/ad source tables despite Lead Ads FR-17 (form id, ad id retention). Instagram/Facebook comments are in the research mock scope but not in PRD or schema; either state out of scope or add a `comments` model. No per-resource role mapping (B5). No `Retry-After`/429 contract or request-size limits.

## Minor

- **m1.** Package name `design-tokens` (architecture, CLAUDE.md) vs `ui-tokens` (research); table `memberships` vs `workspace_members` (research). Pick one.
- **m2.** D14 "Node 26 vs 24": research states Node 26 LTS was scheduled 2026-10-28 (already passed on 2026-11-13). Decide and pin now (`.nvmrc`, `engines`) after checking Expo, Metro and native-module support; D14 text is stale.
- **m3.** PRD NFR realtime says "second client within 2 s p95 on a normal connection", roadmap Phase 4 says "locally". Define the test environment (network profile, payload size, N concurrent clients).
- **m4.** Unmeasurable acceptance criteria: Phase 2 "pagination and search performance measured on 10k contacts" has no threshold (add e.g. p95 list < 300 ms, search < 500 ms); Phase 6 "evaluation fixtures run" has no pass bar; Phase 8 lists audits without exit criteria (zero open high findings?); PRD cold start "when a device is available" is conditional; Lighthouse is measured on unnamed screens and hardware. Missing NFRs: backup frequency, RPO/RTO, availability target, max rate limits, max message/attachment size, DB growth assumptions.
- **m5.** Phase 1 gate item 10 ("iOS: attempted if accounts exist") is a non-gate; either a pass criterion or move out.
- **m6.** `audit_log` is not append-only (no REVOKE UPDATE/DELETE) and lacks request id and session id. Specify both.
- **m7.** `activities`, `domain_events` and `audit_log` overlap; state purposes and which is user-visible and which is replayable. Otherwise events get written three times inconsistently.
- **m8.** Rate limiting store is unspecified (in-memory limiters fail with more than one API instance). Use Postgres or a single instance explicitly.
- **m9.** Postgres connection pooling: `set_config(..., true)` is safe only inside a transaction; with PgBouncer transaction mode LISTEN/NOTIFY and session settings break. State direct connections for the SSE listener and no pooling mode that breaks RLS context. Add a test that a connection reused after a request has empty `app.workspace_id`.
- **m10.** Search: `pg_trgm`/`tsvector` on `messages` under RLS with workspace-first indexes; message search across 10k+ rows and language config (Arabic/other languages?) not decided; locale of contacts unaddressed though `users.locale` exists. Define languages supported and RTL handling in design-system.md (absent).
- **m11.** Design system: touch target sizes and HIG/Material claims marked unverified yet used as CI-level acceptance (PRD NFR). Contrast check "in CI" has no tool named. No dark-mode/RTL/dynamic-type/Large Text requirements for mobile; accessibility on mobile has no automated check (axe covers web only).
- **m12.** Skill matrix shows custom skills (`expo-rn-conventions`, `mobile-security-audit`, `tenant-isolation-testing`, `meta-platform-integration`) as proposals with no phase or owner; mobile security audit is not in the Phase 8 list. Either create them or remove the claims.
- **m13.** Known-limitations lists unverified Meta items (HUMAN_AGENT tag string, delivery/read/echo schemas) but PRD FR-12 and Phase 3 "send pipeline with window rules" depend on them; add a gate "read tag docs before implementing outside-window sends". Make the 7-day Human Agent flow a post-MVP item until verified. Also: Graph version must be configurable (known-limitations notes v26 vs v27), but no config key appears in `integration_accounts` (only `capi_datasets.graph_version`).
- **m14.** CLAUDE.md says Phase 0 "complete in draft"; progress.md says strict review and citation spot-check are not done. Update both after this review; the Phase 0 gate should include the spot-check of the 3-4 load-bearing Meta claims (Dev-mode access without review, roles, webhook retry, deletion callback) before the user approves D18, since the entire MVP premise (PRD section 4) depends on the app-roles doc that research states it did not read.

## Claims not supported by research (summary)
| Claim | Location | Research status |
|---|---|---|
| Rotating refresh tokens | architecture 8, api-strategy | Not in Better Auth/Expo research text |
| Dev-mode access to messaging/webhooks/leads for role users needs no review | PRD 4 | Based on Business Verification page; roles doc unread |
| `business_messaging` CAPI events fit for CRM | CAPI 2 | Marked unverified/partner-only |
| Conversion Leads via "Lead qualified" mapping | CAPI 2 | Research describes different payload (free-form stage names) |
| Touch targets 44 pt/48 dp as NFR | PRD 7, design-system | Apple/Material pages did not render |
| Expo Push covers Android and iOS without further credentials | D1, D9 | Not evidenced; FCM/APNs credentials still needed |

## Suggested order of fixes before approval
1. B1-B4 (architecture): event pipeline, cursor, send state machine, role/tenancy exceptions. One design addendum plus tests named.
2. B5, B6, M8, M9: permissions matrix, compliance endpoints and retention table, consent source.
3. M14, M15, M16, m4: re-sequence phases with an MVP cut line, staging environment, numeric gates, copy the CAPI test list into the repo.
4. Remaining major items during Phase 1 planning; minors as encountered.
