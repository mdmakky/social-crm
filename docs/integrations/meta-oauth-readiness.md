# Meta OAuth readiness (Slice 3), 2026-11-13

Sources: official Meta developer docs fetched today (see also `meta-api-verification-2026-11.md`). Nothing here proves runtime behaviour; no real Meta request has been made. UNVERIFIED stays UNVERIFIED until a recorded real request.

## Verified from the docs (used by the implementation)
- FLfB dialog: `https://www.facebook.com/<version>/dialog/oauth?client_id&redirect_uri&state&config_id` (`config_id` replaces `scope`); default response type `code`; the redirect carries `code` and the unchanged `state`; cancel returns `error=access_denied&error_reason=user_denied`.
- Code exchange: `GET /<version>/oauth/access_token?client_id&redirect_uri&client_secret&code` -> `access_token`, `token_type`, `expires_in`. Long-lived: `grant_type=fb_exchange_token` (about 60 days). Page tokens obtained from a long-lived user token "do not have an expiration date" but "expire or are invalidated under certain conditions" (conditions not listed: UNVERIFIED).
- Pages: `GET /me/accounts` (token fields seen in the long-lived guide: `access_token`, `name`, `id`, `tasks`); linked Instagram account via the Page fields `instagram_business_account` / `connected_instagram_account`.
- Page subscription: `POST /<page-id>/subscribed_apps` with `subscribed_fields`, `GET` lists, `DELETE` removes (needs `pages_manage_metadata`, `pages_show_list`, a Page token from a user with a task on the Page). **Instagram webhooks cannot be subscribed through `subscribed_fields`: the app dashboard must be used.** App-level callback URL and verify token: dashboard Webhooks product, or `POST /<app-id>/subscriptions` (not for Instagram).
- `debug_token` needs an app access token (`app_id|app_secret`).
- Graph versions: v26.0 is the latest in the versions table, `debug_token` shows v27.0; config default is `v25.0` (documented expiry 2028-07-29), overridable with `META_GRAPH_VERSION`.

## UNVERIFIED / not found (do not rely on)
- Whether `http://localhost` redirect URIs are accepted in Development mode (docs say Strict Mode exact match and HTTPS enforcement; localhost not mentioned). Fallback: a second Quick Tunnel to the web app.
- Which permissions work in Development mode without App Review; the exact FLfB configuration permission list (candidates named in docs: `pages_messaging`, `pages_show_list`, `pages_manage_metadata`, `business_management`, `instagram_basic`, `instagram_manage_messages`).
- Whether the Page `tasks` list is returned and which task a send needs (docs name `MESSAGE`; we do not enforce it).
- The Instagram username field on the IG user (not requested; display name is "<Page name> (Instagram)").
- Whether `DELETE subscribed_apps` accepts the Page token (docs name an app access token); the client sends the Page token and ignores failure on disconnect (the account is disabled either way).
- Instagram webhook publication requirement and signature header behaviour: **C8 stays UNVERIFIED.**
- Data deletion and de-authorization callbacks: required by Meta for apps; Development-mode applicability NOT FOUND. Not implemented in Slice 3 (listed as remaining).

## What the owner must do (actual Meta account actions)
1. Create a Meta app (Business type) under a Meta developer account; add products Facebook Login for Business, Messenger, Webhooks (and Instagram if testing it). Note App ID and App Secret.
2. In Facebook Login for Business create a Configuration (user access token, assets: Pages and Instagram accounts, permissions as the dashboard offers for Messenger/Instagram messaging). Note the Configuration ID.
3. Add `http://localhost:3000/v1/integrations/meta/callback` to Valid OAuth Redirect URIs (if rejected, tell us: fallback above).
4. Webhooks: callback URL `<tunnel>/webhooks/meta/messenger`, verify token = `META_VERIFY_TOKEN`; for Instagram set the fields in the dashboard.
5. Use a test Facebook Page where you have full control (and an Instagram professional account linked to it, with "Allow access to messages" on) and a person with a role on the app.
6. Put `META_APP_ID`, `META_APP_SECRET`, `META_FLFB_CONFIG_ID`, `SECRETS_ENCRYPTION_KEY` (`openssl rand -base64 32`), `META_VERIFY_TOKEN`, `DATABASE_URL_*` in `.env` (never commit; never paste secrets into chat).
