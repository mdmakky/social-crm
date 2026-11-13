# Meta Platform API Research for a Social CRM (solo developer, no company)

Retrieval date: 2026-11-13. Primary source: developers.facebook.com. Pages were fetched through a summarising fetch tool, not a browser, so statements are marked "unverified" wherever the tool could not return the relevant text. Several legacy `/docs/...` pages now redirect to `/documentation/...` equivalents; some returned 404 or navigation-only content, and these are listed in the last section.

## 1. Graph API versioning

Source: https://developers.facebook.com/docs/graph-api/changelog/versions (retrieved 2026-11-13).

The newest version listed is v26.0, released 2026-07-29 (expiry TBD). v25.0 was released 2026-02-18 and expires 2028-07-29. v24.0 expires 2028-02-18; v23.0 expires 2027-10-08; v22.0 expires 2027-05-20; v21.0 expires 2027-01-21; v20.0 expires 2026-09-24 (already past). Meta also documents a Marketing API auto-upgrade on 2026-07-29.

Discrepancy: the Send API page (https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages.md) shows a sample URL with `v27.0`, which does not appear in the versions table. Treat v27.0 as unverified. Recommendation: make the version a single config value, default to v25.0 or v26.0, and always send versioned URLs.

## 2. Authentication and tokens

Sources: https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived ; https://developers.facebook.com/docs/instagram-platform/overview ; https://developers.facebook.com/docs/instagram-platform/webhooks (all retrieved 2026-11-13).

- Facebook Login / Facebook Login for Business issues a user access token (short-lived). A server-side call to `GET oauth/access_token?grant_type=fb_exchange_token&client_id&client_secret&fb_exchange_token` returns a long-lived user token, `expires_in` in seconds. This must run on the server because it uses the app secret.
- Long-lived user tokens last about 60 days. An expired token cannot be exchanged; the user must log in again. The page describes no separate refresh endpoint for web/server flows; the SDKs auto-refresh if the user used the app within 90 days. Server apps should re-exchange a still-valid token before expiry.
- Page access tokens: calling `/{app-scoped-user-id}/accounts` with a long-lived user token returns Page tokens. Those derived from a long-lived user token have no fixed expiry but are invalidated on events such as password change, role removal or permission revocation (see the token debugging docs; the invalidation list itself was not read, so unverified). The user needs a role on the Page. For Messenger the user must be able to perform the `MESSAGING` and `MODERATE` Page tasks.
- System user tokens (Business Integration System User): the Instagram webhooks page names a "Business Integration System User Access Token" for Instagram API with Unified Login. Lifetime and creation rules were not on any page I could read: unverified. Creating a system user requires a Business Manager, which a solo dev can create without a registered company, but verification is a separate matter (section 8).
- Instagram Login (Business Login for Instagram): short-lived token valid 1 hour, exchangeable for a long-lived token valid 60 days, refreshable before it expires (Instagram overview page). The refresh endpoint path was not on the pages read: unverified.
- Instagram app owners serving only their own accounts need no login flow: they configure Business Login settings in the App Dashboard to get an Instagram app ID and secret, then generate long-lived tokens (Instagram overview page).

## 3. Messenger Platform

Sources: https://developers.facebook.com/docs/messenger-platform/overview/ ; https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages.md ; .../policy.md ; .../overview/rate-limiting.md ; https://developers.facebook.com/docs/messenger-platform/webhooks (retrieved 2026-11-13).

Permissions for Messenger conversations: `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `pages_read_engagement`, `business_management`. Instagram messaging adds `instagram_basic` and `instagram_manage_messages`. App Review/Advanced Access is not required if the app only messages the developer's own Page.

Send API: `POST https://graph.facebook.com/{version}/{PAGE_ID}/messages` with a Page access token. Body: `recipient.id` (PSID; also user_ref or a comment/post ID for private replies), `messaging_type` (`RESPONSE`, `UPDATE`/`UPDATES` as written on the page, or `MESSAGE_TAG`), `message` (`text` or `attachment(s)`), optional `reply_to.mid`. Success response: `{ "recipient_id": "...", "message_id": "..." }`. Error codes were not on the page read: unverified.

