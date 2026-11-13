# Leads/Pipeline: Kanban Interaction Design

Design only. Uses the Phase 1 design system (`docs/design/design-system.md`, tokens in `packages/design-tokens`, components in `apps/web/components/ui`: button, badge, avatar, panel, overlays, states, skeleton, kbd, field, form-controls). Direction "Quiet precision": calm neutral canvas, white cards, one accent. No new visual language. Sources: repo docs only; no external research was run [A1]. `[Q#]` = open question.

## 1. Board layout by viewport

| Viewport | Layout |
|---|---|
| 375 (phone) | NOT a shrunken board. Header: pipeline switcher + filter button + "New lead". Below, a sticky **stage tab strip** (horizontally scrollable chips: `Name  count`) with the active stage's total under it. One column of cards fills the screen; swipe left/right on the list OR tap a chip changes stage (scroll-snap). Card actions via a `...` menu ("Move to...", Win, Lose, Edit). No drag on phone in v1 (long-press-drag is error-prone with scroll); "Move to..." sheet is the move mechanism, matching FR-55 "segmented stage list with change-stage action". |
| 768 (tablet) | Horizontal board, columns 280px wide, ~2.5 visible, scroll-snap per column, sticky column headers, left rail nav collapsed (shell rule). Touch drag enabled with a drag handle on the card (long-press 250ms also starts a drag). |
| 1440 (desktop) | Horizontal board, columns 300px, 4-5 visible, remaining scroll; the Won and Lost columns pinned at the right end in a compact "Closed" group (collapsible, default collapsed to a header with counts; expand to see recent closed cards) [Q13]. Optional right-side detail panel (drawer) opens over the board when a card is clicked. |

Page chrome (all sizes): page title "Pipeline", pipeline select (shows kind badge Lead/Sales), view toggle Board | List (list = the lead table, same filters), filter bar, "New lead". Board/List choice and filters persist per user (saved view, `entity_type='lead'`).

## 2. Columns

- Header: stage name, count, per-currency totals (value; weighted value in tooltip/secondary line). One currency: one figure. Several: first two chips + "+N" popover. Totals reflect the whole filtered column, not the loaded cards.
- Body: cards, vertical scroll inside the column (column height = viewport minus chrome); per-column "Load more" is automatic on scroll end (intersection observer) with a visible fallback button (keyboard/AT).
- Footer: "+ Add lead" (opens create dialog pre-set to that stage); hidden for won/lost and for viewers.
- Column header menu (admin): rename, change default probability, archive stage. Deep config lives in Settings, the menu is a shortcut.
- No swimlanes (flat board). No WIP limits [A2].
- Won/lost columns show the most recent closed leads (default last 30 days, selector 7/30/90/all), sorted by closed date; no drag inside; dragging a card OUT of them is blocked (use Reopen, admin only).

## 3. Card

