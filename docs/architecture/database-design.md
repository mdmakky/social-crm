# Initial Database Design

Version 0.1 (Phase 0). PostgreSQL 18, Drizzle ORM. Conventions: UUIDv7 primary keys (time-ordered), `created_at`/`updated_at` timestamptz, soft delete via `deleted_at` only where history matters, every tenant table has `workspace_id uuid not null` with RLS. Column lists are the design intent, not final DDL.

## Identity and tenancy
- `users` (id, email unique, name, avatar, locale, created_at) not tenant-scoped.
- `auth_sessions`, `auth_accounts`, `auth_verifications` (managed by Better Auth; session carries device label, ip, last_used_at, revoked_at).
- `workspaces` (id, name, slug, owner_user_id, timezone, settings jsonb).
- `memberships` (workspace_id, user_id, role enum owner|admin|agent|viewer, status). PK (workspace_id, user_id).
- `invitations` (workspace_id, email, role, token_hash, expires_at). Foundation only.

## CRM core
- `contacts` (workspace_id, id, display_name, first_name, last_name, email, phone, company, avatar_url, owner_id, custom jsonb, merged_into_id, last_activity_at).
- `contact_identities` (workspace_id, contact_id, integration_account_id, platform enum, external_id, handle, profile jsonb). Unique (workspace_id, integration_account_id, external_id). One contact, many channels.
- `tags`, `contact_tags`; `notes` (author, body, entity_type, entity_id).
- `pipelines` (workspace_id, name, is_default), `pipeline_stages` (pipeline_id, name, position, kind open|won|lost).
- `leads` (workspace_id, id, contact_id, pipeline_id, stage_id, title, status, priority, value_amount, value_currency, source, source_ref, owner_id, follow_up_at, qualified_at, closed_at, ai_score nullable, ai_summary nullable).
- `lead_stage_history` (lead_id, from_stage, to_stage, changed_by, changed_at).
- `activities` (workspace_id, entity_type, entity_id, actor_type user|system|ai|automation, actor_id, kind, data jsonb, occurred_at). Timeline for everything.
- `reminders` (workspace_id, user_id, entity_type, entity_id, due_at, done_at).
- `saved_views` (workspace_id, user_id nullable, entity_type, filter jsonb, sort jsonb, columns jsonb).

## Inbox
- `conversations` (workspace_id, id, integration_account_id, contact_id, external_thread_id, status open|pending|resolved, assignee_id, unread_count, last_message_at, last_inbound_at, window_expires_at, lead_id nullable, priority). Unique (workspace_id, integration_account_id, external_thread_id).
- `messages` (workspace_id, id, conversation_id, direction in|out, external_id, sender_type contact|user|system|ai, sender_id, body, attachments jsonb, status queued|sent|delivered|read|failed, error jsonb, client_nonce, sent_at, delivered_at, read_at). Unique (workspace_id, conversation_id, external_id) and unique (workspace_id, client_nonce) for idempotent client sends.
- `conversation_reads` (conversation_id, user_id, last_read_message_id) for per-user read state.
- `quick_replies` (workspace_id, shortcut, body, created_by).

## Integrations
- `integration_accounts` (workspace_id, id, platform enum, kind page|instagram|ads|dataset|..., external_id, display_name, status active|needs_reauth|error|disabled, capabilities jsonb, mode live|mock, health jsonb, last_synced_at).
- `integration_credentials` (workspace_id, integration_account_id, kind, ciphertext, wrapped_key, key_version, expires_at, last_refreshed_at, scopes). Never selected by client-facing queries; separate DB role/view.
- `webhook_events` (id, platform, delivery_key unique, workspace_id nullable until resolved, headers_redacted, payload jsonb, signature_valid bool, status received|processing|done|failed, attempts, received_at, processed_at). Retention-limited.
- `outbound_deliveries` (message_id, attempt, request_summary, response_summary, status).

## Realtime and jobs
- `domain_events` (cursor bigserial, workspace_id, type, entity_type, entity_id, payload jsonb, created_at). Retained for a bounded window (for example 7 days).
- pg-boss manages its own schema for queues; job payloads carry workspace_id and idempotency keys.
- `devices` (workspace-independent: user_id, session_id, platform ios|android|web, push_token_enc, locale, last_seen_at, revoked_at).
- `notification_preferences` (user_id, workspace_id, kind, channel push|email|inapp, enabled, preview_enabled, quiet_hours).
- `notification_deliveries` (workspace_id, user_id, device_id, kind, dedupe_key unique, status, provider_ticket, provider_receipt, error, sent_at).

## Automation
- `workflows` (workspace_id, id, name, status draft|enabled|disabled, version, definition jsonb [trigger, nodes, edges], created_by).
- `workflow_runs` (workspace_id, workflow_id, version, trigger_event_id, idempotency_key unique, status running|waiting_approval|succeeded|failed|cancelled, started_at, finished_at).
- `workflow_run_steps` (run_id, node_id, status, attempt, input jsonb, output jsonb, error jsonb, started_at, finished_at).
- `approvals` (workspace_id, run_step_id, requested_for role/user, proposed_action jsonb, status pending|approved|rejected|expired, decided_by, decided_at).
- `automation_settings` (workspace_id, global_enabled, auto_send_policy jsonb).

