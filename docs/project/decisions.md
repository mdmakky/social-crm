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
