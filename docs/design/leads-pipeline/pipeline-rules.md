# Leads/Pipeline: Business Rules

Design only. Pairs with `data-model.md`. `[A#]` assumption, `[Q#]` open question (`open-questions.md`). All rules are enforced server-side in one shared service (`moveLead`) used by API, bulk and (later) automations; the UI only mirrors them.

## 1. Stage movement

| Case | Rule |
|---|---|
| Open to open (same pipeline) | Allowed any direction, any distance. Forward, backward and skipping are all legal; no gating fields in v1 [A1]. Writes `stage_transitions(kind='move')`, bumps `version`. |
| To the won stage | Sets `outcome='won'`, `closed_at = now()` (or supplied `closedAt`), `probability=100`, `probability_manual=false`. Kind `won`. Value is NOT required. |
| To the lost stage | Requires `lostReasonId` (active reason). Optional `lostNote`. Sets `outcome='lost'`, `closed_at`, `probability=0`. Kind `lost`. Missing reason: `lost_reason_required` (422), nothing changes. |
| Reopen (won/lost to any open stage) | Clears `closed_at`, `lost_reason_id`, `lost_note`; probability re-applies stage default; `outcome='open'`; kind `reopened`. History is never rewritten. Role: owner/admin only [Q6]. Reopen target must be an active open stage; default offered = the last open stage before closing (from history). |
| Won to lost or lost to won directly | Not allowed. Reopen first (two explicit transitions, both in history). |
| Pipeline change | Same call with `toPipelineId` + `toStageId` (target must be an active open stage of an unarchived pipeline). Kind `pipeline_change`; sets `qualified_at` on first entry into a `sales` pipeline; probability re-applies target stage default; `rank` recomputed at the end of the target column unless neighbours given. Closed leads cannot change pipeline (reopen first). Currency is kept, never converted. |
| Move into the stage it is already in | No-op success (200, `changed:false`), no transition row, no version bump. Position-only drags in the same column just update `rank` (section 6). |
| Archived stage as target | `stage_archived` (409). Archived stage never holds leads (below). |
| Move of a deleted lead / archived pipeline | `not_found` / `pipeline_archived` (409). |
| Stage must belong to pipeline | Enforced by composite FK and checked first for a clear error (`stage_not_in_pipeline`, 422). |

## 2. Archive and delete

| Action | Rule |
|---|---|
| Archive an open stage | Requires zero non-deleted leads in it, OR body `moveLeadsToStageId` (an active open stage of the same pipeline). The archive runs in one tx: lock stage `FOR UPDATE`, move leads (one transition each, actor = acting admin, `kind='move'`), set `archived_at`. Moves into a stage take `FOR SHARE` on it, so a concurrent move cannot land in a stage being archived. Invariant: archived stages hold no leads, so boards and reports never need an "orphan column". |
| Won / lost stage | Cannot be archived, renamed to empty, or change kind. Rename and `default_probability` locked (won=100, lost=0). |
| Pipeline | No hard delete. "Delete" = archive. Archive requires zero OPEN leads (user must move or close them; `pipeline_not_empty` 409 with counts). Closed leads stay readable (list, contact tab, reports) and read-only for stage changes. Reopen into an archived pipeline is refused. The default pipeline cannot be archived until another is made default [A2]. Unarchive allowed (admin). |
| Lead | Soft delete (`deleted_at`), owner/admin. Hidden from board/lists/reports; its history stays. Restore allowed (owner/admin) within the retention window the same way contacts do [A3]. Deleted leads keep `stage_id`; if the stage is later archived the archive check ignores deleted leads. A restore into an archived stage is refused until moved: restore requires `toStageId` if the stage is archived. |
| Stage reorder | Only `position` changes; no transitions. Positions are rewritten for the whole pipeline in one tx (`reorder` takes the full ordered id list; stale list returns `stage_list_stale` 409). Won/lost always sort last (position forced). |
| Lost reason | Archive only; archived reasons stay on old leads, are hidden from the picker. |

