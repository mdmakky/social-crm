# Leads and Pipeline: implementation design

Date: 2026-11-13. Baseline: `main` `9282e1e` (Contacts, Search, Tasks, Notifications integrated). Status: **design only; nothing is implemented, no schema, contract or code is changed.** Production work stays blocked until Contacts acceptance is decided by the user. Detail lives in `docs/design/leads-pipeline/` (Track E, 7 documents); this file reconciles it with what exists now and lists what still needs the user.

## 1. Decisions already established
- **D20 / FR-35:** one entity, table `leads`, no separate Lead and Deal tables. The pipeline has a `kind` (`lead` or `sales`); won and lost are stage kinds, not tables.
- **Lifecycle stage and pipeline stage are independent** (D40, D20). Lifecycle is on the contact; pipeline stage is on the lead. No automatic coupling.
- **Approved field scope:** value, currency, expected close date, probability 0 to 100, pipeline, pipeline stage, lost reason, won/lost date, primary contact, description, next activity date. Optional where appropriate. PRD FR-6 adds status, priority, owner, source.
- **Multiple pipelines; immutable stage transition history; stage default probability with manual override; validation; tenant isolation and role permissions.**
- **Out of scope for the first release:** forecasting, AI scoring, commission tracking, FX conversion, additional contacts per lead, automations.
- **Platform rules (existing):** `workspace_id` on every table, composite FKs, forced RLS with D45 scalar-subquery policies, `uuidv7()`, optimistic concurrency with `expectedVersion`, soft delete, append-only history (statement-level trigger plus revoked UPDATE/DELETE), contract drift guard, list p95 under 300 ms at 10,000 rows, Playwright at 375/768/1440 with axe.
- **Phase 2 is web-first;** mobile follows (shared contracts and tokens, not UI components).

## 2. Derived from the current architecture (no input needed)
| Topic | Design |
|---|---|
| Tables | `pipelines`, `pipeline_stages` (kind `open`/`won`/`lost`, immutable; exactly one won and one lost per pipeline), `lost_reasons` (configurable, 6 seeded), `leads`, `stage_transitions` (append-only), `lead_tags`. DDL in `docs/design/leads-pipeline/data-model.md`. |
| Money | `value_minor bigint` plus `currency char(3)`, travelling together; totals always per currency. |
| Probability | NOT NULL; stage default applies on stage change; Won is 100, Lost is 0 (CHECK). |
| Stage integrity | composite FK `(workspace_id, pipeline_id, stage_id, outcome)` proves the stage belongs to the pipeline and `outcome` equals the stage kind. |
| Permissions (new matrix actions) | `lead.view` all roles; `lead.edit` owner, admin, agent (agents edit any open lead, as with contacts); `lead.delete` owner, admin; reopen a closed lead owner, admin; pipelines, stages and lost reasons use the existing `schema.manage` (owner, admin); an agent reassigns only to self (as `conversation.assign`). DB policies mirror this (the 0008 and tasks migrations are the pattern). |
| Soft-deleted contact | leads of a deleted contact are read-only history, as notes and tasks are. |
| Duplicates | soft warning for the same contact with an open lead in the same pipeline (`allowDuplicate`), as contacts. |
| Closed columns on the board | collapsed with counts, last 30 days when expanded. |
| Bulk actions | none in the first release (assign owner, tags and move can follow the board). |
| Contact lifecycle on Won | no automatic change; a manual link in the success toast. |
| Extra fields beyond the approved list | keep owner, priority, source, tags, custom fields (all in PRD FR-6 or Contacts parity); **drop** `qualified_at` and `lost_note` until needed (smallest first release). |

