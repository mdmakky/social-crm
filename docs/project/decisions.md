# Decisions Log

Status: Proposed = recommended by Claude, awaiting user approval. Evidence and alternatives live in `docs/research/technology-decisions.md`.

| # | Decision | Status | Recommendation and reason |
|---|---|---|---|
| D1 | Mobile framework | Proposed | React Native with Expo (SDK 58). Fastest for one developer, shares TypeScript, contracts and tokens with the web, Expo Push and EAS cover push and iOS builds without a Mac. Flutter and native rejected for this team size; revisit only if RN performance fails a measured gate. |
| D2 | Backend shape | Proposed | Separate Hono API plus worker in a pnpm and Turborepo monorepo, instead of Next.js route handlers only. Gives mobile a stable versioned API. |
| D3 | Contract style | Proposed | Zod schemas generating OpenAPI and typed clients; not tRPC. |
| D4 | Database and ORM | Proposed | PostgreSQL 18 with Drizzle 0.45 (stable line); Prisma not chosen. |
| D5 | Tenancy | Proposed | Shared schema, workspace_id, forced RLS, non-owner app role. |
| D6 | Auth | Proposed | Better Auth with the Expo plugin; Clerk is the paid alternative if self-hosting auth becomes a burden. |
| D7 | Queue | Proposed | pg-boss on Postgres with a transactional outbox; no Redis in the MVP. |
| D8 | Realtime | Proposed | SSE with cursor replay; WebSocket deferred. |
| D9 | Push | Proposed | Expo Push behind a provider interface; direct FCM/APNs later if needed. |
| D10 | Offline | Proposed | TanStack Query persistence plus a mutation outbox; no full sync engine. Server wins on conflicts. |
| D11 | RN styling | Proposed (open) | Unistyles vs NativeWind: decide after the Phase 1 spike. |
| D12 | AI layer | Proposed | Thin own facade over a provider SDK (Vercel AI SDK candidate), with cost tracking and approvals. |
| D13 | Secrets | Proposed | AES-256-GCM envelope encryption with an environment KEK first, KMS later. |
| D14 | Node version | **Approved 2026-11-13** | Node 24 LTS is the primary runtime, pinned in `.nvmrc` and `engines`. Node 26 may be tested separately for compatibility; it is not the baseline. |
| D15 | CAPI sequencing | Proposed | After AI foundation (Phase 6b), per the brief's "after core event system". |
| D16 | Hosting | **Deferred (approved)** | Production hosting is deferred. Continue local development until hosting requirements and budget are clear. |
| D17 | Apple and Google developer accounts | **Deferred (approved)** | Deferred to store release preparation. Android emulator development proceeds; iOS stays untested until accounts and a device exist. |
| D18 | Meta developer app | **Approved (user action)** | The user will create a Meta Developer App and connect their own Facebook Page and Instagram professional account for Development-mode testing. Development continues on the mock adapter until credentials exist. |
| D19 | Release cut line | **Approved with security conditions** | Release 1 = Phases 1 to 4 plus approved MVP scope. Basic security controls are implemented and tested from the start (RLS, permission matrix, webhook signature checks, encrypted credentials, secure token storage, no secrets in clients or logs, rate limiting, audit log). A full security review must complete before any non-owner user is allowed or any other business connects accounts. |
| D20 | One lead entity with pipeline kinds | **Approved with conditions** | Keep lifecycle stage (on the contact) and pipeline stage (on the lead) separate. Support multiple pipeline kinds. Preserve optional deal-related fields (value, currency, expected close date, probability) on the lead without creating duplicate CRM entities. |
| D21 | Generic conversion tables | **Approved** | Use generic `conversion_*` tables and a platform-independent Conversion Event Engine; Meta CAPI is the first destination adapter. |
| D22 | Email and object storage providers | **Deferred (approved)** | Provider selection waits for hosting and deployment requirements. Provider-independent `Mailer` and `BlobStore` interfaces are designed now, with local implementations. |
| D23 | pgvector for the knowledge base (R2) | Proposed | Postgres extension; confirm the chosen host supports it before R2. |
| D24 | Per-workspace `seq` event ordering with row-lock counter instead of global bigserial | Proposed | Fixes the out-of-order commit gap (review B1). |
| D25 | Three DB roles plus named SECURITY DEFINER lookups | Proposed | Review B4. |
| D26 | Outbound `unknown` state, never auto-retried | Proposed | Review B3; no idempotency key on Meta's Send API (confirm in citation check). |
| D27 | Mobile session tokens: sliding expiry with server revocation; rotating refresh deferred to spike result | Proposed | Review M2. |
| D28 | AI off by default per workspace and per provider | Proposed | Review M18. |

