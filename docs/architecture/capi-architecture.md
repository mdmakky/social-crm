# Meta Conversions API (CAPI) Architecture

Version 0.1 (Phase 0). Facts come from `docs/research/meta-capi-research.md` (official docs read 2026-11-13). Items marked unverified there must be confirmed before implementation. CAPI is a separate integration from Messenger, Instagram messaging, Lead Ads and the Marketing API; it shares only the workspace and the adapter conventions.

## Implementation status (slice 1, 2026-11-16, branch `feat/capi-foundation`): MOCK ONLY, not live
Built and tested on mock: `packages/capi` (event schema, normalisation and SHA-256 with vectors, deterministic `event_id`, consent gate, backoff, mock adapter, real adapter built but NOT wired), migration 0028 (`capi_datasets`, `capi_dataset_secrets`, `consent_records`, `capi_events`; forced RLS, guards), API (`/capi/datasets`, `/capi/events`, `/contacts/:id/ad-consent`), queue worker, Integrations page panel.
Differences from this design, on purpose: the outbox is `capi_events` itself (no separate `capi_delivery_attempts`: attempts, last error code and `fbtrace_id` live on the row); mappings shipped in migration 0034 (`capi_event_mappings`, section 2; no `require_consent` or field allowlist per mapping yet, consent is always required); one event per send (no batching or bisection yet); no pg-boss (in-process loop, `FOR UPDATE SKIP LOCKED` claim with a lease); no LDU, field allowlist, `test_event_code` send button or dead-letter retry; contact deletion cleanup shipped in 0029 (pending cancelled, payloads purged to {}, see D83 to D85). Live status needs a recorded real Test Events delivery (section 10): none exists.

## 1. Flow

```
CRM business event (domain_events)
  -> Event mapping (per workspace; opt-in per event)
  -> Validation (schema, event_time within 7 days, required fields)
  -> Consent and eligibility gate (consent_records, field allowlist, LDU/region rules)
  -> Enqueue: capi_events row (status pending, stable event_id) via transactional outbox
  -> pg-boss job: CAPI adapter builds user_data (normalize + SHA-256), batches up to 1000
  -> POST /{dataset_id}/events  (real adapter) or mock adapter
  -> Result recorded in capi_delivery_attempts; capi_events status updated
```

CRM operations never wait for Meta. The CRM transaction only writes the outbox row.

## 2. Event mapping (configurable per workspace)

A mapping is one rule on a dataset: when a trigger happens, send an event. Table `capi_event_mappings` (workspace_id, dataset_id, trigger_type, stage_id, event_name, value_mode, fixed_value_minor, currency, enabled), at most 50 per dataset, unique on (dataset, trigger, stage, event). Nothing about any industry is in code.

- Triggers: `lead_created`; `lead_stage_entered` (stage required, composite FK to `pipeline_stages`); `lead_won` and `lead_lost` (transition INTO the outcome, not repeated while the lead stays in it).
- Event name: a Meta standard name (`META_STANDARD_EVENTS`, from the Pixel reference in the research doc) or a custom name `^[A-Za-z][A-Za-z0-9_]{0,39}$`. A custom event only helps once it exists in Events Manager (the UI says so).
- Value: `lead_value` (lead value and currency), `fixed` (amount and currency on the rule), `none`. Only a Purchase needs a value; without one it is recorded as `skipped` / `no_value`. A Purchase rule cannot be `none`.
- Default rule for every dataset (seeded, editable, deletable): lead won -> Purchase, lead value. Enabled when the dataset opted in to Purchase.
- Hook: `captureLeadTransition(tx, ...)` at lead creation and every stage move. It selects enabled mappings of ACTIVE datasets whose trigger the transition satisfies, then writes one outbox row per mapping through `enqueueCapiEvent` (consent gate, stable event id). Savepoint per mapping: a CAPI failure never blocks the CRM write. Archiving a stage (bulk housekeeping move) fires nothing.
- Stage map and asking for a value (D330 to D339, migration 0043): the UI shows one row per moment (lead added, each open stage, "won", "lost"). `ask_for_value` (only with `lead_value`) makes the app ask for the deal value BEFORE a stage change when a firing rule needs one the lead lacks: `GET /contacts/:id/stage-check?stageId=` returns what would fire and whether to ask; `POST /leads/:id/move` and `PUT /contacts/:id/lead` take `valueMinor` + `currency` and write them in the same transaction as the move, so the hook above sees the value. Bulk moves never ask; their events are recorded `skipped` / `no_value` and the response counts them (`noValue`). The capture hook, dedupe keys and `resolveValue` are unchanged.
- Dry run: `POST /capi/mappings/preview` returns, per rule, send or skip and why, for a given lead. Nothing is queued.

Meta event suggestions for common CRM facts (the owner picks; nothing here is forced):

| CRM event | Suggested Meta event | Notes |
|---|---|---|
| Lead created | Lead | Include lead_id when the source is a Meta lead ad (highest priority match, not hashed) |
| Lead qualified (a stage) | custom event or Lead with custom_data.lead_event_source (CRM) | Conversion Leads optimization has volume prerequisites (200+ leads a month per research); verify before promising it |
| Appointment scheduled | Schedule | |
| Purchase completed (won) | Purchase | custom_data.value and ISO 4217 currency required |
| Contact created / message started | Contact | action_source depends on origin; business_messaging is limited to Business Messaging Partners (fit for a direct CRM unverified) |
| Registration / application | CompleteRegistration / SubmitApplication | |

