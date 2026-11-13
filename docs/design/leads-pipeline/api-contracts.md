# Leads/Pipeline: API Contracts

Design only. Contracts go in a new `packages/contracts/src/leads.ts` (`export * from "./leads.ts"` + `...leadsEndpoints` spread into `endpoints`, the two shared-file lines from `workstreams.md`). Style follows `packages/contracts/src/crm.ts`: `endpoint({method,path,body,query,response})`, base `${W}` = `/workspaces/:workspaceId`, `trimmed()`, `uuid`, `expectedVersion: z.number().int().min(1)`, errors via the shared `fail(c,status,code,message,extra)` shape, cursors opaque strings with `nextCursor`. `[A#]`/`[Q#]` as before.

## 1. Endpoints

| Method + path | Purpose | Roles |
|---|---|---|
| `GET ${W}/pipelines` | list (incl. stages) `?includeArchived` | all |
| `POST ${W}/pipelines` | create (auto-creates Won + Lost stages) | owner, admin |
| `PATCH ${W}/pipelines/:id` | name, defaultCurrency, isDefault, archived | owner, admin |
| `POST ${W}/pipelines/reorder` | order pipelines | owner, admin |
| `POST ${W}/pipelines/:id/stages` | add open stage | owner, admin |
| `PATCH ${W}/pipelines/:id/stages/:stageId` | name, defaultProbability, archived (+`moveLeadsToStageId`) | owner, admin |
| `POST ${W}/pipelines/:id/stages/reorder` | full ordered id list | owner, admin |
| `GET/POST/PATCH ${W}/lost-reasons` (+`/reorder`) | reason CRUD (archive only) | read all / write owner, admin |
| `GET ${W}/leads` | list, filter, sort, cursor | all |
| `POST ${W}/leads` | create | owner, admin, agent |
| `GET ${W}/leads/:id` | detail (+tags, contact summary, stage, pipeline) | all |
| `PATCH ${W}/leads/:id` | edit fields, `expectedVersion` | owner, admin, agent |
| `DELETE ${W}/leads/:id` | soft delete, body `expectedVersion` | owner, admin |
| `POST ${W}/leads/:id/restore` | undo delete | owner, admin |
| `POST ${W}/leads/:id/move` | stage / pipeline / position | owner, admin, agent |
| `POST ${W}/leads/:id/win` | alias: move to pipeline's won stage | owner, admin, agent |
| `POST ${W}/leads/:id/lose` | alias: move to lost stage + reason | owner, admin, agent |
| `POST ${W}/leads/:id/reopen` | back to open stage | owner, admin [Q6] |
| `GET ${W}/leads/:id/transitions` | immutable history, cursor | all |
| `GET ${W}/leads/:id/timeline` | activities for the lead, cursor (reuses activity shape) | all |
| `GET ${W}/pipelines/:id/board` | board: all columns, first page each | all |
| `GET ${W}/pipelines/:id/board/columns/:stageId` | one column, next page | all |
| `POST ${W}/leads/bulk` | bulk (slice 5) | by action |
| `GET ${W}/leads/export` | CSV/JSON, `?format=` | owner, admin (D44) |
| `GET ${W}/leads/summary` | counts and per-currency totals for filters (feeds dashboard) | all |

Tags use existing tag endpoints extended with `entityType` or `PUT ${W}/leads/:id/tags {tagIds}` [A1: simpler, mirrors contact tag handling]. Notes: `POST/GET ${W}/leads/:id/notes` mirrors contact notes (sets `notes.lead_id`). Tasks: Track B endpoints accept `{entityType:'lead', entityId}` links.

## 2. Zod sketches

