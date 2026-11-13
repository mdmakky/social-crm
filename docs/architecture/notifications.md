# Notifications and the event outbox

Status: built in Track C (2026-11-13). Implements architecture amendments B1 and B2 (section 13 of `architecture.md`) at minimal scale.

## 1. Domain events (the outbox)

| Table | Purpose |
|---|---|
| `domain_events` | Durable, append-only log: `workspace_id`, `seq`, `type`, `entity_type`, `entity_id`, `actor_user_id`, `payload jsonb`, `created_at`. `UNIQUE (workspace_id, seq)`. |
| `workspace_event_counters` | One row per workspace holding `last_seq`. |
| `event_consumers` | `(consumer, workspace_id) -> last_seq`, the offset of each consumer. |

**Producing.** `emitEvent(tx, { workspaceId, type, entityType, entityId, actorUserId, payload })` in `apps/api/src/events.ts`. It must be called inside the caller's own transaction, so the event commits or rolls back together with the change it describes. It bumps the counter with `UPDATE ... RETURNING last_seq`; the row lock is held until commit, which serializes writers of one workspace, so seq order equals commit order and seq has no gaps (a rolled-back transaction never consumes a number). A trigger refuses any counter change other than +1. Tests: 25 concurrent transactions committing in reverse order while a reader polls; every reader snapshot is a contiguous prefix `1..k`.

**Consuming.** `dispatchPending(db, { consumers, batchSize?, workspaceIds? })`:

1. Lists workspaces from the counter table, then for each (consumer, workspace) opens one transaction.
2. Takes the offset row with `SELECT ... FOR UPDATE SKIP LOCKED`. If another dispatcher holds it, that pair is skipped: two dispatchers never double-process.
3. Reads events with `seq > offset` in order (batch of 100), runs `consumer.handle(tx, event)` for each, and advances the offset **in the same transaction**.
4. A handler error rolls back the batch effects and the offset, and is reported in the result. The next run redelivers: at-least-once delivery, so consumers must be idempotent (the notification consumer is, through `dedupe_key`).

Known limit (`shortcut` in code): a permanently failing event blocks its workspace for that consumer. Add an attempt cap or dead-letter table when a second real consumer exists. Malformed payloads for known types are skipped by the notification consumer rather than thrown, so bad data does not block.

**Running it.** `startDispatcher(db, { consumers, intervalMs, retentionDays })` is an in-process polling loop started by `apps/api/src/server.ts` (`EVENT_DISPATCH_INTERVAL_MS`, default 1000; `EVENT_RETENTION_DAYS`, default 30). Runs never overlap and `stop()` awaits the run in flight (wired to SIGINT/SIGTERM). Decision D7: this moves to a pg-boss worker later. `dispatchPending` is already the unit of work and takes a `Db`, so the worker only calls it from a scheduled job; no other code changes. Tests call `dispatchPending` directly.

**Retention.** `pruneEvents(db, { consumers, olderThanDays })` (run hourly by the loop) deletes events older than N days AND at or below every named consumer's offset. Missing offset rows are created at 0 first, so a newly registered consumer holds events back until it has caught up. The database enforces the offset rule again: the `DELETE` policy on `domain_events` only allows `seq <= min(last_seq)` of the workspace's consumers, and only on the system path.

**Append-only.** `UPDATE` and `TRUNCATE` are revoked from the app role; `DELETE` exists only for the pruning policy above.

## 2. Row-level security design

The dispatcher runs as the same `crm_app` role as request handlers, inside a workspace context (`app.workspace_id`). It has no user. The system path is marked by a transaction-local setting `app.system = 'dispatcher'`, exposed as `app_is_system()`. Only `withSystem()` in `events.ts` sets it; request handlers never do. Every policy below still pins `workspace_id = app_workspace_id()`, so even the system path is confined to one workspace per transaction.

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `domain_events` | system | any active member (request path, via `emitEvent`) | none (revoked) | system, below all offsets |
| `workspace_event_counters` | workspace, or system (to discover workspaces; exposes ids and counters only) | active member, `last_seq = 0` | active member, +1 only (trigger) | none |
| `event_consumers` | system | system | system | none |
| `notifications` | own rows: `user_id = app_user_id()` | system, and the recipient must be an **active** member of that workspace | own rows, **column `read_at` only** (column grant) | none |
| `notification_preferences` | own rows, or system (to honour preferences) | own rows | own rows | none |

