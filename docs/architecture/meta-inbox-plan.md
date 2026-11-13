# Meta Inbox: implementation plan (architecture and critical decisions)

Date: 2026-11-13. Status: **design only. No code, schema or contract has been written for the inbox.** Nothing in this document has been verified against real Meta traffic. Platform facts come from `docs/research/meta-api-research.md` and `docs/integrations/meta-dev-mode-readiness.md` (which tags each claim verified, research or unverified); where this plan relies on an unverified fact it says so. Scope is Messenger and Instagram direct messages in owner-only Development mode, behind a mock adapter first. Lead Ads, comments, Conversions API, WhatsApp and TikTok are separate later slices.

## 1. Goals, non-goals, hard requirements
Goals: receive customer messages, show them in a threaded inbox with assignment and read state, send replies, link each conversation to a contact (and optionally a lead), survive duplicate, late and out-of-order deliveries, and never send a message twice by accident.

Non-goals now: comment moderation, broadcast or marketing messages, automation or AI replies (human approval by default, later), media upload beyond receiving attachments as links, multi-page routing rules.

Hard requirements (P0/P1 for this phase):
1. No cross-tenant read or write, including through the webhook path.
2. A webhook is never processed unless its signature verifies over the raw body.
3. Processing is idempotent: delivering the same event any number of times yields one message.
4. A message whose send outcome is unknown is never silently retried and never silently marked failed.
5. Platform tokens never appear in logs, URLs, API responses, error messages or the browser.

## 2. Data model (all tenant tables carry `workspace_id`, forced RLS, composite FKs, D45 scalar-subquery policies, tenancy CI test)
- `integration_accounts`: `id`, `workspace_id`, `platform` (`messenger` | `instagram`), `external_account_id` (Page ID or Instagram professional account ID), `display_name`, `status` (`connected` | `reauth_required` | `disabled`), `scopes text[]`, `token_expires_at` (nullable), `last_token_check_at`, `connected_by`, `connected_at`, `version`. **Globally unique `(platform, external_account_id)`**: one Page can be connected to one workspace only (decision D-F), otherwise an inbound event cannot be routed safely.
- `integration_secrets`: `integration_account_id`, `workspace_id`, `ciphertext`, `nonce`, `key_id`, `created_at`. Access token stored with AES-256-GCM (key id supports rotation). The app role has **no SELECT** on this table; only the worker role does, through a function that returns the decrypted token to the sending code and nothing else. Never joined into any API response.
- `platform_identities`: `workspace_id`, `integration_account_id`, `external_user_id` (page-scoped PSID or IGSID), `contact_id`, `profile_name`, `profile_fetched_at`. Unique `(integration_account_id, external_user_id)`. A new inbound identity creates a contact with source `messenger` or `instagram` only when no identity exists (never merges by name).
- `conversations`: `id`, `workspace_id`, `integration_account_id`, `contact_id`, `identity_id`, `status` (`open` | `pending` | `resolved`), `assignee_user_id`, `last_message_at`, `last_inbound_at` (drives the 24 hour window), `unread_count`, `lead_id` (nullable), `version`. Unique `(integration_account_id, identity_id)`.
- `messages`: `id` (uuidv7), `workspace_id`, `conversation_id`, `direction` (`in` | `out`), `external_id` (Meta `mid`, nullable until sent), `client_msg_id` (uuid, outbound idempotency key), `sender_user_id`, `body`, `attachments jsonb` (type and URL only), `delivery_state` (`received` | `pending` | `sending` | `sent` | `failed` | `unknown`), `failure_code`, `sent_at`, `created_at`. Unique `(integration_account_id, external_id)` where not null; unique `(workspace_id, client_msg_id)`. Append-only except `delivery_state` transitions (guarded by a trigger that enforces the allowed state graph in section 5).
- `conversation_reads`: `(conversation_id, user_id, last_read_message_id)`.
- `webhook_events` (ingress, **not tenant-scoped on write**): `id`, `platform`, `received_at`, `signature_valid`, `raw_body bytea`, `body_sha256`, `account_ref` (page id from the payload, unverified until routed), `workspace_id` (null until resolved), `status` (`received` | `processed` | `failed` | `orphan` | `rejected`), `attempts`, `last_error` (class only), `processed_at`. Written by a dedicated `crm_ingest` role that has INSERT on this table and a SECURITY DEFINER function to look up the workspace by `(platform, external_account_id)`; it has no access to any other table. The app role can read rows only for its own workspace (RLS on `workspace_id`, null rows invisible). Retention 30 days raw, then payload dropped.
- `outbound_attempts`: `message_id`, `attempt`, `started_at`, `finished_at`, `request_summary` (no token, no full body), `http_status`, `platform_error_code`, `outcome` (`accepted` | `rejected` | `ambiguous`). Append-only.
- `integration_events`: append-only audit of connect, reconnect, disconnect, token check results, status changes (feeds the existing audit log screen).

