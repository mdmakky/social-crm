# Leads/Pipeline: Stage History and Reporting

Design only. Table definition is in `data-model.md` section 5; rules in `pipeline-rules.md`.

## 1. What the history stores

One immutable row per lifecycle event of a lead (`created`, `move`, `won`, `lost`, `reopened`, `pipeline_change`): from/to pipeline, stage and outcome; a snapshot of `value_minor`, `currency`, `probability` at that moment; lost reason (only on `lost`); actor (type + user id); `occurred_at`; optional idempotency key. NOT stored: names (resolved by join, stage rows are never deleted), PII, free text, field edits other than value/probability snapshots, reorder-within-column events. Time-in-stage is derived (next row's `occurred_at` minus this row's), not stored, so history stays append-only with no "close the previous row" update.

Guarantees: append-only (RLS + REVOKE + trigger); every `leads.stage_id` change has exactly one row in the same tx (test: property check that `leads.stage_id` = latest `to_stage_id` for all leads); `created` row exists for every lead (backfill for any lead created by import). Time order = `id` (uuidv7) order within a lead; `occurred_at` is for reporting.

## 2. Metrics available now (workspace-scoped, per pipeline, optional date range, optional owner)

| Metric | Definition | Source |
|---|---|---|
| Lead counts | open / won / lost, by pipeline, stage, owner, source | `leads` |
| Value by stage | per-currency `sum(value_minor)` and weighted sum of open leads | `leads` |
| Win rate | won / (won + lost) among leads closed in range (by count; by value per currency) | `leads` (+transitions for range by `occurred_at`) |
| Average / median time in stage | duration between consecutive transitions for leads that left the stage | `stage_transitions` |
| Cycle time | `closed_at - created_at` for won leads | `leads` |
| Aging | days since last stage change for open leads (stale = over N days) | latest transition per lead |
| Lost reasons | count and per-currency value by reason, in range | `leads` (+transitions) |
| Stage conversion | leads entering stage A that later entered stage B | `stage_transitions` |
| Created over time / closed over time | per day/week | `leads.created_at`, `closed_at` |
| Overdue | open leads with `next_activity_at < now()` or no next activity | `leads` |

## 3. Example SQL shapes

```sql
-- value by stage (never mixes currencies)
SELECT stage_id, currency, count(*) AS n, sum(value_minor) AS value_minor,
       round(sum(value_minor::numeric * probability / 100)) AS weighted_minor
FROM leads
WHERE workspace_id = $1 AND pipeline_id = $2 AND outcome = 'open' AND deleted_at IS NULL
GROUP BY stage_id, currency;                       -- idx: (workspace_id, stage_id, rank, id) partial

-- win rate in range, by count
SELECT count(*) FILTER (WHERE outcome='won')::float
       / NULLIF(count(*) FILTER (WHERE outcome IN ('won','lost')), 0) AS win_rate
FROM leads
WHERE workspace_id = $1 AND pipeline_id = $2 AND outcome IN ('won','lost')
  AND closed_at >= $3 AND closed_at < $4 AND deleted_at IS NULL;   -- idx: (workspace_id, pipeline_id, outcome, closed_at DESC)

-- average time in stage (leads that left it)
WITH t AS (
  SELECT lead_id, to_stage_id AS stage_id, occurred_at,
         lead(occurred_at) OVER (PARTITION BY lead_id ORDER BY id) AS left_at
  FROM stage_transitions WHERE workspace_id = $1 AND to_pipeline_id = $2)
SELECT stage_id, avg(left_at - occurred_at) AS avg_time, percentile_cont(0.5) WITHIN GROUP (ORDER BY left_at - occurred_at) AS median
FROM t WHERE left_at IS NOT NULL AND left_at >= $3 GROUP BY stage_id;
-- idx: (workspace_id, lead_id, id); pipeline filter via to_pipeline_id (add index (workspace_id, to_pipeline_id, to_stage_id, occurred_at) if scan cost shows up)

-- aging of open leads
SELECT l.id, now() - max(t.occurred_at) AS in_stage
FROM leads l JOIN stage_transitions t ON t.workspace_id=l.workspace_id AND t.lead_id=l.id
WHERE l.workspace_id=$1 AND l.pipeline_id=$2 AND l.outcome='open' AND l.deleted_at IS NULL
GROUP BY l.id HAVING now() - max(t.occurred_at) > interval '14 days';
-- shortcut option: LATERAL ... ORDER BY id DESC LIMIT 1 on (workspace_id, lead_id, id); or add leads.stage_entered_at later if this is hot [A1]

-- lost reasons
SELECT lost_reason_id, currency, count(*), sum(value_minor)
FROM leads WHERE workspace_id=$1 AND outcome='lost' AND closed_at >= $2 AND deleted_at IS NULL GROUP BY 1,2;
```

