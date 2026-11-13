# Leads/Pipeline: Data Model

Status: DESIGN ONLY (Track E, 2026-11-13). No code or migration exists. Implementation is blocked until Contacts acceptance passes. `[A#]` = assumption, `[Q#]` = open question in `open-questions.md`.

## 1. Entity and rationale

| Decision | Choice | Why |
|---|---|---|
| Table name | `leads` | D20 + `database-design.md` already name it. User-facing label can be "Deal" in a sales pipeline (UI copy only). |
| Lead vs opportunity | Same row. Which one it is = `pipelines.kind` (`lead` or `sales`). A lead "qualifies" by moving to a `sales` pipeline (pipeline change, same id, history kept). | FR-35, D20. No second table, no copy, no duplicate entity. |
| Open / won / lost | `pipeline_stages.kind` (`open`,`won`,`lost`). `leads.outcome` is a denormalized copy of the stage kind, kept honest by a composite FK (see DDL). | Fast filters and checks without joining stages; DB proves it cannot drift. |
| Contact lifecycle vs pipeline stage | Different columns on different tables. `contacts.lifecycle_stage_id` is untouched. No automatic coupling in v1 [Q9]. | D20 condition. |
| Terminal stages | Every pipeline has exactly ONE `won` and ONE `lost` stage, never archived, kind immutable [A1][Q4]. | Makes win/lose endpoints, board columns and reports unambiguous. |
| No hard deletes | Leads: soft delete. Pipelines/stages: archive only. | Preserves history and FKs; no DELETE policy needed. |

## 2. DDL sketch (Drizzle-style intent, shown as SQL)

Conventions copied from `packages/db/src/schema/crm.ts`: `id uuid default uuidv7()`, `workspace_id` on every table, `unique(workspace_id,id)` on parents, composite FKs `(workspace_id, x_id)`, `created_at/updated_at timestamptz`, `version int default 1` on mutable entities.

```sql
CREATE TABLE pipelines (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('lead','sales')),
  default_currency char(3) NOT NULL DEFAULT 'USD' CHECK (default_currency ~ '^[A-Z]{3}$'), -- [A2]
  is_default boolean NOT NULL DEFAULT false,
  position int NOT NULL,
  version int NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX pipelines_one_default ON pipelines (workspace_id) WHERE is_default AND archived_at IS NULL;
CREATE UNIQUE INDEX pipelines_ws_name ON pipelines (workspace_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE pipeline_stages (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  pipeline_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  kind text NOT NULL DEFAULT 'open' CHECK (kind IN ('open','won','lost')),
  default_probability smallint NOT NULL CHECK (default_probability BETWEEN 0 AND 100),
  position int NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, pipeline_id) REFERENCES pipelines (workspace_id, id),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, pipeline_id, id),
  UNIQUE (workspace_id, pipeline_id, id, kind),          -- target of leads outcome FK
  CHECK (kind <> 'won'  OR default_probability = 100),
  CHECK (kind <> 'lost' OR default_probability = 0),
  CHECK (kind = 'open' OR archived_at IS NULL)           -- terminal stages never archived
);
CREATE UNIQUE INDEX stages_one_won  ON pipeline_stages (workspace_id, pipeline_id) WHERE kind='won';
CREATE UNIQUE INDEX stages_one_lost ON pipeline_stages (workspace_id, pipeline_id) WHERE kind='lost';
CREATE INDEX stages_pipeline_pos ON pipeline_stages (workspace_id, pipeline_id, position) WHERE archived_at IS NULL;
-- trigger: BEFORE UPDATE reject change of kind or pipeline_id (immutable).

CREATE TABLE lost_reasons (            -- workspace-configurable [Q5]
  id uuid PRIMARY KEY DEFAULT uuidv7(), workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80), position int NOT NULL,
  archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  description text CHECK (char_length(description) <= 5000),
  primary_contact_id uuid NOT NULL,                      -- [Q2] NOT NULL per FR-6
  pipeline_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  outcome text NOT NULL DEFAULT 'open' CHECK (outcome IN ('open','won','lost')),
  rank text NOT NULL COLLATE "C",                        -- order inside a column, see pipeline-rules.md
  value_minor bigint CHECK (value_minor BETWEEN 0 AND 9007199254740991),
  currency char(3) CHECK (currency ~ '^[A-Z]{3}$'),
  expected_close_date date CHECK (expected_close_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  probability smallint NOT NULL CHECK (probability BETWEEN 0 AND 100),
  probability_manual boolean NOT NULL DEFAULT false,
  closed_at timestamptz,                                 -- won/lost date
  lost_reason_id uuid,
  lost_note text CHECK (char_length(lost_note) <= 1000),
  next_activity_at timestamptz,                          -- derived from tasks, never user-edited
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),  -- [A3] FR-6
  source text NOT NULL DEFAULT 'manual',                 -- same vocabulary as contacts.source [A3]
  source_ref text,                                       -- e.g. lead-ad submission id (Phase 3)
  owner_user_id text REFERENCES "user"(id),
  qualified_at timestamptz,                              -- first entry into a 'sales' pipeline
  custom jsonb NOT NULL DEFAULT '{}',
  version int NOT NULL DEFAULT 1,
  created_by text REFERENCES "user"(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, primary_contact_id) REFERENCES contacts (workspace_id, id),
  FOREIGN KEY (workspace_id, pipeline_id, stage_id, outcome)
    REFERENCES pipeline_stages (workspace_id, pipeline_id, id, kind),   -- stage belongs to pipeline AND outcome = stage kind
  FOREIGN KEY (workspace_id, lost_reason_id) REFERENCES lost_reasons (workspace_id, id),
  CHECK ((value_minor IS NULL) = (currency IS NULL)),                  -- value and currency travel together
  CHECK ((outcome = 'open') = (closed_at IS NULL)),
  CHECK (outcome = 'lost' OR (lost_reason_id IS NULL AND lost_note IS NULL)),
  CHECK (outcome <> 'lost' OR lost_reason_id IS NOT NULL),             -- required to close as lost
  CHECK (outcome <> 'won'  OR probability = 100),
  CHECK (outcome <> 'lost' OR probability = 0)
);
```

