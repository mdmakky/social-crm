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


## Round 2: option D rolled out (2026-11-13)
The first round (tokens and small fixes) was rejected as still generic. The product owner then chose, page by page, from three HTML option sets in `docs/design/options/` (A Paper Sheet, B Graphite, C Soft Studio, D = C with a sidebar) and picked **D**, then asked for it smaller and less colourful. Implemented in the real app:
- Tokens (`packages/design-tokens/src/tokens.ts`): violet-tinted ink, lavender-tinted canvas, white surfaces, accent `#5B4BF0` used only for the primary action, links, focus and the active icon; 13px body, 22px titles, 30px controls, 40px rows, radii 8 and 12; Plus Jakarta Sans; six muted hues for avatars and stage dots; one easing and three durations.
- Shell: white sidebar (active item is a neutral wash), slim top bar with search, icon rail at 768, drawer on mobile.
- Components: pill and square badges, `Status` dot, tinted avatars, soft-shadow `Panel` (no border), pill chips for view switchers (ink when active).
- Screens: Home, Contacts, Contact detail, Leads, Pipeline, Tasks, Notifications, Settings, Members, Audit log and states. Reports, Members, Audit log and auth inherit the system without separate edits. Tasks keeps its table (the mockup's grouped list was not built to keep behaviour intact). Contacts segment chips from the mockup were not built.
- Motion: enter and exit on menus, dialogs, drawer, toasts and scrim; press feedback; page entrance on fine pointers only. Text-bearing content enters with transform only. Reduced motion collapses all of it.
- Fixes found by tests: palette remounts on every open (exit animation kept it mounted); touch-size test now waits for the page to stream in.
Before/after: `docs/design/screenshots/ux-d/` (1440, 768, 375).

## Settings information architecture (2026-11-17)
Grouped sub-navigation (xl) or section list then detail (below xl), shared `SettingsPage` layout (header, one-line description, 56rem content width, page-gap rhythm), AI page in-page index. Screenshots: `docs/design/screenshots/settings-ia/` (before and after, 375, 768, 1440). Decisions D180 to D182.
