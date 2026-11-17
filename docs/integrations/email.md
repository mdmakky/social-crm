# Email support inbox (MOCK, 2026-11-17)

Status: built and tested against a MOCK provider only. **No request to Mailgun or any mail server has ever been made from this code.** Live delivery, live receiving and the Mailgun field names marked UNVERIFIED below are not proven. The UI says "MOCK" and "Not tested live".

Branch `feat/email-channel` (from `feat/channels-foundation`), migration 0039, decisions D250 to D259.

## What it does
A workspace gets a support address `support+<token>@<EMAIL_INBOUND_DOMAIN>`. Customer email to that address becomes a conversation (one per verified sender, like Messenger). Agents reply from the Inbox; the reply goes out as `support@<sending domain>` with threading headers. No third-party approval process (unlike Meta): the owner needs a domain, a mail provider account and DNS records.

## Design
- Ports, provider neutral (`packages/integrations/src/email.ts`): `EmailProvider.send()` returns the provider message id; `parseMailgunInbound`, `verifyMailgunSignature`, `parseMailgunEvent` are the Mailgun inbound side. `MockEmailProvider` (in memory, scriptable failures) and `createMailgunProvider` (HTTPS API, no new dependency) ship. Postmark is the documented alternative and is NOT implemented.
- Env (`.env.example`): `MAIL_PROVIDER=file|mock|mailgun`, `MAILGUN_API_KEY`, `MAILGUN_SIGNING_KEY`, `MAILGUN_DOMAIN`, `EMAIL_INBOUND_DOMAIN`, optional `MAILGUN_BASE_URL` (EU). Secrets are never logged; the guard names variables, never values.
- Production guard (D259, `apps/api/src/mail-config.ts`): production still fails closed unless `MAIL_PROVIDER=mailgun` and all four keys are present. `file` and `mock` never run in production. The Mailer port (password reset, invitations) rides on the same provider when it is mailgun; `INVITATION_EMAIL` stays default 0.
- Data (migration 0039): `email_accounts` (side row of an `integration_accounts` row, platform `email`; `inbound_token` = the account's external id), `email_threads` (opaque per-conversation token), `email_message_meta` (Message-ID, In-Reply-To, References, subject, from, unverified flag, attachment names; append-only), `contact_methods.undeliverable_at/_reason`. All tenant tables have workspace_id, forced RLS and policies; the app role can only SELECT them.
- Connect (no OAuth): Settings > Channels > Integrations > Email. Support address, DNS steps in plain words, collapsed "Technical details", "Check setup" (canned results in mock; the Mailgun path honestly answers "not built yet"), turn on/off, disconnect. Permission `integration.manage`; audit `integration.email.connected|enabled|disabled|disconnected|setup_checked`.

### Inbound (`/webhooks/email/inbound`, `/webhooks/email/events`)
Order, as the Meta webhook: 1 MB body cap, rate limit per peer, signature FIRST (constant-time, stale timestamps refused, replayed token acknowledged and not stored again), then store a normalised JSON in `webhook_events` (platform `email`) and answer 200. The worker (`process.ts` -> `email-inbound.ts`) does everything else.
- Workspace resolution only from the verified recipient token. Unknown token -> orphan, nothing is created. A recipient with no valid token is stored as an unrouted orphan. Disabled account -> orphan `account_disabled` (not re-queued on re-enable).
- Idempotency: `Message-ID` header, unique per account.
- Threading, never by subject: In-Reply-To, then References (newest first), against Message-IDs stored for THIS account; then the conversation token in the Reply-To address (`support+<token>-<convToken>@`), checked against this account; else the sender identity.
- Not trusting From: a sender counts as verified only when the SPF and DKIM verdicts are both "pass" and the envelope sender and From share a registrable domain. Others get their own identity (`email-unverified:<addr>`), a separate contact with no email method, the badge "Unverified sender", and cannot be replied to. They can join a thread only via In-Reply-To or the conversation token.
- Dropped as ignored (webhook row `ignored:<reason>`): `Auto-Submitted` other than `no`, `Precedence` bulk/junk/list/auto_reply, `List-Id`/`List-Unsubscribe`, delivery reports, empty Return-Path, mailer-daemon/noreply/bounce senders, our own address (loops), more than 60 inbound messages per conversation per hour. Per sender: 30 per hour, beyond that acknowledged and dropped.
- Content: plain text only (Mailgun `stripped-text`, else a quote stripper that cuts at "On ... wrote:", "Original Message" and trailing `>` lines). `body-html` is never stored and never rendered. Attachments are not stored; names and sizes are recorded as "N attachments not stored". Messages are capped at 20,000 characters.

### Outbound
Through the existing send pipeline (pending, sending, sent, failed, unknown; `outbound_attempts`; no provider call inside a transaction, D72; never retried). From `support@<domain>` with the workspace name as display name; Reply-To `support+<token>-<convToken>@<inbound domain>`; own Message-ID `<crm.<token>.<random>@domain>`; In-Reply-To = last customer message; References = the chain (last 20); Subject = the customer's subject with a single `Re: `; `Auto-Submitted: no`; plain text. The recipient is always the conversation's own identity. No auto-replies. No reply window rule. Failure codes: `provider_auth`, `provider_rejected`, `rate_limited` (rejected); `provider_unavailable`, `no_response`, `unreadable_response` (unknown).
- Bounces and complaints: the events webhook marks the contact's email undeliverable (address read from our stored message, never from the event); it is shown in the thread and further replies are refused.

## Owner setup (when a real provider is wanted)
1. A domain or subdomain you control (for example `support.example.com`). Use a subdomain so your normal mail is untouched.
2. A Mailgun account and a sending domain. Add the DNS records Mailgun shows: sending (SPF include, DKIM key) and receiving (MX). Add a DMARC record (start with `p=none`).
3. In Mailgun create a route: match recipient `support\+.*@<inbound domain>` (UNVERIFIED expression) with action forward to `https://<api host>/webhooks/email/inbound`. Add a webhook for permanent failures and complaints to `/webhooks/email/events`.
4. Set the five env variables on the API host. Restart. Open Integrations > Email, create the address.
5. Send a real test message and look at the stored webhook row before relying on it. Until someone does, this stays "Not tested live".

## Risks
- Spoofed From: mitigated by the verdict rule above, but only as good as the verdict fields (UNVERIFIED) and the domain heuristic.
- HTML: never stored or rendered. Attachment malware: nothing is stored or opened. Loops: auto-mail dropped, our own address dropped, rate limits, we never auto-reply, and replies carry `Auto-Submitted: no` only because a person wrote them.
- Replying to an unverified sender is blocked on purpose (it would mail whoever the forger named).
- Real mail with large attachments exceeds the 1 MB webhook cap and is refused (413); the provider will retry then give up. Decision for v1; a storage-based flow is a later slice.

## UNVERIFIED list
Confirmed from Mailgun documentation on 2026-11-17: webhook signature (hex HMAC-SHA256 of timestamp+token with the Webhook Signing Key; token/timestamp/signature fields), route forward field names (`recipient`, `sender`, `from`, `subject`, `message-headers`, `body-plain`, `body-html`, `stripped-text`, `attachment-count`), send endpoint `POST /v3/{domain}/messages` with basic auth and `h:` custom headers.
Not confirmed (code and docs label them UNVERIFIED):
1. The SPF/DKIM verdict names (`X-Mailgun-Spf`, `X-Mailgun-Dkim-Check-Result`) and that they are in `message-headers`.
2. The events webhook JSON shape and the `failed`/`permanent`/`complained` values; that the event carries our Message-Id.
3. That Mailgun keeps a custom `h:Message-Id` we set (threading depends on it).
4. The send response (`id`, `message`) and the exact error codes beyond 400/401/429/500.
5. The MX hostnames, the SPF include value, the route recipient expression, the EU base URL.
6. That a Mailgun route POST with a 1 MB cap and 5 hour retry behaves as assumed; behaviour on a 413 answer.
7. Everything about real deliverability, DKIM alignment and spam placement.