Tenant isolation for the webhook path is the central risk: the workspace is **never taken from the payload**. It is derived only from `(platform, page id)` through the `integration_accounts` row, after the signature has been verified. Unknown account: the event is stored as `orphan`, answered with 200 (so Meta does not disable the subscription), counted and alerted; it is never routed.

## 3. Webhook ingress
- `GET` handshake: compare `hub.verify_token` to the configured token with a constant-time comparison; echo `hub.challenge` as plain text only on match, otherwise 403.
- `POST`: read the **raw bytes** before any JSON parsing; body limit 1 MB (reject larger with 413, before reading further); compute HMAC-SHA256 with the app secret and compare with `X-Hub-Signature-256` via `timingSafeEqual` over equal-length buffers; missing or malformed header is a rejection. Two secrets are accepted during rotation (current and previous). On failure: 403, store a `rejected` row **without the body** (headers class, size, source IP hash), rate-limit by source.
- On success: insert the raw event durably, enqueue processing in the same transaction (existing outbox and pg-boss pattern), return 200 immediately. No Graph API call and no heavy work inside the request. Target well under one second; Meta retries on non-2xx and its retry window is long enough that a slow handler causes duplicates, which section 4 absorbs.
- The platform app secret is read from configuration and never logged. Mock mode signs fixtures with a test secret and is labelled mock in the UI and in `webhook_events.platform`.

## 4. Idempotency, ordering, replay
- Delivery is at least once and unordered. Meta does not provide a delivery id, so idempotency is **by message identity**: `(integration_account_id, external_id)` for messages and echoes; for read and delivery receipts, `(account, identity, watermark)` which are monotonic and applied with `GREATEST`. Replaying the same raw body any number of times changes nothing.
- Processing a message event is one transaction: lock the conversation with an advisory lock keyed by `(account, identity)` so two events for one thread are serialised; upsert identity then contact then conversation; `INSERT ... ON CONFLICT DO NOTHING` on the message; update `last_inbound_at`, `unread_count` only when the insert actually happened; emit domain events (notification, search index) only on a real insert.
- Out-of-order: ordering inside a thread is by `sent_at` from the platform with `created_at` as tiebreaker; a late older message is inserted in its correct position and does not move `last_message_at` backwards.
- Echoes (`is_echo`) of our own sends reconcile the outbound row by `mid` (section 5); echoes of messages sent by someone else on the Page (for example in the native app) are stored as outbound with sender `external`.
- Replay tool: any `failed` or `orphan` event can be reprocessed from its stored raw body by an admin action, with the same idempotency guarantees. Raw bodies make this possible, hence the retention rule.

