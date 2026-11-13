# Track C report: in-app notifications and the event outbox

Branch `track/notifications` (worktree), database `crm_notif`, E2E ports 3412 / 8812. Design: `docs/architecture/notifications.md` (includes the events/outbox section). Screenshots: `docs/design/screenshots/notifications/`.

## Scope delivered

- **Event outbox (B1/B2), built from scratch.** `domain_events`, `workspace_event_counters`, `event_consumers`; `emitEvent(tx, ...)`, `dispatchPending(db, opts)`, `pruneEvents`, `startDispatcher` in `apps/api/src/events.ts`. Gapless per-workspace seq, offsets advanced in the consumer's transaction, `FOR UPDATE SKIP LOCKED` so concurrent dispatchers never double-process, crash-resumable, pruning only below all offsets and older than N days (enforced again by a DELETE policy). In-process polling loop started by `apps/api/src/server.ts` with graceful stop; documented as moving to a pg-boss worker (D7).
- **Notifications.** `notifications`, `notification_preferences`; generator registry with common rules (actor excluded, active members only, preferences, dedupe); generators for `contact.owner_assigned`, `task.assigned`, `import.completed`. Six endpoints, typed contracts, bearer compatible.
- **UI.** Topbar bell with badge, inbox page, preferences page (tab added under Settings), polling plus focus refresh with request sequencing, polite live region, non-colour unread cues, empty/loading/error states, 44px touch targets.
- No email or push. Extension point is documented (channel boolean columns beside `in_app`).

## Tests (all against `crm_notif`)

| Suite | Count | Proves |
|---|---|---|
| `packages/db/test/notifications-rls.test.ts` | 9 | RLS on all 5 new tables: a user cannot read another user's notifications (admin and owner included, other workspace, no user); inserts only on the system path and only for active members; dedupe unique per (workspace, user); only `read_at` updatable; no deletes; preferences own-rows-only; domain_events append-only, DELETE only below consumer offsets; counter +1 only; consumers dispatcher-only. The existing `tenancy.test.ts` tenant-table check still passes with the new tables. |
| `apps/api/test/events.test.ts` | 14 | 25 concurrent transactions committing in reverse order give seq 1..25 and a polling reader never sees a gap (B1 test); rollback does not burn a seq; ordering, offsets, redelivery after a crash (batch and offset roll back together), 3 concurrent dispatchers process each event exactly once, independent offsets, poll loop start/stop, pruning (age AND offsets, late consumer holds events), notification pipeline (owner/actor/self-assign, task, import with null actor, malformed payload skipped, preferences, deactivated member, reprocessing creates one row, new generator registration). |
| `apps/api/test/notifications.test.ts` | 10 | Isolation between members and workspaces, non-member 404, every role may read their own inbox, unread count, read/unread, mark all (own rows only), cursor pagination without repeats, limit/cursor validation, bearer path, 401, preferences defaults/update/muting end to end, validation. Drift guard (`contract.test.ts`) passes with the 6 new endpoints. |
| `apps/web/e2e/notifications.spec.ts` | 5 | Badge updates through polling in a second browser context (clock fast-forward past 30 s) and via focus; live region polite; inbox: unread cues, click navigates and marks read, mark unread, mark all read, Unread filter empty state, Load more (20 then 33); preferences keyboard-toggle persists and mutes a kind through the real dispatcher; 375/768/1440 no overflow and axe (wcag2a/aa/21/22aa) clean on inbox and preferences; Pixel 7 touch targets >= 44px. |

E2E seeds events with SQL that mirrors `emitEvent`; the API's own in-process dispatcher turns them into notifications, so the pipeline is exercised end to end.

See the final run results at the bottom (section "Verification run").

## Call sites for the integrator (I did not edit these files)

Each call goes inside the handler's existing transaction (`withContext(db, ..., async (tx) => { ... })`), after the change succeeds. Import: `import { emitEvent } from "../events.ts";`. Do not emit when nothing changed.

