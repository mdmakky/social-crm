# Website chat (channel `web_chat`)

Anonymous visitors on a customer's website chat with agents in the normal Inbox. Branch `feat/web-chat` (local, not merged). Decisions D240 to D249.

**Honest status: tested only against our own local servers** (the web app, the API, and two tiny static pages on other ports acting as "customer sites"). It has not been run on a real third-party site, behind a real CDN, with a real strict Content-Security-Policy, ad blockers, page builders, Safari/Firefox, or on a phone. The settings page shows a "Not tested on real sites" badge for this reason.

Prior art used for the shape (not copied): Chatwoot's public widget API (`/api/v1/widget/*`, a per-session token, optional signed identity). Items marked **UNVERIFIED** are our judgement, not something we confirmed against a source or in production.

## How it fits together

```
customer page --loads--> <web>/widget.js --adds--> launcher button + <iframe src="<web>/widget/<key>?host=<page origin>">
iframe (web origin) --fetch--> <web>/public/widget/<key>/*  (route handler: strips cookies, allowlists paths)
                       --server-to-server--> <api>/public/widget/<key>/*
agent: Inbox (unchanged) --> POST /v1/workspaces/:id/conversations/:id/messages (existing send pipeline)
```

- A widget (`chat_widgets`) owns one integration account (`platform = 'web_chat'`, random 15 digit external id). A visitor is a `platform_identities` row (`external_user_id` = the session's random 15 digit `visitor_ref`), with a contact (`source = 'web_chat'`) and one conversation. So the Inbox, AI suggestions, tasks, leads and contact extraction work unchanged.
- Contact placeholder name is `Web chat user NNNN` (last 4 digits of the visitor ref), not "Visitor ...": the existing database guard (`contacts_worker_name_guard`, migration 0036) lets the worker replace only names of that shape, which is what lets the optional pre-chat form fill in a real name. The contact, identity and conversation are created on the first message (or the first pre-chat submit), not when the widget opens.
- Web chat accounts are hidden from the Meta integrations list (`Settings > Integrations`); they are managed in `Settings > Web chat`.

## Data (migration 0038)

- `chat_widgets`: key (`public_key`, 192 random bits, unique), name, `allowed_origins text[]`, enabled, greeting, offline message, color, pre-chat form flag. Owner/admin only (RLS), no DELETE (disable instead), column-level UPDATE grants.
- `chat_visitor_sessions`: SHA-256 of a 256-bit random token (the token is never stored), `visitor_ref`, contact and conversation (set together), hashed truncated IP (16 hex of SHA-256 over workspace id and IP, not the address), user agent (200 chars), `expires_at` (30 days, sliding). Only `crm_worker` can touch it; `crm_app` has no grant at all.
- Both tables: `workspace_id`, forced RLS, policies. `chat_widget_resolve(key)` is `SECURITY DEFINER` with a fixed `search_path`, executable only by `crm_worker`; it is the single cross-tenant lookup (key to workspace and the widget's public configuration). Pattern: `invitation_preview` in migration 0035.

## Public API (`/public/widget/:key/*`, no cookie, no workspace from the caller)

| Route | Purpose |
|---|---|
| `GET config` | public configuration (name, color, greeting, offline message, pre-chat flag, enabled) |
| `POST sessions` | new visitor session; returns the token once |
| `GET messages?after=<seq>` | polling; messages after a sequence number, max 100 |
| `POST messages` | `{body, clientId?, website?}` (text 1 to 2000 chars). `clientId` makes retries idempotent |
| `POST contact` | optional pre-chat `{name?, email?}` |
| `GET /public/widget/_frame/:key` | allowed origins, read only by the web app's own `proxy.ts` to build `frame-ancestors` |

Per request: key shape, widget lookup (unknown key 404 before anything about origins), **origin check**, then (for session routes) `Authorization: Bearer <token>` looked up as `token_hash` inside the widget's workspace and filtered by `widget_id`. A token of another widget (same or other workspace) finds nothing (401). The conversation id never appears in any URL or response, so there is nothing to guess; a request for `/conversations/<id>/...` is a 404 (tested). Bad, missing or expired token: 401 `session_invalid` (the widget quietly starts a new session).

The visitor sees their own messages and agent messages whose `delivery_state = 'sent'` only (pending, failed, unknown rows are never shown). Agents appear as "Support" (no names or ids leave the server).

## Origin and CORS behaviour (exact)

1. Unknown or malformed key: 404, no CORS headers.
2. The site that embeds the widget is `Origin` when it is present and not one of our own web origins (`WEB_ORIGIN`, `crm://`); otherwise it is `X-Widget-Host` (set by the widget page from `location.ancestorOrigins[0]`, falling back to the loader's `?host=`). Neither present: 403 `origin_required`.
3. The widget's allowlist is normalised (lower case, no trailing slash). Empty allowlist: 403 for everyone. Origin not in the list: 403 `origin_not_allowed`, no CORS headers.
4. Allowed and `Origin` is a foreign site: `Access-Control-Allow-Origin: <that origin>` (never `*`), `Vary: Origin`; no credentials are ever involved (bearer header, no cookies). `OPTIONS` preflight is answered 204 only for an allowed origin (`authorization, content-type, x-widget-host`, 10 minutes).
5. Allowed and `Origin` is our own web origin (the iframe through the proxy): no CORS headers (same origin).
6. The global rule "mutating requests with a foreign Origin are 403" is skipped for `/public/widget/*` only; this route group has its own check above.

**What this does and does not stop (UNVERIFIED in the field).** `Origin` and `X-Widget-Host` are client supplied. A browser cannot lie about `Origin`, so the allowlist stops other websites from using a widget from visitors' browsers; additionally the widget page sends `frame-ancestors <allowed origins>` (per widget, `apps/web/proxy.ts`; `'none'` if the list is empty or cannot be read), so browsers do not render the chat on other sites at all. A script outside a browser (curl) can claim any allowed origin: the allowlist is not authentication. The defence for that is the rate limits below and the fact that the only thing such a client can do is start chats, which an agent sees as an unverified visitor.

## Limits and spam

- Body cap 4 KB (413), text 1 to 2000 characters (400), NUL characters refused.
- Rate limits (in process, fixed window `WindowCounter`; **one API instance assumption**, as for every other limiter here): new sessions 10 per IP and 120 per widget per 10 minutes, messages 20 per session per minute, polls 60 per session per minute, config 60 per IP per minute, pre-chat 5 per session per minute. Over the limit: 429.
- Honeypot: a hidden `website` field; if filled, the answer is a normal 201 and nothing is stored.
- Minimum time between session creation and the first message: 1.5 s (429 `too_fast`; the widget retries once automatically).
- Turnstile or any CAPTCHA: out of scope for v1.
- Tokens are never logged. The API error handler logs code and constraint only.

## Realtime: short polling (D244)

The widget polls `GET messages?after=<last seq received from the server>` every 3 s while the page is visible, every 15 s while hidden, with exponential back-off up to 30 s on errors and a "Reconnecting..." banner; it pauses while the browser reports offline and polls at once when it returns. The cursor only moves with sequence numbers returned by polling (the response to the visitor's own POST is shown but does not advance it), so a message that arrived between two of the visitor's sends is not skipped. Stateless, so it survives API restarts and a free-tier cold start (the first request retries up to four times with a "Connecting..." state).

SSE and WebSocket are out of scope on purpose: they need a long-lived connection per visitor, which a single small instance, the idle-sleeping host and a proxy hop do not give us for free, and they would need a shared pub/sub the moment there are two instances. Cost of polling: up to 3 s latency and about 20 small requests per minute per open widget. Revisit with measured numbers.

## Agent replies (D245)

`apps/api/src/inbox/send.ts`: `web_chat` is in the reply allowlist, has no 24 hour window, and refuses attachments (text only). The message row is created `pending` by the user as for any channel, then one worker transaction moves it `pending -> sending -> sent`, writes one `outbound_attempts` row (`request_summary.method = 'local'`, outcome `accepted`, no HTTP status) and bumps the conversation. There is no network call, so unlike other channels there is no committed `sending` state a crash could strand: a crash rolls back and the row stays `pending` (an agent sees it unsent). `sent` means "stored and visible to the visitor's next poll", not "read" (`contact_read_at` is never set). Replays with the same `clientMsgId` behave as before.

## Embed

`apps/web/public/widget.js` (about 3 KB, no dependencies): reads `data-widget-key` (and optional `data-color`) from its own script tag, injects a launcher `<button aria-expanded aria-label aria-haspopup="dialog">` and, on first open, an iframe titled "Chat". Open/close shows or hides the panel (380 x 600 max, bottom right); under 480 px it becomes a full-screen sheet and the launcher hides. Escape (in the page or inside the iframe, which posts `crm-chat:close`) closes; focus moves into the iframe on open and back to the launcher on close; transitions are skipped under `prefers-reduced-motion`. Styles are applied through the DOM, not an inline `<style>`, so a strict `style-src` on the host page should not block them (**UNVERIFIED**).

Widget page `apps/web/app/widget/[key]`: outside the signed-in app (no shell). States: Connecting, ready (greeting when empty), offline/disabled (the widget's offline message), "not available here" (opened outside an allowed site), error with Try again. Message list `role="log" aria-live="polite"`; input 16 px; Enter sends, Shift+Enter newline; unsent messages keep a "Not sent. Try again" button; everything is rendered as React text, there is no `dangerouslySetInnerHTML`. Token in `localStorage` of the web origin (inside the iframe).

Headers (`apps/web/next.config.ts`, `apps/web/proxy.ts`): every route except `/widget/*` keeps `X-Frame-Options: DENY` and `frame-ancestors 'none'`. `/widget/<key>` has no `X-Frame-Options` and `frame-ancestors` equal to that widget's allowed origins.

## Public proxy decision (D243)

`/public/widget/*` on the web origin is a Next route handler, not a rewrite: it forwards only `content-type`, `authorization`, `origin`, `x-widget-host`, `user-agent` and the first `x-forwarded-for` hop (never cookies, so a signed-in agent's session cookie never reaches the public API), accepts only the four visitor paths, caps bodies at 8 KB before forwarding, and returns only the content type of the answer (never `Set-Cookie`). The browser never talks to the API origin.

## Admin (Settings > Channels > Web chat)

Owner/admin only (`integration.manage`; API and page). List, create (name, sites one per line, color, greeting, offline message, optional pre-chat), edit, turn on/off, copy the install code, preview (opens the widget page with `?host=<first allowed site>`), "Make a new install code" (old code stops working at once). Technical details are in a collapsed section. Audit: `widget.created`, `widget.updated` (field names only), `widget.key_rotated` (never the key). Limit 10 widgets per workspace.

## Not in v1 (D249)

Attachments (either direction), typing indicators, read receipts, visitor identity verification (signed identity like Chatwoot's HMAC), business hours, CAPTCHA, SSE/WebSocket, a purge job for expired sessions (rows stay, they are small and inert), several API instances (rate limits are per process), the mobile app, a "visitor is online" indicator, offline email capture beyond the optional pre-chat form.

## UNVERIFIED list

1. Behaviour on real third-party sites (CSP, cookie and storage blocking in third-party iframes, Safari ITP: `localStorage` in a cross-site iframe may be partitioned or cleared, which would start a new conversation on every visit).
2. `location.ancestorOrigins` is absent in Firefox: there the loader's `?host=` is used, which is client supplied.
3. That the origin allowlist plus rate limits is enough abuse protection for anonymous chat.
4. Polling cost and latency at real volume; free-tier cold starts.
5. Strict host-page `style-src` and `frame-src` policies against `widget.js`.
6. Accessibility with a real screen reader (only axe was run).
7. Browsers other than Chromium; phones.

## How it was tested

See `docs/project/testing-report.md` (Web chat). API tests `apps/api/test/web-chat.test.ts`, database tests `packages/db/test/web-chat-schema.test.ts` (tenancy), Playwright `apps/web/e2e/web-chat.spec.ts` with a second local origin.
