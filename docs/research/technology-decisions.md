# Technology Decisions (ADR set)

Status: Proposed, awaiting human approval on the items in section 16.
Date: 2026-11-13.

## 0. Method and evidence quality

Versions were verified on 2026-11-13 directly against the npm registry (`registry.npmjs.org/<pkg>`), the Flutter release manifest (`storage.googleapis.com/flutter_infra_release/releases/releases_linux.json`), the Expo versions API (`api.expo.dev/v2/versions/latest`), endoflife.date (Node, PostgreSQL), and GitHub release APIs. Better Auth Expo/bearer/multi-session usage was confirmed with Context7 (`/better-auth/better-auth`, retrieved 2026-11-13). A web search on Prisma/Drizzle status returned mostly third-party blogs dated up to September 2026.

Limits of this research: architectural and trade-off reasoning (sections 1 to 15) rests on established engineering knowledge, not on a fresh read of each vendor's documentation. Only the version facts and the Better Auth Expo API shape were checked live. Hosting prices were not re-verified and are deliberately omitted; check vendor pricing pages before committing. Treat every "confidence" rating below with that in mind.

Notable verified facts that differ from older assumptions:

- Node 26 is "Current" (released 2026-05-05, LTS scheduled 2026-10-28, latest 26.13.1). Node 24 is the safer production LTS until Node 26 enters LTS, which per the schedule has now happened; verify with `endoflife.date/nodejs` before pinning.
- PostgreSQL 18 latest is 18.7 (2026-11-09). The local client is 18.3.
- TypeScript is at 7.0.2, React 19.3.1, Next.js 16.4.6, Zod 4.6.7, TanStack Table 9.3.1, Vitest 5.1.0.
- Prisma: npm `latest` tag is 8.0.0-rc.33 (a release candidate sitting on `latest`). Last clearly stable version is 7.10.1. Prisma 8 stable status is unconfirmed.
- Drizzle ORM: `latest` is 0.45.4. A 1.0 line exists only as `rc` (1.0.0-rc.5) and `beta`. Not stable.
- Lucia is not a package to adopt (see section 5).
- Expo SDK 58 is current (expo 58.0.25, published 2026-11-12) and ships React Native 0.88.1.
- Flutter stable is 3.50.0 (2026-11-11, Dart 3.14.0).

## 1. Mobile framework

Decision: React Native with Expo (SDK 58, Expo Router, EAS Build).

Options:

1. React Native + Expo. TypeScript across web, mobile, backend; shared Zod schemas, API client, design tokens, business logic. Expo SDK 58 / RN 0.88.1.
2. Flutter 3.50. Excellent rendering performance and UI control; Dart is a second language; no code sharing with Next.js beyond an OpenAPI-generated client.
3. Native (Kotlin + Swift). Best platform fidelity; two codebases; unrealistic for one developer. iOS also needs macOS regardless.

Criteria:

| Criterion | RN + Expo | Flutter | Native |
|---|---|---|---|
| Dev speed (solo, TS stack) | Highest: shared types and validation | Medium: new language, regenerated client | Lowest |
| Performance | Good for CRM/list/form workloads; New Architecture default; FlashList 2.3.3, Reanimated 4.7.1 | Very good | Best |
| UI flexibility | High; Skia 2.14.0 available | Highest (own renderer) | Highest |
| Background processing | Limited by OS in all options; expo-background-task / expo-task-manager for deferred work; push-triggered refresh is the reliable path | Similar (workmanager) | Best access |
| Push | Expo Notifications 58.1.9 plus Expo push service, or direct FCM/APNs | firebase_messaging | Direct |
| Deep linking | Expo Router gives file-based universal/app links | go_router etc., workable | Direct |
| Camera/uploads | expo-camera, expo-image-picker, resumable uploads via presigned URLs | Mature plugins | Best |
| Realtime/offline | JS libraries (SSE polyfill, WebSocket, SQLite) all workable | Workable | Workable |
| Maintenance | Expo SDK upgrades every ~4 months; one stack to keep current | Flutter + Dart + pub | Two stacks |
| Backend compat | Same language and contract tooling as the backend | OpenAPI codegen only | OpenAPI codegen only |
| Testable on this Linux box | Yes: Metro, Android emulator (after SDK install), Maestro (cli 2.12.1) on Android, Expo Go/dev client on a real phone, Jest/Vitest | Yes for Android and web; no iOS | Android only |

