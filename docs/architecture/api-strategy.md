# API Strategy

Version 0.1 (Phase 0).

## Contract
- REST over HTTPS under `/v1`. Request and response schemas are Zod, in `packages/contracts`. An OpenAPI 3.1 document is generated from them, and a typed client is generated for both web and mobile. tRPC was rejected because a public, versioned contract matters for installed mobile apps.
- Workspace is chosen by path prefix `/v1/workspaces/{workspaceId}/...` (not a header, so SSE and links work), validated against membership on every request. No endpoint returns data across workspaces.
- Errors use one problem-details shape with stable error codes. Pagination is cursor-based. Mutations accept an `Idempotency-Key` header (and messages a `client_nonce`).
- Optimistic concurrency uses `updated_at`/`version` with `If-Match` on mutable entities, so offline replays cannot silently overwrite newer server data (returns 409 with the current record).

## Versioning and mobile compatibility
Additive changes only inside `/v1`. The server returns `X-Min-App-Version` guidance, and the mobile app shows a blocking update screen when its version is below the minimum. Breaking changes ship as `/v2` with an overlap window.

## Auth
Cookie sessions for web, bearer session tokens for mobile with sliding expiry and server-side revocation. Rotating refresh tokens are not assumed: the research does not confirm Better Auth provides them, so the Phase 1 spike must test what the bearer and Expo plugins actually do and record it. Rate limiting per IP and per user on auth, send and webhook endpoints.

## Resource groups
`/auth`, `/workspaces`, `/members`, `/contacts`, `/leads`, `/pipelines`, `/conversations`, `/messages`, `/integrations` (connect, status, disconnect; never credentials), `/webhooks/{platform}` (public, signature-verified), `/capi`, `/workflows`, `/approvals`, `/ai`, `/notifications` (preferences, devices), `/events/stream` (SSE), `/dashboard`.

## Realtime contract
`GET /v1/events/stream?cursor=` with `Last-Event-ID` resume. Event envelope: `{ id, type, entity, entityId, workspaceId, at, data }`. A `resync` event tells clients to refetch lists.

## Compatibility gate
Phase 1 includes a contract test that generates the client and runs a smoke flow from both web and mobile builds, so mobile problems surface before the web UI is complete.

## Amendments (2026-11-13)

Added resource groups: `/me`, `/search`, `/tags`, `/notes`, `/tasks`, `/activities`, `/saved-views`, `/custom-fields`, `/consent`, `/imports`, `/exports`, `/invitations`, `/audit-log` (read only, owner/admin), `/sessions`, `/devices`, `/attachments`, `/notifications`, `/lead-forms`, `/limits`, `/health`, `/conversations/{id}/presence`.
Public Meta compliance endpoints: `POST /v1/webhooks/meta/data-deletion` (parses `signed_request`, returns a status URL and confirmation code), `POST /v1/webhooks/meta/deauthorize`, and a public deletion status page. Exact request and response formats are taken from the citation check.
`If-Match` carries the entity `version`. Workspace path prefix replaces the header (see Contract). Mobile SSE uses a fetch-stream client.
