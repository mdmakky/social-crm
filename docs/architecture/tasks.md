# Tasks (workspace level)

Track B. Extends the per-contact follow-ups into a workspace task system. Contact-scoped endpoints are unchanged in path and behavior.

## Model

| Table | Purpose |
|---|---|
| `tasks` | One row per task. `contact_id` is now nullable (composite FK to `contacts(workspace_id, id)` keeps it in the same workspace). New columns: `description`, `priority`, `version`, `deleted_at`. |
| `task_events` | Immutable history. Append-only for every role including the table owner (statement trigger), `REVOKE UPDATE, DELETE, TRUNCATE` for `crm_app`. |
| `task_links` | Generic task to entity links (see below). |

Status: `open`, `in_progress`, `done`, `cancelled`. Active = open or in_progress. Only `done` sets `completed_at`; reopening or cancelling clears it. Priority: `low < normal < high < urgent` (a Postgres enum, so `ORDER BY priority` and its index work natively).

Delete is a soft delete (`deleted_at`) because history must keep its parent row. Deleted tasks disappear from every list and from 404 on read; their history stays and ends with a `deleted` event.

Events: `created`, `updated` (title, description; lists the fields), `status_changed`, `completed`, `reopened`, `assignee_changed`, `due_date_changed`, `priority_changed`, `contact_changed`, `deleted`. One event per changed attribute, written in the same transaction as the change. A request that changes nothing writes nothing and does not bump `version`. Moving from a closed status (done, cancelled) to an active one is `reopened`; moving to done is `completed`; every other status move is `status_changed`. All carry `{from, to}`.

## Link model: `task_links`

Requirement: tasks must be linkable to future entities (opportunities, conversations, ...) without those entities existing. Options considered:

1. A nullable column per entity on `tasks` (`opportunity_id`, ...): real FKs, but a schema change to the hottest table per entity, and one task cannot relate to several things.
2. `task_links(workspace_id, task_id, entity_type, entity_id)` (chosen): adding an entity is one value in an allow-list plus one validation branch, many links per task, and "tasks for entity X" is one indexed lookup (`task_links_entity_idx`).
3. Free-form JSON: no integrity, no index. Rejected.

Integrity without per-type FKs: a CHECK constraint holds the allow-list (`entity_type IN ('contact')`), a `BEFORE INSERT` trigger (`task_links_validate`) verifies the target exists in the same workspace (one branch per type), the composite FK ties the link to a task of the same workspace, and RLS scopes by workspace. Adding `opportunity` later means: extend the CHECK and `TASK_LINK_ENTITY_TYPES`, add a branch in `task_links_validate`. No pipeline entity is created here.

`tasks.contact_id` stays the canonical, FK-guaranteed primary contact (it is what the existing contract exposes and what makes the common query cheap). A trigger (`tasks_sync_contact_link`) mirrors it into `task_links` atomically on insert and change, so generic "tasks linked to X" queries work for contacts too. The API does not write `task_links` directly today; only future entity types will.

## Permissions

Matrix (`task.edit`): owner and admin any task, agent only own (assignee or creator), viewer none. All roles view tasks and history. Creating requires `task.edit` with `isOwn: true` (agent yes, viewer no).

Enforced twice:
- API: `can()` on every write (`canEditTask` in `@crm/core/tasks` for the UI).
- RLS: `tasks_update` USING lets owner/admin update any row and an agent only rows where `assignee_user_id` or `created_by` is them; WITH CHECK needs only a writer role, so an agent can hand over a task they own. `tasks_insert` requires `created_by = app_user_id()`. `task_events_insert` requires `actor_user_id = app_user_id()`. Policies use the scalar-subquery helper form (D45).

## API

All under `/v1/workspaces/:workspaceId`, defined in `packages/contracts/src/tasks.ts`.

| Endpoint | Notes |
|---|---|
| `GET /tasks` | Filters, sort, keyset cursor, `total`. |
| `GET /tasks/summary` | Counts for the tabs: overdue, today, upcoming, noDate, completed, active. Accepts `assignee`, `contactId`, `tz`, `asOf`. |
| `POST /tasks` | Create; `contactId` optional; assignee defaults to the creator, `null` means unassigned. |
| `GET /tasks/:id`, `GET /tasks/:id/events` | Detail; history newest first, cursor by event id. |
| `PATCH /tasks/:id`, `DELETE /tasks/:id` | Existing endpoints, extended. |
| `GET/POST /contacts/:contactId/tasks` | Existing, unchanged paths. |

Compatibility: the `Task` response only gained fields, with two exceptions to note for mobile: `contactId` can now be `null`, and `status` can be `in_progress` or `cancelled`. `expectedVersion` on PATCH is optional so older clients keep working; when sent it is enforced (409 `version_conflict` with `details.current`). Without it, the update is still guarded by `WHERE version = <read version>`, so a race returns 409 rather than overwriting.

### Filters and sorting

`assignee`: `me`, `unassigned`, or a member's user id (absent = anyone). `status`, `priority`: comma lists. `contactId`. `dueFrom`/`dueTo`: inclusive instants. `search`: case-insensitive substring over title and description (LIKE wildcards escaped). `sort`: `due` (default), `priority`, `created`, `updated`; `dir`: `asc` (default) or `desc`. Due date puts undated tasks last in both directions. Ties break on `id`. The cursor is keyset `(sort key, id)`, bound to the sort and direction of the query that made it; a mismatched cursor is a 400.

### Views, "now" and time zones

`view` is one of: `overdue`, `today`, `upcoming`, `no_date`, `completed`, `all`. The web "Open" tab is `all` plus `status=open,in_progress`.

- "Now" is `asOf` when given, otherwise the server clock.
- overdue: active and `due_at < now` (strict).
- upcoming: active and `due_at >= now`. A task due exactly now is upcoming (and today).
- today: active and `due_at` in `[00:00, next 00:00)` of the calendar day containing now in `tz` (IANA name; default UTC; the web sends the workspace time zone). Calendar arithmetic is done in Postgres (`AT TIME ZONE`), so DST days of 23 or 25 hours are right. A task due earlier today is `today` in the Today view and also `overdue`; the two views overlap by design, and the UI badge shows Overdue first (`dueState`).
- no_date: active with no due date. completed: status `done` (cancelled tasks appear only through the status filter).
- Unknown `tz` is a 400.

### Contact timeline

For a task linked to a contact: create writes `task.created`; done writes `task.completed`; closed to active writes `task.reopened`; cancelled writes `task.cancelled`; delete writes `task.deleted`; changing the contact writes `task.unlinked` on the old and `task.linked` on the new contact. Each goes through `recordActivity`, which also bumps `contacts.last_activity_at`. Plain edits and open/in-progress moves are history-only (no timeline noise). `openTaskCount` on a contact counts active, non-deleted tasks.

## Performance

Expression indexes `coalesce(due_at, 'infinity')` and `coalesce(due_at, '-infinity') DESC` serve the due ordering exactly; plain indexes serve priority, created and updated. 10,000 tasks, as an agent through RLS: every list variant p95 < 60 ms (gate 300 ms). Without the expression indexes the due sort was ~400 ms, which is why they exist.

## Known limits

- Due dates in the form are entered in the browser's time zone (as on the contact page) and displayed in the workspace time zone.
- Search is a substring scan filtered by workspace (no trigram index); fine at 10k per workspace, revisit past ~100k.
- Tasks created before this change have no `created` history entry.
- `task_events.actor_user_id` insert policy checks the actor and role, not task ownership; the API enforces ownership.
