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
- Event rules (D200 to D209) cover lead created, enters a stage, won, lost. Not wired: form leads, appointments, messages, field-level conditions (for example by lead source), a per-rule field allowlist; no LDU/region rules; no sensitive-category denylist. A won or lost event fires once per lead ever (a re-won lead does not send again); archiving a stage fires nothing. 2-decimal currencies assumed except common zero-decimal ones, 3-decimal currencies such as KWD would be 10x off. A custom event name is only useful once it is set up in Meta (not checked here).
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

## AI Studio knowledge base, slice 1 (2026-11-16, branch feat/ai-knowledge-base)
- Search is full-text with the `simple` configuration: no stemming (refund vs refunds), no synonyms, no meaning. Chinese, Japanese and Thai text without spaces is a single token, so substring queries miss. Plain questions work through an any-word retry, which can rank noisily. Embeddings are a later decision.
- Supported files: .txt, .md, .csv, .html, up to 2 MB. PDF, DOCX, images (OCR) and audio return `unsupported_type`; scanned or non-UTF-8 files are rejected (`invalid_encoding`).
- Websites are a single page fetch: no crawling, no JavaScript rendering, no login, no scheduled refresh (re-index is manual). Only text/html, text/plain and text/markdown, 2 MB, 10 s.
- DNS answers are checked and the connection is pinned to the checked address, but an HTTP proxy or a platform egress firewall is not in place; add an egress allowlist at the host for defence in depth.
- Rate limits are in-process (single API instance; move to a shared store before running more than one). Ingestion runs in the request, so a 1 MB source holds a request for about a second.
- A `failed` source keeps its previous passages searchable by design. Failed adds are not stored, so there is no list of past failures.
- The retrieval function exists but no AI agent calls it yet; nothing in the assistant uses the knowledge base.

## AI agent builder, slice 1
- Single-round tool use: tool results (for example `knowledge.search` hits) are shown in the playground, not fed back to the model, so an agent cannot answer from a search it asked for in the same run. Multi-turn loops are not built.
- The JSON protocol depends on the model following instructions. Real providers are UNVERIFIED: how often each real model returns valid JSON is unknown. Invalid output is shown as plain draft text with no actions (flagged "not valid JSON").
- Agents only DRAFT. There is no auto-send, no scheduled agent and no agent-to-customer messaging. The automation `run_ai_agent` action records a note and pending approvals only; it never executes a proposed write. Delays are not available in the automation engine.
- Tools act on one contact (the context contact) and cannot pick another; the inbox "Suggest reply" button has no agent picker yet. `crm.assign_owner` is the only sensitive tool; there is no approval expiry or edit-and-approve.
- Approved actions run as the approver, not the requester. Action arguments (for example a note body) are stored in `ai_agent_actions` so they can be executed; they are model output, not customer transcripts.
- Test/run rate limit (20 per user per minute) is in-process (single API instance). Prompt-injection defence is structural (grants live in the version, customer text is fenced as data, tools are validated), not a guarantee against a model being talked into a harmful but granted action.
- Intermittent test failure (pre-existing, found 2026-11-16): `packages/db` test files such as `rls-matrix.test.ts`, `crm-rls.test.ts` and `tasks-rls.test.ts` insert fixed user emails/ids, so when files run in parallel on one database one of them fails to load with `user_email_unique` (about 1 full run in 4 locally; leftover rows from an aborted run make it persistent). Not caused by AI Studio work. Fix: unique ids per file or per-file schema. Not done.

