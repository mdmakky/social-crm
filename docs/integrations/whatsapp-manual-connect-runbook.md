# WhatsApp manual connection: operations runbook

Status 2026-11-16: built and tested against the MOCK Graph only. Nothing here has been observed against real Meta. Facts and unknowns: `whatsapp-cloud-api.md`. Smoke test (section 6) is NOT RUN.

## 1. Meta app dashboard: webhook (once per app, done by a human, never by this code)
1. App dashboard, WhatsApp, Configuration (or Use cases, Customize, Configuration).
2. Callback URL: `<API public URL>/webhooks/meta/whatsapp` (the Render API, not the web app).
3. Verify token: the value of `META_VERIFY_TOKEN` on the API service.
4. "Verify and save": Meta sends a GET; the API must answer with the challenge. Deliveries are signed (`X-Hub-Signature-256`) with the app secret (`META_APP_SECRET`) over the raw body; unsigned or wrongly signed posts are stored as rejected and never processed.
5. Subscribe the `messages` field. UNVERIFIED whether this must be ticked in the dashboard after the API subscribes the WABA; the Meta docs page for webhook setup does not name the field (the manage-webhooks page defines it). Tick it.

## 2. System user (in Meta Business Settings, by the business admin)
1. Business Settings, Users, System users, Add. Role: Admin or Employee (Employee is enough if the assets below are assigned).
2. Add assets: the app (Develop app / manage app) and the WhatsApp account (WABA) with full control.
3. The WABA must belong to the same business that owns the app (the "direct developer" case). Using a customer's WABA is NOT documented for this token type and is not supported by this slice.

## 3. Token
1. Generate new token for the system user, select this app.
2. Permissions: `business_management`, `whatsapp_business_management` (required by the connect check), `whatsapp_business_messaging` (needed for sending in a later slice; recorded on the connect event).
3. Expiry: Meta lets you choose an expiry preference (docs: system tokens are long-lived). Prefer a token that never expires, else note the date: an expired token shows as "Reconnect needed" after the daily token check.
4. Copy it once. Never paste it into chat, tickets or logs.

## 4. Manual connection (Settings, Integrations, WhatsApp)
Needs the owner or admin role. Steps: enter the WhatsApp Business Account ID and the token, "Find numbers", pick a number, "Connect number". The token is checked (valid, issued to THIS app, has `whatsapp_business_management`), the number must belong to that account, the token is stored encrypted, and the app is subscribed to the WABA. Earlier events for that number (stored as orphans) are queued again.
- Limits: 30 lookups and 10 connects per user per workspace per 10 minutes (in process; see section 7).
- Errors: `token_invalid`, `permission_missing`, `waba_not_accessible`, `number_not_found`, `waba_mismatch` (409, the number is connected under another WABA id), `account_unavailable` (409, the number is held by another workspace), `rate_limited` (429), `meta_unavailable` (502).
- "Re-check subscription" repeats the WABA subscribe; "Check token" runs debug_token. Subscription failure after a successful connect keeps the connection and shows "subscription failed".

## 5. Disconnect and number reservation
- Disconnect deletes the stored token and disables the account. It NEVER unsubscribes the app from the WABA (the subscription is per WABA; another workspace may hold another number of it).
- A disconnected number stays reserved to its workspace and its WABA id: reconnecting there works; another workspace gets 409 `account_unavailable` (the lookup marks it "already connected to another workspace"); a different WABA id gets `waba_mismatch`. There is no in-app release.
- Release (ops, DB owner, only when the account is `disabled` and has no conversations): delete the `whatsapp_accounts` row, then the `integration_accounts` row of that number (cascade or explicit per FK). Do this in a transaction after a backup, and record who asked. Not scripted yet: needs a reviewed script before first use.

## 6. Real Meta smoke test (NOT RUN; record request/response redacted, date, verdict; never tokens)
Use a test WABA and the test number; message only people who have a role on the app (development mode).
| # | Step | Settles |
|---|---|---|
| W1 | Dashboard "Verify and save" for the callback | handshake |
| W2 | Settings, Integrations, WhatsApp: Find numbers with the real WABA id and token | `GET /{waba}/phone_numbers` fields and pagination |
| W3 | Connect number | `debug_token` shape for a system user token (`app_id`, `scopes`, `expires_at`); plain `POST /{waba}/subscribed_apps` with a bearer token (docs conflict); result "Webhook subscribed" |
| W4 | `GET /{waba}/subscribed_apps` (manually, outside the app) | our app is listed |
| W5 | Send a WhatsApp message to the number from an allowed phone | row `signature_valid`, processed into a conversation; real payload shape |
| W6 | Check token; wait for the daily check | token lifecycle |
| W7 | Disconnect, then send again | event arrives, stored as orphan (`account_disabled`), nothing processed; reconnect replays it |
| W8 | Wrong token, then token for another app | `token_invalid` messages; no row stored |
Stop if W3 fails: the subscribe call is the one with conflicting docs; record the exact Meta error code.

## 7. Operational assumption: ONE API instance
`render.yaml` runs one instance (`numInstances: 1`, Free plan). The rate limits of the connect routes, imports and password reset, and the OAuth pending store, are in process memory. With 2+ instances the effective limits multiply and OAuth state breaks. A deploy briefly overlaps two processes: counters are not shared then, which is acceptable. Before scaling out, move the counters to a Postgres table (`INSERT ... ON CONFLICT DO UPDATE` on a window key; no new infrastructure).
