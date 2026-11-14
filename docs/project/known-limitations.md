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

## WhatsApp, slice 1: webhook foundation (2026-11-14, branch feat/whatsapp-foundation)
- NEVER run against real WhatsApp (fixtures built from Meta's documented field lists only). Details and the verified/inferred split: `docs/integrations/whatsapp-cloud-api.md`.
- A WhatsApp number cannot be connected from the UI yet, and replies are refused (`422 unsupported_channel`; the Inbox shows a notice). Incoming events for a number nobody connected are kept as orphans.
- Senders that have only a business-scoped user id (username users without a visible phone number) are not turned into conversations (`bsuid_only`).
- Media is shown as "Attachment, not available" (id kept, no download); locations are placeholders; reactions and system notices are ignored; `sent`/`failed`/`played` statuses are ignored.
- The contact name stays `WhatsApp user NNNN`; the WhatsApp profile name is not used yet.
- Whether Meta delivers WhatsApp events to a separate callback URL and the exact payload of real messages are unverified.
