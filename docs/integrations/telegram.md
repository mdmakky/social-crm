# Telegram support inbox, v1

Status: implemented on branch `feat/telegram`; not pushed, merged or deployed. **MOCK ONLY: no real Telegram request, bot or message has been used.** The real client exists and is unit tested with fake responses. Everything marked UNVERIFIED stays unverified until a recorded real request with a test bot.

## How an owner connects a bot
1. In Telegram, talk to BotFather, create a bot, copy its token.
2. In the CRM: Settings, Integrations, Telegram, paste the token, Connect bot. (Owner or admin only.)
3. We check the token with `getMe`, store it encrypted, and set the bot's webhook to `<public base>/webhooks/telegram/<random id>` with a fresh random secret. The panel shows `@username`, "Check connection" (webhook health) and Disconnect.
4. People write to the bot in a private chat; their messages appear in the Inbox; replies go out as plain text. A bot cannot start a chat, so a reply needs a message from the person first.

Server needs a public https address in `META_PUBLIC_BASE_URL` (Telegram only delivers to https; ports 443, 80, 88, 8443). Mock mode (`META_MOCK=1`) accepts any base and never contacts Telegram.

## Facts used (official docs)
- Bot API: https://core.telegram.org/bots/api (getMe, setWebhook, deleteWebhook, getWebhookInfo, sendMessage, Update, Message, ChatMemberUpdated). FAQ: https://core.telegram.org/bots/faq. Webhooks guide: https://core.telegram.org/bots/webhooks.
- `setWebhook`: `url` (https), `secret_token` (1-256 chars `A-Za-z0-9_-`, sent back as header `X-Telegram-Bot-Api-Secret-Token`), `max_connections` 1-100 (we use 3), `allowed_updates` (we always send `["message","my_chat_member"]`: omitting it keeps the previous setting), `drop_pending_updates`.
- `getWebhookInfo`: `url`, `pending_update_count`, `last_error_date`, `last_error_message` (used for the health line). `deleteWebhook` on disconnect.
- `sendMessage`: text 1-4096 characters; we send plain text, no `parse_mode`. Error answers carry `error_code`, `description` and, for 429, `parameters.retry_after`.
- A message id is unique within one chat only; the stable person key is the numeric `from.id`; username is optional and can change.
- File URLs from `getFile` contain the bot token, so we never build or store one.

## How it is built
- `packages/integrations/src/telegram.ts`: client, parser, secret check, mock and fixtures. `apps/api/src/inbox/telegram-connect.ts` (connect, health), `telegram-webhook.ts` (public route), `process.ts` (telegram branch), `send.ts` (telegram allowed, rules, delivery), migration `0037_telegram_accounts`.
- Routing and auth of the webhook: unguessable path id + per-account secret, SHA-256 stored, constant-time compare, same 403 for unknown path and bad secret, both rotated on reconnect (decisions D231, D232).
- Receive: store then answer 200; the in-process worker creates contact, identity, conversation and message. Dedupe on identical body (retry of one update) and on `<chat_id>:<message_id>` (D233).
- Send: the one outbound pipeline (pending, sending, sent, failed, unknown), no network call inside a transaction, no retry (D236, D237).

## UNVERIFIED (not confirmed by a real request or by the docs)
1. The bot token format (documented as an opaque string; commonly `<id>:<secret>`). We only check it with `getMe`.
2. That Telegram retries a failed delivery with identical bytes (our update dedupe relies on it; the message key is the backstop).
3. That Telegram sends the secret header exactly as documented, and honours `allowed_updates` and `max_connections` as we set them.
4. Error semantics: 403 when the user blocked the bot or is deactivated, 400 "chat not found", the exact description text (matched loosely), 429 `retry_after` behaviour.
5. That Telegram has no 24 hour reply window for bots.
6. That a bot cannot message a person who never wrote to it (we enforce it ourselves: no reply without an inbound message).
7. Per-chat rate (about one message a second) and the global limits: not enforced by us.
8. `my_chat_member` with status `kicked` for a private chat means "blocked" and `member` means "unblocked".
9. That a private chat id always equals the sender's user id (we ignore updates where they differ).
10. Behaviour behind a real tunnel or proxy (the webhook route keys its rate limits by TCP peer).

## Not done (v1)
Media download and send, groups, channels, business and inline modes, edited messages, `getUpdates` polling, per-chat pacing, automatic 429 retry, long text splitting (over 4096 is refused with 422; the 2000 character reply cap applies first).