Notes:
- **Why `outcome` as a column:** plain checks cannot see another table's `kind`; the 4-column composite FK makes `outcome` provably equal to the stage kind. Cost: stage `kind` is immutable (also a product rule).
- **Money = `bigint` minor units + `char(3)` currency, not `numeric`.** Integer math has no rounding drift in sums; JSON-safe up to `Number.MAX_SAFE_INTEGER` (the CHECK bound), so the API sends plain integers and mobile needs no decimal library. ISO 4217 exponent (JPY 0, USD 2, KWD 3) comes from a code-side table in `packages/core` used for parse/format. DB check is shape only (`^[A-Z]{3}$`); the real allow-list lives in Zod so adding a currency needs no migration [A4]. `numeric(19,4)` rejected: strings in JSON, driver/rounding hazards, no gain since we never store sub-minor units.
- `probability` is NOT NULL (always the stage default or an override) so weighted sums need no null handling; "optional" fields = value, currency, expected close, description, next activity.
- Not stored: `status` (= `outcome`), `follow_up_at` (= `next_activity_at`).
- Reserved nullable columns `ai_score`, `ai_summary` from `database-design.md` are NOT created now (AI scoring is out of scope).

## 3. Indexes

| Index | Serves |
|---|---|
| `leads (workspace_id, stage_id, rank, id) WHERE deleted_at IS NULL` | board column page (keyset on `(rank,id)`) |
| `leads (workspace_id, pipeline_id, outcome, closed_at DESC) WHERE deleted_at IS NULL` | won/lost columns, win-rate, closed lists |
| `leads (workspace_id, owner_user_id, outcome) WHERE deleted_at IS NULL` | "my leads", owner filter |
| `leads (workspace_id, primary_contact_id) WHERE deleted_at IS NULL` | contact detail "Leads" tab, dup check |
| `leads (workspace_id, next_activity_at) WHERE outcome='open' AND deleted_at IS NULL` | overdue / due-soon filter and sort |
| `leads (workspace_id, expected_close_date) WHERE outcome='open' AND deleted_at IS NULL` | closing-soon filter |
| `leads (workspace_id, created_at DESC, id)` | default list sort |
| `gin (lower(title) gin_trgm_ops)` | title search (feeds Track D later) |
| `stage_transitions` indexes: section 5 | history, reports |