iOS constraint: no macOS, so iOS binaries come from EAS Build (cloud macOS workers), distributed through TestFlight; iOS must be tested on a physical device or EAS-built simulator builds on someone else's Mac. This constraint applies to all three options and is mildest for Expo because EAS Build, EAS Submit and EAS Update are a first-class workflow. Android toolchain (SDK, emulator, KVM) still needs installing locally; Java 25 on this machine may not match what the Android Gradle plugin supports, so install the JDK that the Expo/RN docs for SDK 58 name (commonly a JDK 17-21) via `sdkman` or a Fedora package and verify in the Expo environment-setup docs.

Recommendation: React Native + Expo. Prefer development builds (`expo-dev-client`) over Expo Go once a native module is needed. Confidence: High (85%).

## 2. Backend shape and API contract

Decision: separate API service (Hono on Node) in a pnpm + Turborepo monorepo, versioned under `/v1`, with OpenAPI as the contract. Next.js is the web UI only (plus Better Auth route mount if desired, but see section 5).

Options:

1. Next.js route handlers only. Fewest deployables. Couples API lifecycle to the web release cycle, and long-lived SSE connections and workers fit poorly on serverless hosting. Mobile clients pin to old API versions for months, so the API needs its own deploy cadence.
2. Hono 4.13.18 on Node. Small, fast, web-standard Request/Response, good Zod/OpenAPI integration (`@hono/zod-openapi` 1.6.3, `@hono/node-server` 2.1.8), runs anywhere (Node, Bun, edge).
3. Fastify 5.12.8. Mature, fast, strong plugin ecosystem and schema validation; more Node-specific.
4. NestJS 12.5.0. Full framework with DI; more ceremony than a solo developer needs.

Contract strategy options:

- OpenAPI from Zod (`@hono/zod-openapi`) then generated clients (`openapi-typescript` 7.13.0 plus `openapi-fetch`). Language-agnostic, versionable, publishable docs, also works for any future non-TS client. Recommended.
- tRPC 11.28.0. Excellent TS DX but ties clients to TS and to router shape; poor fit for a versioned public mobile API.
- ts-rest 3.52.1. Contract-first, OpenAPI generation available; smaller community. oRPC 1.16.2 is a newer alternative with OpenAPI support; not recommended until you need it.
- Plain Zod shared package plus Hono RPC client. Fast but TS-only and no standalone spec.

Rules for mobile compatibility: additive-only changes within `/v1`; a minimum-supported-client-version header check; error envelope with stable machine codes; cursor pagination; idempotency keys on all mutating endpoints the mobile client may retry.

Monorepo layout: `apps/web` (Next), `apps/api` (Hono), `apps/worker`, `apps/mobile` (Expo), `packages/db`, `packages/contracts` (Zod), `packages/ai`, `packages/ui-tokens`, `packages/config`. Note pnpm with Expo needs `node-linker=hoisted` or the documented Expo monorepo settings; Metro and strict pnpm symlinks have historically conflicted. Verify against current Expo monorepo docs.

Recommendation: Hono API service plus OpenAPI contract. Confidence: High (80%). Fallback if the human wants minimum ops: Next.js route handlers wrapping the same Hono app (`hono/vercel`), keeping the option to split later.

## 3. Database and ORM

Decision: PostgreSQL 18 with Drizzle ORM 0.45.4 and drizzle-kit 0.31.11, SQL-first migrations.

Options:

- Drizzle: SQL-like, thin, supports `pgPolicy`/`.enableRLS()` in schema, transaction-friendly, fits `SET LOCAL` for RLS. 1.0 is only rc/beta, so pin 0.45.x and plan a migration.
- Prisma: strong DX, schema file, Prisma 7 removed the Rust engine. The npm `latest` tag now points at an 8.0.0-rc (version 7.10.1 is last stable). Per-request RLS context requires client extensions or interactive transactions; workable, more friction. Larger abstraction.
- Kysely or raw SQL with a migration tool (`node-pg-migrate` 9.0.0): maximal control; less schema-to-type convenience.

