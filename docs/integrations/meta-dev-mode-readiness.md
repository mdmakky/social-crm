# Meta Development-Mode Readiness (owner checklist)

Status: draft, 2026-11-13. Documentation only. Nothing here has been run against live Meta; the CRM runs on the mock adapter until the owner supplies credentials (decision D18). Mock mode must stay labeled as mock.

Basis: `docs/research/meta-api-research.md` (and its errata), `docs/research/meta-capi-research.md`, `docs/integrations/capi-setup-guide.md`, `docs/architecture/api-strategy.md`, decisions D18 and D26. Claims re-checked against official Meta pages on 2026-11-13 are tagged **[verified]** with the URL; anything else is tagged **[unverified]** or **[research]** (carried from earlier research, not re-fetched today).

Scope: the owner connects their own Facebook Page and Instagram professional account, in Development mode, with the owner and added role users as the only people who can message or generate leads. Public/customer use needs Live mode, App Review and Business Verification, which are out of scope here.

## 1. Developer App configuration

| Item | Requirement | Status |
|---|---|---|
| Account | Meta developer account (registered on the owner's personal Facebook login) | [research] |
| App type / use case | Business-type app with the Messenger/Instagram/Lead Ads use cases. The Dashboard now uses "use cases"; exact labels change, confirm in the UI | [unverified] labels |
| Mode | New apps start in Development mode and stay there | [verified] app-modes page |
| Products to add | Webhooks, Messenger (Facebook Login for Business or Facebook Login for the Page token flow), Instagram (choose Instagram Login, Facebook Login, or Unified Login), Marketing API/lead retrieval for Lead Ads. Conversions API needs no product on the app (token generated in Events Manager, see `capi-setup-guide.md`) | [research] |
| Basic settings | App ID, App Secret (server-side only, never logged), App Domains, contact email, Privacy Policy URL. These are mandatory only for going Live, but set them early | [research]; Live field list in errata |
| Roles | Administrator (all settings, reset secret, assign roles), Developer (technical settings), Tester (use/test only, no settings), Analytics User. Max 50 testers on an unlinked app | [verified] https://developers.facebook.com/docs/development/build-and-test/app-roles (accessed 2026-11-13) |
| Tester rules | Invitations go from App Dashboard > Roles. Testers must be people with a working relationship (Meta says employees/agreement). Invitee must accept as Authorized App Tester, under Facebook Settings > Apps and Websites | [verified] same page |
| Data deletion / deauthorize | Not needed in Development mode; needed before Live. Planned endpoints are in `api-strategy.md` | [research] |

In Development mode "only role users" can use the app and "apps in Development mode can only request permissions from role users, and only permissions with standard or advanced access levels" [verified] https://developers.facebook.com/docs/development/build-and-test/app-modes (accessed 2026-11-13). The page does not literally say "App Review is skipped"; that conclusion rests on the Business Verification page ([research]: apps used only by role users need no verification and role users can grant any permission).

## 2. Facebook Page and Instagram prerequisites

1. A Facebook Page (not a personal profile) on which the connecting user has a role. Messenger needs the `MESSAGING` and `MODERATE` Page tasks; lead retrieval needs a Page role plus advertiser access on the ad account. [research] (Page task names: get-long-lived page and Send API docs)
2. Page messaging enabled (Messenger inbox not restricted). [unverified]
3. Instagram professional account (business or creator); a personal IG account cannot be used. [research] https://developers.facebook.com/docs/instagram-platform/overview
4. Path choice for Instagram:
   - Instagram Login: no Facebook Page needed, host `graph.instagram.com`, `instagram_business_*` permissions.
   - Facebook Login: IG account must be linked to the Page, host `graph.facebook.com`, `instagram_*` permissions plus Page permissions.
   - Meta recommends Unified Login for new integrations. [research] (errata item 7)
   Pick one before writing the real adapter; it changes tokens, hosts and webhook setup. This is an open architecture decision.
5. IG setting "Allow access to messages" for connected tools must be on in the Instagram app (Settings > Messages and story replies > Message controls). [unverified]
6. Lead Ads: a Page, an ad account, and a Lead Gen form; the owner must accept the Lead Ads Terms of Service on the Page. [unverified]; a test lead can be created with Meta's Lead Ads Testing Tool [unverified].
7. Business portfolio (Business Manager) is needed for system users and for CAPI via Events Manager; a registered company is not stated as required. [research]

## 3. Permissions per capability and Development-mode status

Rule of thumb: with Standard Access (default) every permission works for role users only; events for non-role users (real customers) require Advanced Access, which needs App Review and Business Verification. [research] https://developers.facebook.com/documentation/development/graph-api/overview/access-levels

| Capability | Permissions | Works in Dev mode without App Review? |
|---|---|---|
| Messenger (Page DMs) | `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `pages_read_engagement`, `business_management` | Yes, for the owner's own Page and role users. No customer messages from outside the role set. [research] |
| Instagram messaging (Facebook Login path) | above plus `instagram_basic`, `instagram_manage_messages` | Yes for own account and role users [research] |
| Instagram messaging (Instagram Login path) | `instagram_business_basic`, `instagram_business_manage_messages` (comments: `instagram_business_manage_comments`) | Yes for own account and role users [research] |
| Comments / private replies | FB `feed` webhook: `pages_manage_metadata`, `pages_show_list`; IG: `instagram_manage_comments` or `instagram_business_manage_comments` | Yes for role users [research] |
| Lead Ads | `leads_retrieval`, `pages_manage_metadata`, `ads_management`, `pages_manage_ads`, `pages_read_engagement`, `pages_show_list` | Webhook plus retrieval for forms on Pages the role user administers: expected yes, but a real ad-driven lead from a non-role user is **[unverified]** in Development mode. Test with Meta's testing tool or a role user submitting the form. |
| Conversions API | Events Manager dataset access token (system user generated by Meta). No app permission, no App Review | Yes [research] `capi-setup-guide.md`. Real events show as received only; no attribution claim. |

Messaging policy that applies even in Development mode: 24-hour standard window; Human Agent tag extends a manual human reply to 7 days; bot must respond within 30 seconds; tags `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` return error 100 from 2026-04-27. Tag string case (`human_agent`) per errata. [research] No idempotency key on Send API, so outbound failures with unknown outcome go to the `unknown` state and are never auto-retried (D26).

## 4. Webhooks

1. Public HTTPS endpoint with a valid CA certificate; self-signed is not supported. Local dev needs a tunnel (tunnel choice is the owner's; not documented by Meta). [verified] https://developers.facebook.com/docs/graph-api/webhooks/getting-started (accessed 2026-11-13)
2. Verification handshake: when the callback is saved in the App Dashboard, Meta sends `GET` with `hub.mode=subscribe`, `hub.challenge`, `hub.verify_token`. The endpoint checks the token against the Verify Token configured in the Dashboard and responds 200 with the `hub.challenge` value. [verified] same page
3. Signature: every event `POST` carries `X-Hub-Signature-256: sha256=<hex>`; compute HMAC-SHA256 with the App Secret over the payload and compare after the prefix. Meta says validation is optional ("You don't have to validate the payload, but you should"); the CRM must treat it as mandatory and reject mismatches. [verified] same page. Compute over the exact raw bytes received; Meta's HMAC uses an escaped-unicode (`\uXXXX`, lowercase hex) form of the payload, so never re-serialize parsed JSON. [research] errata item 2, not re-fetched.
4. Respond 200 fast; process asynchronously; deduplicate (duplicates and out-of-order delivery occur; Messenger `mid`). Generic Graph webhooks retry over about 36 hours [verified]. Messenger and Instagram messaging webhooks alert after 15 minutes and auto-unsubscribe after 1 hour of failures, so the Page subscription must be re-checked after downtime. [research] errata item 3
5. Subscriptions: Page-level `POST /{PAGE_ID}/subscribed_apps?subscribed_fields=messages,...` (and `leadgen`, `feed`); Instagram fields (`messages`, `comments`, `mentions`) are enabled in the app's Instagram webhook settings. In Development mode, Standard Access delivers events only for people with a role on the app. [research]
6. Subscribe only after the endpoint is live and verified. History cannot be queried, so store raw payloads.

## 5. Token lifecycle and reconnect

| Token | Lifetime | Notes |
|---|---|---|
| Short-lived user token | about 1-2 hours | From Facebook Login. [research]; exact hours [unverified] |
| Long-lived user token | "generally about 60 days"; expires if no requests are made; an expired token cannot be exchanged, user must log in again | Server-side `GET oauth/access_token?grant_type=fb_exchange_token` with App Secret. [verified] https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived (accessed 2026-11-13) |
| Page access token | "do not have an expiration date and only expire or are invalidated under certain conditions" when derived from a long-lived user token. Obtain via `GET /{app-scoped-user-id}/accounts`; the requester needs a Page role | [verified] same page. The invalidation list is **[unverified]**: the token-debugging page returned 404 on 2026-11-13. Research expects password change, role removal, permission revocation, app removal by the user, or user logout of sessions. |
| Instagram Login token | short-lived 1 hour, long-lived 60 days, refreshable before expiry | [research]; refresh endpoint path [unverified] |
| System user token (unified login webhooks, CAPI) | not established | [unverified] |

Reconnect flow the CRM must support (design requirement, no code here):
1. Detect failure: Graph error code 190 (invalid or expired token) on any call, or a failed scheduled health check using `debug_token`. Exact subcodes [unverified].
2. Mark the integration `reconnect required`, stop outbound sends, keep inbound data, surface a visible banner; never retry silently.
3. Owner clicks Reconnect: fresh Facebook Login, server exchanges for long-lived token, re-derives Page tokens, re-subscribes the Page to webhooks, re-verifies permissions granted.
4. Proactive: schedule re-exchange of the long-lived user token well before day 60 while it is still valid; calendar-remind the owner if no activity.
5. Tokens stay server-side and encrypted; never logged (project convention).

## 6. Supported vs unsupported in Development mode

Supported (owner and role users only):
- Facebook Login for role users and connecting own Pages.
- Receiving and sending Messenger and Instagram DMs between the owner's Page/IG account and role-user accounts, inside the 24-hour window (Human Agent 7 days). [research]
- Webhooks for messages, comments (role users), `leadgen` for owned Pages [research; leadgen caveat above].
- CAPI test events using the Events Manager dataset and Test Events code. [research]

Unsupported or blocked until Live plus approvals:
- Messages or lead events from real customers who hold no app role (needs Advanced Access, App Review, Business Verification).
- Third-party customers connecting their own Pages (multi-tenant onboarding of strangers).
- Whether a sole proprietor without registered company documents can pass Business Verification: **[unverified]**.
- One-Time Notifications on Instagram (not available). [research]
- Anything depending on Live-only listing (App Center), data-use checkup (annual, required before Live). [research]

Because Development mode hides nothing from the CRM's own users, results here prove the integration plumbing only, not production behavior with the public. Do not label the integration as "working in production".

## 7. Owner manual checklist

Do in this order. Tick and record evidence (timestamp, screenshot, a real request id) in `docs/project/testing-report.md`.

- [ ] Create or reuse a Meta developer account; enable 2FA on it.
- [ ] Create a Business-type app; note App ID. Keep it in Development mode.
- [ ] Copy the App Secret into the local `.env` only (never commit, never paste in chat).
- [ ] Choose the Instagram path (Instagram Login, Facebook Login or Unified Login) and tell the team; add the matching products.
- [ ] Create a Facebook Page you administer; confirm Messenger inbox is on.
- [ ] Convert or create an Instagram professional account; for the Facebook Login path link it to the Page; enable access to messages for connected tools in the Instagram app.
- [ ] Add role users/testers in App Dashboard > Roles; each invitee accepts under Facebook Settings > Apps and Websites. Only add people with a real working relationship (Meta's rule).
- [ ] Create a Business portfolio if you want system users or CAPI; create an Events Manager dataset and generate the Conversions API token (see `capi-setup-guide.md`).
- [ ] For Lead Ads: have an ad account, create a Lead Gen form on the Page, accept the Lead Ads terms; plan a test lead via the Lead Ads Testing Tool.
- [ ] Start a public HTTPS tunnel to the API (`/v1/webhooks/meta`); give the URL to the team.
- [ ] Webhooks product: set callback URL and a random Verify Token (stored in `.env`); click Verify and Save; confirm the CRM logs a handshake success.
- [ ] Subscribe the Page to `messages` (and `leadgen`, `feed` as needed) and the IG account to `messages`/`comments`; confirm via the subscribed apps call.
- [ ] Run the Facebook Login flow from the CRM as the Page admin; grant all requested permissions; confirm the CRM stores the Page token server-side encrypted.
- [ ] Send a DM from a role-user account to the Page and to the IG account; confirm webhook delivery, valid signature, and a stored message. Reply from the CRM inside 24 hours.
- [ ] Submit a test lead; confirm `leadgen` webhook and lead retrieval.
- [ ] Send a CAPI test event with the Test Events code; confirm it appears in Events Manager.
- [ ] Record the actual error text for an intentionally revoked token to fill in the unverified items in section 5, then exercise the reconnect flow.
- [ ] Put a recurring reminder at day 45 for the long-lived token re-exchange until automatic renewal exists.
- [ ] Do NOT click "Switch to Live" or submit App Review/Business Verification without a separate decision.

## 8. Sources and unverified list

Fetched 2026-11-13:
- https://developers.facebook.com/docs/development/build-and-test/app-modes
- https://developers.facebook.com/docs/development/build-and-test/app-roles
- https://developers.facebook.com/docs/graph-api/webhooks/getting-started
- https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
- 404 on 2026-11-13: `/docs/roles/`, `/docs/facebook-login/guides/access-tokens/debugging`

Carried from `docs/research/meta-api-research.md` (retrieved 2026-11-13, not re-fetched): permission lists, messaging windows and tags, rate limits, Instagram path table, Lead Ads fields, Business Verification and access levels.

Unverified: current app type and use-case labels in the Dashboard; short-lived token exact lifetime; page token invalidation list and error subcodes; system user token lifetime; Instagram token refresh endpoint; real non-role-user lead delivery in Development mode; Lead Ads terms acceptance and testing tool steps; IG "allow access to messages" setting path; Page messaging prerequisites; whether sole proprietors can pass Business Verification; Graph API version to pin (v27.0 released 2026-11-04 per errata).