## 4. Relations

| Relation | Design |
|---|---|
| Primary contact | `primary_contact_id` composite FK. Changeable via PATCH (history in activities). Contact soft delete does not delete leads; leads of a soft-deleted contact are hidden from boards by join on `contacts.deleted_at IS NULL` [A5]. Contact merge moves `primary_contact_id` (already in merge semantics). |
| Additional contacts | NOT in v1 [Q2]. Additive later: `lead_contacts(workspace_id, lead_id, contact_id, role)`. |
| Tags | `lead_tags(workspace_id, lead_id, tag_id)` mirroring `contact_tags`; same `tags` table (shared vocabulary, composite FKs to `tags_ws_id`). |
| Custom fields | Reuse `custom_field_definitions` with `entity_type='lead'` (column already exists) and `leads.custom jsonb`; same validator as contacts. No schema change to definitions. |
| Saved views / import / export | Reuse `saved_views.entity_type='lead'`, `import_jobs.entity_type='lead'` (export owner/admin, D44). |
| Tasks (Track B) [A6] | Assume B ships `task_links(workspace_id, task_id, entity_type, contact_id NULL, lead_id NULL)` with `entity_type IN ('contact','lead')` allow-list, a CHECK that exactly the matching column is set, and composite FKs. Per-type nullable FK columns recommended over a bare `entity_id` so the DB enforces integrity. **Must change in B:** (1) `tasks.contact_id` NOT NULL goes away (link table replaces it); (2) allow-list gets `'lead'` when Leads ships (additive); (3) B exposes `refreshLeadNextActivity(tx, workspaceId, leadId)` and calls it in the same tx on task create/update/complete/reopen/delete/link change; (4) tasks stay when a lead is soft-deleted but are hidden from "my tasks" lists via the join. Until B lands, Leads slice 1-3 ship with `next_activity_at` always null. |
| Notes | Add nullable `notes.lead_id` (composite FK to `leads`), keep `contact_id` NOT NULL = the lead's primary contact at write time. Lead timeline filters `lead_id`; contact timeline shows everything for that contact including its leads' notes (labelled with lead title). Additive migration. |
| Activities (timeline) | Add nullable `activities.lead_id` + index `(workspace_id, lead_id, id)`. Every lead event writes ONE row with `contact_id = primary contact`, `lead_id`, `kind`, `data`. Contact timeline therefore shows lead events with no extra query. Kinds: `lead.created`, `lead.updated` (data lists changed fields only, no values for `description`), `lead.stage_changed`, `lead.won`, `lead.lost`, `lead.reopened`, `lead.owner_changed`, `lead.contact_changed`, `lead.deleted`. Activities stay append-only (existing RLS: insert only). Also bumps `contacts.last_activity_at` like other activities. |
| Audit | Config changes (pipelines, stages, lost reasons), reopen, delete and export also go to `audit_log` (exists in `tenancy.ts`) [A7]. |

## 5. `stage_transitions` (immutable)

```sql
CREATE TABLE stage_transitions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),          -- time-ordered: id order = chronological per lead
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  lead_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('created','move','won','lost','reopened','pipeline_change')),
  from_pipeline_id uuid, from_stage_id uuid, from_outcome text,   -- all NULL when kind='created'
  to_pipeline_id uuid NOT NULL, to_stage_id uuid NOT NULL, to_outcome text NOT NULL,
  value_minor bigint, currency char(3),          -- snapshot at transition
  probability smallint NOT NULL,                 -- snapshot
  lost_reason_id uuid,                           -- snapshot, only kind='lost'
  actor_type text NOT NULL DEFAULT 'user',       -- user | system | import | automation (later)
  actor_user_id text,
  idempotency_key text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, lead_id) REFERENCES leads (workspace_id, id),
  FOREIGN KEY (workspace_id, to_stage_id) REFERENCES pipeline_stages (workspace_id, id)
);
```

