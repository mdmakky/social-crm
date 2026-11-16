# System Architecture

Version 0.1 (Phase 0). Date: 2026-11-13. Stack choices are recommendations pending approval; evidence in `docs/research/technology-decisions.md`.

## 1. Principles
1. A modular monolith for the API, with one separate worker process. No microservices.
2. The CRM core knows nothing about Meta. Platforms plug in through adapters.
3. One versioned HTTP API is the only way clients reach data. Web and mobile are both ordinary clients of it.
4. Tenant isolation is enforced in the database (row level security), not only in application code.
5. Everything slow or external (Meta calls, CAPI delivery, AI, automations, push) runs in background jobs fed by a transactional outbox.
6. Secrets and platform tokens never leave the server.

## 2. Containers

```
 Web (Next.js)        Mobile (Expo / React Native)
        \                 /
         \   HTTPS + SSE /
          v               v
        API (Hono, /v1, OpenAPI from Zod)
          |  auth, RBAC, workspace context
          |  business modules (contacts, leads, inbox, automation, ai, capi, ...)
          v
        PostgreSQL 18 (RLS, outbox, pg-boss queue tables)
          ^
          |
        Worker (same codebase): pg-boss jobs
          |-- webhook processor
          |-- outbound message sender
          |-- CAPI delivery
          |-- automation runner
          |-- AI jobs
          |-- push dispatch
          |-- token refresh / health checks
          v
        Platform adapters --> Meta | (TikTok, WhatsApp, LinkedIn later) | Mock
        AI providers (via facade)    Expo Push service
```

Web is a pure client; Next.js route handlers are not used for business logic, so mobile and web share identical rules and permissions.

## 3. Monorepo layout

```
apps/web            Next.js
apps/mobile         Expo
apps/api            Hono HTTP server
apps/worker         pg-boss worker entry (imports server packages)
packages/contracts  Zod schemas, OpenAPI spec, generated API client
packages/db         Drizzle schema, migrations, RLS policies, tenant-scoped query helper
packages/core       domain services (contacts, leads, inbox, pipeline, workflows)
packages/integrations  adapter interface, capability registry, meta/, mock/, stubs
packages/capi       mapping, validation, hashing, delivery
packages/ai         provider facade, prompt store, cost tracking, tools
packages/design-tokens  W3C token JSON -> CSS variables and RN object
packages/config     tsconfig, eslint, shared tooling
```

UI components are not shared between web and mobile. Tokens, contracts, validation and the API client are.

## 4. Multi-tenancy
- Every tenant table carries `workspace_id`. Composite foreign keys (`workspace_id`, id) stop cross-workspace references.
- RLS with `FORCE ROW LEVEL SECURITY`. The application connects as a non-owner role. Each request runs in a transaction that sets `app.workspace_id` and `app.user_id` with `set_config(..., true)`.
- Platform credentials live in `integration_accounts`, linked to one workspace, encrypted with envelope encryption (per-record data key, key-encryption key from environment first, KMS later).
- Jobs carry `workspace_id` and re-establish context before touching data. A Testcontainers suite attempts cross-tenant reads and writes on every table and must fail them all.

## 5. Platform integration layer

```
CRM Core (inbox, contacts, leads)
   |  normalized types: ChannelIdentity, InboundEvent, OutboundMessage, Capabilities
Integration Layer (registry, health, webhook router, send pipeline)
   |
Adapters: meta (messenger, instagram, leadgen) | mock | tiktok | whatsapp | linkedin (stubs, gated)
```

Each adapter declares per-account capabilities (inbound DM, outbound DM, comments, lead forms, templates, read receipts, attachments, window rules) and implements `verifyWebhook`, `parseWebhook` (to normalized events), `send`, `checkSendability`, `refreshCredentials`, `healthCheck`. The sketch of the TypeScript interface is in `docs/research/future-integrations.md`. The core asks `checkSendability` before enabling the composer, so the 24-hour window and similar rules surface in the UI instead of failing at send time.

Webhook path: raw body captured, signature verified (`X-Hub-Signature-256`, constant-time compare), event persisted to `webhook_events` with a unique delivery key, HTTP 200 returned, job enqueued. Processing is idempotent and tolerant of duplicates and out-of-order delivery. A mock adapter replays signed fixtures that match official payload shapes, so the whole pipeline is testable without Meta access.

