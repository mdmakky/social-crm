# Real Meta test runbook (not yet executed)

**Status: NOT RUN.** Nothing below has been observed against Meta. Record each result as: request (redacted), response (redacted), date, verdict. Never record tokens or secrets. Mock results do not count. Prerequisite check: `dev/meta-preflight.mts` (see `meta-oauth-readiness.md`); any missing item is reported with its exact action instead of continuing.

| # | Test | Pass means | Records / settles |
|---|---|---|---|
| R1 | `meta-preflight.mts --graph` | App ID and Secret valid (REAL debug_token on app token) | credentials |
| R2 | Handshake: Meta dashboard "Verify and save" for messenger | dashboard accepts; API log shows GET 200 | webhook verify |
| R3 | OAuth: Settings > Integrations > Connect with Meta, approve in the dialog | redirect to `?meta=select`; Page list shows the test Page and eligibility; localhost redirect accepted (settles that UNVERIFIED) | dialog, code exchange, long-lived token, `/me/accounts`, `/me` |
| R4 | Connect Page | account `connected`, subscription `subscribed`; check `GET subscribed_apps` result; `tasks` field present or `tasksUnverified` event | Page token, subscribed_apps, tasks |
| R5 | Linked Instagram: tick "also connect Instagram" | IG account created; `instagram_business_account` returned (settles linked-IG discovery); subscription shows `dashboard_required` | IG discovery |
| R6 | Messenger delivery: message the Page from a person with an app role | webhook row `signature_valid`, processed into a conversation; capture the real header name and payload shape (settles C1 non-ASCII: send text with non-ASCII characters too) | signature, payload |
| R7 | Instagram delivery (separate): message the IG account | row arrives or not; header used; `object` and `entry.id`; **settles C8**, until then C8 stays UNVERIFIED | C8 |
| R8 | Echo: reply from the Page inbox app | `is_echo` event stored as outbound; `app_id` seen | echo shape |
| R9 | Token check | `debug_token` valid, `expires_at`, scopes returned | token lifecycle |
| R10 | Disconnect then reconnect | `DELETE subscribed_apps` accepted with the Page token or not (settles that UNVERIFIED); account `disabled`, secret gone; reconnect restores | disconnect |
| R11 | Remove the app in Facebook settings (Apps and Websites) | deauthorize callback arrives: record method, content type, body; accounts become `reauth_required` | deauthorize body |
| R12 | Data deletion: Facebook settings > request deletion (or dashboard test) | callback arrives; status link opens | data deletion |
