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