- Append-only, three layers: (a) RLS has SELECT + INSERT policies only, no UPDATE/DELETE policy; (b) `REVOKE UPDATE, DELETE, TRUNCATE` from the app role; (c) trigger `BEFORE UPDATE OR DELETE ... RAISE EXCEPTION 'stage_transitions is append-only'` (also defends against the owner role by accident).
- Rows hold ids and numbers only, no names or PII, so contact erasure needs no deletion [A8]. Stage names resolve through `pipeline_stages` (archived rows keep names).
- Reorder inside a column is NOT a transition. Pipeline-only edits (title, value) are NOT transitions (value change shows in `activities`; a value-over-time report is out of scope).
- Written in the same transaction as the lead update; a lead create writes `kind='created'`.
- Indexes: `(workspace_id, lead_id, id)` history; `(workspace_id, to_stage_id, occurred_at)` stage flow; `(workspace_id, to_outcome, occurred_at) WHERE to_outcome IN ('won','lost')` win/loss reports; unique `(workspace_id, lead_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.

## 6. `lead_tags`

`PRIMARY KEY (workspace_id, lead_id, tag_id)`, composite FKs to `leads` and `tags`. Index `(workspace_id, tag_id, lead_id)` for the tag filter.

## 7. RLS (D45 form; policies in a separate self-contained custom migration per workstreams.md)

All new tables: `ENABLE` + `FORCE ROW LEVEL SECURITY`; `workspace_id = (SELECT app_workspace_id())` in every policy; roles via `(SELECT app_has_role(array[...]))`.

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `pipelines`, `pipeline_stages`, `lost_reasons` | all roles | owner, admin | owner, admin | none |
| `leads` | all roles | owner, admin, agent | owner, admin, agent; WITH CHECK also `(deleted_at IS NULL OR (SELECT app_has_role(array['owner','admin'])))` so an agent cannot soft-delete even through a bug | none |
| `stage_transitions` | all roles | owner, admin, agent | none | none |
| `lead_tags` | all roles | owner, admin, agent | none | owner, admin, agent |
| `activities`/`notes` (existing) | unchanged | unchanged | unchanged | unchanged |

```sql
CREATE POLICY leads_update ON leads FOR UPDATE
  USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent']))
              AND (deleted_at IS NULL OR (SELECT app_has_role(array['owner','admin']))));
```
Reopen (admin only [Q6]) cannot be expressed without OLD row: enforced in `can()` + API, covered by a role test; optionally a BEFORE UPDATE trigger later.

## 8. Seed defaults and migration

- New workspace (same transaction/hook that seeds lifecycle stages [A9]): pipeline "Sales" kind `sales`, `is_default`, currency `USD` [A2]. Stages: New 10, Contacted 20, Qualified 40, Proposal 60, Negotiation 80 (open), Won 100, Lost 0. Lost reasons: No budget, No response, Chose competitor, Not a fit, Timing, Other. Whether to also seed an "Inbound leads" `lead` pipeline: [Q3].
- Existing workspaces: backfill with idempotent `INSERT ... WHERE NOT EXISTS`, inside the integrator's combined migration.
- Backward compatibility: all additive. New tables, plus nullable `activities.lead_id`, `notes.lead_id`. No existing column or API shape changes; contact endpoints unchanged. A later additive `leadCount` on contact detail is optional.
- Order: tables, then RLS/triggers custom migration (self-contained), then seed backfill. Tenancy CI test (`workspace_id`, forced RLS, one policy per table) must pass for all 6 new tables. Integrator regenerates numbering; track suffix `leads_*`.
- Rollback: drop new tables and the two nullable columns; no data in existing tables depends on them.

## Assumptions

A1 one won + one lost stage per pipeline. A2 `default_currency` on pipelines, not a workspace setting. A3 priority and source included from FR-6/`database-design.md` though not in the 2026-11-13 list (cheap, easy to drop). A4 currency allow-list in code. A5 leads of soft-deleted contacts hidden. A6 Track B link model as described. A7 `audit_log` usable for config events. A8 history rows hold no PII. A9 a workspace-seed hook exists.