## 5. Outbound sending and the unknown state
State graph (enforced by trigger): `pending -> sending -> sent | failed | unknown`; `unknown -> sent | failed` only through reconciliation or an explicit human decision; `failed -> pending` only by an explicit user "Retry" that creates a **new** `client_msg_id`.
1. The composer writes the message `pending` with a client-generated `client_msg_id` (retry of the same HTTP request returns the same row, so a double click or a flaky client cannot create two messages).
2. The worker takes the row with `SELECT ... FOR UPDATE SKIP LOCKED`, sets `sending`, writes an `outbound_attempts` row, then calls the Send API. The Send API has no idempotency key (research doc; to be reconfirmed), so the platform cannot deduplicate for us.
3. Outcome classification, decided before any retry logic exists:
   - **accepted** (2xx with `message_id`): `sent`, store `mid`.
   - **rejected** (a definitive 4xx that is documented as "not delivered", for example window closed, recipient unavailable, permission or token error): `failed` with a user-readable reason. Token errors also flip the account to `reauth_required` (section 6).
   - **ambiguous** (timeout, connection reset after the request was written, 5xx, unparseable response, process crash while `sending`): `unknown`. **Never retried automatically.**
4. Reconciliation of `unknown`: if the echo webhook for our app arrives with a matching text and timing, it supplies the `mid` and the row becomes `sent`. A recovery job inspects rows stuck in `sending` longer than 2 minutes and moves them to `unknown`. After a reconciliation window (default 10 minutes, setting) with no echo, the UI shows "Delivery unknown" with two actions for a human: "Mark as not sent" (allows Retry) and "It was delivered" (closes it). The choice is audited. We accept occasionally asking a human over silently double-sending.
5. Messaging window: a reply is allowed only within 24 hours of `last_inbound_at` (Messenger and Instagram standard messaging). Outside it the composer is disabled with an explanation; the HUMAN_AGENT tag (7 days) is a separate decision (D-C) and off until decided. The check runs server-side at send time, not only in the UI.
6. Permission: `conversation.reply` (owner, admin, agent); viewers read only. Agents may reply on any conversation they can see (matrix unchanged); assignment follows `conversation.assign` (agents only to self).

## 6. Token lifecycle and reconnect
- Connect: OAuth with Facebook Login for Business (or the chosen Instagram path, D-A); the user token is exchanged for a long-lived token, Page tokens are obtained per selected Page, stored encrypted per section 2, and the Page is subscribed to the webhook fields. The user token is discarded after use.
- Page tokens derived from a long-lived user token do not carry a fixed expiry (research doc; **unverified** in the readiness doc) but can be invalidated by password change, permission removal, app removal or role loss. So expiry is not scheduled; **health is checked**: a daily `debug_token` (or equivalent) check, plus immediate reaction to Graph error 190 and its subcodes on any call.
- On invalidation: status `reauth_required`, outbound sends are refused with a clear message, queued `pending` messages stay pending (not failed), an in-app notification goes to workspace owners and admins, an `integration_events` row is written. Inbound webhooks keep being stored.
- Reconnect: the same OAuth flow; if `(platform, external_account_id)` already exists in this workspace the row is **updated in place** (new secret version, status `connected`), preserving conversations, identities and history; if it exists in another workspace the connect is refused with a clear error (D-F). After reconnect, pending messages resume in order.
- Disconnect: unsubscribes the Page, deletes the secret, sets `disabled`; history stays.
- Never logged: tokens, the app secret, raw message bodies (only sizes and ids). Error messages stored in `last_error` and `failure_code` are classes, not payload excerpts.

## 7. Retry strategy
- Inbound processing: up to 6 attempts with exponential backoff (10 s to about 10 min) and jitter; then `failed`, visible to admins, replayable. Poison events (unparseable, schema-violating) fail on the first attempt without retries and keep the raw body.
- Outbound: no automatic retry after an ambiguous result (section 5). Automatic retry exists only for failures that happened **before** the request could have been accepted (for example the token or secret could not be loaded, rate limiter said wait). Platform rate limits (HTTP 429 or the documented error codes for call limits) pause the account's queue using a per-account token bucket with a circuit breaker; messages stay `pending`.
- Graph reads (profile name fetch): best effort, timeout 5 s, failure leaves the contact name as the platform id placeholder and schedules one later retry; never blocks message storage.
- All jobs are idempotent and safe to run twice; every job carries the event or message id as its singleton key.

