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
