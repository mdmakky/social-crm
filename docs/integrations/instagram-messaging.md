# Instagram messaging (Messenger Platform for Instagram, Facebook Login for Business)

Status 2026-11-14: code complete and tested with mocks. **No real Instagram message has been sent or received by this code.** Everything marked UNVERIFIED needs the hosted test below.

## What Meta documents (read 2026-11-14, pages under developers.facebook.com/documentation/business-messaging/instagram-messaging/ and /messenger-platform/)
VERIFIED from official text:
- Two ways exist: Messenger Platform for Instagram (Facebook Login for Business, a **Page token**, the Page linked to the Instagram professional account carries the conversation) and the Instagram Platform messaging API (Instagram Login). **We use the first**, because the app already has Facebook Login for Business and Page tokens.
- The Instagram account must be a Professional account (Business or Creator) linked to a Facebook Page on which the connecting person can perform the MODERATE task. Instagram app: Settings > Messages and story replies > Message controls > Connected tools > **Allow access to messages** must be on.
- Permissions named: `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`, `pages_show_list` (user-profile page also: `pages_read_engagement`; overview also lists `business_management`).
- Webhook payload: `object: "instagram"`, `entry[].id` = the Instagram professional account id, `messaging[].sender.id` = IGSID, `recipient.id` = our account, `message.mid`, `text`, `attachments`, `is_echo` (our own sends, including ones typed in the Instagram app), `is_unsupported`. `messaging_seen` carries `read.mid`.
- Send: `POST https://graph.facebook.com/{version}/me/messages` (or `/{PAGE-ID}/messages`) with a Page token, body `{"recipient":{"id":"<IGSID>"},"message":{"text":"..."}}`, success `{recipient_id, message_id}`. Text: "less than 1,000 characters" and "1,000 bytes or less" (contradictory wording: we enforce 1000 UTF-8 bytes).
- Window: 24 hours for most user actions (up to 7 days after Click-to-Direct ads). Replies outside the window use the Human Agent tag "under separate rules" (not used).
- No idempotency key is documented. Sends are therefore never retried automatically.
- Error codes (messenger-platform/error-codes): outside window `10/2534022`, `10/2018278`; person unavailable `551`, `551/1545041`, `100/2534014`; IG access `200/2534041`, `100/2534013`, `100/2534029`, `10/2534077`; another app owns the thread `100/2534037`, `10/2018300`; limits `4`, `613/2534040`, `10/1893063`; token `190`.
- Apps with Standard Access can interact only with people who have a role on the app; testers need a role on the app and on the Instagram account.
- The user-profile API (`name, username, profile_pic`) needs user consent (the person messaged the business) and the permissions above.

UNVERIFIED / contradictory (decide by testing, do not assume):
- **Webhook subscription for Instagram.** The pages say "Instagram topic webhooks subscribed" and that the Messenger setup page's `POST /{page-id}/subscribed_apps` works for Pages. They do NOT say that subscribing the Page subscribes the Instagram account. This code therefore does NOT claim it: Instagram accounts report `dashboard_required` and the dashboard step below is mandatory.
- Whether Meta delivers Instagram events to the Messenger callback URL or to a separate one. The ingress now accepts both `/webhooks/meta/instagram` and `/webhooks/meta/messenger`, and decides the channel from the signed `object` field.
- The docs say an app "must be published, regardless of app review status, to receive webhooks" while also saying role holders can test in Standard Access. Whether Development mode delivers Instagram webhooks for role holders is unknown until tested (C8 stays UNVERIFIED).
- Graph fields for the connect screen (`username, name, profile_picture_url` on the Instagram account id) are standard Graph but not shown on the pages read; failure only hides the username (falls back to the Page name).
- Whether a Page token from the existing login configuration carries `instagram_manage_messages` (depends on the configuration below).