Approval record: decisions above marked Approved or Deferred were given by the user on 2026-11-13. D1 to D13 and D23 to D28 were not explicitly addressed in that approval; they are treated as in effect for the Phase 1 spike only, subject to spike results, and remain listed as Proposed until confirmed.

## Spike outcomes (2026-11-13)
D1, D2, D4, D6, D7 (stack): verified by the spike on the server side; see `spike-report.md`. D6: Better Auth issues no rotating refresh token, so D27 (sliding session expiry with server revocation) is confirmed. Mobile run on a device is still unverified. User decision 2026-11-13: web work comes first; mobile device verification is deferred.

## Phase 1 web decisions (2026-11-13)
| # | Decision | Status | Reason |
|---|---|---|---|
| D29 | The web app proxies `/api/auth/*` and `/v1/*` to the API (same origin) | Implemented | Keeps session cookies first-party and avoids CORS; the API still enforces an Origin allowlist. |
| D30 | Unbuilt features are not links. They appear once, as plain text under "Coming soon", filtered by permission, with no internal phase language | Implemented | Independent design critique B2; avoids dead controls and roadmap leakage. |
| D31 | Design tokens are authored in TypeScript (`packages/design-tokens/src/tokens.ts`) and generated to CSS; no Style Dictionary | Implemented | Smallest thing that works for one platform; a React Native output can be added later from the same source. |
| D32 | RLS pattern: `app_user_id()` and `app_workspace_id()` session settings per transaction; membership writes restricted to owners/admins in the database; audit log append-only for every role | Implemented | Defense in depth with the application permission matrix. |
| D33 | TypeScript is 5.9.x in packages and ~6.0.3 in the mobile app (Expo template); TS 7 not adopted | Open | Align deliberately when tooling support is confirmed. |

## Approvals 2026-11-13 (user)
| # | Decision | Status | Conditions |
|---|---|---|---|
| D34 | Shared thin typed fetch client instead of a generated OpenAPI client | **Approved** | Shared Zod contracts; type-safe endpoint definitions; centralized auth, errors, timeouts; cookie and bearer support; one package for web and mobile; drift prevention. OpenAPI generation stays a future milestone. Roadmap item 5 renamed "Shared Typed API Client". |
| D35 | Begin Phase 2 web-first while Phase 1 stays formally open | **Approved with conditions** | Phase 1 not marked passed; Android emulator login and SecureStore runtime verification remain mandatory; mobile compatibility preserved in all shared contracts and API changes; no mobile-readiness claim until mobile auth tests pass; second independent Phase 1 review first; blockers resolved; loading/empty/error test coverage updated in the roadmap. |
| D36 | Complete password-reset flow in Phase 2 using the Mailer interface | **Approved** | Local development mail adapter for tests; production provider deferred with hosting (D22). Secure single-use tokens, expiry, invalidation, rate limiting, account-enumeration protection. |

## Phase 2 decisions (2026-11-13)
| # | Decision | Status | Reason |
|---|---|---|---|
| D37 | Redirect targets for auth flows must be same-site paths or one of our origins; checked before Better Auth sees them | Implemented | Found by test: Better Auth followed any `redirectTo`, leaking reset tokens. |
| D38 | Throttled and unknown-address reset requests return the normal success response | Implemented | Prevents account enumeration through rate-limit behavior. |
| D39 | `FileMailer` is the only mail adapter until hosting is decided; production start fails closed without a provider | Implemented | D36 and D22 together. |