## 3. Probability

- Stage `default_probability` (0-100). New lead and every stage change set `probability = stage.default_probability`, `probability_manual=false`.
- Manual override: PATCH `probability` 0-100 sets `probability_manual=true`. Allowed only while `outcome='open'`.
- **When the default re-applies:** on EVERY stage or pipeline change the override is cleared and the new stage default applies [Q7 - recommended; alternative: override sticks until reset]. Also on explicit `resetProbability:true`, and on reopen. Won/lost always force 100/0.
- Editing a stage's `default_probability` later does NOT retro-update existing leads (history stays truthful); only `probability_manual=false` leads in that stage are re-synced by an explicit admin "apply to open leads" action (out of v1, noted) [A4].
- Transition rows snapshot probability so reports use the value that was true then.

## 4. Currency and value

| Rule | Detail |
|---|---|
| Format | `currency` ISO 4217 alpha-3, uppercase, from a code allow-list (`packages/core`); `valueMinor` integer >= 0 in that currency's minor unit (exponent table: JPY 0, USD 2, KWD 3). Both set or both null. |
| Default | New lead: currency defaults to `pipeline.default_currency` when a value is supplied without a currency. Never silently default when both absent (value stays null). |
| Changing currency | Allowed on open leads; value is NOT converted (UI warns "value stays X, only the currency label changes"). Closed leads: value/currency read-only; reopen to edit [Q6]. |
| Totals | NEVER sum across currencies. Every total is an array grouped by currency: `[{currency, valueMinor, weightedValueMinor, count}]`. UI shows one chip per currency (max 3 shown, "+N" opens popover). Single-currency workspaces see exactly one figure. |
| Weighted value | `sum(value_minor * probability) / 100` computed in SQL as `round(sum(value_minor::numeric * probability / 100))` per group (rounding once, half up, at the aggregate). |
| FX conversion | Not now [Q8]. Would need a rates table, date policy and a reporting currency; excluded with forecasting. |

## 5. Dates

| Field | Rule |
|---|---|
| `expected_close_date` | Calendar date (no timezone), 2000-01-01 to 2100-12-31. Past dates allowed on open leads (shown "overdue"). Not editable on closed leads. Cleared on nothing automatically. Closing does not change it (kept for slip analysis). |
| `closed_at` | Server `now()` by default. Optional `closedAt` for back-dating: must be `<= now() + 5 min` (clock skew) and not before the lead's `created_at` (else `close_date_invalid`) [A5]. Set only by win/lose/move-to-terminal. |
| `next_activity_at` | Read-only derived (below). |
| Timezone | All timestamps UTC; UI renders in the viewer's timezone; the expected close date is shown as the stored calendar date. |

## 6. Ordering inside a column (survives concurrent drags)