## AI multimodal, slice 1
- No real provider was contacted: Anthropic vision/PDF and OpenAI-compatible vision/transcription are UNVERIFIED (fake fetch only), and the catalog capability and price flags are from memory. The UI labels them UNVERIFIED. A workspace-added model id is text only (no capability override yet).
- (Superseded by Inbox attachments below, D130 to D139.) No inbox attachment storage: `messages.attachments` holds platform references, nothing downloads or keeps the bytes, so agents cannot reference media by id and the agent tools `media.describe_image` / `media.extract_text` are not built. Media is uploaded per request, held in memory and dropped.
- No streaming, no voice agent, no video, no real-time audio; requests are synchronous in the API process (a 20 MB audio file is a 27 MB JSON body and a long provider call).
- Size caps: image 5 MB (png, jpeg, webp, gif), audio 20 MB (mp3, wav, m4a, ogg, webm), PDF 10 MB. Detection is by magic bytes only: a corrupt but correctly-headed file reaches the provider, and `.m4a` accepts any `ftyp` container.
- Media cost uses provider-reported tokens when present, otherwise rough documented estimates; the per-minute transcription price uses the provider duration or an estimate from file size (128 kbit/s). All UNVERIFIED.
- Rate limit (60 media calls per workspace per minute) is in-process (single API instance). OCR and transcription output is returned and indexed as text and is customer-controlled content: it can contain prompt-injection text; agents treat it as data, not instructions.
- A failed media upload leaves a `failed` knowledge source (code only) that counts toward the 200-source limit until deleted; re-index of such a source reports `empty_content` (delete and upload again).
- The knowledge file route now accepts a 28 MB request body (text formats are still capped at 2 MB after decoding).
- Mobile web (2026-11-16): checked at 360, 375, 390, 430, 820 and 1440 px in Chromium with touch emulation only, never on a real iPhone or Android phone (safe-area insets, the keyboard and `interactive-widget` behave differently there). Pipeline cards still drag with a long press on the handle (its 44px hit area is a pseudo-element); the "Move to" menu is the reliable touch path. Native checkboxes and radios are still drawn at 20px; on touch the 44px label around them is the target (asserted in `mobile.spec.ts`), but a tap that lands on the label's padding outside the box is not tested on a real finger. Contacts and Tasks are cards on a touch tablet (D123); other tables (Leads, Members, Audit log) keep small header and row links there. No swipe gestures on list rows. Pipeline stage chips do not track the visible column. AI Studio, Commerce and the workflow builder are not on this base, so their mobile layouts are not done.
- Emoji (2026-11-17), found in the audit and not changed because they are not Inbox rendering: the workspace switcher initials (`name.slice(0, 2)`) can split an emoji at the start of a workspace name; the live-region announcement of a new message (`body.slice(0, 200)`) can end on half an emoji; the webhook parsers cut text at 20,000 UTF-16 units (`slice(0, 20000)`), which can leave a lone surrogate in a message longer than that, and PostgreSQL rejects a lone surrogate in jsonb, so such a webhook may fail. Not reproduced; unchecked on Windows or Linux emoji fonts (only macOS Chromium was used).

