# Known Limitations and Unverified Items

Updated: 2026-11-13 (Phase 0).

## Research evidence quality
- The research agents summarised pages through a fetch tool; exact wording may differ from the source. Citation spot-checks are still pending.
- UI/UX research: Apple HIG and Material 3 pages did not render, so every iOS and Material guideline (touch target sizes, tab bars, safe areas) is unverified. Mobile app pattern claims are from general knowledge. Notion has no source. To do before design sign-off.
- Competitor research: Manychat official pages returned HTTP 403 (prices from third parties); HubSpot Professional and Enterprise prices unverified; Google Play ratings not retrieved; dashboard, contact management and onboarding sections lack sources for several products. Differentiation ideas are inferences, not demand evidence.
- Meta messaging research: message-tags page, Send API reference, messages webhook page unreadable; exact `HUMAN_AGENT` tag string, Messenger delivery/read/echo payload schemas, system-user token lifetime, app-role and App Review docs unverified. Privacy-policy and deletion-callback requirement confirmed only by secondary sources. Sole-proprietor Business Verification eligibility unknown. Graph API version in the Send API sample (v27.0) differs from the versions table (v26.0 newest); make version configurable.
- CAPI research: opt_out semantics, full messaging_channel enum, GDPR consent fields, sensitive-category policy, madid hashing, token expiry, per-event required params, and error-code table unverified. Business messaging events appear aimed at Business Messaging Partners.
- Future integrations: TikTok DM API gating and limits come from third-party sources; LinkedIn messaging access unverified; several official pages empty. WhatsApp pricing changes frequently and must not be hard-coded.
- Technology research: versions were checked against registries, but trade-off reasoning relies on established knowledge, not fresh vendor documentation; hosting prices unverified; Lucia deprecation status not re-verified; Java 25 compatibility with the Android toolchain unknown.

## Environment
- No Android SDK or emulator installed. No macOS, so iOS can be built only through EAS cloud and tested only on a real device or cloud service with an Apple account. iOS testing cannot be claimed otherwise.
- No Meta developer app, Dataset, Apple or Google developer accounts exist yet.

## Product
- Live Meta use for third-party accounts requires Business Verification and App Review (external). MVP proves flows on the owner's own accounts and a mock adapter.

## Added 2026-11-13 (review and audit)
- Meta platform terms on sending DM content to third-party AI providers are unverified.
- Whether pg-boss can enqueue inside the application transaction is unverified; design does not depend on it (dispatcher fallback).
- Better Auth refresh-token behavior for mobile is unverified; Phase 1 spike must record it.
- Meta Send API lacks an idempotency key per the review; the citation check result decides whether this is confirmed.
- Story interactions and private replies are planned R2 and depend on permissions not yet confirmed.
- No calendar estimates exist until the Phase 1 spike measures velocity.