- `leads.rank text COLLATE "C"`: fractional index (base-62 string, insert-between algorithm, a la LexoRank/`fractional-indexing`). Sort is `ORDER BY rank, id`; `id` (uuidv7) breaks ties, so two writers who compute the same rank still give a deterministic order and nobody errors.
- Client sends neighbours, not a rank: `beforeId` / `afterId` (either or both, same target column). Server, inside the move tx, reads the two neighbours' current ranks (not the client's view) and computes a rank strictly between. If a neighbour moved meanwhile, the card lands next to the surviving neighbour - acceptable and never an error. If neighbours are missing/deleted, fall back to column end.
- Reorders do NOT check or bump `version` (so dragging never conflicts with someone's field edit). Stage changes DO check `expectedVersion` (section 8).
- Rebalance: when a computed rank would exceed 48 chars or equals a neighbour, server rewrites that column's ranks with even spacing in one statement (rare; locked by `pg_advisory_xact_lock(hash(stage_id))`). Clients treat rank as opaque and re-read after a `rebalanced:true` hint.
- Default position on create / entering a column from another stage: top (newest first) for open stages; won/lost columns sort by `closed_at DESC` and ignore rank (drag within terminal columns is disabled).
- Default order alternative (by value/close date) is a view sort, not stored rank; dragging is only enabled when the board sort is "Manual" [A6].

## 7. next_activity_at derivation

= `min(due_at)` of OPEN tasks linked to the lead (Track B `task_links`, entity `lead`), null if none. Overdue tasks count (shows as overdue). Recomputed in the same tx by `refreshLeadNextActivity` on any task change (create, due change, complete, reopen, delete, link add/remove, lead restore). Safety net: nightly job recomputes drift (cheap, indexed). Closed leads: set null on win/lose (open tasks remain tasks but stop driving the lead) and recompute on reopen. Never writable via API. Until Track B ships it stays null [A7].

## 8. Concurrency and idempotency

| Operation | Mechanism |
|---|---|
| PATCH fields, move-stage, win/lose/reopen, delete | `expectedVersion` required; mismatch returns 409 `version_conflict` with `current` lead attached (same as contacts, D42). Successful change: `version = version + 1` in the same `UPDATE ... WHERE version = $expected` (single statement, no read-then-write race). |
| Position-only move | No version check, no bump. |
| Retried request | `Idempotency-Key` header (existing `idempotency_keys` table, M12) on create, move, win/lose; replay returns the stored response. Without a key, moving to the stage the lead is already in is a natural no-op, so a retried move after success does not double-write history even if `expectedVersion` is stale: detect `current.stage_id == toStageId` and return 200 with `changed:false`. Transition rows also carry `idempotency_key` with a partial unique index as a last guard. |
| Concurrent moves of one lead | Row lock (`SELECT ... FOR UPDATE` on the lead in the move tx); loser gets `version_conflict`, UI shows conflict toast with the winner's stage. |

## 9. Duplicate prevention

- Soft guard like contacts: on create, if the same `primaryContactId` already has an OPEN lead in the same pipeline, return 409 `duplicate_lead` with the existing lead; client may resend `allowDuplicate:true`. Not a DB unique constraint: one contact legitimately has several deals [Q10].
- Double submit: create accepts `Idempotency-Key`; UI disables submit while in flight.
- Cross-source (lead ads, Phase 3): unique `(workspace_id, source, source_ref)` partial index where `source_ref IS NOT NULL` so a webhook replay cannot create two leads [A8].

## 10. Validation rules table

| Field | Rule | Error code |
|---|---|---|
| title | trimmed, 1-160 | `validation_error` |
| description | <= 5000, plain text | `validation_error` |
| primaryContactId | exists, same workspace, not deleted | `contact_not_found` (422) |
| pipelineId / stageId | same workspace, stage in pipeline, stage and pipeline not archived (for writes) | `stage_not_in_pipeline`, `stage_archived`, `pipeline_archived` |
| valueMinor | integer 0..9007199254740991 | `value_invalid` |
| currency | ISO 4217 allow-list; required iff value set | `currency_invalid` |
| probability | integer 0..100, open leads only | `probability_invalid` |
| expectedCloseDate | `YYYY-MM-DD`, real date, 2000..2100 | `close_date_invalid` |
| closedAt | ISO instant, not future, not before created | `close_date_invalid` |
| lostReasonId | active reason, required for lost | `lost_reason_required`, `lost_reason_invalid` |
| ownerUserId | active member of workspace | `owner_invalid` |
| tagIds | max 20, exist | `validation_error` |
| custom | validated against `custom_field_definitions` (entity `lead`) | `validation_error` with field paths |
| closed lead edit | value, currency, close date, probability, stage-affecting fields refused | `lead_closed` (409) |

## Assumptions
A1 no stage-gating fields now. A2 default pipeline cannot be archived while default. A3 lead restore mirrors contact restore behaviour. A4 no automatic probability resync. A5 backdating limited to after creation. A6 manual sort is the only draggable sort. A7 Track B ships first. A8 Lead Ads dedupe key at Phase 3.
