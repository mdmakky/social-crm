# Leads/Pipeline: Permissions Matrix

Design only. Extends `docs/architecture/permissions.md` (roles owner, admin, agent, viewer; one `can(actor, action, resource)` in `packages/core/src/permissions.ts`, role tests iterate the matrix). Defence in depth: API `can()` is the source of truth for fine rules; RLS is the backstop for tenant isolation and coarse role. Own-only scoping is NOT used for leads in MVP: every agent sees and edits all workspace leads, like contacts [A1].

## 1. Role by action

| Action (new `can()` action) | Owner | Admin | Agent | Viewer | RLS backing |
|---|---|---|---|---|---|
| View leads, boards, history, timeline (`lead.read`) | yes | yes | yes | yes | SELECT all roles, workspace-scoped |
| Create lead (`lead.create`) | yes | yes | yes | no | INSERT owner/admin/agent |
| Edit fields, tags, owner, priority, notes (`lead.update`) | yes | yes | yes | no | UPDATE owner/admin/agent |
| Reassign owner to someone else (`lead.assign`) | yes | yes | self only (assign to self or unassign self) | no | none (API only) [Q12] |
| Move between open stages, reorder, change pipeline (`lead.move`) | yes | yes | yes | no | UPDATE + transition INSERT |
| Win / lose (`lead.close`) | yes | yes | yes | no | same |
| Reopen closed lead (`lead.reopen`) | yes | yes | no | no | API only (needs OLD row) [Q6] |
| Edit closed lead fields | no (reopen first) | no | no | no | API rule `lead_closed` |
| Soft delete / restore (`lead.delete`) | yes | yes | no | no | WITH CHECK blocks `deleted_at` for agent |
| Bulk assign/tag/move | yes | yes | yes (assign limited as above) | no | per-item RLS |
| Bulk delete | yes | yes | no | no | per-item |
| Export leads (`lead.export`) | yes | yes | no | no | API only; D44 |
| Import leads (later, `lead.import`) | yes | yes | no | no | `import_jobs` policies |
| Manage pipelines, stages, probabilities, lost reasons (`pipeline.manage`) | yes | yes | no | no | INSERT/UPDATE owner/admin on config tables |
| View pipeline configuration | yes | yes | yes | yes | SELECT all roles |
| Manage lead custom fields / tags catalogue | yes | yes | no | no | existing policies |
| Hard delete anything (leads, pipelines, stages, history) | nobody via app | | | | no DELETE policy; history trigger |
| Update/delete `stage_transitions`, `activities` | nobody | | | | no policy, REVOKE, trigger |

Permission list placed inside `// --- track:leads ---` markers: `lead.read, lead.create, lead.update, lead.assign, lead.move, lead.close, lead.reopen, lead.delete, lead.export, pipeline.manage`.

## 2. Rules and edge cases

- Viewer: all mutation controls hidden in UI (not just disabled) and the board is read-only: no drag handles, no "Move to" menu; API returns 403 `forbidden` anyway.
- Tenant isolation: workspace id comes from the authenticated session via `app_workspace_id()`; every lead id lookup is `WHERE workspace_id = ...` AND RLS. Cross-tenant id returns 404 (not 403) so existence is not leaked. Composite FKs prevent linking a lead to another tenant's contact, stage or reason even with a service bug.
- Removed member: leads they own keep `owner_user_id`; UI shows "Former member"; admins can bulk reassign. Owner picker only lists active members (`owner_invalid`).
- Contact visibility: a lead exposes primary contact name only; email/phone appear only in contact detail (same role rules there).
- Read-only API tokens or future integrations get the viewer matrix unless explicitly granted.
- Export is a data-leaving action: rate limited, audited (who, filters, row count), CSV formula-injection escaped (same exporter as contacts).

## 3. Audit and activity entries

| Event | `activities` (visible timeline) | `audit_log` (admin-only trail) [A2] |
|---|---|---|
| Lead created | `lead.created` | no |
| Fields edited | `lead.updated` (changed field names; no description text) | no |
| Owner changed | `lead.owner_changed` (from, to) | no |
| Primary contact changed | `lead.contact_changed` (on BOTH old and new contact) | no |
| Stage move / pipeline change | `lead.stage_changed` (+ `stage_transitions` row) | no |
| Won / lost | `lead.won` / `lead.lost` (+reason) | no |
| Reopened | `lead.reopened` | yes |
| Soft delete / restore | `lead.deleted` / `lead.restored` | yes |
| Pipeline, stage, lost-reason create/rename/archive/reorder, probability default change | none | yes (actor, before/after) |
| Export | none | yes (filters, count) |
| Permission denied on a mutation | none | no (logged to request log only) |

## 4. Tests required (slice acceptance)

1. Role matrix test iterates every action x role against `can()`, and an RLS test hits the DB as each role for each table/command in `data-model.md` section 7 (including: agent cannot UPDATE `deleted_at`, nobody can UPDATE/DELETE `stage_transitions`, viewer cannot INSERT anywhere).
2. Two-tenant isolation test: tenant B cannot read, move, link to or count tenant A leads, stages, reasons, transitions; the tenant-table CI check passes for the 6 new tables.
3. Agent cannot reopen, delete, export, edit pipelines; viewer cannot do any mutation; admin can all.

## Assumptions / questions
A1 no own-only restriction in MVP (matches permissions.md; per-record scoping is its R2). A2 `audit_log` is usable for these events. Q6 reopen role. Q12 whether agents may reassign to others (matrix says conversations: self only; copied here).
