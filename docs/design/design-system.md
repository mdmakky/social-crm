# Design System: Direction (Phase 0)

Status: direction only. Tokens, components and screens are produced in Phase 1 using ui-ux-pro-max, impeccable and design-consultation, followed by a strict critique. This document records the starting direction taken from `docs/research/ui-ux-research.md`. Mobile platform claims in that research are marked unverified and must be re-checked against Apple HIG and Material 3 before sign-off.

## Direction: "Quiet precision"
A dense, calm, tool-like interface. Neutral surfaces, one accent used sparingly for primary action and focus, strong typographic hierarchy, thin borders instead of shadows, motion only where it explains a change. Not allowed: decorative gradients, glassmorphism, oversized hero headings, card grids with no purpose, emoji as icons, placeholder lorem content.

## Tokens (to be finalized in Phase 1)
- **Source of truth:** one W3C design-tokens JSON in `packages/design-tokens`, three layers (primitive, semantic, component). Style Dictionary emits CSS variables for web and a typed object for React Native.
- **Color:** perceptual (OKLCH) 12-step neutral scale plus one accent scale; semantic roles for surface, border, text, accent, success, warning, danger, info; platform brand colors only for small channel badges. Light and dark themes are semantic remaps. Contrast is checked in CI (text >= 4.5:1, large text and UI >= 3:1, WCAG 2.2 AA).
- **Type:** Inter (or equivalent chosen in Phase 1) in a 7-step scale from 11 to 28 px; tabular numerals for data; system fonts on mobile where it improves native feel.
- **Spacing and radii:** 4 px base scale; a small radius set; touch targets >= 44 pt on iOS and 48 dp on Android (unverified numbers to confirm).
- **Density:** comfortable, default, compact (row heights about 52, 40, 32 px on web); mobile uses comfortable only.
- **Motion:** 100 to 200 ms, ease-out, no motion that blocks input; respects reduced-motion.

## Web patterns
Left sidebar with workspace switcher, a global command menu, saved views on tables, a three-pane inbox (list, thread, context), keyboard shortcuts for common actions, inline editing, skeleton loading shaped like the final content, actionable empty states.

## Mobile patterns
Bottom tab bar (Home, Inbox, Contacts, Leads, Profile), large touch rows, swipe actions on inbox rows (assign, resolve) with an alternative visible control, pull to refresh, sticky composer with keyboard-aware layout, safe-area handling, bottom sheets for filters and pickers, an offline banner and per-message send state.

## Component standards
Each component documents states (default, hover, focus, active, disabled, loading, error), keyboard behavior, ARIA or accessibility props, and ships with a visual test. Web uses Tailwind v4 and shadcn/Radix primitives customized to the tokens. Mobile components are built natively on the token object; the two sets share names and behavior, not code.

## Review process
After each UI phase: screenshots at desktop and mobile widths, comparison against the references, an independent strict critique agent, and a fix pass. Findings are logged in `docs/project/testing-report.md`.

## As built in Phase 1 (2026-11-13)

Source of truth: `packages/design-tokens/src/tokens.ts`; generated CSS in `dist/tokens.css`; mapped to Tailwind utilities in `apps/web/app/globals.css`. This section supersedes the direction text above where they differ.

- **Color:** soft neutral canvas `#F6F7F9`, white surfaces, borders `#E3E6EB`/`#CBD0D9`, charcoal text `#16181D` (secondary `#454B58`, tertiary `#596070`), single indigo accent `#4F46E5` (hover `#4239C9`, subtle `#F1F2FF`). Semantic success, warning and danger backgrounds and foregrounds. The raw Tailwind palette is disabled (`--color-*: initial`), so only tokens are usable. 42 contrast assertions run for light and dark themes.
- **Type:** Inter variable. Scale 11, 12, 13, 14 (body), 16, 20, 24 (page title), 28 (unused). Tight ratio, tabular numerals for dates. Letter-spacing token `tracking-title` on titles.
- **Space and shape:** 4px base. Radii 4, 6, 8, 12. One shadow (popover). Borders do the separating.
- **Layout:** sidebar 248px at lg and above; icon rail 56px at md; off-canvas drawer below md. Topbar 52px with search (left) and account (right). Content max 1120px on a canvas background with white panels.
- **Density:** controls 32px on fine pointers and 44px on coarse pointers (`pointer-coarse:`); inputs use 16px text on touch. Table rows carrying a two-line identity (name plus email) are about 61px, an accepted exception to the 40px default.
- **Components** (`apps/web/components/ui`): Button (primary, secondary, ghost, danger; sm, md, lg; icon; loading), Input, Select, Field (label, hint, error wiring), Badge, Avatar (initials drawn with CSS), Skeleton, EmptyState, ErrorState, Alert, Panel, PageHeader, Table, Tooltip, DropdownMenu, Dialog (focuses the first field), Kbd. Shell: AppShell, SidebarNav, WorkspaceSwitcher, CommandMenu (cmdk), UserMenu.
- **Navigation policy:** built features are links; planned features are plain text under one collapsed "Coming soon" group; everything is filtered by role. No internal phase language in the product.
- **Browser surfaces themed:** selection, caret, `accent-color`, scrollbars, focus ring (in `@layer base`), autofill, placeholder, theme-color, SVG favicon.
- **States:** hover, focus, active, disabled, loading on buttons; error and success alerts; skeletons for the default, Home and Settings routes; empty and forbidden states; route error boundary.
- **Not done:** dark theme switch, density modes beyond the table exception, mobile (React Native) components.