Messaging window: a user action opens a 24-hour standard window; after a Click-to-Messenger or Click-to-Direct ad the window may last up to 7 days. RESPONSE and UPDATE messages must be inside the window and may be promotional.

Message tags: send outside the window with `messaging_type=MESSAGE_TAG`, non-promotional only. The Human Agent tag allows a manual human reply within 7 days. The exact tag string `HUMAN_AGENT` is not shown on the pages I could read (the tags page returned 404/empty): unverified from official text. Per the Send API page, from 2026-04-27 requests using `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE` or `POST_PURCHASE_UPDATE` return error code 100, so only Human Agent (and the news-only `NON_PROMOTIONAL_SUBSCRIPTION`) can be assumed; a full current tag list is unverified.

One-Time Notification: beta; user opts in, Page receives a single-use token that expires within one year; one follow-up message. Not available for Instagram messaging.

Policy: automated bots must reply to all user input within 30 seconds; violations give 7 days to fix. Disclose automation where law requires.

Rate limits (per Page / per IG professional account): Send API 300 calls/second for text/link/reaction/sticker, 10/second for audio/video; Private Replies 750 calls/hour (comments on posts and reels) and, for Instagram, 100/second for Live comments; Conversations API 2 calls/second.

Webhook subscription: `POST /{PAGE_ID}/subscribed_apps?subscribed_fields=messages,...`. Standard Access delivers events only for people with a role on the app; customers require Advanced Access.

## 4. Instagram

Sources: https://developers.facebook.com/docs/instagram-platform/overview ; .../instagram-api-with-instagram-login ; https://developers.facebook.com/documentation/instagram-platform/webhooks/fields ; .../webhooks/examples (retrieved 2026-11-13).

Both paths require an Instagram professional account (business or creator).

| Aspect | Instagram API with Instagram Login | Instagram API with Facebook Login |
|---|---|---|
| Facebook Page needed | No | Yes (account linked to a Page) |
| Host | graph.instagram.com | graph.facebook.com |
| Token | Instagram User access token | Facebook User or Page token |
| Permissions | `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages`, `instagram_business_content_publish` | `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`, plus Page permissions |
| Messaging | Supported | Via Messenger Platform Instagram Messaging API |
| Hashtag search, product tagging, partnership ads | No | Yes |

Meta recommends Unified Login for new integrations (log in with Instagram or Facebook; system user token for webhooks). Messaging window is about 24 hours (7 days after Click-to-Direct ads); Human Agent tag gives a separate 7 days. Standard Access suffices if the app serves only accounts the developer owns or manages.

## 5. Facebook Lead Ads

Source: https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving ; https://developers.facebook.com/docs/graph-api/webhooks/reference/page (retrieved 2026-11-13).

Subscribe the Page webhook field `leadgen`. Payload: `object: "page"`, `entry[].changes[].field: "leadgen"`, `value` with `leadgen_id`, `page_id`, `form_id`, `adgroup_id`, `ad_id`, `created_time`. Then `GET /{LEADGEN_ID}` to fetch field data. Bulk: `/{FORM_ID}/leads` or `/{AD_ID}/leads`, filterable by `time_created`. Permissions: `pages_manage_metadata` (webhook), `leads_retrieval`, `ads_management`, `pages_manage_ads`, `pages_read_engagement`, `pages_show_list`. The caller needs a role on the Page and advertiser access on the ad account (Leads Access Manager can restrict). Notifications can lag a few minutes. Rate cap: 200 x 24 x leads created in the past 90 days per Page per 24 hours. The page does not state a separate "CRM integration access" approval; it only points to partner CRM integrations. Whether the app needs Advanced Access for `leads_retrieval` against your own Page: unverified, but by the access-level rule below it is only needed for non-role users.