## 6. Realtime
Domain changes write a row to `domain_events` (per-workspace gapless `seq`, see Amendment A4 below; `workspace_id`, type, entity, payload) in the same transaction as the change. The API exposes an SSE stream per workspace with `Last-Event-ID` resume. If the cursor is too old, the server sends `resync` and clients refetch. Postgres `LISTEN/NOTIFY` only wakes the streaming code. Clients apply events with an idempotent reducer keyed by event id, so duplicates and reordering are harmless. WebSocket is deferred; it is justified only if bidirectional low-latency needs appear (for example typing indicators).

## 7. Notifications
Push goes through a provider interface (Expo Push first). Device tokens are stored per device session and workspace, revoked on logout. Payloads default to content-free text ("New message") with a deep link; users may opt in to previews. Delivery attempts and receipts are logged; a dedupe key per (event, device) prevents repeats.

## 8. Authentication
Better Auth on the API: cookie sessions for web, bearer tokens for mobile stored with `expo-secure-store`, device-aware multi-session, rotating refresh. Authorization is role-based per workspace and checked in the service layer and again by RLS. Meta tokens are never returned by any endpoint.

## 9. Automation and AI
See `docs/architecture/ai-automation-architecture.md`.

## 10. CAPI
See `docs/architecture/capi-architecture.md`.

## 11. Observability and operations
Structured JSON logs with request and workspace ids and redaction of tokens and message bodies; job metrics (queue depth, failures, latency); a dead-letter view in the UI; health endpoints; config validated at boot with Zod. Environments: local (Docker Postgres, mock adapter), staging, production. Hosting is deferred to approval (web on Vercel or Cloudflare; API and worker as containers; managed Postgres; EAS for mobile builds).

## 12. Key trade-offs
- Separate API vs Next-only: costs one more deployable, buys a stable versioned contract for mobile and a cleaner worker boundary.
- Postgres-backed queue vs Redis: fewer moving parts for one developer and transactional enqueue with the outbox; revisit if throughput outgrows it.
- SSE vs WebSocket: simpler, proxy friendly, enough for server-to-client events; client actions use normal HTTP.
- RLS plus app checks: defense in depth against the most damaging class of SaaS bug.

## 13. Amendments after independent review and feature audit (2026-11-13)

These amendments supersede conflicting text above. Sources: `docs/project/phase0-review.md` (B = blocker, M = major, m = minor) and `docs/project/feature-completeness-audit.md` (A = amendment).

**A4 / B1 Event ordering.** `domain_events` gets a per-workspace gapless `seq`. A row `workspace_event_counters(workspace_id, last_seq)` is incremented with `UPDATE ... RETURNING` inside the same transaction as the change. The row lock is held until commit, so `seq` order equals commit order within a workspace, and a client resuming from `seq = n` can never skip an event. Cost: writes to one workspace serialize briefly, which is acceptable at this scale. A test commits concurrent transactions and asserts no gaps from the reader's view.

**B2 Relay and consumers.** `domain_events` is the durable log. Each consumer (SSE, automation, CAPI mapping, push, notification centre) has an offset row `event_consumers(consumer, workspace_id, last_seq)`. A dispatcher job reads events after the offset and enqueues pg-boss jobs with a `singletonKey = consumer:workspace:seq`, then advances the offset. Pruning removes only events older than the retention window AND below every consumer's offset. SSE clients behind the retention window get `resync`. Whether pg-boss can enqueue inside the caller's transaction is verified in the Phase 1 spike; if not, the dispatcher is the only enqueuer, which already satisfies the design.

**B3 Outbound send safety.** Meta's Send API has no idempotency key (per review; confirm in citation check). Message states: `queued` → `sending` (persisted before the HTTP call) → `sent` | `failed` | `unknown`. A crash or timeout after the call leaves `unknown`, never an automatic retry. Reconciliation: the echo webhook or a conversation fetch matches by returned message id, otherwise by recipient, text and time window; if still unmatched the UI shows "Delivery unconfirmed" with an explicit Resend. Inbound upserts on the platform message id, so an echo that arrives before our API response is stored merges into the same row.

**B4 Database roles and RLS exceptions.** Three roles: `crm_app` (request path; RLS applies; no BYPASSRLS), `crm_worker` (jobs; RLS applies; sets workspace context from the job payload and asserts the loaded rows belong to it), `crm_migrator` (DDL only). The unavoidable cross-tenant lookups are a short list of named `SECURITY DEFINER` functions owned by a separate role with fixed `search_path`: `resolve_integration_for_webhook(platform, external_id)`, `list_workspaces_with_due_work(job_kind)`, and `membership_lookup(user_id)`. Each is tested and listed in the security review. pg-boss tables live in their own schema owned by `crm_worker`; the dead-letter UI reads through a function that filters by `workspace_id` stored in the job data.