Migrations: generate with drizzle-kit but hand-review and keep RLS policies, triggers, functions and grants as explicit SQL migrations, because drizzle-kit does not model all of them. Run migrations with a privileged role; the application connects as a separate non-owner, non-BYPASSRLS role. Expand/contract pattern for destructive changes because mobile clients lag.

Recommendation: Drizzle 0.45.4. Confidence: Medium-High (70%). Human should accept the 1.0-migration risk or prefer Prisma 7.10.1 pinned.

## 4. Multi-tenancy and Row Level Security

Decision: shared schema; every tenant-owned table has `workspace_id uuid not null`; Postgres RLS as defence in depth enforced for the application role.

Details:

- Roles: `owner` (runs migrations, owns tables), `app_user` (NOLOGIN-inheriting or login role with no BYPASSRLS, not table owner), `worker` role if background jobs need cross-tenant access (use explicit, audited policies, not BYPASSRLS, where practical).
- Enable and force: `ALTER TABLE t ENABLE ROW LEVEL SECURITY; ALTER TABLE t FORCE ROW LEVEL SECURITY;` so even the owner is subject to policies.
- Policy: `USING (workspace_id = current_setting('app.workspace_id', true)::uuid) WITH CHECK (same)`. Set per transaction with `SELECT set_config('app.workspace_id', $1, true)` (equivalent to `SET LOCAL`), inside the same transaction as the queries. Never use session-level `SET` with a connection pool.
- If a pooler in transaction mode (PgBouncer) is used, `SET LOCAL` inside an explicit transaction is the only safe form. Wrap every request in a transaction helper `withWorkspace(workspaceId, fn)`; make it the only DB entry point in `packages/db`.
- Missing setting must fail closed: `current_setting(..., true)` returns NULL, `workspace_id = NULL` matches nothing.
- Composite keys: include `workspace_id` in foreign keys (`(workspace_id, id)` unique plus composite FK) so a row cannot reference another tenant's parent.
- Indexes: lead composite indexes with `workspace_id`. Policy expressions must be indexable; avoid subqueries in policies on hot tables (use a denormalised `workspace_id` instead of joins).
- Membership: a `workspace_members` table; the API resolves workspace from the validated session plus membership before calling `set_config`. RLS is not a substitute for authorisation checks (roles, permissions) in the API.
- Tests: Testcontainers integration tests that connect as `app_user` and assert cross-tenant reads and writes return nothing and error respectively.
- Pitfalls: views run with owner privileges unless `security_invoker = true` (Postgres 15+); `SECURITY DEFINER` functions bypass RLS; unique constraints can leak existence across tenants (scope them by `workspace_id`); full-text and aggregate counts still go through RLS.
- Alternatives rejected: schema-per-tenant (migration cost multiplies, poor fit for solo); database-per-tenant (only for enterprise isolation requirements later).

Confidence: High (85%).

## 5. Authentication

Decision: Better Auth 1.7.22 self-hosted in the API service, with `@better-auth/expo` 1.7.22, bearer plugin and multi-session as needed.

Options:

- Better Auth: TypeScript, framework-agnostic, Drizzle adapter, organization/multi-tenant plugin, 2FA, passkeys, Expo plugin that stores session cookie/tokens in `expo-secure-store` (58.0.3), bearer plugin for `Authorization` header use (confirmed in Context7 docs), multi-session plugin. Owns your data in your Postgres.
- Auth.js (next-auth): npm `latest` is 4.24.15; v5 remains `beta` (5.0.0-beta.32). Web-centric; weak mobile story. Not recommended.
- Lucia: its author deprecated the library in 2025 and recommends implementing sessions yourself; the repo is not a dependency to adopt. Rolling your own session layer is viable but is unnecessary work next to Better Auth.
- Clerk (`@clerk/nextjs` 7.9.26): fastest to start, polished UI, Expo SDK; vendor lock-in, per-MAU cost, user data outside your DB, awkward for RLS-linked tenancy.
- Self-hosted alternatives (Keycloak, Ory, Zitadel): heavy for a solo developer.