## 6. Webhooks

Source: https://developers.facebook.com/docs/graph-api/webhooks/getting-started (retrieved 2026-11-13).

- Verification: Meta sends GET with `hub.mode=subscribe`, `hub.challenge`, `hub.verify_token`; return the challenge value with 200 if the token matches.
- Signature: header `X-Hub-Signature-256: sha256=<hmac>`, HMAC-SHA256 of the raw body with the App Secret. Meta calls validation recommended; do it anyway.
- Delivery: HTTPS with a valid CA certificate (self-signed not supported); respond 200 (Messenger page: within 5 seconds). Failed deliveries are retried immediately and then over up to 36 hours with decreasing frequency, then dropped. Duplicates and out-of-order delivery are possible (sort by `timestamp`, dedupe by `mid`). Batches of up to 1,000 updates are possible but not guaranteed. History cannot be queried, so persist payloads. mTLS applies to WhatsApp only.
- Envelope: `object`, `entry[]` with `id`, `time`, then `changes[]` (Graph-style) or `messaging[]` (Messenger/Instagram). Subscribe to fields only after the endpoint exists.
- Local development needs a public HTTPS URL (tunnel); not documented on the pages read.

## 7. App modes, roles, access levels, review

Sources: https://developers.facebook.com/docs/development/build-and-test/app-modes ; https://developers.facebook.com/documentation/development/graph-api/overview/access-levels ; https://developers.facebook.com/documentation/development/release/business-verification ; https://developers.facebook.com/docs/development/maintaining-data-access/data-use-checkup ; https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback (retrieved 2026-11-13).

