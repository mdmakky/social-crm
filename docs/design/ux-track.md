# Product Design and UX Improvement Track (2026-11-13)

Direction: Quiet Precision (light-first, off-white canvas, white surfaces, charcoal text, restrained indigo). Skills: `impeccable:impeccable` (loaded; `context.mjs` run with `--target apps/web/app/page.tsx`, PRODUCT.md read, no DESIGN.md exists yet). Before/after screenshots: `docs/design/screenshots/ux-track/` (1440, 768, 375).

## Audit (what was actually wrong)
- Home was a placeholder ("Getting started", "Coming soon") and showed raw audit keys such as `lead.created`.
- Settings tabs sat above the page title; Tasks filters wrapped into three rows; view tabs were boxed chips; notification All/Unread were filled buttons (three tab styles in one product).
- Pipeline gave empty columns the same width as full ones.
- Contacts repeated "Unassigned / None / Added manually" at full strength on every row.
- Contact detail said "Pipeline records are not available yet" although Leads shipped.
- Radius, control height and borders were set per component, so one change could not restyle the product.

## Design system (single source: `packages/design-tokens/src/tokens.ts`)
Role tokens added: `line-control`, `line-card`, `bg-row-hover`, `radius-control`, `radius-card`, `control-h`, `control-h-touch`, `row-h`, `page-gutter`, `page-gap`. Components use `rounded-card`, `rounded-control`, `border-line-card`, `border-line-control`, `h-[var(--control-h)]`. About 50 hardcoded radius classes migrated. Changing a token restyles every screen. New shared pieces: `ui/stat.tsx` (Stat, StatGrid), `ui/tabs.ts` (one tab style for tasks, notifications, settings).

## Screens changed
Home (stat tiles, "Your next tasks", plain-sentence activity), Settings (left sub-nav, responsive), Tasks (tabs, filter row), Pipeline (narrow empty columns), Notifications (shared tabs), Contacts (empty and default values recede; all seven default columns and all values kept), Contact detail (real Deals panel, RBAC-gated by `lead.view`, values hidden by the API for restricted roles), Audit log and Home activity (readable sentences, unknown actions still show the raw key), Lead detail (title style), Members and Audit log (inherit tokens and Panel; no layout change).

## Fixes found by verification
- Overlay `pop` animation faded opacity, which made axe report contrast failures in freshly opened dialogs and the drawer. Failures reproduced on untouched HEAD. Now transform-only.
- Settings tab strip overflowed at 375 (fixed).
- `leads.spec.ts` "pipeline settings" reloaded before the optimistic reorder had saved (race, also on HEAD under load). Test now waits for "Stage order saved."

## Not done
No DESIGN.md. Dark mode not reviewed. Members and Audit log have no layout redesign. Dialogs were checked by axe and existing specs, not individually redesigned. No keyboard-only manual walkthrough beyond the existing e2e keyboard tests. Mobile app untouched.
