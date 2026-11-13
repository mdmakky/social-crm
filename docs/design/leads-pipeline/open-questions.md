# Leads/Pipeline: Open Questions (need the user)

Each has a recommendation; defaults in the other docs already assume the recommendation.

| # | Question | Recommendation |
|---|---|---|
| Q1 | UI naming: one entity, but what is it called? Table is `leads` (D20). In a `sales` pipeline do we say "Deal" or keep "Lead" everywhere? | Table/API stay `leads`. UI label per pipeline kind: "Lead" in `lead` pipelines, "Deal" in `sales` pipelines (copy only). |
| Q2 | Is `primary_contact_id` mandatory, and are additional contacts needed? | Mandatory (FR-6 "leads linked to contacts"); additional contacts deferred (`lead_contacts` junction is additive later). |
| Q3 | Seed only one default "Sales" pipeline for new workspaces, or also an "Inbound leads" (`lead` kind) pipeline? | Seed both only when Lead Ads/inbox capture ships (Phase 3); Phase 2 seeds "Sales" only; `lead` kind is creatable by admins. |
| Q4 | Exactly one Won and one Lost stage per pipeline (simple), or several terminal stages (e.g. "Won - upsell")? | Exactly one each; use lost reasons for variety. Revisit only on a real need. |
| Q5 | Lost reasons: workspace-configurable table, or a fixed list? | Configurable table seeded with 6 defaults (small CRUD, one more settings screen). |
| Q6 | Who may reopen a closed lead? | Owner/admin only (closing is a record of truth); agents ask an admin. Alternative: agents can reopen leads they own. |
| Q7 | Probability override: cleared on every stage move (default re-applies), or sticky until reset? | Cleared on stage/pipeline change; explicit edit afterwards. Sticky overrides go stale silently and skew weighted totals. |
| Q8 | Multi-currency totals: group per currency only (recommended), or add a reporting currency with FX rates? | Per-currency only now; FX needs rates table and policy; defer with forecasting. |
| Q9 | On Won, should the contact lifecycle stage change automatically (e.g. to "Customer")? | No automatic coupling (D20: separate); offer a manual "Set contact lifecycle..." link in the success toast. Revisit when lifecycle stages have semantic roles. |
| Q10 | Duplicate policy: soft warning for same contact + open lead in same pipeline (recommended) or hard unique? | Soft warning with `allowDuplicate`; a contact can have several deals. |
| Q11 | Bulk operations scope for first release? | Assign owner, add/remove tag, move between open stages, soft delete (admin). No bulk win/lose (reason capture needs a human per lead). Can ship after the board. |
| Q12 | May agents reassign a lead to another user, or self only (as conversations)? | Self only (consistent with `permissions.md`); admins reassign others. |
| Q13 | Won/Lost columns on the board: collapsed "Closed" group by default (recommended), or always expanded? | Collapsed with counts, last-30-day filter when expanded. |
| Q14 | Approve new web dependencies: `@dnd-kit/core`, `@dnd-kit/sortable`, `@tanstack/react-virtual` (none installed today)? | Yes; they carry the keyboard-accessible drag and virtualization. Alternative: build without drag in slice 3 (Move menu only) and add drag later. |
| Q15 | Should deal value be hidden from some roles (e.g. agents)? | No; all readers see value (matches contacts openness). Field-level hiding is a later feature. |
| Q16 | Extra fields beyond the approved list that this design includes: `priority`, `source`/`source_ref`, `owner_user_id`, `qualified_at`, `lost_note`, tags, custom fields. Keep all? | Keep (they come from FR-6 and `database-design.md`); drop `lost_note`/`qualified_at` if you want the strictest reading of the approved list. |
| Q17 | Task dependency: Leads slice 1-3 can ship before Track B links tasks (next activity stays empty). OK, or must Leads wait for Track B? | Ship without; add `next_activity_at` wiring when B's `task_links` lands. |
| Q18 | Retention/erasure: history rows hold ids only; on contact erasure leads of that contact are anonymised (title/description cleared) rather than deleted. Acceptable? | Yes; keeps pipeline metrics intact while removing personal data. |