```ts
const Money = {
  valueMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullish(),
  currency: z.enum(CURRENCY_CODES).nullish(),        // ISO 4217 allow-list from packages/core
};
const withMoneyPair = <T extends z.ZodTypeAny>(s: T) => s.refine(
  (d: any) => (d.valueMinor == null) === (d.currency == null) || d.valueMinor === undefined || d.currency === undefined,
  { message: "valueMinor and currency go together", path: ["currency"] });

export const LeadOutcome = z.enum(["open", "won", "lost"]);
export const LeadPriority = z.enum(["low", "normal", "high"]);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validCalendarDate_2000_2100);

const LeadFields = {
  title: trimmed(1, 160, "Title"),
  description: nullableText(5000),
  primaryContactId: uuid,
  ownerUserId: z.string().nullish(),
  priority: LeadPriority.optional(),
  source: ContactSource.optional(),
  expectedCloseDate: IsoDate.nullish(),
  probability: z.number().int().min(0).max(100).optional(),   // sets manual override
  custom: z.record(z.string(), z.unknown()).optional(),
  ...Money,
};
export const CreateLeadBody = withMoneyPair(z.object({
  ...LeadFields,
  pipelineId: uuid.optional(),            // default pipeline if omitted
  stageId: uuid.optional(),               // first open stage if omitted
  tagIds: z.array(uuid).max(20).optional(),
  allowDuplicate: z.boolean().optional(),
}));
export const UpdateLeadBody = withMoneyPair(z.object({
  expectedVersion: z.number().int().min(1),
  ...partial(LeadFields minus primaryContactId optional),
  primaryContactId: uuid.optional(),
  resetProbability: z.boolean().optional(),
}));
export const MoveLeadBody = z.object({
  toStageId: uuid,
  toPipelineId: uuid.optional(),          // only for pipeline change
  expectedVersion: z.number().int().min(1).optional(),   // REQUIRED by server when stage changes; optional for same-column reorder
  beforeId: uuid.optional(), afterId: uuid.optional(),   // neighbours for position
  lostReasonId: uuid.optional(), lostNote: nullableText(1000),  // required iff target kind=lost
  closedAt: z.string().datetime().optional(),
});
export const WinLeadBody  = z.object({ expectedVersion: z.number().int().min(1), closedAt: z.string().datetime().optional() });
export const LoseLeadBody = z.object({ expectedVersion: z.number().int().min(1), lostReasonId: uuid, lostNote: nullableText(1000), closedAt: z.string().datetime().optional() });
export const ReopenLeadBody = z.object({ expectedVersion: z.number().int().min(1), toStageId: uuid.optional() });

export const LEAD_SORTS = ["manual", "created", "updated", "value", "expectedClose", "nextActivity", "title"] as const;
export const LeadListQuery = z.object({
  search: z.string().max(100).optional(),
  pipelineId: uuid.optional(), stageId: uuid.optional(),
  outcome: LeadOutcome.optional(),
  ownerUserId: z.union([z.string(), z.literal("unassigned")]).optional(),
  contactId: uuid.optional(), tagId: uuid.optional(), priority: LeadPriority.optional(),
  currency: z.enum(CURRENCY_CODES).optional(),
  valueMin: z.coerce.number().int().min(0).optional(), valueMax: z.coerce.number().int().optional(),
  closeFrom: IsoDate.optional(), closeTo: IsoDate.optional(),
  activity: z.enum(["overdue", "today", "week", "none"]).optional(),   // next_activity_at buckets
  sort: z.enum(LEAD_SORTS).default("created"), dir: z.enum(["asc", "desc"]).default("desc"),
  cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const BoardQuery = LeadListQuery.pick({ search, ownerUserId, tagId, priority, currency, valueMin, valueMax, closeFrom, closeTo, activity })
  .extend({ perColumn: z.coerce.number().int().min(1).max(50).default(20), closedWithinDays: z.coerce.number().int().min(1).max(365).default(30) });
```

Response shapes (abridged):

```ts
LeadCard   = { id, title, primaryContact:{id,name,avatarSeed?}, stageId, pipelineId, outcome, valueMinor|null, currency|null,
               probability, expectedCloseDate|null, nextActivityAt|null, priority, owner:{id,name}|null, tagIds[], rank, version, updatedAt }
LeadDetail = LeadCard + { description, source, sourceRef, closedAt|null, lostReason:{id,name}|null, lostNote|null, qualifiedAt|null,
                          probabilityManual, custom, createdAt, createdBy }
Totals     = Array<{ currency: string, count: number, valueMinor: number, weightedValueMinor: number }>   // never mixed currencies
BoardColumn= { stage:{id,name,kind,position,defaultProbability}, count: number, totals: Totals, cards: LeadCard[], nextCursor: string|null }
Board      = { pipeline: Pipeline, columns: BoardColumn[], filteredOut: number }   // count of leads hidden by filters, for "N hidden" hint
Transition = { id, kind, from:{pipelineId,stageId,outcome}|null, to:{...}, valueMinor, currency, probability, lostReasonId|null, actor:{id,name,type}, occurredAt }
MoveResult = { lead: LeadDetail, changed: boolean, rebalanced?: boolean }   // changed:false on no-op
Page<T>    = { items: T[], nextCursor: string|null }
BulkResult = { results: Array<{ id: string, ok: true, version: number } | { id: string, ok: false, code: string }> }
```