Mobile token flow: sign in via authClient; the Expo plugin handles OAuth via system browser and app-scheme deep link (`trustedOrigins` includes the scheme), and persists the session token in SecureStore (Keychain/Keystore backed). API accepts the token as a bearer; web uses httpOnly cookies. Use short-lived access sessions with rolling expiry refreshed on use; revoke per device through the session list (device sessions = rows in the session table with user agent and IP; expose "sign out other devices"). Enforce rate limiting and, for sensitive operations, step-up re-authentication. Keep SecureStore values small (platform size limits on some devices) and never store refresh tokens in AsyncStorage.

Confidence: High (78%). Check Better Auth security advisories and changelog before each upgrade; it is fast-moving (1.8.0-beta in progress).

## 6. Background jobs

Decision: pg-boss 12.38.2 (Postgres-backed queue) in `apps/worker`.

Options:

- pg-boss: runs on the existing Postgres (`SKIP LOCKED`), retries with backoff, scheduling (cron), singleton keys, dead-letter queues, no Redis. Throughput ceiling in the low thousands/sec, ample for a CRM.
- Graphile Worker 0.18.0: also Postgres-based, very fast, uses LISTEN/NOTIFY, task-per-file model; pre-1.0 version number.
- BullMQ 6.7.6: mature, rich features, requires Redis (extra infra).
- Inngest 4.26.2 and Trigger.dev 4.8.5: managed durable workflows, great DX for multi-step AI jobs, but external dependency/cost and data leaves your infra. Reasonable later for long AI workflows.

Idempotency and retry rules: every job payload carries a deterministic `idempotency_key`; handlers are written as upserts or guarded by an `processed_events` table keyed by that key; use pg-boss `singletonKey` for de-duplicating enqueue; exponential backoff with a retry limit and a dead-letter queue and alerting; enqueue inside the same DB transaction as the business change (transactional outbox) so a job exists if and only if the data committed; per-workspace fairness via key-based concurrency or separate queues for heavy tenants; set job expiry and heartbeat for long jobs.

Confidence: High (80%).

## 7. Realtime

Decision: Server-Sent Events over HTTP from the API for server-to-client events, fed by Postgres LISTEN/NOTIFY (or the outbox) with a durable `events` table providing ordering and replay. Mutations stay ordinary HTTP.

Options:

- SSE: one-way, auto-reconnect, works through proxies, simple; on React Native requires a polyfill or fetch-streaming library (`react-native-sse` or `event-source-polyfill`); browsers have native `EventSource` (cookies only, no custom headers, so use fetch-based streaming for bearer auth on web too, or cookie auth on web).
- WebSocket: bidirectional, needed for presence/typing/collaborative editing; more operational work (heartbeats, sticky scaling). Introduce only when a feature needs client-to-server push.
- LISTEN/NOTIFY alone: payload limit 8000 bytes, not durable, lost when no listener; use it only as a wake-up signal, never as the source of truth.
- Supabase Realtime, Electric (`@electric-sql/client` 1.5.28), PowerSync (2.4.1): ready-made sync; adopt only if offline-first sync becomes a core requirement, as they bring their own infrastructure and model.

Reliability protocol: each event has a monotonically increasing `event_id` (bigserial/ULID) per workspace; server sends `id:` field; client reconnects with `Last-Event-ID` (or `?cursor=`); server replays from the `events` table after that cursor (retention window, e.g. 7 days) and responds with a "resync required" signal if the cursor is too old, whereupon the client refetches via normal queries. Client dedups by `event_id` and applies idempotently; events are invalidation hints for TanStack Query (refetch affected keys) where possible. Reconnect with exponential backoff plus jitter; pause on app background, resume and catch up on foreground. Authorise the stream per workspace and re-check membership on reconnect.

Confidence: High (80%).

## 8. Push notifications

Decision: Expo Push Service via `expo-server-sdk` 8.0.0 and `expo-notifications` 58.1.9 at first; keep a provider interface so direct FCM/APNs can replace it.