## 3. What changed since Track E wrote its design (reconcile before building)
1. **Tasks landed (Q17 is settled):** `task_links` exists with `CHECK (entity_type IN ('contact'))`. A migration must widen that allow-list to include `lead`, then derive `next_activity_at` from open tasks linked to the lead. Leads no longer need to wait for Tasks.
2. **`activities.contact_id` is NOT NULL:** lead timeline entries are written against the lead's primary contact, with a new nullable `lead_id`. This is why a primary contact is mandatory (see decision 2).
3. **Search registry exists:** add a `leads` provider (`requires: can(role, "lead.view")`); no change to the shell.
4. **Notifications and the event outbox exist:** emit `lead.owner_assigned` through `emitEvent` in the same transaction (additive `EventPayloads` entry). Stage-change notifications are deferred.
5. **Migrations are at 0013.** New files start at `0014`. The drizzle journal `when` of every new entry must be later than the latest applied one, otherwise drizzle silently skips it on existing databases (this happened during integration).
6. **Permission matrix** (`packages/core/src/permissions.ts`) has no lead actions yet; adding them is the first change, with the docs table.
7. **Import:** lead CSV import is not in scope; the contact importer is unaffected.

## 4. Decisions that need the user
Each has a default; the design assumes the default if you do not object.
1. **Name in the UI (Q1).** Table and API are `leads`. Default: the label follows the pipeline kind ("Lead" in `lead` pipelines, "Deal" in `sales` pipelines).
2. **Is the primary contact mandatory? (Q2)** Default: yes (FR-6 "leads linked to contacts"; also needed for the timeline). Additional contacts later.
3. **Probability override (Q7).** "Stage default with manual override" can mean the override is cleared on every stage move (default) or stays until reset. Default: cleared on stage or pipeline change, because stale overrides silently distort weighted totals.
4. **New web dependencies (Q14):** `@dnd-kit/core`, `@dnd-kit/sortable`, `@tanstack/react-virtual` (none installed). Default: approve. Alternative: ship the board with a Move menu only and add drag later.
5. **Deal value visibility (Q15).** Default: every role that can read leads sees value. Say so if agents must not.
6. **Erasure (Q18).** Default: when a contact is erased, its leads are anonymised (title and description cleared), not deleted, so pipeline counts stay intact.

## 5. Proposed implementation sequence
| # | Slice | Depends on | Done when |
|---|---|---|---|
| 0 | Prerequisites | Contacts acceptance decided; the six decisions above; permission actions added | matrix tests updated |
| 1 | Schema, RLS, seed | 0; migration at 0014 (journal timestamp rule); `task_links` allow-list change; `activities.lead_id` | DB tests for every CHECK and composite FK; RLS per role and command; append-only trigger; tenancy CI test; fresh and upgrade migration runs |
| 2 | Pipeline configuration | 1 | admin CRUD for pipelines, stages, lost reasons; reorder; archive rules (`pipeline_not_empty`, move leads on archive); race test for concurrent move versus archive; settings UI |
| 3 | Lead CRUD, list, detail | 1, 2 | create and edit with `expectedVersion`; validation table; soft delete and restore; filters, sort, cursor; duplicate warning; tags; notes and timeline; list p95 under 300 ms at 10,000 leads |
| 4 | Board | 3; dependency decision | drag with keyboard alternative; closed group; axe and touch checks at 375/768/1440 |
| 5 | Tasks link | 3; Tasks (done) | link and unlink tasks; `next_activity_at` derived and shown |
| 6 | Search and notifications | 3; Search and Notifications (done) | `leads` provider; `lead.owner_assigned` notification |
| 7 | Minimal reporting | 3 | open count and value per stage and currency; stage history view; no forecasting |
| 8 | Mobile list and detail | 3 to 5 | shared contracts; verified on a device only when the Android runtime is verified (Phase 1 gate) |

Slices 4 to 7 are independent once 3 is done and can run in parallel with disjoint file ownership. Slices 1 to 3 are sequential because they share the schema index, the contracts index and migrations.

## 6. Risks to watch
- Shared files (schema index, contracts index, `workspaces.ts` route list, `permissions.ts`) need a single owner per slice.
- The `task_links` and `activities` changes touch tables owned by earlier features; they need their own tests and an upgrade run on a database with existing data.
- Phase 1 stays OPEN until the Android emulator login and SecureStore runtime are verified; slice 8 does not start before that.
