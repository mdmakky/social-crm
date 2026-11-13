# Handoff: continue this project on another machine

## Where the project stands (2026-11-13)
- `main` has Contacts, Search, Tasks, Notifications, Leads/Pipeline, Meta Inbox Slice 1 (merge `65cf409`) and Slice 2 (`413ce01`: webhook ingress, `@crm/integrations`, worker, purge, migration 0019). Mock adapter only; no real Meta call has been made.
- Phase 1 is formally OPEN: Android emulator login / SecureStore verification is DEFERRED and UNVERIFIED. Do not claim mobile readiness.
- Do NOT start Slice 3 (OAuth) without the user: it also needs the user-confirmed HTTPS tunnel domain. C8 (Instagram webhook publication requirement) stays UNVERIFIED until tested with the real Meta app. Other open items: KMS (D-D), contact erasure (D-E), deal-value DB-level protection, production hosting, echo reconciliation (Slice 5).
- Read first: `CLAUDE.md`, `docs/project/progress.md`, `docs/project/roadmap.md`, `docs/architecture/meta-inbox-plan.md` (sections 9a to 9c), `docs/project/meta-inbox-slice1-report.md`, `docs/project/known-limitations.md`.

## Setup on a new machine
1. `git clone https://github.com/mdmakky/social-crm && cd social-crm`; `cp .env.example .env`.
2. Node 24 (`.nvmrc`), pnpm 12 (`corepack enable`), `pnpm install`.
3. Easiest: `docker compose -f docker-compose.full.yml up --build` (web :3000, API :8787). **Not yet verified.**
4. Or local: `pnpm db:up`, run `packages/db/sql/001_roles_and_probe.sql` once as superuser (postgres/postgres, DB `crm`), `pnpm --filter @crm/db migrate`, then the commands in `CLAUDE.md`.
5. Isolated test DB: `scripts/db-create.sh <name>`, run tests with `CRM_DB_NAME=<name>`.

## Working rules the user has set
- Never weaken acceptance criteria or security; report honestly; never claim verified without a green command.
- Delivery speed over ceremony: max 3 active agents including the main one, focused tests while developing, full suite only at integration checkpoints, P2/P3 do not block, 15-minute time-box on non-critical blockers, small meaningful commits.
- Never run the roles setup script on the main dev database without confirming the superuser procedure first. Never rewrite applied migrations; journal `when` must be monotonic.
- Tooling gotchas: large tool output is truncated by the context-mode hook (keep outputs small); do not use `pkill -f` with patterns that match your own command line.

## Claude Code setup used (global, not stored in this repo)
Global instructions (`~/.claude/CLAUDE.md`): pipeline IDEA, BRAINSTORM, REQUIREMENTS, ARCHITECTURE, PLAN, IMPLEMENT, TEST, REVIEW, DELIVER, using only the stages a task needs. Brainstorm with superpowers brainstorming and mattpocock `grill-me`; architecture questions through graphify; plan with superpowers writing-plans; TDD where a test seam exists; UI work with ui-ux-pro-max then impeccable critique/polish, verified with Playwright; library APIs through Context7; review with `/code-review` and `/security-review`; never claim done without running build/tests. Project `CLAUDE.md` wins over the global file.

Plugins / skill sets installed (reinstall them on the new machine from their marketplaces):
| Set | Used for in this project |
|---|---|
| superpowers | brainstorming, writing-plans, systematic-debugging, TDD, verification-before-completion, dispatching-parallel-agents, git worktrees |
| ui-ux-pro-max | design-system search, UX/a11y guidance for the web UI |
| impeccable | UI shape/craft/critique/polish ("Quiet precision" direction, `docs/design/design-system.md`) |
| gstack (`cso`, `review`, `qa`, `ship`, `verify`, ...) | `cso` static security review of Contacts; review / verify / QA skills |
| mattpocock-skills | grilling, TDD, code-review, domain-modeling |
| caveman | terse reply style (opt-in); `ponytail` smallest-change coding mode (active) |
| context-mode | keeps large command output out of the conversation (`ctx_execute`, `ctx_search`) |
| claude-mem | persistent memory and work-state tracking |
| graphify | knowledge-graph queries over the codebase |
| artifact / dataviz / code-review / simplify / loop / schedule | built-in skills available in the harness |

MCP servers used: context7 (library docs), playwright and chrome-devtools (browser checks), claude-in-vscode diagnostics, claude.ai connectors (Docs; Google Drive needs authorization). Browser tests: `cd apps/web && pnpm exec playwright test`.

Skill-to-phase mapping with "used / verified" columns: `docs/project/skill-utilization-matrix.md`.
