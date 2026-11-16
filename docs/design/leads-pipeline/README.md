# Leads/Pipeline Design (Track E, design only)

> Update 2026-11-17 (D170 to D179): the kanban board described in `kanban-interaction-design.md` was removed. Leads is the single view (list with stage chips, filters and bulk stage change) and the UI says "lead" everywhere, never "deal". This design set is kept as history for the data model and rules, which are unchanged.

Date 2026-11-13. No code, migrations or contracts exist for this feature; production implementation is blocked until Contacts acceptance passes (see `docs/project/workstreams.md`).

**Summary.** One CRM entity, table `leads` (D20, FR-35), represents both a lead and a deal: the pipeline it sits in has `kind` `lead` or `sales`, and won/lost are stage kinds (`pipeline_stages.kind`), not separate tables. Contact lifecycle stage is untouched and separate. The record carries the user-approved fields (value as integer minor units + ISO 4217 currency, expected close date, probability 0-100 with stage default and manual override, pipeline, stage, lost reason, closed date, primary contact, description, next activity date derived from tasks). Multiple pipelines are supported; each has exactly one Won and one Lost stage. Every stage change writes an immutable `stage_transitions` row (append-only by RLS, REVOKE and trigger). Concurrency uses `expectedVersion` (as contacts) and fractional `rank` for card order; totals are always per currency. Forecasting, AI scoring and commissions are out of scope.

## Documents

| File | Contents |
|---|---|
| `data-model.md` | entity decision, DDL, constraints, indexes, relations, RLS, seed, migration |
| `pipeline-rules.md` | stage/probability/currency/date rules, ordering, concurrency, validation table |
| `api-contracts.md` | endpoints, Zod sketches, errors, mobile, drift guard |
| `permissions-matrix.md` | role x action, RLS backing, audit entries, tests |
| `kanban-interaction-design.md` | board at 375/768/1440, drag + keyboard alternative, states, screens |
| `stage-history-and-reporting.md` | history semantics, metrics, SQL shapes, NOT-now list, dashboard needs |
| `open-questions.md` | 18 numbered decisions with recommendations |

## Build-order proposal (slices; each ends green on the repo gates)

Gates for every slice: lint, typecheck, full unit/integration suites against its own DB, tenancy CI test (`packages/db/test/tenancy.test.ts`), role/RLS tests, contract drift guard, and for UI slices Playwright at 375/768/1440 + axe + touch-target checks + screenshots under `docs/design/screenshots/leads/`. Test-first for logic.

| # | Slice | Acceptance criteria | Test plan |
|---|---|---|---|
| 0 | Prereqs | Contacts acceptance passed; Track B `task_links` shape agreed; open questions Q1-Q18 answered | review only |
| 1 | Schema + RLS + seed | 6 tables (`pipelines`, `pipeline_stages`, `lost_reasons`, `leads`, `stage_transitions`, `lead_tags`), nullable `activities.lead_id`/`notes.lead_id`, RLS migration (D45 form), append-only trigger, seed for new + existing workspaces | DB tests: every CHECK and composite FK (stage in pipeline, outcome = stage kind, money pair, lost reason), RLS per role/command, trigger blocks UPDATE/DELETE, tenant isolation, tenancy CI passes |
| 2 | Pipeline config API + settings UI | Admin CRUD pipelines/stages/lost reasons, reorder, archive rules (`moveLeadsToStageId`, `pipeline_not_empty`), roles enforced | route tests, role matrix, archive race test (concurrent move vs archive), contract drift |
| 3 | Lead CRUD + list + detail | create/edit with `expectedVersion`, validation table, soft delete/restore, filters/sort/cursor, duplicate guard, tags, custom fields, timeline + notes, list p95 < 300 ms at 10k leads | unit (validators, currency table, probability rules), API + stale-version 409, cursor pagination at depth, perf test, e2e create lead |
| 4 | Stage moves, win/lose/reopen, history | `moveLead` service, transitions row per change, idempotent retries, rank ordering with neighbours, rebalance, reasons required, reopen role | property test (`stage_id` == last transition), concurrent move/reorder tests, idempotency replay, history endpoint |
| 5 | Board API + Kanban UI | board endpoint with per-column totals/cursors, drag + Move menu + keyboard, optimistic rollback/conflict, mobile stage tabs, won/lost dialogs | board query perf (10k leads, 8 stages), e2e move stage web, e2e 375 tabs, axe, 2.5.7 keyboard-only move test, conflict test with two sessions |
| 6 | Contact tab, bulk, export | Leads tab on contact, bulk assign/tag/move/delete, export (owner/admin) | role tests, export injection escaping, partial-success bulk |
| 7 | Tasks wiring | `next_activity_at` via Track B `refreshLeadNextActivity`; "Tasks" tab on lead | integration test with B, drift nightly job |
| 8 | Reporting + dashboard feed | `/leads/summary`, dashboard tiles per `stage-history-and-reporting.md` | metrics vs hand-computed fixtures incl. reopen and pipeline change |
| 9 | Mobile | pipeline stage list + change-stage + lead detail on mobile (FR-55), same lead visible on both clients | cross-client check per roadmap Phase 2 gate |

Roadmap Phase 2 gate coverage: "create lead" and "move stage" e2e (slices 3, 5), "same lead change visible on mobile" (slice 9), list p95 (slice 3).

## Integrator notes (shared files)
`contracts/src/index.ts` (export + endpoints spread), `schema/index.ts`, `routes/workspaces.ts` (`leadsRoutes`), `core/permissions.ts` (`// --- track:leads ---`), `apps/web/lib/nav.ts` (Leads, Pipeline). Track B must make `task_links` allow `lead`; Track D's search can index `leads.title` later.