## Manual Meta Dashboard actions (you)
1. **Instagram account**: in the Instagram app, switch to a Professional account (Business or Creator); link it to your Facebook Page (Instagram > Settings > Account type and tools > or Page settings > Linked accounts > Instagram). Turn on Settings > Messages and story replies > Message controls > Connected tools > **Allow access to messages**.
2. **Roles**: your Facebook user must be Admin/Developer/Tester on the Meta app AND hold a role on the Page with the MODERATE task (full control) AND be the owner/admin of the Instagram account. The person who will DM it for the test needs a role on the app too (Development mode).
3. **Login configuration** (App Dashboard > Facebook Login for Business > Configurations > the one whose id is in `META_FLFB_CONFIG_ID`): add the permissions `instagram_basic`, `instagram_manage_messages` (plus the existing `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`). Add only these. `business_management` is listed in the overview but is not requested unless /me/accounts later proves to need it. Save, then **reconnect the Page in the CRM** so a new token carries them.
4. **Webhooks**: App Dashboard > Messenger > Instagram settings (or Products > Webhooks, object **Instagram**). Callback URL: `https://social-crm-api-7om7.onrender.com/webhooks/meta/instagram` (the Messenger URL also works, see above). Verify token = the existing `META_VERIFY_TOKEN`. Subscribe the field **messages** (add `messaging_seen` if you want read receipts). Verify and save. If a "Add subscriptions" step asks to pick the Instagram account, pick the linked one.
5. Do not publish or request App Review yet; first test with role holders.

## Hosted verification procedure (after deploy of this branch)
1. Settings > Integrations > Instagram tab > Connect with Meta, approve the dialog (the new permissions appear if step 3 was done), choose the Page, tick "Also connect the linked Instagram account (@username)", Connect. Expect: Instagram account listed with @username, status Connected, subscription "dashboard_required".
2. Check token on the Instagram account: expect valid.
3. From a *different* Instagram account that has a role on the app, send a DM to the connected account. Expect within seconds: a conversation with the Instagram badge in the Inbox, name replaced by the person's name/username and picture after enrichment. If nothing arrives: Webhooks step 4 (subscription) is the first suspect; look at `webhook_events` for platform `instagram`.
4. Reply from the Inbox ("Test IG 1", Enter). Expect Sent and the text in the Instagram DM. One bubble after the echo. Double-click Send: one copy.
5. Record: date, `messages.external_id`, `outbound_attempts.outcome='accepted'`, screenshot. Only then mark C8 and Instagram messaging verified.


---

# Method C: Instagram API with Unified Login (no Facebook Page)

Status 2026-11-14: code complete and tested with mocks and a fake `fetch`. **Never run against real Meta.** Branch `feat/instagram-unified-login`.

**Why this and not "Instagram Login".** Instagram API with Instagram Login (separate Instagram App ID/secret, `graph.instagram.com`) is **not available for newer apps**: the dashboard of this app says so ("Your app uses API setup with Unified login instead"), and Meta's migration guide says "Newly created apps can't set up the Instagram API with Instagram Login". An earlier branch (`feat/instagram-login`) built that variant; it cannot work on this app and is NOT to be merged.

## How it differs from Method A (Page-based)
| | Method A: Page-based | Method C: Unified Login |
|---|---|---|
| Facebook Page needed | yes | **no** ("Your clients don't need a Facebook Page": unified-login page) |
| Business portfolio | not required | required (the person picks one in the dialog) |
| Login | Facebook Login for Business, configuration with Pages | Facebook Login for Business, configuration labelled **Instagram Login Compatible** (Instagram account only) |
| App id / secret | Meta app | the same Meta app |
| Token | Page token | system-user token (SUAT/BISUT), belongs to the business portfolio; expiry depends on the configuration (default shown in the dashboard: never) |
| Account discovery | `me/accounts` | `me/assigned_instagram_accounts` |
| Send | `me/messages` | `POST /{ig-id}/messages` (`me` would be the system user) |
| Permissions | `instagram_basic`, `instagram_manage_messages`, `pages_*` | `instagram_basic`, `instagram_manage_messages` (from the configuration, no scope parameter) |
| Webhook subscription | dashboard (a Page call is not documented to cover Instagram) | per account: `POST /{ig-id}/subscribed_apps` with the token, plus the dashboard callback |
| Stored as | `auth_method='facebook'` | `auth_method='unified'` |
Both give the same `platform='instagram'` account, webhooks, conversations, messages and Inbox. The account id from `assigned_instagram_accounts` equals the webhook `entry.id` (migration guide step 7), so routing is unchanged. One Instagram account can be connected once, in one workspace.