Trade-offs: Expo Push is the fastest to implement, one API for both OSes, receipts API for delivery errors, and it needs no APNs key handling in your own server; downsides are a third-party dependency and rate/feature limits, and tokens are Expo-specific. Direct FCM and APNs give full control and lower latency/dependencies but double the integration surface and need more native config. Process receipts in a background job, delete invalid tokens (`DeviceNotRegistered`), store tokens per device session, and treat push as a wake-up and a convenience, never the only delivery channel (the in-app event stream and unread counts are the source of truth). On iOS, push requires an Apple Developer account and APNs credentials managed by EAS.

Confidence: High (80%).

## 9. Offline cache (React Native)

Decision: TanStack Query 5.107.1 with persistence (`@tanstack/react-query-persist-client`) backed by MMKV (`react-native-mmkv` 4.3.2) or `expo-sqlite` 58.0.17 for larger caches; queue offline mutations with idempotency keys.

Options: TanStack Query persistence (simple, read-mostly offline, minimal code); `expo-sqlite` or op-sqlite 19.0.5 (a local relational store, more work); WatermelonDB 0.28.0 (reactive offline DB with its own sync protocol, heavy, requires server sync endpoints); PowerSync/Electric (full sync engines). A CRM generally needs read-mostly offline with a small outbox of queued writes; full bidirectional sync with conflict resolution is expensive and should be a deliberate later decision. Conflict policy to start: last-write-wins with server `updated_at`/version check (`If-Match` style) and a user-facing conflict message for edited-by-others cases.

Confidence: Medium-High (70%).

## 10. UI stack