Why this satisfies "never read others' rows, even admins": the notification SELECT policy has no role clause and no system clause. Owners and admins get the same policy as everyone, so `SELECT` returns only their own rows. The system path can insert for any active member (the dispatcher must create a recipient's row) but cannot read the table. An insert for a deactivated member or a non-member violates the policy and fails, which is a second line of defence behind the consumer's own check. Users cannot insert notifications at all, so a user cannot forge one for a colleague.

Trade-off, stated plainly: `app_is_system()` is a convention among application code, not a credential. A bug or injected code that sets `app.system` could read the event log of the current workspace and insert notifications for members. It still could not read anyone's notifications, cross workspaces, or alter history. A stronger variant (a separate `crm_worker` role with its own grants) belongs with the pg-boss worker (D7), where the dispatcher becomes its own process.

## 3. Notifications

- `notifications`: `id` (uuidv7, so id order is time order and pages use it as the cursor), `workspace_id`, `user_id` (recipient), `kind`, `title`, `body`, `entity_type`, `entity_id`, `data jsonb`, `dedupe_key`, `created_at`, `read_at`. `UNIQUE (workspace_id, user_id, dedupe_key)`.
- `notification_preferences`: `(workspace_id, user_id, kind) -> in_app boolean`. No row means on.
- **Channel extension point (not built).** `in_app` is the first channel column. Email and push would be added as `email` / `push` boolean columns (default per kind) on `notification_preferences`, with a delivery step beside the notification insert in `consumer.ts`. The preferences endpoint and form return one object per kind, so adding channels widens each object without changing the shape. No email or push code exists.

### Generators

A new kind is added by (1) adding it to `NOTIFICATION_KINDS` and `EventPayloads` in `packages/contracts/src/notifications.ts` and (2) calling `registerGenerator(type, (event, payload) => drafts)` in `apps/api/src/notifications/generators.ts`. A generator only maps an event to recipients and text. The consumer applies the rules common to all kinds:

- the actor is never notified of their own action (`draft.userId === event.actorUserId` is dropped);
- only active members receive rows;
- `in_app = false` for that kind suppresses the row;
- `dedupe_key = <event id>:<kind>` with `ON CONFLICT DO NOTHING`, so processing an event twice creates one row;
- an unknown event type is ignored; a payload that fails its schema is skipped.

### Kinds now

| Event type | Notified | Actor | Entity | Payload |
|---|---|---|---|---|
| `contact.owner_assigned` | `ownerUserId` (the new owner) | user who changed the owner | `contact`, contact id | `{ ownerUserId, previousOwnerUserId?, contactName }` |
| `task.assigned` | `assigneeUserId` | user who assigned | `task`, task id | `{ assigneeUserId, title, contactId? }` |
| `import.completed` | `importedByUserId` | **null** (system completion; the importer is in the payload, otherwise the "actor is never notified" rule would suppress it) | `import`, import job id | `{ importedByUserId, created, updated, skipped, failed? }` |

### API (`packages/contracts/src/notifications.ts`, all under `/v1/workspaces/:workspaceId`)

`GET /notifications` (cursor, `limit` up to 100, `unread=true`), `GET /notifications/unread-count`, `PATCH /notifications/:id` (`{ read }`, so mark read and unread), `POST /notifications/read-all`, `GET /notification-preferences`, `PATCH /notification-preferences` (`{ preferences: [{ kind, inApp }] }`). Every active member of the workspace, any role, may use them for their own data; non-members get 404. Cookie and bearer both work; the drift guard covers all six.

### UI

Bell link with unread badge in the topbar (links to the inbox page; no popover, so no new dependency), `/w/:id/notifications` inbox (All / Unread, Load more, Mark all as read, per-row mark read/unread, row click marks read and navigates to the contact when the notification has one), `/w/:id/settings/notifications` personal preferences (one checkbox per kind, saved on change). The unread count polls every 30 s (`NEXT_PUBLIC_NOTIFICATION_POLL_MS` overrides it), on tab focus and on visibility change; only the newest request may write state. A polite live region announces count changes after the first load. Unread rows show a dot, a "New" label, bold title and screen-reader text "Unread:", so state never relies on colour alone.