## 8. Realtime, search, notifications, privacy
- New inbound message, delivery-state change and assignment publish domain events through the existing outbox; the web inbox listens through SSE with resume (Phase 4 design) and falls back to polling. Conversation list is cursor paginated, p95 target under 300 ms at 10,000 conversations (same budget as other lists).
- Search: message body and contact name via the existing provider registry (additive `conversations` provider); results never expose the other tenants' data and respect `requires`.
- Notifications: `conversation.assigned` and optionally `message.received` for the assignee; preferences use the existing mechanism.
- Privacy: message bodies are personal data. Erasure of a contact anonymises identity and bodies in its conversations while keeping counts and delivery metadata (same policy as decision 6 for leads). Retention for message bodies is a workspace setting with a default (D-E). Attachments are stored as platform URLs only in this phase (they expire at the platform); copying them to our blob store is later and needs a malware-scanning decision.

## 9. Critical decisions needing the user before coding
| ID | Decision | Recommended default |
|---|---|---|
| D-A | Instagram path: Instagram Login, Facebook Login, or Unified Login | Facebook Login for Business for both channels (one OAuth flow, one Page token); revisit if Instagram-only accounts must be supported without a Page |
| D-B | Public HTTPS webhook URL for development (tunnel) and for production hosting | Stable dev tunnel domain owned by the user; production host decision stays open and blocks external users |
| D-C | HUMAN_AGENT tag (7-day reply window) | Off until Meta allows it for this app in Dev mode; enable per workspace later |
| D-D | Token encryption key management | Env-provided key with key id now (labelled not production grade); KMS before external users |
| D-E | Message body retention default | Keep until contact erasure; workspace-configurable later |
| D-F | One Page connects to exactly one workspace | Yes (required for safe routing) |
| D-G | Unknown-state window length and wording | 10 minutes, wording as in section 5 |

### 9a. Decisions APPROVED by the user (2026-11-13)
| ID | Approved decision |
|---|---|
| D-A | Facebook Login for Business for Messenger and Instagram. Instagram-only accounts (no Page) are out of scope for now. Current Meta requirements must be verified again before the real OAuth flow is implemented (a first verification pass is in `docs/integrations/meta-api-verification-2026-11.md`). |
| D-B | Stable HTTPS development tunnel. Production hosting deferred. The local API must not be exposed before webhook signature verification exists. The user must confirm the actual tunnel domain before any real Meta webhook test. |
| D-C | HUMAN_AGENT tag disabled by default; enable only after Meta eligibility and permission are verified. |
| D-D | Environment-based encryption key for owner-only development with `key_id` and rotation support, **explicitly NOT production-grade**. The application role has no SELECT on `integration_secrets`. KMS is mandatory before external users. |
| D-E | Message bodies are kept until contact erasure. Raw webhook bodies are deleted after 30 days. Contact erasure implementation is mandatory before external users. |
| D-F | One external Page or account belongs to exactly one workspace; global uniqueness on `(platform, external_account_id)` is a critical tenant-isolation requirement. |
| D-G | Delivery-unknown timeout is 10 minutes, then an explicit human decision ("Mark as not sent" or "It was delivered"); an unknown send is never retried automatically. |
Slice 3 (OAuth) does not start until the actual development tunnel and the required Meta configuration are confirmed.