Web: Tailwind CSS 4.3.5, shadcn/ui (CLI 4.23.0) on Radix primitives, TanStack Table 9.3.1 (note: v9 is a major version; check its migration notes and shadcn's data-table recipe compatibility), TanStack Query for server state, Zustand 5.1.0 for small client state only (avoid global stores for server data), React Hook Form or TanStack Form with Zod 4.6.7 schemas shared from `packages/contracts`.

React Native: NativeWind 4.2.7 (Tailwind syntax on RN; v4 is the stable line, check v5/Tailwind-4 compatibility before relying on it), Unistyles 3.8.1 (fast, StyleSheet-like, theming via C++), Tamagui 3.3.2 (cross-platform component kit; large, steeper). Recommendation: Unistyles 3 for performance and explicit theming, or NativeWind if the team (you) values class-name parity with web. Pick one; do not mix. Given Tailwind v4 on web, NativeWind lowers cognitive load, but its Tailwind 4 alignment must be verified; Unistyles is the lower-risk choice for correctness.

Shared design tokens: a `packages/ui-tokens` package exporting a TypeScript token object (colors, spacing, radii, type scale) from which a generator emits Tailwind v4 `@theme` CSS variables for web and the Unistyles theme for mobile. Use Style Dictionary only if tokens come from Figma.

Confidence: Medium (65%) on RN styling choice, High on web stack.

## 11. AI layer

Decision: Vercel AI SDK (`ai` 7.0.171, provider packages such as `@ai-sdk/anthropic` 4.0.103 and `@ai-sdk/openai` 4.0.116) behind a thin in-house `packages/ai` facade.

Rationale: the SDK already abstracts providers, streaming, structured output and tool calling; a facade of roughly `generate`, `stream`, `embed` limits lock-in and is where you add cross-cutting concerns the SDK does not own: per-workspace budgets and rate limits, cost tracking (store provider, model, input/output/cached tokens, computed cost from a versioned price table, workspace, user, feature, latency in an `ai_usage` table), prompt versioning, request logging with PII redaction, retries/fallback model routing, and tool allow-lists. Tool calls that mutate data must run through the same authorised API layer and RLS context as a human request, with a confirmation step for destructive actions. Own provider abstraction from scratch is justified only if the SDK's major-version churn (it is at 7.x) becomes painful; the facade makes that swap cheap. Per-tenant provider keys are stored encrypted (section 12).

Confidence: High (75%).

## 12. Secrets encryption at rest

Decision: envelope encryption. Per-secret random 256-bit data key (DEK) encrypts the value with AES-256-GCM (random 96-bit nonce, authenticated additional data = workspace_id + secret id); the DEK is wrapped by a key-encryption key (KEK) and stored beside the ciphertext with a `key_version`.

KEK options for a solo developer: (a) a master key in the host's secret store or env var, versioned, loaded only by the API/worker (cheapest, weakest: host compromise exposes it); (b) AWS KMS (`@aws-sdk/client-kms` 3.1168.0): small per-key and per-request cost, audit logs, rotation, no key material ever in your process; recommended once real customer secrets exist; (c) GCP KMS or HashiCorp Vault: comparable but more setup. Start with (a) behind an interface so that (b) is a drop-in, with a documented rotation procedure (re-wrap DEKs, not re-encrypt data). Never log secrets, never return them to clients after write (show last 4 only), decrypt only in the worker or API at use time. Use Node's built-in `crypto`; do not invent primitives. Also use disk encryption and encrypted backups at the host level.

Confidence: High (85%).

## 13. Testing

- Unit and integration: Vitest 5.1.0.
- Database: Testcontainers (`@testcontainers/postgresql` 12.2.1) running Postgres 18, applying real migrations, connecting as the non-owner app role so RLS is genuinely exercised. Docker is available locally.
- Web E2E: Playwright 1.65.0 (works on Fedora; install browsers via `npx playwright install`; Fedora may need extra system libraries).
- Mobile E2E: Maestro (cli 2.12.1) recommended; YAML flows, works against Android emulator and iOS simulator, with cloud runs possible for iOS. Detox 20.51.4 is gray-box and stronger on sync but heavier to maintain, and iOS needs macOS. On this Linux machine only Android flows can run locally; iOS E2E needs cloud (Maestro Cloud, EAS workflows on macOS runners).
- Contract: run the OpenAPI spec through a linter in CI and compare against a stored snapshot to catch breaking changes (oasdiff or similar).
- Additional: RLS leakage suite, idempotency replay tests for jobs and mutations, SSE reconnect/cursor replay test.

Confidence: High (80%).

## 14. Hosting

Early stage (cost-minimised, low ops): web on Vercel or Cloudflare (Next.js 16.4.6); API and worker as one container each on a small VPS or container host (Fly.io, Railway, Render or a Hetzner box with Docker/Coolify), because SSE and pg-boss need long-running processes, which serverless handles poorly; managed Postgres 18 with PITR backups (Neon, Supabase, or the container host's offering; confirm PG 18 availability and connection pooling mode, since RLS context needs transaction-scoped settings); object storage S3-compatible (Cloudflare R2 or S3) for uploads with presigned URLs; EAS (Build, Submit, Update) for mobile; Sentry (`@sentry/react-native` 8.35.0 and web) for errors; Expo push for notifications.

Later: move API and worker to a container platform (ECS/Fly machines/Kubernetes only if justified), read replica or larger managed Postgres, PgBouncer, Redis only if a measured need arises, KMS for keys, a managed queue or Inngest/Trigger.dev for durable AI workflows. Prices were not verified in this research; check current vendor pricing before choosing.

Confidence: Medium (60%): vendor landscape changes quickly and costs were not verified.

## 15. Recommended stack (versions verified 2026-11-13 via npm/APIs)

| Area | Choice | Version |
|---|---|---|
| Runtime | Node.js (use LTS line; 26 is current/LTS per endoflife.date) | 26.13.1 (or 24 LTS) |
| Package manager | pnpm | 12.18.0 |
| Monorepo | Turborepo | 2.11.11 |
| Language | TypeScript | 7.0.2 |
| Web | Next.js + React | 16.4.6 + 19.3.1 |
| Mobile | Expo SDK / React Native / Expo Router | 58 (expo 58.0.25) / 0.88.1 / 58.0.31 |
| Build | EAS CLI | 27.9.0 |
| API | Hono + @hono/node-server + @hono/zod-openapi | 4.13.18 / 2.1.8 / 1.6.3 |
| Validation | Zod | 4.6.7 |
| API client | openapi-typescript | 7.13.0 |
| Database | PostgreSQL | 18.7 |
| ORM / migrations | drizzle-orm / drizzle-kit | 0.45.4 / 0.31.11 |
| Auth | better-auth + @better-auth/expo | 1.7.22 |
| Secure storage | expo-secure-store | 58.0.3 |
| Jobs | pg-boss | 12.38.2 |
| Realtime | SSE over HTTP + Postgres outbox | no library |
| Push | expo-server-sdk / expo-notifications | 8.0.0 / 58.1.9 |
| Server state / offline | TanStack Query + persist client | 5.107.1 |
| Local storage (RN) | react-native-mmkv / expo-sqlite | 4.3.2 / 58.0.17 |
| Web UI | Tailwind CSS / shadcn CLI / TanStack Table | 4.3.5 / 4.23.0 / 9.3.1 |
| Client state | Zustand | 5.1.0 |
| RN styling | react-native-unistyles (or NativeWind 4.2.7) | 3.8.1 |
| Lists / animation (RN) | @shopify/flash-list / reanimated | 2.3.3 / 4.7.1 |
| AI | ai + @ai-sdk/anthropic + @ai-sdk/openai | 7.0.171 / 4.0.103 / 4.0.116 |
| KMS (later) | @aws-sdk/client-kms | 3.1168.0 |
| Tests | Vitest / Playwright / Testcontainers (PG) / Maestro CLI | 5.1.0 / 1.65.0 / 12.2.1 / 2.12.1 |
| Errors | @sentry/react-native | 8.35.0 |

Note: several of these libraries are on major versions that postdate common training data (TypeScript 7, Vitest 5, TanStack Table 9, AI SDK 7, Expo 58). Before scaffolding, read each library's migration notes and run a small spike that compiles and runs the whole chain (Expo app in monorepo calling the Hono API with Better Auth) to confirm compatibility.

## 16. Decisions requiring human approval

1. Mobile framework: React Native + Expo (versus Flutter), and acceptance that iOS builds and testing run via EAS cloud and physical devices.
2. Separate Hono API service versus Next.js route handlers only (affects hosting cost and number of deployables).
3. OpenAPI-from-Zod as the contract (versus tRPC for faster but TS-only DX).
4. Drizzle 0.45.x with a known 1.0 migration ahead (versus Prisma 7.10.1 pinned, or waiting for a stable Prisma 8).
5. Shared-schema multi-tenancy with RLS, and whether any customer needs stronger isolation later.
6. Better Auth (self-hosted, fast-moving) versus Clerk (paid, hosted), including who owns user data.
7. pg-boss on the main database (versus adding Redis/BullMQ or a managed workflow service).
8. SSE-only realtime (no collaborative/presence features at launch).
9. Expo Push Service as a third-party dependency for push.
10. Offline scope: read-mostly cache plus outbox, not full bidirectional sync.
11. RN styling: Unistyles versus NativeWind.
12. AI SDK dependency behind a facade, and the AI budget/cost policy per workspace.
13. Secrets: env-held KEK at first, AWS KMS later (needs a cloud account).
14. Hosting vendors and monthly budget; Apple Developer (USD 99/yr as of last known) and Google Play accounts are required to ship.
15. Node line to standardise on (24 LTS versus 26) and the Android JDK version to install alongside Java 25.

## Sources and retrieval dates

All retrieved 2026-11-13 unless stated.

- npm registry: https://registry.npmjs.org/ (per package, versions in section 15)
- Expo versions API: https://api.expo.dev/v2/versions/latest (SDK 58 maps to React Native 0.88.1)
- Expo GitHub releases: https://api.github.com/repos/expo/expo/releases
- Flutter release manifest: https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json
- Node release data: https://endoflife.date/api/nodejs.json
- PostgreSQL release data: https://endoflife.date/api/postgresql.json
- Maestro releases: https://api.github.com/repos/mobile-dev-inc/maestro/releases/latest
- Lucia repository metadata: https://api.github.com/repos/lucia-auth/lucia (deprecation status stated from prior knowledge, not re-verified)
- Better Auth docs via Context7 library `/better-auth/better-auth` (Expo plugin, bearer, multi-session)
- Web search (standard mode) on Prisma and Drizzle status; results third-party, up to September 2026: https://www.prisma.io/blog/announcing-prisma-orm-7-0-0 and https://www.pkgpulse.com/guides/prisma-vs-drizzle-2026
