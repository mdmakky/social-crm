# WhatsApp Cloud API: slice 1 (webhook foundation)

Status: implemented on branch `feat/whatsapp-foundation`; not pushed, merged or deployed. Mock and fixture tests only: **no real WhatsApp request, number, or message has been used.**

## What slice 1 does
- `POST /webhooks/meta/whatsapp` accepts signed WhatsApp webhook bodies; `GET` answers Meta's verification handshake (same verify token as the other channels).
- Every `changes[]` item with `field: "messages"` becomes its own stored `webhook_events` row, keyed by `value.metadata.phone_number_id` (= `integration_accounts.external_account_id`). `entry[].id` is the WABA id and is never used for routing.
- The worker (same in-process worker and routing as Messenger/Instagram) creates contact, identity, conversation and message for a connected WhatsApp account; `delivered`/`read` statuses of a message we sent move the conversation watermarks.
- Migration `0025_whatsapp_foundation`: `whatsapp` accepted by the platform checks (`integration_accounts`, `webhook_events`, `contact_methods.source`), worker policy and placeholder-name guard extended, new tenant table `whatsapp_accounts` (forced RLS, worker writes, members read, identity immutable, parent must be a WhatsApp account of the same workspace).
- Integrations page: WhatsApp stays a "Coming soon" channel with an honest reason (no connect, no send). The Inbox shows WhatsApp conversations read-only with a notice instead of a composer; the API refuses a reply with `422 unsupported_channel`.

## Not in slice 1
Connecting a number (slice 2), sending, templates, media download, Embedded Signup, Coexistence, token handling. A message for a number nobody connected is stored as an `orphan` event and can be replayed (`orphan -> received`) after the account exists.

## Verified against Meta's official pages (read 2026-11-14)
Pages: `documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint` and `.../webhooks/reference/messages/*` (the old `developers.facebook.com/docs/whatsapp/cloud-api/webhooks/...` URLs return 404).
- Signature: header `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 of the raw body with the **app secret** (same scheme and same secrets as Messenger/Instagram, so `verifyMetaSignature` is reused).
- Handshake: `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`; answer 200 with the challenge.
- Retries: immediately, then with decreasing frequency for up to 7 days; "your server should handle deduplication". POST bodies may batch up to 1000 updates. No API for historical webhooks.
- Payload: `object: "whatsapp_business_account"`, `entry[].id` = WABA id, `changes[].field` = `messages`, `value.messaging_product`, `value.metadata.{display_phone_number,phone_number_id}`, `value.contacts[]` (`profile.name`, `wa_id`, `user_id`), `value.messages[]` (`from`, `id` = `wamid.…`, `timestamp` = Unix **seconds as a string**, `type`, and a type object), `value.statuses[]` (`id`, `status`, `timestamp`, `recipient_id`, `errors[]`).
- Type objects used: `text.body`; `image|video|document` `{id, mime_type, sha256, caption, (filename)}`; `audio {id, mime_type, voice}`; `sticker {id, mime_type, animated}`; `button.text`; `interactive.button_reply|list_reply.title`; `location`, `reaction {message_id, emoji}`, `unsupported {type}` + `errors[]` on the message.
- Status values: `sent`, `delivered`, `read`, `failed`, `played`.
- Media: a media `id` is exchanged for a URL with a GET using the access token. The webhook `url` field is "being released gradually since 2025-11-12". The pages state no retention time for an id or url.
- Identity: Meta says to identify users by `user_id` (BSUID, e.g. `US.1349…`); `wa_id`/`from` are omitted for username-only users who have no phone number available.

## Inferred or decided by us (NOT verified against a real account)
- Real payloads match the documented field lists. The fixtures (`buildWhatsAppChange`) are built from those lists, not captured from Meta.
- The sender key is `wa_id` (`from`, digits). A message with only `from_user_id` (BSUID) is **ignored with reason `bsuid_only`** and its raw body is kept for 30 days; it creates no conversation. This is the main open design question (see blockers).
- The webhook media `url` is never stored (it is not a public link and needs a token). Only `mediaId`, `mime`, and a document `name` are kept in `messages.attachments`; the message shows "Attachment · image — not available" until slice 3 adds a proxy download. The contract currently strips `mediaId` from API output.
- Locations are stored as a placeholder only (coordinates and name are not copied). Reactions and system notices are ignored. Unknown types become an "unsupported" placeholder instead of a silent drop.
- `delivered`/`read` statuses count only if the message id is a message **we** stored on that account (direction out). `sent`, `failed`, `played` are ignored (nothing of ours exists yet to attach a failure to).
- A contact is named `WhatsApp user NNNN` (last four digits). `contacts[].profile.name` is not used yet.
- The webhook callback for WhatsApp is configured per app in the Meta dashboard (Webhooks, object WhatsApp Business Account, field `messages`); whether it must be a separate URL from Messenger is unverified, and our handler takes the channel from the signed `object` anyway.

## Blockers and inputs for slice 2 (manual onboarding)
1. A WhatsApp Business Account, a phone number, and a system-user token with `whatsapp_business_management` + `whatsapp_business_messaging`. Direct (non Tech Provider) use with a system-user token is implied by Meta's wording but not stated outright: verify in slice 2.
2. Decide BSUID handling: relax `platform_identities.external_user_id` (currently digits only) and key identities by `user_id` when Meta stops sending `wa_id` for username users, or keep a phone-only policy. Needs a real payload.
3. Dashboard step (not done): subscribe the app to the WhatsApp Business Account webhook, callback `https://social-crm-api-7om7.onrender.com/webhooks/meta/whatsapp`, field `messages`, same verify token. Nothing was changed in production Meta settings.
4. No new environment variable was added in slice 1.

## Rollback
Migration `0025` is additive except the replaced CHECK constraints and two worker policies. To undo it on an empty `whatsapp` dataset: drop trigger/function `whatsapp_accounts_guard`, drop table `whatsapp_accounts`, restore the three CHECKs and the two policies and the name-guard function from `0017`/`0022`/`0019`. With WhatsApp rows present the CHECKs cannot be restored until those rows are removed.