- Development mode: only role users can use the app; test data visible to role users only. Live mode: anyone can use it, but only permissions approved via App Review are active. For Consumer apps, Advanced permissions work for everyone and Standard ones only for role users.
- Roles (admin, developer, tester): the roles doc was not read, so the per-role capability split is unverified. The Business Verification page states that apps used only by people with a role on the app need no verification, and those users can grant any permission at any time with all features active.
- Standard Access: default, role users only, no review. Advanced Access: any user; needs Business Verification (since 2023-02-01) and sometimes per-permission App Review. A search snippet suggests Meta may be renaming tiers to Limited/Full Access; the access-levels page itself still says Standard/Advanced.
- Business Verification: done in Business Manager by a Business admin; app is connected under Settings > Basic > Verification, and an unverified Business can be connected. The document list lives in the Business Help Center and was not read: whether a sole proprietor without a registered company can pass is unverified. A 2023 official blog (https://developers.facebook.com/blog/post/2023/02/01/developer-platform-requiring-business-verification-for-advanced-access/) is reported by search to say individual verification no longer substitutes for it (snippet only, unverified).
- Data Use Checkup: annual, required for apps that are Live with a use case or hold Advanced Access; not required in Development mode or at Standard Access; required before switching to Live.
- Data deletion callback: HTTPS endpoint receiving POST `signed_request` (verify HMAC-SHA256 with app secret; payload has `algorithm`, `expires`, `issued_at`, `user_id`), responding JSON `{ "url": "<status page>", "confirmation_code": "<code>" }`; entered in the Data Deletion Request URL field in app settings. Meta's switch-to-Live prompt requiring a Privacy Policy URL plus deletion info (callback or instructions URL) was confirmed only via secondary sources (Adweek, forum posts): treat as probable, not official-verified.

## 8. Capability classification

Classes: (1) available now in Development mode for app-role users; (2) requires App Review; (3) requires Advanced Access / Business Verification; (4) unavailable without approval; (5) future.

| Capability | Class | Notes |
|---|---|---|
| Facebook Login for role users (own Page) | 1 | Role users get all permissions; email/public_profile default at Standard |
| Long-lived user and Page tokens | 1 | Server-side exchange; own Pages |
| Page webhooks (feed, messages, leadgen) for own Page | 1 | Standard Access delivers events only for role users |
| Messenger send/receive with own Page and role-user PSIDs | 1 | `pages_messaging` etc. at Standard Access, no review for own Page |
| Human Agent tag 7-day replies to role users | 1 (unverified) | Tag availability for unreviewed apps not confirmed |
| Instagram messaging/comments on own professional account (either login) | 1 | Standard Access sufficient for own accounts |
| Instagram webhooks for own account | 1 | |
| Lead Ads retrieval for own Page, own ad account, role user | 1 (probable) | `leads_retrieval` use by role users; not explicitly confirmed |
| Messaging real customers / non-role users | 3 | Advanced Access + App Review + Business Verification |
| Instagram messaging/comments for accounts you do not own | 3 | Explicitly stated in the Instagram overview |
| `pages_messaging`, `instagram_manage_messages`, `leads_retrieval` etc. for public use | 2 and 3 | App Review per permission, then Live mode |
| Multi-tenant SaaS onboarding of client Pages | 3 | Needs verified Business; users from other Businesses cannot grant until verified |
| Switching to Live mode | 2/4 | Needs Privacy Policy URL, deletion mechanism, Data Use Checkup |
| Data Use Checkup annual | 3 | Only with Advanced Access / Live |
| Instagram hashtag search, product tagging, partnership ads | 3 | Facebook Login path only; use not needed for MVP |
| Marketing/lead sync via partner CRM listing | 4 | No self-serve path found: unverified |
| One-Time Notification on Instagram | 4 | Not available for IG |
| Retired tags (`CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE`) | 4 | Error 100 since 2026-04-27 |
| One-Time Notification on Messenger | 5 / beta | Beta feature; keep behind a flag |
| Unified Login with system user tokens | 5 | Recommended by Meta for new integrations; build after MVP |
| WhatsApp, Threads, Telegram | 5 | Out of scope of this research |

## 9. Practical path for a solo dev without a company

1. Create a Meta developer account, a Business-type app, and a personal Facebook Page you admin as the test Page. Create or convert an Instagram account to a professional account and link it (or use Instagram Login with no Page).
2. Stay in Development mode. As admin you hold a role, so every permission and webhook works for you and any testers you add (add testers as app roles; the roles doc itself was unread). Test Messenger and Instagram DMs by messaging your own Page from role-user accounts.
3. Build webhook endpoints behind an HTTPS tunnel; implement GET challenge, signature check, dedupe, 200-fast with async processing.
4. Store long-lived user token, derive Page tokens; schedule re-exchange well before day 60.
5. Do not build for public users yet. Going live needs a verified Business, App Review with screencasts, Privacy Policy URL, deletion callback and Data Use Checkup. Whether a sole proprietor can verify without registered company documents is unverified; check the Business Help Center "About Business Verification" page before committing to a launch timeline. Using the CRM only on your own accounts and for role-user testers requires none of this.
6. Design the product as "connect your own Pages" with a mock adapter, so that the real adapter is swappable once approval is obtained.

## 10. Mock-mode requirements

The mock adapter should expose the same interface as the real one and replicate the following, all taken from the official examples above:

- GET verification handshake: query `hub.mode`, `hub.verify_token`, `hub.challenge`; return challenge verbatim.
- Signed POST deliveries: `X-Hub-Signature-256: sha256=<hex>` over the raw body using a test App Secret; fixtures for valid, tampered and missing signature; duplicate delivery and out-of-order timestamps; a retry simulation (fail first, redeliver).
- Messenger (`object: "page"`, `entry[].messaging[]` with `sender.id`, `recipient.id`, `timestamp`): text message (`message.mid`, `message.text`); attachment message (`message.attachments[]` types `image`, `audio`, `video`, `file`, `reel`, `ig_reel`); postback (`postback.title`, `postback.payload`); and delivery, read and echo events (exact schemas unverified: the event pages were not readable).
- Instagram (`object: "instagram"`, `entry[].messaging[]`): message with `mid`, optional `text`, `attachments[{type,payload.url}]`, `is_echo`, `is_deleted`, `is_self`, `is_unsupported`, `quick_reply.payload`, `referral{ad_id,source:"ADS",type:"OPEN_THREAD",ads_context_data}`, `reply_to{mid}` or `reply_to{story{url,id}}`; `message_reactions` with `reaction{mid,action:"react|unreact",reaction,emoji}`.
- Instagram comments, in both envelopes: Business Login shape (`entry[].field` and `entry[].value` with `id`, `from{id,username}`, `text`, `media{id,media_product_type}`) and Unified/Facebook Login shape (`entry[].changes[].value` with `comment_id`, optional `parent_id`, `from`, `text`, `media{id,...}`). Mentions: `changes[].field="mentions"`, `value{media_id}` or `{comment_id,media_id}`.
- Facebook Page feed comment: field `feed`, value with `item`, `verb`, `comment_id`, `post_id`, `parent_id`, `message`, `created_time`, `from{id,name}` (full example not on page: shape partially unverified).
- Lead Ads: `field: "leadgen"`, value `{leadgen_id, page_id, form_id, adgroup_id, ad_id, created_time}`, followed by a stub of `GET /{leadgen_id}` returning lead `field_data` (response shape not read: unverified).
- Send API stub: `POST /{PAGE_ID}/messages` returning `{recipient_id, message_id}`; enforce the 24-hour window locally (reject `RESPONSE` outside it with a Graph-style error, accept `MESSAGE_TAG` + Human Agent within 7 days); error code 100 for retired tags.
- Token behavior: 60-day expiry simulation, invalidated Page token, and the one-hour short-lived Instagram token.
- Rate limit simulation at 300/s text and 10/s media; fixture for the Data deletion callback `signed_request` and its JSON response.

## 11. Pages that could not be read

- https://developers.facebook.com/docs/messenger-platform/send-messages/message-tags (navigation only) and .../documentation/.../send-messages/message-tags.md (404): tag strings unverified.
- https://developers.facebook.com/docs/messenger-platform/reference/send-api (navigation only), .../docs/messenger-platform/webhooks/webhook-events/messages (404), .../docs/graph-api/webhooks/reference/page full examples (partial), https://developers.facebook.com/docs/resp-plat-initiatives/individual-business-verification (404).
- App roles doc, App Review doc, token debugging doc, system user doc, Business Help Center verification docs: not fetched.

## Errata from citation spot-check (2026-11-13)
See `docs/research/citation-spot-check.md`. Corrections to this document: (1) newest Graph API version is v27.0 (released 2026-11-04), not v26.0; v18, v19, v20 are expired; v26 and v27 expiry dates are TBD. (2) The X-Hub-Signature-256 HMAC is computed over an escaped-unicode form (`\uXXXX`, lowercase hex) of the payload as received; hash the exact received bytes. (3) The 36-hour retry window applies to generic Graph webhooks; Messenger and Instagram messaging webhooks alert after 15 minutes and are auto-unsubscribed after 1 hour of failures. (4) Official required-for-Live fields: Display Name, Contact Email, Terms of Service URL, App Icon, Category, App Purpose; Privacy Policy and data deletion URLs are documented but not marked required; Data Use Checkup is annual. (5) Lead retrieval also needs `ads_management`. (6) The `HUMAN_AGENT` tag string is shown lowercase (`human_agent`) on the official feature page; OTN "beta" label is unverified. (7) Meta now recommends Unified Login as a third Instagram setup. (8) Comments: Facebook `feed` webhook needs `pages_manage_metadata` and `pages_show_list`; Instagram `comments`, `live_comments`, `mentions` need `instagram_manage_comments` (Facebook Login) or `instagram_business_manage_comments` plus `instagram_business_basic` (Instagram Login). Story mentions arrive via the `messages` webhook (only mentions, and the mentioner must be public); story replies via this path are unverified.