PageView, ViewContent, AddToCart, InitiateCheckout come from the website Pixel. The CRM does not invent them. If a website Pixel sends the same event, deduplication uses a shared `event_id`.

## 3. Event identity and deduplication
- `event_id` is derived deterministically, for example `sha256(workspace_id | dataset_id | crm_event_id | meta_event_name)` encoded as a short string, and stored on the `capi_events` row at creation. Retries always reuse it; a unique index on (workspace_id, dataset_id, event_id) prevents duplicate rows.
- THE RULE: `crm_event_ref` is `lead:<id>:created|won|lost` (once per lead, ever; this is the legacy Purchase key) or `lead:<id>:stage:<stageId>:<n>` for stage entered, n = how many times the lead has entered that stage (from `stage_transitions`, this entry included). A request that changes nothing is not an entry; leaving and re-entering is entry n+1 and may send again. The mapping id is not in the key: the (dataset, trigger, stage, event) tuple is unique, so a deleted and re-created rule must not re-send history. Two rules with different event names on one transition give two events (the event name is in `event_id`).
- A Purchase skipped for `no_value` is stored under its own key (`...:no_value`), so adding the value and winning again still sends the real event.
- Browser and server deduplication needs the same `event_name` and `event_id` within the window Meta documents (48 hours per research). Where a website Pixel is in use, the page must pass its event id to the CRM, for example through a hidden form field, and the CRM reuses it.
- `event_time` is the original business time, not the retry time. Events older than 7 days are marked `skipped` with a reason rather than risking a failed batch.

## 4. user_data and hashing
The CAPI adapter owns normalization and hashing, with unit tests per field based on Meta's rules:
- Hashed with SHA-256 after normalization: em, ph, fn, ln, ge, db, ct, st, zp, country. External id hashing is recommended, not required.
- Never hashed: client_ip_address, client_user_agent, fbc, fbp, lead_id, subscription_id, fb_login_id, ctwa_clid, page-scoped and Instagram-scoped ids.
- fbc and fbp are sent only when they were really captured (fbc format `fb.{subdomain_index}.{creation_time_ms}.{fbclid}`, case-sensitive). The adapter refuses to synthesize them.
- Missing identifiers are omitted, never invented. Payload quality is surfaced as a completeness indicator in the UI, not as a claim about Event Match Quality.
- Exact per-field rules are encoded as test vectors from the research doc during implementation.

## 5. Consent, privacy and minimization
- `consent_records` hold per-contact purpose-based consent (for example `ad_measurement`) with source and evidence. A mapping with `require_consent=true` skips events lacking granted consent and records `skip_reason=no_consent`.
- The field allowlist per mapping limits what leaves the system; defaults send the minimum for a decent match. Sensitive categories are blocked by a configurable denylist and a documented warning (policy text still to be read and cited).
- Data processing options (for example LDU) can be set per workspace for applicable jurisdictions.
- A privacy page documents exactly which fields are sent to Meta (`docs/integrations/capi-setup-guide.md`).
- Deleting a contact removes pending queue entries and redacts stored payloads. Retention trims payload copies after a configured period.
- CRM ownership of a contact does not imply permission to share it. Default for new workspaces: CAPI disabled, every mapping disabled, consent required.

## 6. Delivery, retry and rate handling
- Backoff schedule for transient failures (timeouts, 5xx, rate limits); no retry for validation and auth errors (4xx), which become `failed` with the error captured for inspection.
- Per-dataset concurrency limit and batch size up to 1000. Batching reduces calls but one invalid-old event fails the request, so the validation step removes stale events first.
- After max attempts: `dead`, visible in the dead-letter view with manual retry. A retry never creates a new event_id.
- The `fbtrace_id` and response summary are stored for support.

## 7. Credentials
Dataset access token is stored through the standard credential envelope (AES-256-GCM, per-record data key). It is write-only from the UI: after saving, only the last four characters and status are shown. Tokens never appear in logs, API responses or the mobile app. Token expiry is unverified in research; health checks detect invalid-token errors and flip the dataset to `needs_reauth`.

## 8. UI (web only for management; mobile shows read-only health in Settings)
Connect Dataset (with step-by-step instructions to generate a token in Events Manager), test connection, send test event with `test_event_code`, mapping table with per-event toggle and field allowlist, delivery history with filters, error inspector, retry for eligible failures, health card.

## 9. Analytics wording
The dashboard reports events queued, sent, accepted by Meta, failed and skipped, trends, last success and error groups. A 2xx response means Meta accepted the request. It does not mean attribution or a counted conversion, and the UI says so.

## 10. Mock adapter and live verification
The mock adapter validates payload shape and returns scripted outcomes (success, 4xx, 5xx, timeout) to exercise retry and failure paths. "Live" status requires a real request to Meta's test events mechanism with a screenshot or log of the accepted test event recorded in `docs/testing/capi-test-report.md`. Until then the status is "mock only".

## 11. Tenant isolation
Dataset, mappings, consent, queue and logs are all workspace-scoped with RLS. The worker sets workspace context per job and the adapter is constructed from that workspace's dataset only. A test enqueues events in two workspaces and asserts no cross-use of tokens or identifiers.