## Verified from the official pages (read 2026-11-14, developers.facebook.com/documentation/instagram-platform/...)
- Unified Login page and overview: Facebook Page "Not required", Business portfolio "Required"; Business and Creator accounts are eligible; personal accounts are not (error `(#10) ... instagram account type is not business or creator`).
- Dialog: `https://www.facebook.com/dialog/oauth?client_id=<META_APP_ID>&config_id=<CONFIG_ID>&redirect_uri=...&response_type=code` (`prompt=login` shows both the Facebook and Instagram sign-in options). The person chooses the business portfolio and the Instagram account to share. If messaging is used, the person must also turn on "Allow access to messages" in Instagram.
- "Your app doesn't receive an access token directly from the login flow": the server exchanges the code at `https://graph.facebook.com/v27.0/oauth/access_token?client_id&client_secret&code` with the **Meta** app id/secret and receives the system-user token.
- Accounts: `GET /me/assigned_instagram_accounts?fields=id,username` (needs `instagram_basic`).
- Send to `graph.facebook.com/{ig-user-id}/messages` with that token; permissions `instagram_manage_messages`; 24-hour window; Human Agent tag exists (not used). Message ids differ in format from the Instagram Login ones.
- Per-account subscription `POST /{INSTAGRAM_ACCOUNT_ID}/subscribed_apps?subscribed_fields=...` with the token; payload `object: "instagram"`, `entry[].id` = the Instagram professional account id; signature `X-Hub-Signature-256` with the App Secret.
- The token stops working if the client removes the app from the business portfolio or moves the Instagram account to another portfolio.
- Development mode: add the Instagram account as an **Instagram Tester** (up to 50, accepted in Instagram on the web); Standard Access is enough for people with a role on the app; "Test users aren't supported".

## UNVERIFIED (decide by the hosted test; documented as unknown, not assumed)
1. **Webhooks in Development mode.** Meta: "Your app must be published or Live to receive notifications for app users". Whether role holders/testers receive Instagram webhooks while unpublished is NOT stated. If DMs do not arrive, this is the first suspect; sending is unaffected.
2. **Where the webhook callback is configured**: the migration guide says "the callback URL set for the Instagram object on your Meta app"; the setup page says "Configure webhooks on the API setup with Unified login tab". Both quoted from Meta; use the one your dashboard shows (the screenshot shows step "3. Configure webhooks" on that tab).
3. Message request body for Unified Login (the page returned no content; the guide says "most request bodies stay the same", so the same text body is used) and message-related error codes (Page-API subcodes are mapped but may differ).
4. Token expiry/refresh: depends on the configuration ("Never" is the dashboard default). Refreshing an expiring token needs Meta's Business Integration System User token management API and `business_management`; **not built**. If you choose a configuration that expires, the account moves to "Reconnect needed" at the 6-hourly token check after expiry.
5. Whether the same app can run Page-based Facebook Login and this configuration side by side: not stated; the shared redirect-URL list in the dashboard already lists both kinds of URLs on one screen, so it is expected to work.
6. Webhook field names for this variant (`messages`, `messaging_seen`, `message_reactions` ...): the server subscribes `messages,messaging_seen` and falls back to `messages` alone.
7. Whether the sender profile call (`name, username, profile_pic` on `graph.facebook.com/{igsid}`) works with this token; if not, names stay "Instagram user ####".
8. `graph.facebook.com` unified-login webhook signatures: assumed to use the Meta app secret already configured.