Pagination: keyset cursor encodes the sort key tuple + id (e.g. `(rank,id)` for manual, `(created_at,id)` default, `(value_minor,id)` with NULLs last); opaque base64url; a cursor from a different `sort` is `invalid_cursor` (400). Board column cursors are `(rank,id)`; terminal columns `(closed_at DESC,id)`. Totals/counts are computed over the whole filtered column, not the loaded page. `limit` max 100 (list), 50 (column).

Board query shape: one SQL with window `row_number() OVER (PARTITION BY stage_id ORDER BY rank,id)` filtered `<= perColumn`, plus a grouped aggregate for `count/totals` per stage and currency. Two statements, one tx snapshot (REPEATABLE READ read-only) so counts and cards agree.

## 3. Behaviour notes

- `POST /leads/:id/win|lose` are thin wrappers calling `moveLead` with the pipeline's won/lost stage; a move directly to a terminal stage behaves identically (one code path).
- `move` response always returns the updated `LeadDetail` so the client can reconcile optimistic state with server `version`, `rank`, `probability`.
- 200 vs 409: conflict body = `{error:{code:'version_conflict',message,current: LeadDetail}}` exactly like contacts (D42).
- `Idempotency-Key` header supported on create/move/win/lose/reopen/bulk; same key + different body hash = 422 `idempotency_conflict`.
- Bulk `POST /leads/bulk` `{ids:[<=100], action:'assign'|'tag'|'untag'|'move'|'delete', ...params}`; each item independent (partial success reported per id); `move` only within one pipeline and only to open stages (win/lose are single-item so a reason is always captured) [Q11]; `delete` owner/admin. Each item writes its own transition/activity.

## 4. Error codes

| HTTP | code | When |
|---|---|---|
| 400 | `validation_error` (with field paths), `invalid_cursor` | shape |
| 401/403 | `unauthenticated`, `forbidden` | auth, role |
| 404 | `not_found` | lead, pipeline, stage, reason (also cross-tenant: never reveals existence) |
| 409 | `version_conflict` (+`current`) | stale `expectedVersion` |
| 409 | `duplicate_lead` (+`existing`) | same contact, open lead, same pipeline |
| 409 | `stage_archived`, `pipeline_archived`, `pipeline_not_empty` (+counts), `lead_closed`, `stage_list_stale`, `last_default_pipeline`, `terminal_stage_locked` | state rules |
| 422 | `lost_reason_required`, `lost_reason_invalid`, `stage_not_in_pipeline`, `contact_not_found`, `owner_invalid`, `currency_invalid`, `value_invalid`, `probability_invalid`, `close_date_invalid`, `invalid_transition`, `idempotency_conflict` | business validation |
| 429 | `rate_limited` | existing limiter |

## 5. Mobile compatibility

Bearer-token and cookie both work (same middleware). Plain JSON, integer money, ISO dates, no server-rendered HTML. Offline replays safe: every mutation has `expectedVersion` or idempotency key; `rank` is opaque; the mobile pipeline view (FR-55 segmented stage list) uses `GET /pipelines/:id/board/columns/:stageId` per selected segment + `move` with `toStageId` (no position needed). Additive only: new optional fields later never remove existing ones; clients ignore unknown fields. `LeadCard` is deliberately small for list payload size.

## 6. Drift guard implications

- Every endpoint above is declared with `endpoint()` in `leads.ts`, registered in `endpoints`, and the API route handlers must match the contract; the existing drift test (contracts vs registered Hono routes) fails if a route is missing or undeclared. Adding ~25 endpoints grows that list: write routes and contracts in the same slice.
- Route order: `/leads/bulk`, `/leads/export`, `/leads/summary`, `/pipelines/reorder` before `/:id` patterns to avoid shadowing (the contacts router already has the same hazard with `lifecycle-stages/reorder`).
- Response schemas are used by `apiClient` in `apps/web` and mobile: any shape change is a contract change and breaks typecheck in both clients (intended).
- Shared-file edits for the integrator: `index.ts` (export + spread), `workspaces.ts` (one `.route`), `permissions.ts` (`// --- track:leads ---` actions, see permissions-matrix.md).

## Assumptions
A1 tag set via `PUT /leads/:id/tags`. Open: [Q11] bulk scope, [Q6] reopen role.