## Inbox attachments (2026-11-17, branch `feat/inbox-attachments`)
- No real storage and no real channel media were contacted: the S3 store is tested against a fake endpoint (UNVERIFIED against R2, S3 and MinIO), the WhatsApp media lookup and media send are mock Graph only (UNVERIFIED), and Messenger/Instagram CDN downloads are tested with a fake fetch. The Meta CDN host allowlist is a guess and fails closed.
- Hosted free tier: Render free has no persistent disk and Neon holds no blobs, so a hosted deployment needs an S3-compatible bucket (for example the Cloudflare R2 free tier, terms UNVERIFIED). Without `STORAGE_DRIVER` received media stays metadata and uploads answer `storage_not_configured`.
- Media received while no storage is configured stays `pending` and is downloaded later only if the provider link is still valid (WhatsApp media ids expire; Messenger/Instagram links are short-lived); otherwise it becomes `failed` (`media_expired`) and can be retried.
- The download worker runs after stored events and on the slow safety-net interval (default 15 minutes): a transient failure's backoff (30 s, 2 min, ...) is only honoured when something wakes the worker, so a retry can wait up to one interval. Reconcile runs every 6 hours with the token checks.
- Sending files: WhatsApp only, one file per message, a documented subset of types, no template fallback outside the 24 hour window. Instagram and Messenger refuse with `unsupported_channel_media`. Audio sent as a file is not a voice note.
- No HTTP range support on `content` (video seeking buffers the whole file), no thumbnails, no antivirus scan (executables and scripts are refused by their bytes only), no signed URLs, no per-workspace storage quota, no retention job for old media (only delete, contact delete and reconcile).
- Knowledge from an attachment: images, PDF and audio need an AI provider with the capability; txt and csv work without one; docx, xlsx, pptx and video are `unsupported_type`. OCR and transcription output is customer-controlled content and can contain instructions.
- Media agent tools run inside the apply transaction, which stays open during the provider call (the only tools that do network work). The media service rate limit (60 per minute per workspace) is in-process like the others.
- A `ready` row whose blob vanishes answers `file_missing` on read until reconcile marks it `missing`; the application role cannot change that status itself.
- A delete that crashes between the row update and the blob delete leaves an orphan blob; reconcile reports it only for the local store (providers do not list keys here).
- Upload progress is a status (Uploading, Ready, Failed), not a percentage: the upload is one JSON request.
- Review fixes (2026-11-17): media agent tools now run before the apply or approve transaction opens (results are stored; no network or blob call runs inside a transaction) and pools fail fast after 10 s (`DB_CONNECT_TIMEOUT_MS`); S3 requests time out after 30 s; reconcile aborts when a storage probe fails, needs two consecutive misses before marking a file `missing`, and recovers it when the blob returns; a retried file whose bytes changed ends `content_changed` and never overwrites the blob; uploads are capped at 4 in flight per process and 2 per user (429 `busy`) and an identical re-upload within a minute returns the first attachment; PDFs are served as downloads; the web proxy was checked (Playwright) to keep the API's strict CSP on attachment content. The older note that media tools hold the apply transaction open is obsolete.

## OpenRouter gateway, slice A
- Everything is UNVERIFIED against the live service: no recorded real request (the opt-in `scripts/openrouter-smoke.mjs` has not been run). Documented facts (URL, auth, error codes, usage.cost, model list fields) are implemented from the docs; `architecture.input_modalities` is not verified, so vision shows only when it is present.
- The model list endpoint is assumed public. If it needs a key the browser shows an error; there is no fallback to a workspace key.
- Model list cache and the browse rate limit are in-process (one API instance). Capability confirmation on save uses that cache: after a restart or 10 minutes, a save keeps what is already stored but cannot grant new capabilities.
- Prices cover input and output tokens only; per-request, image or reasoning fees are only covered through the reported `usage.cost` (the higher value is charged). Free models cost 0.
- Not built (slice B is separate): routing preferences, BYOK, audio transcription through OpenRouter, router aliases (`openrouter/auto`).