## Dashboard setup you must do (nothing is changed by the code)
App Dashboard > **Use cases** > **Manage messaging & content on Instagram** (Customize) > **API setup with Unified login**:
1. **1. Configure your app**: click **Create new configuration**; choose the Instagram account asset and permissions `instagram_basic` and `instagram_manage_messages` only; save. It must be labelled "Instagram Login Compatible" (otherwise people will not see the Instagram sign-in). Copy its **Configuration ID**.
2. Same section, **Register a new redirect URL**: `https://social-crm-web.vercel.app/v1/integrations/instagram/callback` > Save. (The dropdown above it can stay on the existing `.../integrations/meta/callback`.)
3. **2. Generate access tokens**: add your Creator account as an **Instagram Tester** (Roles tab), then accept the invitation in Instagram on the web (instagram.com > Settings > Website permissions / Apps and websites > Tester invites). Per Meta the account must be public.
4. **3. Configure webhooks**: callback URL `https://social-crm-api-7om7.onrender.com/webhooks/meta/instagram`, verify token = your existing `META_VERIFY_TOKEN`; subscribe `messages` (and `messaging_seen`). The screenshot already shows this step ticked; check the callback URL is the Instagram one.
5. In the Instagram app on the Creator account: Settings > Messages and story replies > Message controls > Connected tools > **Allow access to messages**.
6. Render > Environment: add `META_IG_CONFIG_ID` = the Configuration ID from step 1. (`META_IG_OAUTH_REDIRECT_URI` only if you registered a different URL.) No new secret: the existing Meta app id/secret are used. Redeploy the API.
Until `META_IG_CONFIG_ID` exists the "Connect Instagram" button is disabled with the reason.

## Test with your Creator account (no Page)
1. Do the dashboard setup and deploy this branch (code + the env var). The migration adds one column (below).
2. Settings > Integrations > Instagram > **Connect Instagram** (right-hand card). Choose Instagram sign-in, pick the business portfolio and the Creator account, allow. Expect "Instagram account connected directly", row `@username`, "Direct · no Page", Connected. If it says the subscription was not accepted, press **Re-check subscription**.
3. **Check token**: valid. Expiry shows if the configuration has one.
4. From another Instagram account that has a role on the app, DM the Creator account. Expect the conversation (Instagram badge). If nothing arrives: unverified item 1, then the callback URL/verify token (dashboard), then `webhook_events` rows with platform `instagram`.
5. Reply "Test direct 1" with Enter: Sent, text in the Instagram DM, one bubble after the echo; double-click Send: one copy.
6. Record the date, `messages.external_id`, `outbound_attempts.outcome='accepted'` and a screenshot before marking Method C verified.

## Production / App Review
Not requested by this work. For accounts you do not own, `instagram_manage_messages` needs Advanced Access (App Review, Business Verification) and the app must be Live to receive webhooks. Existing Advanced Access to `instagram_*` permissions carries over (migration guide).

## Migration 0024 and rollback
`0024_instagram_unified_login.sql` adds `integration_accounts.auth_method text NOT NULL DEFAULT 'facebook'`, two CHECK constraints (`facebook`|`unified`; `unified` only for `platform='instagram'`) and `GRANT UPDATE (auth_method) ... TO crm_worker`. A constant default makes this a metadata-only change on Postgres 11+; existing rows are `facebook`. Old code ignores the column, so the migration may run before the API deploy.
Rollback: disconnect (or delete the secrets of) every account with `auth_method='unified'` first (their tokens are not Page tokens), then as `crm_migrator`: `ALTER TABLE integration_accounts DROP CONSTRAINT integration_accounts_auth_method_platform, DROP CONSTRAINT integration_accounts_auth_method, DROP COLUMN auth_method;` and remove journal entry 24.

## Troubleshooting
- Button disabled "not configured": `META_IG_CONFIG_ID` missing on Render.
- Dialog error about redirect URI: the URL is not registered in step 2 or differs (host, trailing slash); `META_IG_OAUTH_REDIRECT_URI` must match.
- The Instagram option is missing in the dialog: the configuration is not "Instagram Login Compatible".
- Returned with "no Instagram account was shared": connect again and select the account; it must be Business or Creator, not personal.
- "Login link expired": start again from the same browser (the state is bound to it, valid 10 minutes).
- Connected but no messages: unverified item 1; then Re-check subscription; then the dashboard callback.
- "Reconnect needed": the token was revoked, the app was removed from the portfolio, or an expiring configuration expired. Reconnect.
- Cannot send: the person must have written within 24 hours; the text limit is 1000 bytes.
- Secrets in URLs: the code exchange is a documented GET that carries the Meta app secret in the query string (existing behaviour of the Facebook flow); the code never logs URLs or error text.
