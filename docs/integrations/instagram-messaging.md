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