Index needs beyond `data-model.md`: none for MVP volumes (target 10k leads, ~5 transitions each, 50k rows: all queries scan one workspace via index). Re-evaluate at 1M transitions per workspace: partition `stage_transitions` by month or add a rollup table (not now). Consider `leads.stage_entered_at` (denormalized, set in the same tx) if aging becomes a hot board feature [A1].

Correctness notes: exclude soft-deleted leads (history rows stay, joins filter `leads.deleted_at IS NULL`); a reopened lead has several `won`/`lost` rows, so win rate counts distinct final states via `leads.outcome`, while "transitions into won in range" counts events: label the report so users know which; archived stages still appear by name in history; pipeline changes count as leaving one stage and entering another (cycle time per pipeline uses `to_pipeline_id`).

## 4. NOT now

| Excluded | Reason / what would be needed |
|---|---|
| Forecasting (weighted pipeline by close month, quota, scenarios) | Out of approved scope. Weighted value shown on board totals is a static sum, not a forecast. |
| AI scoring / AI summaries | Out of scope; no `ai_score` columns created. |
| Commission tracking | Out of scope; no rep targets, splits or payouts. |
| FX conversion / single reporting currency | Needs rates table + policy [Q8]. |
| Value-over-time history (value changed from X to Y) | Only snapshots at stage transitions; field-level history lives in activity data. |
| Cohort/funnel visualisations beyond simple conversion table | Later with dashboard. |
| Sales cycle benchmarks across workspaces | Never (tenant isolation). |
| Event streaming / BI export | Phase 6 outbox consumers. |

## 5. Requirements for the dashboard slice (FR-30)

1. Endpoint `GET ${W}/leads/summary` (or `/reports/pipeline`) with `pipelineId`, `from`, `to`, `ownerUserId`; returns per-currency arrays only. Shape: `{ byStage:[{stageId,count,totals}], winRate:{count, byCurrency[]}, lostReasons:[...], avgTimeInStage:[{stageId, avgSeconds, medianSeconds, samples}], aging:{buckets}, createdSeries, closedSeries }`.
2. Dashboard tiles needed: new leads (period vs previous), open pipeline value by stage (per currency), win rate, avg cycle time, lost reasons top 5, overdue next-activity count, aging list.
3. Role: all roles read; values visible to everyone who can read leads [Q15: hide value from agents? recommendation no].
4. Performance: each tile under 300 ms p95 at 10k leads; computed on demand with indexes above; cache for 60 s per (workspace, params) only if measured slow.
5. Test data: seed generator producing leads with realistic transition histories (including reopen and pipeline change) to test metrics against hand-computed expectations.
6. Empty-state rules: win rate shows "No closed leads in this period", never 0%; time-in-stage hides stages with fewer than 3 samples ("not enough data").
7. Export of report rows follows the export permission (owner/admin).

## Assumptions
A1 `stage_entered_at` is deferred; derived from latest transition until measured slow.
