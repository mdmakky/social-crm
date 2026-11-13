# Skill Utilization Matrix

Last updated: 2026-11-13 (Phase 0). Status values: **Used** (invoked and its output applied), **Loaded** (instructions read, not yet applied), **Planned**, **Skipped** (with reason). Nothing is marked Used unless it was actually invoked in a session.

## 1. Discovery summary

Sources inspected: `~/.claude/skills/` (gstack suite and e-commerce skills), installed plugins under `~/.claude/plugins/cache/` (caveman, context-mode, impeccable, mattpocock-skills, ponytail, superpowers, claude-mem, ui-ux-pro-max), the built-in skill list, and available agent types. Global `~/.claude/CLAUDE.md` defines the pipeline IDEA → BRAINSTORM → REQUIREMENTS → ARCHITECTURE → PLAN → IMPLEMENT → TEST → REVIEW → DELIVER. No project-level skills or CLAUDE.md existed (the repository was empty). MCP tools available: Playwright, Chrome DevTools, Context7, claude-mem, context-mode, easel (charts), Claude Docs. Not available: Google Drive (needs authorization; not required).

Environment facts that affect skill choice: Fedora Linux, Node 26, pnpm 12, PostgreSQL 18 client, Docker 29, Java 25. No Android SDK or emulator installed. No macOS, so no local iOS simulator.

## 2. Gaps (no suitable installed skill)

| Gap | Evidence | Proposed reusable custom skill |
|---|---|---|
| React Native / Expo implementation guidance | No SKILL.md mentions Expo; ui-ux-pro-max has a react-native style stack only | `expo-rn-conventions`: project layout, navigation, EAS builds, secure-store, push, deep links |
| Mobile security audit | `cso` is a web/OWASP static audit; nothing covers token storage, certificate pinning, jailbreak, deep-link hijack | `mobile-security-audit`: OWASP MASVS checklist |
| Mobile testing (Maestro / Detox / emulator) | `ios-qa` targets SwiftUI on real hardware; no RN or Android skill | `rn-e2e-testing`: Maestro flows, emulator setup on Linux |
| Meta platform integration | None | `meta-platform-integration`: webhook verification, token lifecycle, review checklist |
| Multi-tenant Postgres / RLS testing | None | `tenant-isolation-testing` |

Until these exist, Context7 and official documentation fill the gap, and each gap is a recorded limitation rather than a claimed capability.

## 3. Matrix by phase

| Phase | Required skills | Optional skills | Why / when | Expected output | Used? | Verified? |
|---|---|---|---|---|---|---|
| 0 Discovery | superpowers:brainstorming; claude-mem:mem-search (continuity); professional-documentation (doc polish) | gstack:office-hours; gstack:plan-ceo-review; gstack:autoplan; market-competitor-analysis; mattpocock-skills:grilling; spec | Brainstorming sets approach before design; plan-review skills challenge the PRD/architecture once written | PRD, research docs, architecture, roadmap | brainstorming: Loaded (gate applies to building; Phase 0 produces documents only). Others: Planned for the review pass | Pending |
| 0 Research | Parallel research agents (general-purpose) | Context7 for library docs; WebSearch/WebFetch | Independent topics with no shared state | Six research documents with citations | Used (6 agents, 2026-11-13) | Pending citation spot-check |
| 0 Design direction | ui-ux-pro-max:ui-ux-pro-max | gstack:design-consultation; gstack:design-shotgun; impeccable:impeccable | Generates and compares design-system options before any UI code | `docs/design/design-system.md` direction | Planned (Phase 1 start; direction only in Phase 0) | Pending |
| 1 Foundation | superpowers:writing-plans (Used: spike plan saved in docs/superpowers/plans); Context7 (Used: Better Auth, pg-boss, Expo docs); superpowers:writing-plans; superpowers:test-driven-development; Context7 | ponytail (scope discipline); superpowers:using-git-worktrees; impeccable (shape, then polish); ui-ux-pro-max:ui-styling; gstack:design-html | Plan before code; TDD where a seam exists; library APIs verified, not remembered | Monorepo, tokens, shell, auth, DB | Planned | Pending |
| 1 Design review | gstack:design-review; impeccable critique; independent critique agent | gstack:plan-design-review | Strict critique of screenshots, desktop and mobile | Findings list, fixes | Planned | Pending |
| 2 Core CRM | superpowers:test-driven-development; superpowers:systematic-debugging (bugs); Playwright MCP | graphify (once code exists); gstack:qa | Real DB operations need integration tests | Contacts, leads, pipeline, dashboard | Planned | Pending |
| 3 Meta integration | Context7; official Meta docs; gstack:cso (webhook/token review) | gstack:codex (second opinion) | Never invent permissions; webhook signature and token storage are security-critical | Meta adapter, mock adapter, setup guide | Planned | Pending |
| 4 Inbox + realtime | Playwright MCP; superpowers:systematic-debugging | gstack:benchmark; gstack:qa | Realtime ordering and dedup bugs need disciplined debugging | Inbox web + mobile | Planned | Pending |
| 5 Automation | superpowers:test-driven-development | mattpocock-skills:domain-modeling | Engine has well-defined seams (trigger, condition, action) | Workflow engine, logs, approval | Planned | Pending |
| 6 AI | claude-api skill (if Anthropic is one provider); Context7 | gstack:eval-plan | Provider abstraction must stay neutral; cost tracking verified | AI layer, logs, cost tracking | Planned | Pending |
| 7 Platform readiness | Official docs per platform | gstack:devex-review | Capability registry must match real gating | Adapter stubs, registry | Planned | Pending |
| 8 Quality | gstack:cso; security-review; code-review; gstack:qa; gstack:benchmark; chrome-devtools lighthouse; superpowers:verification-before-completion | gstack:health; gstack:test-audit; gstack:ship; gstack:document-release | Gates in the directive require measured evidence | Test, security and performance reports | Planned | Pending |
| Mobile 1-6 | Custom skills proposed above (not installed); impeccable (native iOS/Android screens); ui-ux-pro-max (react-native stack); Context7 for Expo | gstack:ios-design-review and ios-qa (only if a real iOS device exists; otherwise Skipped) | No Expo skill exists; fall back to docs | Mobile app, test report | Planned | Pending |
| CAPI | Context7; official CAPI docs; gstack:cso | superpowers:test-driven-development | Hashing rules have exact specs and are unit-testable | CAPI module, test report | Planned | Pending |

## 4. Skipped skills (with reasons)

- All `amazon-*`, `ecommerce-*`, `affiliate-*`, `market-sizing`, `market-gap-analysis`: unrelated e-commerce research domain. `market-competitor-analysis` is borderline and kept optional.
- `caveman:*`: a response-style tool, never applied to code, commits or docs.
- `gstack:ios-*`, `ubicloud`, `canary`, `land-and-deploy`, `setup-deploy`: deployment or real-device iOS flows not applicable until Phase 8 or a physical device exists.
- `gstack:make-pdf`, `diagram`: optional for polished deliverables; `diagram` may be used for architecture diagrams.

## 5. Execution policy

1. Invoke a skill only when its phase arrives; read its instructions first.
2. Update the "Used?" column in the same commit as the work that used it.
3. If a skill fails, record the failure here and the alternative used.
4. Project instructions (this repository's CLAUDE.md) override skill defaults.