## OpenRouter slice B (streaming, tools, structured output)
- Everything is UNVERIFIED against the live service: `[DONE]`, `stream_options.include_usage`, `usage.cost` in the final chunk, the mid-stream `error` shape, `tool_calls` shape and `response_format` behaviour per model. The extended `scripts/openrouter-smoke.mjs` (opt-in) has NOT been run.
- Only reply suggestion streams. Agent runs and other AI calls stay non-stream. Tool calls are not streamed and there is no multi-turn tool loop (single round, no `role:'tool'` results).
- A stream cut by the client is logged with estimated tokens (4 chars per token), because no usage event arrives; the provider may bill slightly differently.
- Capabilities are only known for OpenRouter models; other providers always use the JSON-in-text protocol and prompt-based JSON. Structured output is non-strict json_schema; the answer is validated either way.
- The stream route answers HTTP 200 once past the shared checks, so a budget stop or provider failure arrives as an `error` event, not an HTTP status. Keepalive and abort rely on the Node server noticing a closed connection.
- The mock agent answering plain text (no JSON) is no longer flagged `malformed`, because native tool-calling models answer plain text by design.
- Not built (slice B): streaming, native tool calling, structured output, routing preferences, BYOK, audio transcription through OpenRouter, router aliases (`openrouter/auto`).
## Leads only (2026-11-17)
- No drag and drop and no board: moving leads is the row menu or bulk Change stage. The only drag-and-drop dependency (`@dnd-kit`) is unused and still listed in `apps/web/package.json`.
- Bulk change stage takes at most 100 leads per call and only leads loaded on screen (no "select all 4,210"); 30 bulk calls per user per minute (in-process counter, one API instance).
- Bulk moves are one transaction per lead: a request that dies midway leaves the earlier leads moved. The answer lists every lead that was handled; a dropped connection shows nothing, so the list refetches.
- Stage chips count by stage; Won and Lost chips count all time (not the old 30-day window of the board). Counts ignore the status filter by design. With "All pipelines" selected there are no chips (stages differ per pipeline); the count text still works.
- The value-range filter uses the pipeline currency's decimals and compares raw minor units, it does not convert between currencies. Roles that cannot see values do not get the inputs and get 403 from the API.
- The source filter is an exact text match (sources are free text, only `manual` is written today).
- Performance at 10,000+ leads is verified for the stage-counts query shape and time on 4,210 seeded rows only; the list itself has no dedicated index for `updated_at` sorting beyond what exists (UNVERIFIED at 10k with EXPLAIN ANALYZE on a production-sized table).
- Old board-only strings in docs/design/leads-pipeline/* describe the removed board; they are history, not current behaviour.
- Invitations are link-based: there is no production mail provider (D22), so by default the inviter copies the link and sends it. Email goes out only when the API runs with `INVITATION_EMAIL=1` and a real mailer exists (today only the file mailer, which writes to disk).
- Invitation rate limits and the pending cap check are per API instance (in-process counters, like the reset throttle). The session email is not verified (no verification flow), so a person who holds both the link and an account registered with the invited address can join.
- The register form is not prefilled with the invited email (the public preview shows it masked only); a mismatch is caught on accept.

## Moved out of the UI copy (UI cleanup, 2026-11-17)
- Not tested live (shown as a badge): Messenger, Instagram and WhatsApp connections, real AI providers, OpenRouter prices and capabilities, the built-in model capability list. No recorded request to a live service exists for them; see the sections above.
- Meta webhooks: the callback URL and fields (Instagram via a Page, WhatsApp `messages`) are set once in the Meta app dashboard; real delivery is unverified until the first real message arrives.
- Conversions API is mock only: events are checked and recorded, nothing is sent to Meta, and a real accepted request would not mean Meta counted a conversion. Only Purchase is created today.
- WhatsApp is receive only. Free-form replies are limited to 24 hours after the customer's last message; templates are not available.

## Telegram (MOCK ONLY, `feat/telegram`)
- Never run against Telegram: the real `createTelegramClient`, the webhook secret header, `allowed_updates`, error wording (403, 400 chat not found, 429 `retry_after`) and the "no 24 hour window" and "a bot cannot start a chat" rules are UNVERIFIED. The UI says "Not tested live".
- Text only. Photos, files, voice and stickers arrive as a placeholder (metadata kept, never downloaded, never a URL); replies cannot carry files. Private chats only; groups, channels and edited messages are ignored.
- Replies are plain text, at most 2000 characters (Telegram allows 4096). A 429 is shown as "not sent" and is not retried; per-chat pacing is not enforced.
- A bot cannot start a chat: there is no "new message" to a person who has not written first.
- The webhook needs a public https address (`META_PUBLIC_BASE_URL`); without it connecting answers `public_url_required` outside mock mode. Telegram ports allowed: 443, 80, 88, 8443.
- A bot connected to one workspace cannot be connected to another until it is disconnected there and released.

## Website chat (2026-11-17, `feat/web-chat`)
- Tested only against our own local servers. Not tried on a real third-party site, a strict host-page CSP, ad blockers, page builders, Safari/Firefox or phones. The settings page says "Not tested on real sites".
- The origin allowlist is not authentication: `Origin` and `X-Widget-Host` are client supplied, so a script outside a browser can claim an allowed origin. Browsers are stopped (CORS and per-widget `frame-ancestors`); scripts are limited only by the rate limits, which are in-process (one API instance) and keyed on `x-forwarded-for`, which is only as trustworthy as the host in front of the API.
- Firefox has no `location.ancestorOrigins`, so there the widget uses the loader's `?host=` (client supplied). Safari and other browsers that partition or clear third-party iframe storage may lose the visitor's token and start a new conversation on each visit (UNVERIFIED).
- Polling: new messages take up to 3 s to appear (15 s when the tab is hidden); no typing indicator, no read receipts, no push.
- Text only, both directions. No business hours, no visitor identity verification, no CAPTCHA, no purge of expired sessions (rows stay).
- Agents appear to visitors as "Support" (no names). Replies show as `sent` once stored, not when read.
- Replying needs the worker database URL on the API (same as Meta): without `DATABASE_URL_WORKER` the widget routes are not mounted and creating widgets answers 503.
- An agent who replies to a conversation of a widget that was later turned off still sends; the visitor cannot read it while the widget is off.

## Email channel (2026-11-17, MOCK only)
- Not tested live: no request to Mailgun has ever been made. The SPF/DKIM verdict field names, the events webhook shape, custom Message-Id handling, MX/SPF values and the route expression are UNVERIFIED (docs/integrations/email.md).
- Attachments are not stored (names and sizes only) and inbound mail whose webhook body exceeds 1 MB is refused. Outbound attachments are not available. HTML is never shown.
- Senders that fail the SPF/DKIM check (or lack DKIM) are shown as Unverified sender and cannot be replied to. The check also needs envelope and From domains to match, so mail sent through third-party senders may be marked unverified.
- One support address per workspace; one conversation per sender. Orphaned events (disabled account) are not re-queued when email is turned on again. "Check setup" is canned in mock and not built for Mailgun. Replay protection and flood limits are in process (one API instance).
- Contact methods of source email cannot be corrected or deleted by people yet (same gap as D220: migration 0023 policies list only messenger and instagram).

## One contact, one lead (2026-11-18, branch `feat/one-lead-per-contact`)
- Existing duplicate leads stay as they are. The UI shows one primary lead per contact (most recent open, else most recent) and "+N more"; a stage, value or owner write moves only the primary lead. Reports and the lead API still count every lead, so a contact with two open leads is one row on Contacts but two in Reports. Nothing merges them; there is no link from "+N more" to the others.
- The virtual first stage: a contact with no lead is shown (and counted, and filtered) as the first open stage of the DEFAULT pipeline, although no lead exists. Reports and the lead API do not count it. If the default pipeline changes or its first stage is archived, those contacts show under the new first stage.
- A contact whose only lead is won or lost shows that outcome; moving it re-opens that same lead (needs `lead.reopen`). There is no "start a second lead" action in the UI; use `POST /leads`.
- Owner: Contacts shows the contact's owner. A lead created before this change can have a different lead owner; saving the owner in the new section sets both, but the list never shows the lead owner. `?owner=` on an old /leads link now filters by the contact owner.
- Removed from the web UI (API unchanged): the lead detail page (probability override and reset, stage history list, linked lead tasks), the New lead dialog (title, expected close date, description, priority), min/max value, expected-close and last-activity lead filters, lead sort by expected close. (Delete, restore and value-access grants came back on 2026-11-18, see below.)
- Multi-pipeline: stage chips and the bulk dialog use the default pipeline. A contact whose primary lead sits in another pipeline can be moved only within that pipeline (row menu); bulk to a default-pipeline stage reports it as "cannot go to that stage".
- Stage sort compares stage positions (a contact in another pipeline sorts by its own position); value sort compares minor units across currencies.
- Copy: "lead" still appears in the inbox Stage panel, the audit log wording, CAPI settings and mapping labels (Meta's Lead event) and the Reports page numbers; only Home, Contacts, the contact page, navigation, members text and metadata were reworded. Not yet checked with the owner.
- Unverified: nothing was run against a real Meta account; CAPI behaviour is shown from the outbox rows in tests only.

## One contact, one lead: fixes (2026-11-18, branch `feat/one-lead-fixes`)
- Remove and restore act on the contact's primary lead only; "Recently removed" is a dialog (owner/admin), 25 per page with Load more, no search. Restore of a lead whose contact was deleted is refused by the API ("Restore the contact first"); the button is disabled with that hint.
- Value access is per lead, so it is edited on the contact page for the primary lead; a contact with several leads shows grants of the primary one only.
- Lifecycle stage is hidden, not gone: still in the data, the API, CSV import mapping and Settings, Contacts (lifecycle stage list), and old activity rows still say "moved the lifecycle stage". A saved view or link that carries `lifecycleStageId` still filters (Clear removes it). Automations and segments were not changed; none of the code read here depends on the contact page field.
- The audit log and activity feed use the old names `lead.deleted` / `lead.restored`.

- Web chat preview (D270 to D277): preview conversations are real and appear in the Inbox like any visitor; the only mark is `chat_visitor_sessions.user_agent = 'CRM preview'` (not visible in the Inbox). A grant lives 10 minutes and is not revoked on role change. The loader's check of the allowed sites reads a CORS failure as "not allowed", so an unreachable chat server also hides the launcher (with the same console line). Tested only on our own local origins.
- Web chat v2 (D280 to D289): the away notice is a manual switch, nothing turns it off by time. The unread badge needs the chat page to poll while the panel is closed (every 15 s, stopping after 10 minutes closed or while the tab is hidden): one small request per 15 s per page view for those 10 minutes, even for visitors who never open the chat. The page shown to agents has the query string and fragment removed on purpose, so a link that depends on them lands on the bare page, and paths can still hold ids. The launcher label follows the widget's default language only; the visitor's own choice applies inside the panel. Owner text (title, subtitle, greeting, quick replies, away text) is not translated. Safe-area padding inside the iframe and the Bangla rendering (font fallback to the system Bengali font, mixed `PM` in times) were checked only in desktop Chromium. A host page with a strict `img-src` shows the initial letter instead of the avatar in the launcher.

## Leads page (2026-11-18, branch `feat/leads-page`)
- No total value in the header and no value or last-activity filter: the API has neither (D304). Needs a currency-aware, permission-aware aggregate first.
- The Agent filter and its counts use the contact's owner (what the Agent column shows). A lead whose own owner differs from the contact's owner is not told apart; they are kept in step by the lead page.
- The lead page loads the latest conversation by searching the Inbox list for the lead's name (no per-lead conversation endpoint): two leads with the same name and more than 100 matching conversations could miss one.
- Phone and tablet layouts were checked in emulated Chromium (touch, 320 to 768 px). Not checked: real iOS or Android devices (safe-area insets, on-screen keyboard, momentum scrolling), Safari, Firefox, a screen reader.
- The URLs still say `/contacts` (D301); saved column layouts from before keep their old column set (the new default only applies to devices without a saved layout).
- Notifications created before this change keep the title stored with them (for example "Your contact import finished"); new ones say lead. Activity and audit wording is built at display time and already says lead.
## Tasks redesign and voice typing (2026-11-18, branch `feat/tasks-redesign`)
- No reminder for follow-ups: tasks have a due time but no reminder, so the demo's "Remind me" is not built.
- A follow-up is a new task; it is not linked to the task it came from except by its title and its history line.
- The completed task panel and list refresh after each action; there is no live update when a teammate changes a task.
- Voice typing depends on the browser: works in Chrome, Edge and Safari, absent in Firefox. Bangla accuracy is the browser's, not ours. It needs a microphone permission and an internet connection. Verified only with a faked recognizer in Playwright, never with a real microphone or real Bangla speech.
- The inbox reply composer gained a voice button; no automated test covers it yet.