## AI
- `ai_providers` (workspace_id, kind, name, credential ref, enabled).
- `ai_models` (workspace_id, provider_id, model_id, purpose enum suggest|summarize|classify|agent, params jsonb).
- `ai_runs` (workspace_id, id, purpose, provider, model, entity_type, entity_id, prompt_version, input_tokens, output_tokens, cost_micros, latency_ms, status, redacted_input_ref, output jsonb, approval_id nullable, created_at).
- `ai_budgets` (workspace_id, period, limit_micros, spent_micros, hard_stop).
- `knowledge_sources` (workspace_id, kind, title, content_ref, embedding_status). Foundation only.

## CAPI
- `capi_datasets` (workspace_id, id, dataset_id, name, status, token credential ref, test_event_code nullable, graph_version, last_success_at).
- `capi_event_mappings` (workspace_id, dataset_id, crm_event, meta_event_name, enabled, action_source, value_rule jsonb, field_allowlist jsonb, require_consent bool).
- `consent_records` (workspace_id, contact_id, purpose, status granted|denied|withdrawn, source, evidence jsonb, recorded_at).
- `capi_events` (workspace_id, id, dataset_id, event_id (stable), crm_event_id, event_name, event_time, payload_redacted jsonb, status pending|sending|delivered|failed|skipped|dead, skip_reason, attempts, next_attempt_at, last_error jsonb, created_at). Unique (workspace_id, dataset_id, event_id).
- `capi_delivery_attempts` (capi_event_id, attempt, http_status, fbtrace_id, response_summary jsonb, attempted_at).
Hashed identifiers are computed at send time from the contact record; stored payloads are redacted and short-lived.

## Audit
- `audit_log` (workspace_id, actor, action, entity, before/after summary, ip, at). Covers credential changes, role changes, exports, deletions, automation enable/disable.

## Indexing and integrity notes
Indexes lead with `workspace_id`. Search uses `pg_trgm` and `tsvector` on contacts and messages. Foreign keys include workspace_id. Check constraints on enums and money. Retention jobs trim `webhook_events`, `domain_events`, `capi_events` payloads and notification deliveries; deletion of a contact cascades to identities, notes and CAPI queue entries.

## Amendments (2026-11-13) from review and audit

**Conventions.** Every tenant table, including child tables, carries `workspace_id` and an RLS policy; a CI test lists all tables in the tenant schemas and fails if one lacks either. Mutable entities (contacts, leads, conversations, tasks, workflows, mappings) gain `version int not null default 1`, incremented on update and checked with `If-Match`. Child tables that previously relied on the parent: `lead_stage_history`, `pipeline_stages`, `contact_tags`, `conversation_reads`, `capi`/conversion delivery attempts, `workflow_run_steps`, `outbound_deliveries`.

**Changed**
- `domain_events`: key is `(workspace_id, seq)`; add `workspace_event_counters` and `event_consumers` (see architecture amendments B1, B2).
- `conversations.kind` (`dm`, `comment_thread`); `messages.kind` (`message`, `comment`, `reply`, `note`), `messages.parent_external_id`, `messages.sent_by_user_id`, `messages.status` adds `sending` and `unknown`.
- `conversations.first_inbound_at`, `first_response_at`, `resolved_at`; `workspaces.business_hours`.
- `pipelines.kind` (`lead`, `sales`); `contacts.lifecycle_stage`.
- `capi_*` renamed `conversion_destinations` (destination_kind `meta_capi`), `conversion_event_mappings`, `conversion_events`, `conversion_delivery_attempts`. CAPI re-checks consent at send time, not only at enqueue; a failed batch is bisected so one bad event cannot block the rest; Lead-stage mapping uses free-form stage names as documented for Conversion Leads.
- `consent_records` becomes contact-level and purpose-based with `source` (`form`, `manual`, `import`, `platform_policy`, `inferred_dm`). For DM-sourced contacts the default is "not recorded", so consent-required mappings skip them until someone records a basis.

**Added**
- `tasks` (replaces `reminders`), `custom_field_definitions`, `lead_tags`, `import_jobs`, `export_jobs`, `deletion_requests`, `notifications` (in-app centre), `idempotency_keys`, `workspace_limits`, `usage_counters`, `posts`, `lead_forms`, `lead_form_mappings`, `lead_submissions`, `conversation_events` (assignment and status history), `ai_insights`, `attachments` (blob refs). R2: `teams`, `team_members`, `sla_policies`, `knowledge_chunks` (pgvector).

**Contact merge semantics.** Merge is a transaction that moves identities, conversations, leads, notes, tasks, consent (most restrictive wins), activities and queued conversion events to the survivor, writes a `contact_merges` record (loser snapshot for 30-day undo), and leaves `merged_into_id` on the loser. Lookups and in-flight webhooks that resolve to a merged contact follow the pointer. If both contacts have a conversation on the same integration account and thread, the newer thread stays separate and is linked, not silently combined.

**Retention defaults (configurable per workspace).** `webhook_events` raw 30 days; `domain_events` 7 days and below all consumer offsets; conversion event payloads 30 days after delivery; AI run inputs 30 days; notification deliveries 90 days; audit log 2 years; deleted workspace purge 30 days after request. Contact erasure removes the contact, identities, messages (or anonymizes per policy), notes, tasks, insights, queued conversion events and search entries; backups age out within the backup retention window, which the privacy page states.