## Contacts decisions (2026-11-13)
| # | Decision | Status | Reason |
|---|---|---|---|
| D40 | Lifecycle stage is a configurable list on the contact, independent of pipeline stages; stages are archived, never deleted | Implemented | User requirement and D20; archiving keeps history and counts. |
| D41 | Contacts are soft-deleted; duplicates are detected by normalized email or phone and warned about, never blocked | Implemented | Recoverable, privacy work comes later; duplicates may be legitimate. |
| D42 | Edits use `expectedVersion` (optimistic concurrency) in the body, with the current record returned on conflict | Implemented | Works for web and mobile and for offline replays without silently overwriting. |
| D43 | CSV import is upload, mapping, preview, then one atomic commit; exports neutralise spreadsheet formulas and the importer reverses that guard | Implemented | Safety plus lossless round trip. |
| D44 | Export and import are owner and admin actions; agents and viewers cannot download or import customer data | Implemented | Data-loss prevention; matches the permission matrix. |
| D45 | RLS policies call helper functions as `(SELECT app_has_role(...))` so Postgres evaluates them once per query, not once per row | Implemented for all Contacts tables | Measured: list p95 264 to 410 ms before, 66 ms after. Earlier tables (workspaces, memberships, audit_log) should be rewritten the same way. |
| D46 | Phones and emails read from conversations live in `contact_methods` (kind, normalised value, source, confidence, verified, provenance); `contacts.phone/email` stay the human-entered primary fields and are only ever FILLED when empty by the worker (trigger-enforced), never overwritten | Implemented (migrations 0022, 0023), local only | Backward compatible with search, import and duplicate detection; extracted data is never presented as verified. |
| D47 | Extraction is deterministic (no AI): Bangladeshi mobile forms and explicit +CC/00CC international numbers, emails by the same rule as manual entry; it runs in the message transaction behind a savepoint, after the duplicate check, so a failure cannot affect message storage and a re-delivered webhook never extracts twice | Implemented | Fast, testable, no external dependency in the critical path. Bare non-Bangladeshi national numbers are NOT extracted (ambiguous with order numbers). |
| D48 | Only unverified messenger/instagram methods can be corrected or deleted through the API, and RLS enforces it (app role: update value/raw_value/correction columns only, delete only detected rows); entered, imported and verified values are refused (409). Verification is a separate workflow, out of scope | Implemented | A detected-method workflow must never become a way to rewrite human data. |
| D49 | Notes: own-note add/edit/delete stay on the contact timeline; editing or deleting SOMEONE ELSE'S note (owner/admin only) additionally writes `note.edited_by_other` / `note.deleted_by_other` to `audit_log` with actor, contactId and authorUserId, never the text | Implemented | audit_log is for privileged and destructive actions; the timeline already records ordinary note activity, so no duplicate entries for own notes. Before this, an admin edit of another person's note left no trace. |
| D50 | Outbound Messenger text: the message row (`pending`) is committed first, then claimed `pending -> sending` with an `outbound_attempts` row (both committed BEFORE the Send API call), then exactly one call is made. 4xx Graph error -> `failed`; timeout, 5xx, unreadable or id-less answer -> `unknown`. No automatic retry of any send, ever. | Implemented | Meta documents no idempotency key (Send API guide read 2026-11-14), so a repeated call can deliver twice. |
| D51 | Duplicate protection is a client-generated `clientMsgId` (unique per workspace, enforced by the existing partial unique index plus an advisory lock). A repeat returns the stored message and sends nothing; the same id on another conversation or user is a 409. | Implemented | Double click, network retry and two tabs cannot send twice. |
| D52 | Standard messaging only: `messaging_type: "RESPONSE"` inside 24 h of the contact's last message, checked server-side against the database clock. No message tag (HUMAN_AGENT or any other) is sent; the tag stays a separate, unmade decision (D-C). | Implemented | Brief; tag eligibility is not verifiable from the pages read. |
| D53 | A `sending` row older than 2 minutes (process died, redeploy) becomes `unknown`, never `failed` and never re-sent. An echo webhook with the same text in the same conversation within 30 minutes adopts its Meta id and makes the row `sent` (no duplicate row). A person may decide an `unknown` message after 10 minutes (D-G); the decision is audited. | Implemented | Closes the Slice 5 prerequisites in the Meta inbox plan except admin replay. |
| D54 | Instagram uses Messenger Platform for Instagram (Facebook Login for Business + the Page token already stored per account), not Instagram Login. The Instagram account row stores the Instagram id and its own sealed copy of the Page token. | Implemented | Reuses the existing OAuth, token store, RLS and disconnect flow; no second login system. |
| D55 | The webhook channel comes from the signed payload `object`, not from the callback URL. | Implemented | Whether Meta uses one URL or two for Instagram is UNVERIFIED (C8); the signature already proves origin. |
| D56 | Instagram webhook subscription is never reported as done by the API (`dashboard_required`); the dashboard step is documented. | Implemented | Page `subscribed_apps` is documented for Pages only. |
| D57 | Instagram replies reuse the Messenger send pipeline (persist, claim, one call, UNKNOWN on ambiguity, echo adoption); only the channel call (`me/messages`, no messaging_type), the 1000-byte limit and error subcode mapping differ. | Implemented | Brief: no separate messaging system. |
| D58 | Direct Instagram connection (no Page) uses Instagram API with Unified Login: the existing Meta app, Facebook Login for Business with an "Instagram Login Compatible" configuration, a system-user token. Instagram Login (separate Instagram app id, `graph.instagram.com`) is NOT used because newer apps cannot set it up. | Implemented | The app's own dashboard and Meta's migration guide say so. |
| D59 | One new column `integration_accounts.auth_method` (`facebook` default, `unified`, only for Instagram, migration 0024); no new tables. Dispatch is by method: send addresses `/{ig-id}/messages` for `unified`; everything else (webhooks, messages, contacts, token check via `debug_token`, enrichment) is shared. | Implemented | Brief: minimal schema change, no duplicate inbox. |
| D60 | The OAuth state is signed, 10 minutes, bound to user, workspace, a browser nonce cookie (`crm_ig_nonce`) and marked as the Instagram flow; the Facebook callback refuses marked states. The code is exchanged server-side; the browser sees only a result word. | Implemented | CSRF / login-CSRF defence. |
| D61 | Each shared account is stored in its own transaction (one belonging to another workspace is skipped, the rest connect). System-user token refresh is not built; an expiring configuration surfaces as "Reconnect needed". | Implemented | Refresh needs a separate Meta API and `business_management`. |
| D62 | WhatsApp is one more platform of the existing inbox (`platform='whatsapp'`, `external_account_id` = phone number id), with one side table `whatsapp_accounts` (WABA id, display number, mode). No separate messaging system. | Implemented (slice 1) | Same routing, worker, conversation and message model as Messenger/Instagram; WhatsApp-only facts do not belong on the shared table. |
| D63 | A WhatsApp webhook POST is split per `changes[]` item; each row is routed by `metadata.phone_number_id`, never `entry.id` (the WABA id, which can own several numbers). | Implemented | Meta payload reference; also prevents a body from writing into a number it was not routed to. |
| D64 | A WhatsApp sender is identified by `wa_id` (`from`). A message that carries only a business-scoped user id is ignored (`bsuid_only`), not guessed; the raw event is kept. | Implemented, open question | Meta says to move to BSUIDs, but their format is not digit-only and no real payload has been seen; identities stay digit-only until slice 2 decides. |
| D65 | WhatsApp media is stored as a reference only (`mediaId`, mime, file name); the webhook `url` is dropped. Statuses only update watermarks for messages we stored. | Implemented | The url needs the account token (not a public link); a status for a message we do not know must not change anything. |
