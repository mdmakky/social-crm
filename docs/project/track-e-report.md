# Track E Report: Leads/Pipeline Design

Date 2026-11-13. Branch: worktree of `track/design-leads`. Documents only.

## Delivered
`docs/design/leads-pipeline/`: README (index, summary, 10-slice build order with acceptance and test plan), data-model, pipeline-rules, api-contracts, permissions-matrix, kanban-interaction-design, stage-history-and-reporting, open-questions (18 items).

## Key decisions
Table `leads` (D20); `pipelines.kind` lead|sales; won/lost = stage kind; `outcome` denormalized with composite FK to stage kind; money = bigint minor units + ISO 4217 code; one Won and one Lost stage per pipeline; immutable `stage_transitions`; fractional `rank` for card order; per-currency totals only; `expectedVersion` for field and stage changes, none for reorder.

## Files touched
Only `docs/design/leads-pipeline/*` and this report. No code, migrations, contracts or shared files.

## Skills and sources used (honest)
No skill was invoked (brainstorming, writing-plans, ui-ux-pro-max, Context7, graphify were NOT used). Inputs were the repo documents and source files named in the brief, read with shell greps and tool search over their output; the full text of `prd.md`, `database-design.md`, `api-strategy.md`, `design-system.md` and `roadmap.md` was not read end to end (targeted greps only, so details outside the hit lines may be missed). Kanban patterns come from general knowledge, not external research; library choices (dnd-kit, tanstack-virtual) are unverified against current docs and flagged for Context7 at build time.

## Not done / risks
Nothing executed or tested (design only). Assumptions are listed per document (`[A#]`); questions in `open-questions.md`. The `audit_log` shape and the workspace-seed hook were assumed, not inspected in depth. Integration with Track B (`task_links`) is an assumption.