**M5 Per-conversation ordering.** Message processing takes `pg_advisory_xact_lock(hashtextextended(conversation_id::text, 0))` and orders by platform timestamp, not arrival. Out-of-order arrivals are inserted in position.

**M6 Webhook handling.** Raw body bytes are verified before JSON parsing, using the exact bytes received (Meta signs an escaped-unicode form of the payload, so never re-serialize or decode before hashing). Respond 200 within 2 s after persistence. Dedupe by `delivery_key = sha256(raw body)` plus the unique platform message id. Support two app secrets during rotation. Messenger and Instagram webhooks alert after 15 minutes of failures and auto-unsubscribe after 1 hour (the 36-hour retry window applies only to generic Graph webhooks), so the health monitor must detect subscription loss and resubscribe. Unknown page ids return 200 and are dropped with a counter. Payload size limit and per-source rate limit apply.

**M7 Key handling.** The KEK has a documented backup separate from the database; losing it makes every stored token unrecoverable, so a restore drill covers key plus data. Rotation procedure: re-wrap data keys with a new KEK version (`key_version` column exists). Token refresh jobs and a reconnect prompt cover expiry.

**M12 Idempotency.** One `idempotency_keys` table (workspace_id, scope, key, request_hash, response_ref, created_at, expires_at) backs API `Idempotency-Key`, `client_nonce` sends and job step keys. Retention 48 hours.

**M17 Workflow safety.** A per-run step cap, a per-workflow runs-per-hour cap, loop detection (a workflow cannot be re-triggered by its own action on the same entity within 60 seconds), and "disable cancels waiting runs and rejects pending approvals" semantics.

**M18 AI safety.** AI is off by default per workspace and per provider. Customer text is untrusted input: tools run under the same RLS context and are scoped to the current conversation; suggested replies are sanitized (no links or markup unless the user adds them). Budgets use reserve-then-settle in one transaction, with a parallel-call hard-stop test. Meta platform-terms limits on sending message content to third-party AI providers are unverified and recorded in known-limitations.

**M19 Push.** Allowed push data fields: notification type, entity id, workspace id. Notification taps re-authorise (user may have been removed or logged out). Opt-in previews carry a warning. Tokens are bound to a device session and deleted on logout.

**M3 / M4 / A3 Mail and storage.** Interfaces `Mailer` and `BlobStore` with local implementations (a dev mailbox and local MinIO, both added in Phase 1) and production providers chosen at deployment. Attachment ingest is a job: fetch the Meta media URL promptly, enforce size and type limits, store, link to the message.

**M1 Cross-host auth.** Web and API are served from sibling subdomains of one site. Cookies are `Secure`, `HttpOnly`, `SameSite=Lax`; mutating requests need an `Origin` check and a custom header; CORS uses an allowlist. Mobile SSE uses a fetch-stream client that can send `Authorization`, because `EventSource` cannot set headers and is not available in React Native.

**m7 Three logs, three purposes.** `domain_events`: replayable technical log for sync and consumers, short retention. `activities`: user-visible CRM timeline, kept with the entity. `audit_log`: append-only security and admin trail (REVOKE UPDATE/DELETE for application roles, includes request id and session id).

**Naming (m1).** Package `design-tokens`; table `memberships`.

**A1/A2/A5.** One lead entity with `pipelines.kind`; generic `conversion_*` tables with `destination_kind`; `conversations.kind` and `messages.kind` for comments and internal notes. Details in `database-design.md`.

**Inbox attachments (decisions D130 to D139).** One storage port, two providers: `BlobStore` (local disk for development and tests, S3-compatible for hosted) chosen by `STORAGE_DRIVER`; business code only sees `attachmentKey(workspaceId, attachmentId)`. The `attachments` table holds metadata; the bytes are never in PostgreSQL. Flow: the webhook worker records `pending` rows with the provider reference, the download step fetches outside any transaction through the SSRF guard, validates by magic bytes and writes the blob; users, agent tools and workflows then read it through the API (conversation scoped, RLS) and may explicitly run describe, OCR, transcription or add it to the knowledge base by reference. Hosted free tier: Render has no persistent disk and Neon holds no blobs, so a bucket is required (docs/deploy/free-tier.md).