## Citation spot-check results (2026-11-13)
42 claims checked: 35 confirmed, 4 contradicted (corrected by errata in the research files), 3 unverifiable (`HUMAN_AGENT` casing and Send API tag list, OTN beta label, CAPI retry and timeout numbers). Not checked: Business Verification document lists, CAPI error-code table, the `feed` webhook payload field names, and whether the Send API has an idempotency key (decision D26 still rests on the review's claim). Instagram comments and story-mention permissions are now known (see Meta errata) but not exercised.

## Added after the Phase 1 web shell (2026-11-13)
- Tests share the single local development database. Test data is run-unique and accumulates (the audit log is append-only and cannot be cleaned by the app role). A separate test database is needed before CI.
- No hosted CI; "from a clean checkout" was run locally. The e2e suite builds and starts both servers itself on ports 3217 and 8791.
- Forgot-password is not available (needs a provider for the Mailer, D22).
- Invitations are not built; tests add members by direct SQL. The Members page cannot add anyone yet.
- No before/after values in audit entries.
- Dark theme tokens exist and pass contrast tests but no UI toggle exists and it has not been visually checked.
- `@crm/contracts` is shared Zod; no OpenAPI document or generated client exists yet (Phase 1 item 5).
- The web app uses a same-origin proxy (`/api/auth`, `/v1`) so cookies stay first-party. In production the web host must proxy to the API (or serve both under one site); this is not deployed or tested outside local.
- `minimumReleaseAgeExclude` entries that pnpm added for fresh package versions weaken release-age protection for those packages; review as they age.
- Typography: Inter is self-hosted via `@fontsource-variable/inter`; no fallback metrics tuning (possible layout shift).

## Added with password reset (2026-11-13)
- No production mail provider (D22). The API refuses to start with `NODE_ENV=production` for that reason. Development and tests use `FileMailer` (JSON files in `MAIL_DIR`, default `.dev-mail/`, gitignored).
- Reset throttling counters live in process memory: one API instance only. Move to a shared store before scaling out.
- Client IP for throttling comes from `x-forwarded-for`; the hosting proxy must set it and strip client-supplied values, otherwise all users share one bucket or attackers can spoof it.
- Timing equality between existing and unknown addresses is by design (mail sending is not awaited) but not measured.
- Password reset emails are plain text only.
- No account lockout or breached-password check on sign-in.
- Web CSP only restricts framing, base URI, form targets and plugins; no `script-src` yet.

## Contacts slice (2026-11-13)
- Independent review of the Contacts slice is outstanding.
- Related conversations and pipeline records are placeholders; tasks are per contact only.
- No duplicate merge; no per-field permissions; no fuzzy search; no restore of deleted contacts.
- `import_jobs.csv` holds raw uploaded text (admin-only) without a retention job.
- A deleted contact keeps its notes, tasks and activity rows (hidden from every read path); erasure workflow is a later item.
- The contact table scrolls sideways inside its own region below about 1280 px; phones use cards.
- Lifecycle stage names are matched case-insensitively on import; unknown stages are row errors, not auto-created.
- Phone matching compares normalized digits as written; numbers without a country prefix match only identical numbers.
- Test data accumulates in the shared development database; the perf test removes its own rows.

## Leads and pipelines (added 2026-11-13)
- **SECURITY-READINESS BLOCKER for external users: deal value is protected by the API only.** `leads.value_minor` and `currency` are ordinary columns; row-level security cannot hide a column, so any client holding the `crm_app` database role can read them for every lead in the workspace. The API masks the value (null plus `valueHidden`) unless the caller is owner/admin or holds a per-lead grant, and tests assert this at the API and in the rendered page. There is no database-level protection. Do not claim it. Fix options: move value to a separate table with its own policy, or expose leads to the app role through a view that nulls the column. Required before any non-owner or external user.
- No board yet (slice 4), no lead tags or custom fields, no task links on leads, no lead search provider or owner notification (slices 5 and 6).
- Android emulator crashes on start on this machine, so no mobile behavior is runtime verified; see `android-verification.md`. The mobile app does not handle a 401 (no `onUnauthorized`).
- Default pipelines are created at workspace creation and on the first admin visit to existing workspaces; before that, non-admins see an empty pipeline list.

## Contact methods and detection (added 2026-11-14, branch feat/smart-messenger-crm, not merged)
- Extraction handles Bangladeshi mobile numbers and explicit international numbers (+CC or 00CC) only. A bare national number from another country is not extracted. Landlines inside Bangladesh without +880 are not extracted.
- Extraction applies to NEW messages only; nothing scans earlier messages.
- There is no workflow to VERIFY a detected method yet (kept out of scope on purpose); detected values stay unverified. Correct and remove are available to owner, admin and agent.
- Detected methods are shown in the Inbox panel and on Contact Details; they are not yet searchable (search and duplicate detection use `contacts.phone/email` only) and not part of CSV export.
- `contacts.phone/email` filled automatically from a conversation cannot be told apart from an entered value later except through `contact_methods.is_primary` and its source.
- Messenger profile enrichment (name, picture) needs Advanced Access to the "Business Asset User Profile Access" feature per Meta docs; it worked for the connected test Page in development mode only. Other people's Pages are UNVERIFIED until App Review. Picture URLs expire (refreshed at most weekly for active people).
- Test suite: `apps/api` test files share one database and run in parallel; several (inbox ingress, profile, contact methods, meta-connect due-token job) drain global queues, so run the suite on a fresh isolated database (`scripts/db-create.sh`) and re-run a failing file alone before suspecting the code. `packages/db` rls-matrix and crm-rls can fail at start with a duplicate `user_email_unique` when both files start in the same millisecond (pre-existing).
- Customer data retention: the Meta data-deletion callback disconnects accounts and erases tokens and the Meta user link, but it does not purge contacts, messages or detected methods. A retention and customer-data deletion policy is still to be decided.
- The same number or email detected for two different contacts is stored on both (duplicate detection across contacts is the next planned slice); nothing is merged automatically.

## Outbound Messenger replies (2026-11-14)
- NEVER tested against real Meta from this code. Automated tests use a mock Graph and a fake `fetch`. The first real send is the hosted manual test (steps in `docs/integrations/meta-real-test-runbook.md`, section "Outbound reply").
- Text only. No attachments, stickers, quick replies or message tags. Instagram replies are refused (422), not attempted.
- Replies outside 24 hours are refused; the HUMAN_AGENT 7-day tag is not used (decision pending).
- The 2000-character cap is ours; Meta's own text limit is not stated on the pages we could read. Meta error codes beyond 10, 100, 190, 551, 613 and 1545041 are mapped from the existing classifier and are unverified for the Send API; the exact error for "outside the window" is not documented in the pages read, so it surfaces as a generic `meta_error_<code>` failure if our own check ever lets one through.
- Echo matching is by conversation + exact text + 30-minute recency (Meta gives no way to tie an echo to our request). Two identical texts sent within seconds could swap their Meta ids; both stay `sent`.
- If an echo is stored as an "external" copy before our row can adopt the id (text normalised by Meta), the thread shows the message twice. Not observed; no test can prove Meta never rewrites text.
- `recoverStuckSends` walks the workspaces of non-disabled Messenger accounts every minute (worker role cannot see messages across workspaces). Fine for tens of workspaces.
- A rejected token (190) marks the message failed but does not move the account to `reauth_required` by itself; the 6-hourly token check does.
- The "It was delivered / not delivered" buttons appear 10 minutes after the original send time (client clock vs `occurredAt`); the server enforces the real 10 minutes from the state change.
- Existing Playwright test "composer stays disabled" was removed (behaviour changed); no new Playwright coverage by request.

## Instagram messaging (2026-11-14)
- NEVER tested against real Meta. Mock Graph and fake fetch only. C8 (Instagram webhooks reach us, and in which mode/URL) remains UNVERIFIED. See `docs/integrations/instagram-messaging.md` for what is verified from the docs and what is not.
- Instagram webhook subscription is a manual dashboard step; the CRM cannot confirm it. "Re-check subscription" says so.
- Text only. No attachments, reactions, story replies, or Human Agent tag. Incoming media we cannot read arrives as an "unsupported" placeholder.
- 1000-byte limit is the stricter reading of contradictory wording in Meta's page (characters vs bytes); long Bengali replies are limited to 333 letters.
- Read receipts: `messaging_seen` is treated as "read up to the event time" (payload has only `read.mid`). Delivery receipts do not exist for Instagram in the pages read.
- Instagram profile enrichment needs the person's consent (they must have messaged us) and `instagram_basic`; without it the placeholder name stays.
- Account display name is `@username` captured at connect time; it does not refresh until reconnect.
- An Instagram-only connection (without the Messenger inbox of the same Page) is not offered; connecting the Page always connects Messenger.

## Direct Instagram connection, Unified Login (2026-11-14)
- NEVER run against real Meta (mocks and fake fetch only). Unknowns are listed in `docs/integrations/instagram-messaging.md`, Method C.
- Receiving DMs while the app is in Development mode may not work (Meta says the app must be Live to receive notifications for app users); sending is unaffected.
- No automatic refresh of system-user tokens; if the configuration makes them expire, the account needs a reconnect.
- Webhook field names and the message body for this variant are partly inferred from Meta's migration guide.
- Display name (`@username`) is captured at connect time; no account type is shown.
- The earlier branch `feat/instagram-login` (Instagram Login with a separate Instagram app) cannot work on this app and must not be merged.
- Unified Login DM webhook shape (`messaging[]` vs `changes[]`), the send URL/auth for this variant, and `debug_token` expiry for system-user tokens are inferred, not stated by Meta's pages (see the verification pass in `docs/integrations/instagram-messaging.md`).
- Only the first 25 shared accounts are read and at most 10 are connected per login; the result says "some skipped".
- A token that is still valid but whose Instagram account was removed from the business portfolio is not detected by Check token; sends then fail with a channel-access error until reconnected.
- Instagram echo dedupe (2026-11-15): the id Meta returns from the Instagram send call differs from the id on the echo webhook (seen on a real Unified Login account), so an echo is matched to our own reply by text: within 10 minutes, an echo is dropped while we have recorded more CRM replies with that exact text than stored echoes. A message typed in the Instagram app with the same text as a CRM reply inside that window is therefore not shown separately. Messenger matches by id and is unchanged. One duplicate "Sent from another app" bubble created before this fix stays in the hosted data.
- Inbox redesign (2026-11-14): tab counts exist only for Unread (the API returns no other totals); no internal notes, saved replies, tasks panel or "also on Instagram" link (no API yet); the stage control uses the contact's newest open lead, so a contact with several open leads shows only one; undoing a move out of Won or Lost needs the reopen permission and shows the server's error otherwise. Not checked on a real phone, only at 375 px in Chromium.

## WhatsApp, slice 1: webhook foundation (2026-11-14, branch feat/whatsapp-foundation)
- NEVER run against real WhatsApp (fixtures built from Meta's documented field lists only). Details and the verified/inferred split: `docs/integrations/whatsapp-cloud-api.md`.
- A WhatsApp number cannot be connected from the UI yet, and replies are refused (`422 unsupported_channel`; the Inbox shows a notice). Incoming events for a number nobody connected are kept as orphans.
- Senders that have only a business-scoped user id (username users without a visible phone number) are not turned into conversations (`bsuid_only`).
- Media is shown as "Attachment, not available" (id kept, no download); locations are placeholders; reactions and system notices are ignored; `sent`/`failed`/`played` statuses are ignored.
- The contact name stays `WhatsApp user NNNN`; the WhatsApp profile name is not used yet.
- Whether Meta delivers WhatsApp events to a separate callback URL and the exact payload of real messages are unverified.

## WhatsApp, slice 2: manual connection (2026-11-16, branch feat/whatsapp-connect)
- NEVER run against real Meta: the connect flow is tested with the mock Graph only. `GET /{waba-id}/phone_numbers`, plain `POST /{waba-id}/subscribed_apps` (Meta's Graph reference page calls POST/DELETE "not supported" while the webhook override page uses it) and `debug_token` for system user tokens are unverified until a recorded real request.
- Replying is still refused (`422 unsupported_channel`); media download, templates, profile names are not built.
- The callback URL and the `messages` field must still be set once in the Meta app dashboard; nothing here changes Meta settings.
- A disconnected number stays reserved for its workspace (409 elsewhere); there is no release path yet. A number moved to another WABA cannot be re-connected (`waba_mismatch`).
- Token expiry options of system user tokens are not documented; an expired token shows as "Reconnect needed" after the daily token check. The connect and lookup routes are rate limited in process only (per API instance; a shared store is needed before running more than one instance).
- Number release: a disconnected number is reserved to its old workspace and WABA. Safe release needs an ops script run as the DB owner (delete side row, secrets and account of a `disabled` account with no conversations); in-app release would need a DELETE grant and a migration. Not built.
- `/numbers` marks a number held by another workspace "unavailable" (advisory; `/connect` stays authoritative, 409). The UI does not show the WABA id of a connected number.

## WhatsApp, slice 3: outbound text (2026-11-16, branch feat/whatsapp-send)
- NEVER run against real Meta: the send request and the `messages[0].id` response are UNVERIFIED (mock and fake-fetch tests only).
- Text only, inside the 24 h window. No templates, media, buttons or reactions; after 24 h the composer is disabled until the customer writes again.
- WhatsApp `sent` and `failed` statuses are not applied to the message (only `delivered`/`read` watermarks). A `failed` status after an accepted send is therefore not shown; WhatsApp-specific error codes (131xxx) are not mapped and show a generic failure line.
- `window_closed` is 422 for WhatsApp but 409 for Messenger/Instagram (kept for existing clients).
## Automation foundation, slice 1 (2026-11-16, branch feat/automation-foundation)
- Triggers: `contact.created`, `lead.stage_changed`, `contact.owner_assigned`, `lead.owner_assigned`. No `message.received`, schedule or follow-up-due trigger yet. Actions: `create_task`, `add_tag`, `assign_owner` only (lead triggers act on the lead's primary contact). No send-message, no AI, no delays.
- Linear rules only (no branches); the builder edits one flat all/any condition list (a stored nested tree is kept read-only). Condition values are strings in the UI; ids are typed by hand (stage, pipeline ids), no pickers yet.
- Executor runs inside the API process after each dispatcher pass (same single-instance assumption as D7/D71), not in a worker. A run that crashes mid-transaction stays `pending` and is retried; actions are atomic with their step log, so no duplicate effects.
- A permanently failing event is not a problem for the dispatcher (runs absorb failures), but a rule author who lost workspace membership makes auto-run executions fail after 3 attempts (RLS denies).
- Rule edits do not affect already created runs (snapshot); approval requests do not expire and there is no per-user "named approver" or mobile approval UI yet. Web only.
- The Settings > Automations page polls every 10 s; Playwright E2E for it was not run in this slice.
## Meta Conversions API, slice 1 (2026-11-16, branch feat/capi-foundation)
- MOCK ONLY. Nothing is sent to Meta, no real Test Events delivery has been recorded, so no claim of live operation. "Accepted" in the UI means the mock accepted it.
- One hook (lead Won becomes Purchase; needs a lead value; 2-decimal currencies assumed except common zero-decimal ones, 3-decimal currencies such as KWD would be 10x off). Lead, Schedule, form leads, appointments are not wired. No per-workspace mapping or field allowlist; no LDU/region rules; no sensitive-category denylist.
- Ad measurement consent can be recorded on the web contact page (owner, admin, agent) but there is no mobile control yet. Consent granted after a skip does not replay the event. The history shows the last 20 records.
- One event per request (no batching or bisection), no manual retry or dead-letter view, no `needs_reauth` flip on an auth error (the event fails with `auth`), no test-event send button. The token is not validated against Meta on connect (mock).
- Contact deletion (soft delete) cancels pending CAPI events and purges payloads, but a row the worker had already claimed and is sending at that instant may still go out once. A future hard delete or anonymisation job must keep the contact row (tombstone) because `consent_records` and `capi_events` reference it (NO ACTION FK, append-only consent).
- The worker is an in-process 15 s loop on the single API instance (same shortcut as the inbox worker); dataset create rate limit is in process.
- Hash vectors: the em, ph, fn (Mary) and non-ASCII fn (Valéry, 정) vectors match Meta's published examples (checked against the live customer information parameters page on 2026-11-16); ln, ct, st, zp, country and external_id are our own shasum values over the normalised string, not Meta-published.
- Hash vectors: only the email vector is Meta's published one (recalled, re-check on the live page); the rest were computed from the normalisation rules read on 2026-11-13. Phone numbers without a country code are dropped (not guessed).
- Mobile approvals (`apps/mobile`) are not device-verified: typechecked, linted and unit tested only; never run on Android or iOS (Android login is itself still deferred). Metro resolution of `@crm/core/approvals` and `@crm/design-tokens` is untested. The mobile app has no router yet (state-based screens), reject has no reason (API has none), kill switch is read-only on mobile, and the list shows the first 50 runs without paging.
- AI foundation (Phase 6 slice 1): the Anthropic and OpenAI-compatible adapters have NEVER been run against a live service (fake fetch only); model prices in the catalog are indicative and unchecked; only reply suggestion exists (no summaries, lead classification, AI workflow step, mobile surfaces, evaluation fixtures, secondary-model fallback). Real provider status stays "unverified" until a recorded real request.
- AI budget: in-flight calls can overshoot the cap slightly; rate limits and the suggestion limiter are in process (single API instance); the base-URL check does not stop DNS rebinding (D96); provider keys use the development SecretBox (same release gate as other secrets: KMS and rotation before external users). Retention: `ai_runs` has no purge job yet (it holds no text, only counts).
- AI settings UI: workspace model price overrides and custom model ids exist in the API but have no UI yet; the AI page and the composer button are web only.