| File / function | When | Call |
|---|---|---|
| `apps/api/src/routes/contacts.ts`, create contact handler (`POST /contacts`) | new contact created with `ownerId` set | `emitEvent(tx, { workspaceId, type: "contact.owner_assigned", entityType: "contact", entityId: contact.id, actorUserId: userId, payload: { ownerUserId: contact.ownerId, previousOwnerUserId: null, contactName: contact.name } })` |
| `contacts.ts`, update contact handler (`PATCH /contacts/:contactId`) | `ownerId` changed to a non-null user | same, with `previousOwnerUserId: <old ownerId>` |
| `contacts.ts`, bulk/other places that assign owner (if any) | owner changes | same |
| `apps/api/src/routes/tasks.ts` (Track B), create task | `assigneeUserId` set | `emitEvent(tx, { workspaceId, type: "task.assigned", entityType: "task", entityId: task.id, actorUserId: userId, payload: { assigneeUserId, title: task.title, contactId: task.contactId ?? null } })` |
| `tasks.ts`, update task | assignee changed to a non-null user | same |
| `contacts.ts` task handlers (today's `createTask`/`updateTask`, until Track B moves them) | as above | as above |
| `apps/api/src/routes/imports.ts`, commit handler (`POST /imports/:importId/commit`) | after the import job is marked complete, in the same transaction | `emitEvent(tx, { workspaceId, type: "import.completed", entityType: "import", entityId: importId, actorUserId: null, payload: { importedByUserId: userId, created, updated, skipped } })` |

Payload shapes are validated by `EventPayloads` in `packages/contracts/src/notifications.ts`. `actorUserId` is the acting user for assignments (so self-assignment notifies nobody); for `import.completed` it must be null because the importer is the intended recipient. The event is emitted in the caller's transaction on purpose: if the change rolls back, no notification is produced. If the integrator adds an `entityId` link target, the web mapping lives in `notificationLink` in `apps/web/components/notifications/notification-list.tsx` (contact, task with `data.contactId`, import).

Also for the integrator:
- Start the dispatcher wherever the API process is composed: already done in `apps/api/src/server.ts`. If Track B or D add consumers, pass them in `startDispatcher({ consumers: [...] })`.
- `EVENT_DISPATCH_INTERVAL_MS` and `EVENT_RETENTION_DAYS` are new optional env vars.
- Prefer deactivating members through the existing member flow: notifications skip non-active members automatically.

## Shared-file edits (minimal, for the integrator)

- `packages/db/src/schema/index.ts`: `export * from "./notifications.ts";`
- `packages/contracts/src/index.ts`: import of `notificationEndpoints`, `export * from "./notifications.ts"` (marked `// track:notifications`), and `...notificationEndpoints` in `endpoints`.
- `apps/api/src/routes/workspaces.ts`: import plus `scoped.route("/", notificationRoutes(db)); // track:notifications`.
- `packages/core/src/permissions.ts`: **no change** (notification endpoints need membership only; own-data access).
- `apps/web/components/shell/app-shell.tsx` (mine): `<NotificationBell>` in the topbar.
- `apps/web/app/w/[workspaceId]/settings/settings-tabs.tsx`: one added "Notifications" tab (not on the ownership list; a one-line change).
- `apps/api/src/server.ts`: dispatcher start, graceful stop, two env vars.
- Migrations: `packages/db/drizzle/0008_notif_tables.sql` (generated) and `0009_notif_rls.sql` (custom, self-contained: function `app_is_system`, FORCE RLS, policies, grants/revokes, counter trigger). I did not touch `_journal.json` beyond what `drizzle-kit generate` wrote for my two entries; the integrator should discard these numbers, regenerate, and re-apply `0009_notif_rls.sql` verbatim after the table migration.

## Design-hook fix

The impeccable hook flagged a coloured side border (side-tab) on unread rows. Removed. Unread is now a filled dot, a visually-hidden "Unread:" label, a visible "New" label, a bolder title and a subtle background tint (`bg-accent-subtle/40`). Axe and e2e re-run after the change (see verification run).

## Open issues and limits

- A permanently failing event blocks its (consumer, workspace) pair; no attempt cap or dead-letter yet (documented `shortcut` in `events.ts`).
- `app.system` is an application-level marker, not a separate DB role (trade-off in `notifications.md` section 2). Split into a `crm_worker` role when the pg-boss worker lands.
- The dispatcher scans every workspace that has a counter row each interval (one cheap query plus one offset transaction per workspace with data). Fine at current scale; at large scale add a "dirty workspaces" notification (LISTEN/NOTIFY) or a worker per shard.
- The notification link for a `task` notification only works when the payload has a `contactId`; Track B's task page needs a mapping when it exists.
- Notifications are not deleted (no retention job for them yet; the app role has no DELETE).
- `import.completed` and the assignment events are not emitted until the integrator wires the call sites above, so in the running app the inbox stays empty until then (the pipeline is proven by tests that call `emitEvent`).
- No popover list in the bell (page only), no sound, no email/push.

## Skills used (actual)

- Read `docs/project/workstreams.md` and architecture section 13 first, as instructed.
- Used Drizzle Kit (`generate`, `generate --custom`) for migrations.
- Visually checked 375 and 1440 screenshots with the image reader.
- Did NOT invoke: superpowers brainstorming/writing-plans, context7, ui-ux-pro-max, impeccable critique/polish, /code-review, /security-review (a post-write impeccable design hook ran automatically on new UI files and found nothing deterministic; I did not run a manual critique). The design followed the existing component library directly. A reviewer pass is still owed.

## Verification run (2026-11-13, database `crm_notif`)

- `turbo run lint typecheck test --continue --force --env-mode=loose`. Note: turbo's strict env mode drops `CRM_DB_NAME`, so without `--env-mode=loose` tests silently hit the default `crm` database. Lint and typecheck pass everywhere. Tests: core 48, api-client 16, db 45, web unit 34, design-tokens 42, api 157 (12 files) all pass in the filtered run (`turbo run test --filter=@crm/api`).
- In the one full-parallel run of all tasks, the existing, unmodified `apps/api/test/contacts-list.test.ts` failed once with `Hook timed out in 10000ms` in its `beforeAll` under CPU contention; it passes in isolation and in the filtered run. Load flake, not a logic failure; its hook timeout should be raised.
- Playwright, full suite on ports 3412/8812: 58 passed (53 existing + 5 notification tests), run before the unread-marker fix. The 5 notification tests (axe at 375/768/1440, touch targets) were re-run after the fix: 5 passed, screenshots regenerated.