### 9b. Slice 1 as implemented (migrations 0017 and 0018)
- **Tables:** `integration_accounts`, `integration_secrets`, `platform_identities`, `conversations`, `messages`, `conversation_reads`, `webhook_events`, `outbound_attempts`, `integration_events` (drizzle schema in `packages/db/src/schema/inbox.ts`). All forced RLS, policies written `TO <role>` with D45 scalar subqueries.
- **Roles (new, created by `packages/db/sql/001_roles_and_probe.sql`, which must be re-run as a superuser on an existing database before migrating):** `crm_app` (the API), `crm_ingest` (webhook ingress: INSERT only on `webhook_events`, `workspace_id` must be NULL, no read-back, column-limited SELECT on `integration_accounts` for routing), `crm_worker` (background processing: scoped by the workspace setting; reads secrets; routes events; the only role that may drive `pending -> sending -> sent | failed | unknown`).
- **Secrets:** `crm_app` has INSERT only (owner/admin); no SELECT, UPDATE or DELETE and `RETURNING` is refused. The ingress role cannot read them. The worker reads them only inside a matching workspace context.
- **Raw bodies:** `crm_app` cannot select the `raw_body` column at all (column grant); `purge_webhook_event_bodies()` nulls bodies older than 30 days, refuses a longer retention, and only the worker may execute it. The scheduler that calls it is Slice 2.
- **Delivery state graph** is enforced by trigger for every role including superusers; `crm_app` may only do `unknown -> sent|failed` and `failed -> pending` (retry with a new client id); `crm_worker` may do the automatic part; nobody can leave `sent`; inbound messages are immutable. One small extension to section 5: `pending -> failed` for a send refused before any request (token or window).
- **Integrity:** composite FKs force identity, conversation and message to the same workspace and account; message content is immutable; messages are never deleted (contact erasure will need a dedicated anonymisation procedure, still to be built, mandatory before external users); `integration_events` is append-only; send attempts finish once; account routing keys are immutable.
- **Known gaps carried to later slices:** `conversations.unread_count` is one number while reads are per user (needs a per-user derivation or a decision); no scheduler for the purge; worker grants on contacts, activities and domain events are not defined yet (Slice 2 processing); the unique-violation on `(platform, external_account_id)` tells a workspace that a Page is connected elsewhere (the API must return a generic error).
- **Meta research impact (see the verification doc, conflicts C1 to C8):** keep raw-bytes signature verification and add a non-ASCII fixture; respond to webhooks within about 5 seconds; add a periodic subscription check; Messenger echoes carry `metadata` so `client_msg_id` can ride in it; Instagram has no `message_echoes`, `message_reads` or `message_deliveries` fields; the Instagram webhooks page says the app must be published to receive webhooks, which may conflict with Development-mode-only testing and must be tested first with the real app.

## 10. Implementation sequence (each slice is web-first, shared contracts, mobile compatible by contract)
0. Decisions D-A to D-G recorded; Meta app and test Page set up by the owner using the readiness checklist.
1. Schema and RLS for integration, conversation and message tables, ingress role and function, state-graph trigger; DB tests for every constraint, role grant, cross-tenant routing and the append-only tables.
2. Webhook ingress and processing against the **mock adapter** with signed fixtures: handshake, signature valid and invalid, size limit, rotation, duplicates, out-of-order, orphan page, replay; contract tests; no real Meta call.
3. Connect and token health (mock first, then the owner's real Page): encrypted secrets, status machine, reconnect, notifications.
4. Inbox web UI: list, thread, composer, assignment, read state, contact context, unknown-state UI.
5. Outbound sender with the state graph, reconciliation job, rate limiting; failure-injection tests (timeout after write, crash while `sending`, 5xx, token invalid, window closed).
6. Real-Meta verification in Development mode with the owner's Page: each claim recorded as an actual request and response (redacted) before it is called verified.
7. Search and notification integration; SSE; performance check; mobile inbox only after the Android runtime is verified (deferred).

Test gates before any claim of working: signed-fixture suite green; duplicate and reordering property test (same event set in random order and with repeats yields identical final state); cross-tenant test where a payload names another workspace's page; failure-injection suite for outbound; secret-leak test (grep logs and responses for the token and app secret in the test run).

## 11. Verification status
- Nothing in this plan is implemented or verified.
- Unverified platform facts that must be confirmed against the owner's real app before slice 6: Page token invalidation causes and error subcodes, Instagram messaging prerequisites and settings path, Send API idempotency behaviour, 24 hour and HUMAN_AGENT windows, current Graph API version to pin, whether Development mode needs App Review for the permissions used.