Target height about 88-104px, fits 5-6 cards per viewport on desktop. Content, in priority order:
1. Title (1 line, ellipsis; 2 lines on mobile) with priority marker (only for `high`: small flag icon + sr text).
2. Primary contact (avatar 20px + name).
3. Value (formatted via `Intl.NumberFormat` with the lead's currency; "-" muted if none) and probability chip ("40%") on the same row.
4. Footer row: expected close date (red text + "overdue" label if past), next activity (icon + relative date; red if overdue; "No next step" muted if none), owner avatar (right).
5. Tags: not on card in comfortable density; shown in compact-off mode as up to 2 chips [A3].

Density: one fixed density; no toggle in v1. Colour is never the only signal (overdue also has text/icon). Card is a link to `/w/:ws/leads/:id` (cmd/ctrl-click works) and a drag source; click vs drag distinguished by an 5px activation distance.

## 4. Drag and drop and the keyboard alternative (WCAG 2.2 SC 2.5.7)

- Library [A4]: neither a drag-and-drop nor a virtualization library is installed in `apps/web`. Recommend `@dnd-kit/core` + `@dnd-kit/sortable` (pointer, touch, keyboard sensors, announcements) and `@tanstack/react-virtual`. Pin exact versions >= 2 weeks old, check with Context7 at build time; adding deps is a [Q14] decision.
- Pointer: drag a card within the column (reorder) or to another column (stage change). Drop indicator is a 2px accent line between cards and a highlighted column; auto-scroll near edges; Escape cancels.
- **Non-drag alternative (required, not optional):** every card has a "Move to..." menu button (also in the detail page header). Menu: stage list (current checked, archived hidden) + "Move to top / bottom of column" + Win... + Lose... Pipeline change under "Move to pipeline...". Works with a single pointer tap, no dragging, on every viewport and is the only mechanism at 375.
- Keyboard: card focusable (roving tabindex inside column; arrows Up/Down move focus between cards, Left/Right between columns). Space picks up (dnd-kit KeyboardSensor), arrows move the target (Up/Down reorder, Left/Right change column), Space drops, Escape cancels. Shortcut `M` opens the Move menu on the focused card. Shortcuts are listed in a `kbd` help popover.
- Screen readers: live region announcements ("Picked up Acme renewal, position 2 of 5 in Proposal", "Moved to Negotiation, position 1 of 3"); column = `role="list"` with `aria-label="Proposal, 5 leads, total $20,000"`; card `role="listitem"`.
- Drop on Won: opens the Won dialog; drop on Lost: opens the Lost dialog (reason required); cancelling the dialog returns the card to its origin (no write).

## 5. Optimistic update, rollback, conflicts

1. On drop: card moves immediately in local cache; column counts/totals adjust locally (approximate), card shows a subtle "saving" state (small spinner, not blocking).
2. `POST /leads/:id/move` with `expectedVersion` from the card's cached `version` and a fresh `Idempotency-Key` (reused on retry).
3. Success: replace the card with the returned `LeadDetail` (authoritative `version`, `rank`, `probability`) and refresh the two affected column totals from the response of a cheap `GET column` (or board refetch debounced 500ms).
4. Failure: network/5xx: roll the card back to its origin, toast "Couldn't move 'Acme'. Try again" with Retry (replays same key). 403: roll back, toast "You can't move leads". 422 (`lost_reason_required` etc.): roll back and open the right dialog.
5. 409 `version_conflict`: roll back, show the returned `current` state in place, toast "Someone else changed this lead" with "Move again" (re-sends with `current.version`) and "Open lead". Never silently overwrite.
6. If the same card changed stage elsewhere meanwhile (stale cache), conflict handling above applies; concurrent position-only drags never conflict (server picks neighbours, section pipeline-rules 6).
7. Realtime: none in Phase 2 (SSE arrives Phase 4); board refetches on window focus and every 60s while visible, preserving scroll and loaded pages; changed cards get a brief highlight.

## 6. Won / Lost dialogs

| Dialog | Fields | Notes |
|---|---|---|
| Mark as won | Close date (default today, cannot be future), optional final value+currency (prefilled, editable), optional note (becomes lead note) | Confirm button "Mark won". Focus on confirm; Escape cancels. |
| Mark as lost | Lost reason (select, required, first focus), optional note, close date | Confirm disabled until reason chosen; inline error text, not colour only. |
| Reopen (admin) | Target open stage (defaults to last open stage) | Explains that history is kept. |
The same dialogs are used from the board drop, the Move menu, bulk-free detail page and mobile. After won: success toast with "Set contact lifecycle..." link (manual, no auto-coupling) [Q9].

## 7. Filters

Search (title/contact), owner (me / unassigned / person), tags, priority, currency, value range, expected close (overdue / this month / custom), next activity (overdue / today / this week / none), closed window for Won/Lost. Chips show active filters with "Clear all"; filtered-out count is shown ("12 hidden by filters"). Filters apply to board and list identically (same `BoardQuery` subset). Saved views reuse `saved_views`.

## 8. States

| State | Behaviour |
|---|---|
| Loading | Skeleton columns (3) with 3 skeleton cards each; per-column skeleton while paging. Header totals show skeleton pill. |
| Empty pipeline | Panel: "No leads yet", primary "New lead", secondary "Import leads" (admins, later) and a one-line explanation of stages. |
| Empty column | Muted dashed drop zone "No leads in Proposal" (still a valid drop target). |
| Filtered to nothing | "No leads match these filters" + Clear filters. |
| Error (board) | Full-area error state with Retry; one column failing shows an inline column error with Retry, others stay usable. |
| No pipelines (all archived) | Admin: "Create a pipeline"; others: "Ask an admin to set up a pipeline". |
| Offline / slow | Mutation toast with retry; board shows stale banner when refetch fails but keeps last data. |
| Read-only (viewer / archived pipeline) | No handles/menus; banner for archived pipeline. |

## 9. Performance

- Server: first board load = columns x 20 cards (default), index-backed keyset per column; p95 target under 300 ms on 10,000 seeded leads / 8 stages (matches roadmap gate for lists).
- Client: virtualize cards in any column > 30 loaded (`@tanstack/react-virtual`, fixed estimate 96px, dynamic measure), keep drag overlay outside the virtual list; pages of 20 appended on scroll; max 200 cards held per column then oldest pages are dropped from DOM only. Cards are memoized; column totals are separate selectors so a drag re-renders only two columns. No layout shift on totals (reserve height).
- Targets: drag start under 100 ms, drop-to-paint under 100 ms (optimistic), axe clean, no horizontal page scroll (only the board scrolls).

## 10. Accessibility checklist

Touch targets >= 44px (menu button, chips); visible 2px focus ring; contrast AA for tokens incl. overdue red on white; drag alternative present at all sizes (2.5.7); target size (2.5.8); no motion-only cues, respect `prefers-reduced-motion` (no auto-scroll animation, instant drop); dialogs trap focus and restore it to the originating card; announcements via `aria-live=polite`; dark mode uses the existing tokens.

## 11. Screens

1. Pipeline board (375 tabs / 768 / 1440). 2. Lead list (table, filters, saved views). 3. Lead detail page: header (title, stage chip, Move menu, Win/Lose), fields panel (value, currency, probability with "manual" badge and Reset, expected close, owner, priority, contact, description, custom fields, tags), tabs: Timeline, Notes, Tasks (Track B), History (transitions). 4. Create/edit lead dialog (full-screen sheet at 375). 5. Won / Lost / Reopen / Move-to dialogs. 6. Pipelines settings (list, create, default, archive; admin). 7. Stage editor (name, default probability, order by drag + move up/down buttons, archive with "move leads to..." step). 8. Lost reasons settings. 9. Contact detail "Leads" tab (list + "New lead for this contact"). 10. Mobile stage-tab view (same route, responsive). 11. Bulk action bar (list view). Each screen: loading, empty, error, success states and screenshots under `docs/design/screenshots/leads/` at 375/768/1440.

## Assumptions
A1 repo documents only; `ui-ux-pro-max` not run. A2 no swimlane/WIP. A3 tags off the card by default. A4 library choice pending [Q14]. Open: Q13 (closed column default), Q14 (new dependencies).
