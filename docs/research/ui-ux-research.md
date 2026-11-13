# UI/UX Research: Premium B2B Social CRM (Web and Mobile)

Prepared 2026-11-13. Scope: Next.js web app and React Native mobile app.

## How to read this document

Evidence quality varies and is labelled throughout:

- **[V]** Verified. Read directly from the cited page on 2026-11-13.
- **[S]** Search-snippet or secondary source only (the page itself was not read in full).
- **[U]** Unverified. Drawn from general knowledge or from product use; confirm before relying on it.

Several first-party pages (Apple HIG, Material 3, Vercel Geist subpages) render client-side and could not be extracted by the fetch tool. Claims from those are marked [U] with the URL to re-check. No claim in this document should be treated as a product spec without that re-check.

## 1. Executive summary

The reference products share one stance: dense, quiet, keyboard-first interfaces where chrome recedes and content carries the hierarchy. The common mechanics are:

1. A small number of perceptually-derived neutral surfaces plus a single accent. Linear generates themes from base colour, accent and contrast rather than hand-tuned variables [V].
2. A persistent left sidebar, a thin header with filters and display options, and a detail side panel.
3. A command menu with a contextual action panel (Raycast's Cmd/Ctrl+K pattern) [S].
4. Saved views (filters, sorts, visible columns) as the primary way to manage table density and segmentation (Attio) [S].
5. Progressive disclosure to manage density: expand extra context on demand (Intercom Inbox) [S].
6. Accessible colour achieved by designing in a perceptual colour space with fixed contrast steps (Stripe) [V].

Mobile is not a shrunken web app. It needs bottom navigation, 44pt/48dp targets, swipe actions, and keyboard-aware composers, with a shared token layer so colour, type and spacing stay identical in intent.

## 2. Web product study

### 2.1 Linear

Source: https://linear.app/now/how-we-redesigned-the-linear-ui (retrieved 2026-11-13) [V]

- Themes are generated in LCH rather than HSL because LCH lightness is perceptually uniform. Each theme now takes three inputs (base colour, accent colour, contrast) instead of 98 hand-set variables.
- Surfaces are separated by elevation: background, foreground, panels, dialogs, modals.
- Chrome colour (blue) was deliberately limited so the palette reads neutral and timeless. Text and neutral icons were made higher contrast; a contrast variable supports high-contrast accessibility themes.
- Typography: Inter Display for headings, Inter for body. The article gives no sizes or weights.
- Layout: an inverted-L of global chrome (sidebar plus header). Sidebar, tab labels, icons and buttons are aligned on both axes. The stated aim is less visual noise and higher hierarchy and density of navigation.
- Views offer list, board, timeline, split and fullscreen modes, with header filters and display options plus a side panel for properties.
- Principles: cohesion and timelessness over novelty; stress-test across environments (desktop, browser) and appearance before implementation.

Takeaway for us: adopt the "few inputs generate the whole theme" model, keep the accent rare, and make density a first-class display option, not an afterthought.

### 2.2 Stripe Dashboard

Source: https://stripe.com/blog/accessible-color-systems (retrieved 2026-11-13) [V]

- Stripe's brand colours failed WCAG minimums (4.5:1 small text, 3:1 large). Darkening to pass made colours muddy.
- HSL was rejected: its lightness ignores perceived brightness per hue (yellow looks lighter than blue at equal HSL lightness). CIELAB was used for perceptual uniformity.
- Each hue got the same contrast curve. Rule: any two colours at least five levels apart pass for small text; four levels apart pass for icons and large text.
- Badges were fixed by shifting both background and text one level, avoiding per-colour tuning.
- WCAG measures contrast, not vibrancy, so both must be designed for.

Takeaway: build a numbered scale (e.g. 12 steps) per hue where the step distance encodes the contrast guarantee. This gives status badges, tags and charts safe pairings by construction. Further Stripe observations about table density and detail-page structure from product use are [U].

### 2.3 Attio

Sources: https://attio.com/help/reference/managing-your-data/views and https://attio.com/help/reference/managing-your-data/views/filter-and-sort-views (retrieved 2026-11-13, via search results) [S]; TechCrunch background https://techcrunch.com/2021/11/24/attio-wants-to-build-the-crm-for-the-airtable-generation/ [S]

- Table views behave like a spreadsheet: records are rows, attributes are columns.
- Filters and sorts can be stacked and saved per view; each view carries its own filters, sorts and visible attributes. A view changes presentation, not data.
- Table and kanban views are offered over the same data model.
- No Attio design-blog source on typography or spacing was found. Statements about Attio's visual density are [U].

Takeaway for a CRM: saved views are the core object. Treat "view = filters + sorts + columns + grouping + density" as one serialisable record that can be personal or shared.

### 2.4 Notion

No Notion source was fetched in this pass. The following are [U] and should be verified before use: block-based editing with a slash command menu; hover-revealed row actions; database views with filters and sorts; inline, low-chrome property editing. Re-check at https://www.notion.com/help (not retrieved).

### 2.5 Vercel Dashboard and Geist

Source: https://vercel.com/geist/introduction (retrieved 2026-11-13) [V]

- Geist Sans and Geist Mono (plus Serif and Pixel) form the typeface family.
- The colour system is described as high contrast and accessible; a grid system is described as core to the aesthetic; foundations cover radii, fills, strokes, shadows and layout.
- Component pages exist per component. Geist docs can be fetched as Markdown by appending `.md` (e.g. `/geist/colors.md`); this is a good next step for exact scales (not done).

Takeaway: a monospace companion for IDs, timestamps and numeric columns is cheap and increases scannability. Use tabular numerals where a mono face is overkill.

### 2.6 Raycast

Sources: https://manual.raycast.com/action-panel , https://developers.raycast.com/api-reference/user-interface/action-panel , https://raycast.com/blog/a-fresh-look-and-feel (retrieved 2026-11-13, via search results) [S]

- The Action Panel opens with Cmd/Ctrl+K and lists actions for the selected item, grouped in sections, with its own search field.
- In lists, the first and second actions get default shortcuts (Enter and Cmd+Enter).
- An action bar at the bottom shows the context's actions with shortcuts, which teaches shortcuts passively.
- Third-party descriptions of compact uniform rows and high-contrast selection are not official [U].

Takeaway: two command surfaces. A global palette (navigate, create, search) and a contextual action panel on any selected row or record. Always render the shortcut next to the action.

### 2.7 Intercom

Sources: https://www.intercom.com/blog/fundamentals-good-interaction-design , https://www.intercom.com/blog/shared-inbox , https://www.intercom.com/blog/designing-for-clarity-restructuring-intercoms-information-architecture , https://www.saasframe.io/examples/intercom-help-desk-inbox (all retrieved 2026-11-13, via search results) [S]

- Visual hierarchy through space, typography, grouping and indentation is an explicit fundamental.
- Shared inbox principles: let teams work alongside one another, not across each other; provide full customer context with every conversation.
- Next-gen Inbox: conversation events and customer context expand when needed (progressive disclosure).
- The 2025 information-architecture post focuses on navigation that is clear and predictable at a glance [S].
- Search and filtering let users control density (secondary source) [S].

Takeaway: a three-pane inbox (list, conversation, customer context) with collapsible context and presence indicators to avoid collisions between teammates.

## 3. Cross-cutting patterns

### 3.1 Information density

- Offer three modes: Comfortable, Default, Compact, differing only in row height, vertical padding and secondary-line visibility. Typography size should change by at most one step.
- Prefer progressive disclosure to hiding data: show primary identity, status and one signal per row; reveal the rest in the side panel.
- Avoid card grids for lists of records. Cards waste vertical space; use rows.
- Right-align numbers, use tabular figures, truncate with tooltip, never wrap identity columns.

### 3.2 Typography

- One variable sans family (Inter or Geist Sans are what Linear and Vercel use [V]) plus an optional mono. A display cut for large headings is optional.
- Few sizes. Product UI rarely needs more than 6 steps. Large marketing-style type has no place in a dense CRM.
- Weights: 400 body, 500 labels and table headers, 600 headings. Avoid 700+ in UI chrome [U, house opinion].
- Body line height around 1.4 to 1.5; tight (1.2 to 1.3) for headings. [U, widely used convention]

### 3.3 Spacing system

- 4px base unit. Common product steps: 4, 8, 12, 16, 20, 24, 32, 48, 64.
- Dense table rows commonly 32 to 40px; comfortable 44 to 52px [U, convention; tune with users].
- Align icon, label and control baselines in chrome. Linear states that this alignment is felt after minutes of use rather than noticed immediately [V].

### 3.4 Sidebar navigation

- Persistent left sidebar, collapsible to an icon rail; width 220 to 260px expanded [U].
- Group by workflow, not by data model: Inbox, My work, Contacts and companies, Pipelines, Reports, then pinned views and teams.
- Badges only for actionable counts (unread, assigned to me). Cap at 99+.
- Keyboard: a leader-key or number shortcuts to jump between sections [U].
- Below a breakpoint (about 768px) the sidebar becomes an overlay drawer; below it the web app should use a top bar with hamburger rather than trying to keep an icon rail.

### 3.5 Command menus

- Global palette (Cmd/Ctrl+K): navigate, create, search records, switch view, change theme or density.
- Contextual action panel on selection (Raycast model [S]): actions grouped in sections, searchable, with shortcut hints.
- Recents first, then results grouped by type; show the record type icon and a secondary descriptor.
- Accessibility: implement as a combobox/dialog with correct ARIA roles, focus trap, Escape to close and focus restored to the trigger [U, WAI-ARIA Authoring Practices; verify at https://www.w3.org/WAI/ARIA/apg/].
- Do not make the palette the only route to a feature. Every action needs a visible UI path.

### 3.6 Data tables

- Sticky header and sticky first column; column resize, reorder, hide; row selection with shift-range select; inline cell editing for simple attributes (Attio-like, [S]).
- Bulk-action bar appears on selection, replacing or overlaying the filter bar.
- Virtualise beyond about 100 rows. Preserve scroll and selection when data refreshes.
- Pagination versus infinite scroll: for CRM work with saved views, use cursor-based infinite scroll with a visible total count [U, judgement call].
- Accessibility: use real `<table>` semantics or ARIA grid with documented keyboard model; 24x24 CSS px minimum target for row controls (WCAG 2.2 SC 2.5.8) [V, see 3.10].

### 3.7 Filters

- Structured filter builder: field, operator, value chips; AND by default, explicit OR groups.
- Filters are visible as removable chips under the header, never hidden in a modal after being applied.
- Save as view; show a dirty indicator when the live state differs from the saved view (Attio's saved views behave this way [S]).
- Quick filters (Mine, Unassigned, Unread) as one-click pills for the inbox.

### 3.8 Empty and loading states

- Skeletons that match the final row geometry for first loads; avoid spinners for anything over roughly 300ms except indeterminate background work [U, convention].
- Optimistic UI for low-risk mutations (assign, tag, archive) with undo toast.
- Empty states have three kinds and each needs its own copy: first-use (explain and offer one primary action), no-results (offer to clear filters), and error (say what failed and offer retry).
- Avoid illustration-heavy empty states in dense work areas. A line of text and one button is enough.

### 3.9 Responsive layouts

- Breakpoints (suggested): 0 to 639 phone, 640 to 1023 tablet, 1024 to 1439 laptop, 1440 and up desktop [U, suggestion].
- Inbox: three panes at 1280 and up; two panes (list plus conversation, context as drawer) at 1024; single pane with push navigation below 768.
- Tables collapse to a prioritised column set, then to a row-list pattern on phones. Do not horizontally scroll the whole page.
- Respect `prefers-reduced-motion`, `prefers-color-scheme` and `prefers-contrast`.

### 3.10 Accessibility

Source: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html (retrieved 2026-11-13) [V]

- WCAG 2.2 SC 2.5.8 (AA): pointer targets at least 24 by 24 CSS px. Smaller targets pass if a 24px circle centred on them does not intersect another target. Exceptions: equivalent control elsewhere, inline text links, user-agent controls, essential.
- Contrast: 4.5:1 for normal text, 3:1 for large text, 3:1 for non-text UI components and focus indicators (WCAG 2.x, as cited in the Stripe article for the text ratios [V]; the 3:1 non-text rule is [U] pending a re-check of SC 1.4.11).
- Other WCAG 2.2 AA items to build in: Focus Not Obscured (2.4.11), Dragging Movements (2.5.7, every drag needs a non-drag alternative, which matters for kanban and reorder), Consistent Help (3.2.6), Accessible Authentication (3.3.8). These are [U] from general knowledge; confirm at https://www.w3.org/TR/WCAG22/.
- Focus: always visible, 2px ring offset from the element, never removed. Sticky headers and toasts must not cover focused elements.
- Colour is never the only status signal: pair status colour with an icon or label.

### 3.11 Micro-interactions

- 100 to 200ms for hover and press, 200 to 300ms for panel transitions, ease-out for entrances and ease-in for exits [U, convention].
- Animate opacity and transform only. No layout-thrashing animation on list rows.
- Meaningful feedback: row highlight on new message, subtle flash on a field updated by another user, undo toast on destructive action.
- Keyboard feedback: show pressed shortcut hints; focus moves predictably after archive (next conversation selected).
- Every animation has a reduced-motion fallback (fade or none).

## 4. Mobile

Apple and Google first-party pages could not be extracted by the fetch tool (client-rendered). Everything attributed to them below is [U] and must be re-checked at:

- https://developer.apple.com/design/human-interface-guidelines/tab-bars
- https://developer.apple.com/design/human-interface-guidelines/layout
- https://developer.apple.com/design/human-interface-guidelines/accessibility
- https://m3.material.io/foundations/designing/structure
- https://m3.material.io/foundations/accessible-design/overview
- https://m3.material.io/components/navigation-bar/overview

### 4.1 Platform guidance (all [U], recheck)

- **Bottom tabs.** iOS: 3 to 5 tabs on iPhone, short labels, icon plus label, badge for unread counts, tab bar stays visible for top-level sections. Android Material 3 navigation bar: 3 to 5 destinations; navigation rail for tablets and foldables, drawer or rail on large widths.
- **Touch targets.** iOS 44x44pt minimum; Material 48x48dp minimum, with at least 8dp between targets. Extend the hit area (hitSlop in React Native) rather than enlarging glyphs. Our single rule: 48x48 for everything on both platforms.
- **Safe areas.** Keep interactive content out of the status bar, notch or Dynamic Island, home indicator and rounded corners. Let backgrounds bleed. Use `react-native-safe-area-context` insets; on Android handle edge-to-edge (default from Android 15 for apps targeting SDK 35 [U]).
- **Keyboard handling.** Composer pinned above the keyboard; list scrolls to keep last message visible; interactive keyboard dismiss on scroll drag; avoid the composer hiding behind the keyboard on Android with edge-to-edge. Libraries: `react-native-keyboard-controller` is widely used for this [U].
- **Swipe actions.** Leading swipe for the positive/quick action (assign to me, mark done), trailing for secondary (snooze, archive, more). Full swipe triggers the first action only for reversible operations. Every swipe action must have a non-gesture alternative (long-press menu or detail screen), which also aligns with WCAG 2.5.7 [U].
- **Pull to refresh.** Native refresh control on list screens; do not combine with custom spinners. Show last-updated time for offline-tolerant lists.
- **Skeletons.** Row-shaped placeholders; no shimmer if reduce-motion is on.
- **Dark mode.** Follow system by default with a manual override. Do not invert colours: define dark surfaces by elevation using lighter surfaces for higher layers, and reduce accent saturation slightly. Both platforms recommend this in principle [U].
- **Dynamic type and font scaling.** Support OS text scaling up to at least 200%; layouts must reflow, not truncate identity text [U].

### 4.2 Reference mobile apps

No first-party sources were fetched for these. All observations below are [U] from general product knowledge and must be verified by hands-on audit with screenshots before they inform decisions.

- **Linear mobile.** Compact issue lists, bottom tab navigation, swipe actions on rows, inbox as a primary tab, fast optimistic updates. Lesson: the same information model as desktop with fewer panes.
- **Intercom inbox.** Conversation list with unread emphasis, quick filters, snippets and assignee avatars; composer with internal-note toggle. Lesson: make reply versus internal note unmistakable (colour plus label).
- **Slack.** Bottom tabs (Home, DMs, Activity, You), swipe and long-press on messages, strong unread typography (bold). Lesson: unread is a typography state, not only a badge.
- **WhatsApp Business.** Chat list conventions users already know, labels (tags) on chats, quick replies, away and greeting messages. Lesson: tags and quick replies are first-class on mobile; use familiar chat-list and bubble conventions.
- **Front.** Shared inbox with assignment, comments inside conversation threads, snooze. Lesson: team collaboration inside the thread (mentions, internal comments) must be mobile-visible.
- **HubSpot mobile.** Records (contacts, deals) with click-to-call and log activity, deal stage changes. Lesson: on mobile a CRM is about the next action (call, message, log note, change stage), not editing 40 properties.

### 4.3 Mobile-specific CRM priorities

1. Inbox first: unread, assigned to me, and snooze reachable in one tap.
2. Record screens led by action buttons (call, message, note, task) then timeline, then properties.
3. Offline tolerance: queue outgoing messages and notes with visible pending/failed states [U, product decision].
4. Push notifications deep-link to the exact conversation and restore the list position on back.
5. Biometric lock option for sensitive client data [U, product decision].

## 5. Recommendations

### 5.1 Design direction

**"Quiet precision."** A neutral workspace with a single accent, high type clarity, dense-by-choice layouts, keyboard-first on web, action-first on mobile. Brand personality comes from restraint, motion quality and copy, not from decoration. This follows the convergence seen in Linear [V], Vercel Geist [V] and Raycast [S].

### 5.2 Type scale

Font: Inter (variable) for UI, with `font-feature-settings: "tnum"` on numeric columns; JetBrains Mono or Geist Mono for IDs and code (optional). Mobile uses the same family loaded as a bundled font, falling back to the system font if load fails.

| Token | Size / line height (px) | Weight | Use |
|---|---|---|---|
| text-xs | 11 / 16 | 500 | Badges, captions, table meta |
| text-sm | 13 / 20 | 400/500 | Table cells, secondary text, dense body |
| text-base | 14 / 20 | 400/500 | Default web body |
| text-md | 16 / 24 | 400/500 | Mobile body, inputs (prevents iOS zoom on web) |
| text-lg | 18 / 26 | 600 | Section headings |
| text-xl | 22 / 30 | 600 | Page titles |
| text-2xl | 28 / 36 | 600 | Rare: empty states, onboarding |

Mobile body is 16 minimum for inputs and message text; 14 for secondary rows. All sizes scale with OS text scaling.

### 5.3 Spacing and sizing scale (4px base)

space-0 0, 1 = 4, 2 = 8, 3 = 12, 4 = 16, 5 = 20, 6 = 24, 8 = 32, 10 = 40, 12 = 48, 16 = 64.

Radii: 4 (inputs, chips), 6 (buttons, rows), 8 (cards, popovers), 12 (dialogs, mobile sheets), full (avatars, pills).

Minimum interactive size: 24px CSS floor for web density modes (WCAG 2.5.8 [V]); 32px default web control height; 48 on mobile.

### 5.4 Colour: neutral plus one accent

- Neutrals: a 12-step neutral scale with a barely tinted hue (cool or warm, pick one) for backgrounds, borders, text. Surfaces by elevation (app, panel, popover, modal), as in Linear [V].
- One accent hue (a 12-step scale) used only for primary action, selection, focus ring and links. Aim for under about 5% of pixels.
- Semantic colours (success, warning, danger, info) are separate small scales, used with icon plus label, never alone. Keep them lower chroma than the accent.
- Derive scales in a perceptual space (OKLCH or LCH, as with Linear [V] and Stripe's CIELAB [V]). Define step pairs with guaranteed contrast, e.g. "step 11 text on step 2 surface passes 4.5:1", so contrast is a property of the system.
- Dark mode: its own scale, not an inversion. Test every step pair in both themes.
- Choice of the accent hue is a brand decision pending client input. Avoid the default purple-to-blue gradient look (see 5.9).

### 5.5 Density modes

| Mode | Table row | Control height | Body | Use |
|---|---|---|---|---|
| Comfortable | 52px | 40px | 14 | Default on touch laptops, new users |
| Default | 40px | 32px | 14 | Default on desktop |
| Compact | 32px | 28px | 13 | Power users, large monitors |

Density is a user preference stored per account and synced between devices. Mobile has a single density (48dp targets) with an optional "compact list" toggle that reduces secondary lines but never target sizes. Compact on web still keeps 24x24 minimum targets or spacing exception [V].

### 5.6 Motion principles

1. Motion explains change of state or position; it is never decoration.
2. Fast: 100 to 150ms micro, 200 to 250ms panels, 300ms max for sheets [U convention].
3. Ease-out for appear, ease-in for dismiss; no bounce in work surfaces.
4. Transform and opacity only.
5. Respect reduced motion on both platforms (`prefers-reduced-motion`, `AccessibilityInfo.isReduceMotionEnabled`).
6. Loading is shown with skeletons shaped like content; optimistic updates are preferred over spinners.
7. Defined once as tokens (duration, easing) and shared.

### 5.7 Accessibility targets (WCAG 2.2 AA)

- Text contrast 4.5:1 (3:1 for large text, 18pt or 14pt bold); UI components and focus indicators 3:1 [text ratios V via Stripe; non-text 3:1 U].
- Target size: 24x24 CSS px minimum on web [V]; 44pt iOS and 48dp Android on mobile [U, recheck HIG and M3].
- Full keyboard operability on web with visible focus not obscured by sticky UI; every drag and swipe has a single-pointer or non-gesture alternative.
- Screen reader semantics verified with VoiceOver, TalkBack, NVDA and axe in CI; labelled icon-only buttons.
- Text resize to 200% without loss; no content that relies on colour alone.
- Provide a high-contrast theme option, mirroring Linear's contrast variable [V].
- Include accessibility checks in design review and automated tests (axe-core on web, accessibility lint on mobile); treat violations as build blockers for AA items.

### 5.8 Shared web and mobile token strategy

Goal: one source of truth, platform outputs generated, no hand-copying.

1. **Source.** A single JSON token file following the W3C Design Tokens Community Group format (https://www.designtokens.org/ , not retrieved, [U] on current status) kept in a shared package (e.g. `packages/tokens` in a monorepo).
2. **Three layers.** Primitive (raw scales: neutral-1..12, accent-1..12, space, radius, type), semantic (bg-app, bg-panel, text-primary, text-muted, border-subtle, accent-solid, focus-ring), and component tokens only when needed. Components consume semantic tokens only.
3. **Themes.** Light, dark and high-contrast are alternative mappings of the semantic layer onto primitives. Generate the primitives from a few inputs (base, accent, contrast) in OKLCH, in the way Linear describes [V].
4. **Build.** Style Dictionary (https://styledictionary.com , [U] not retrieved) or a small script emits: CSS custom properties (web; Tailwind theme extension if Tailwind is used), and a TypeScript object for React Native (StyleSheet or a theme context). Use hex or rgb for RN output because RN does not support OKLCH [U, verify].
5. **Units.** Web uses rem for type and px for spacing at 4px base; mobile uses unitless density-independent values from the same numbers.
6. **Platform-specific differences are explicit.** Touch target, safe-area and font scaling tokens exist only on mobile; hover and focus-ring tokens only on web. Shared values are never overridden silently.
7. **Contrast tests in CI.** A script iterates semantic text/background pairs for every theme and fails below 4.5:1 or 3:1 as appropriate.
8. **Component parity, not code parity.** Share tokens, icons (a single SVG set) and naming. Do not try to share UI components between Next.js and React Native beyond headless logic and types, unless the team adopts a cross-platform UI layer deliberately [U, architectural trade-off].
9. **Docs.** A living token page (web) and a Storybook or equivalent for both targets; visual regression on token changes.

### 5.9 AI-slop anti-patterns to avoid

Visual:
- Purple/indigo-to-blue gradients, glowing orbs, glassmorphism everywhere, and neon accents on a dark base.
- Every surface a rounded card with a soft shadow; nested cards inside cards.
- Gradient text on headings; sparkle icons marking every AI feature.
- Emoji as icons or as bullet decoration in product UI.
- Decorative stock illustrations or 3D blobs in empty states of a work tool.
- Oversized hero-style typography in application screens.
- Random colour per tag or avatar with no contrast check.

Layout and content:
- Dashboards leading with four identical big-number tiles with up-arrows and green percentages, and no actionable path.
- Fake or lorem-style data, round-number metrics (e.g. 10,000, 99.9%), and the generic placeholder names "John Doe" and "Acme Inc".
- Copy such as "Unlock the power of...", "Seamless", "Supercharge", "Elevate your workflow".
- Three-column icon-title-blurb feature grids reused as product UI.
- Generic gradient avatars and identical icon-in-circle patterns.

Interaction:
- Hover-only actions with no keyboard or touch equivalent.
- Modals for everything, including simple edits that belong inline.
- Toasts that cover focus or critical content, or that vanish before the user can read or undo.
- Infinite shimmer with no timeout or error path.
- Chat-bubble "AI assistant" widgets bolted on as the main navigation, with no integration with records.
- Animations on every element on load, bounce easing, parallax in a work tool.
- Placeholder-as-label inputs, and disabled buttons with no explanation.
- Colour as the only state indicator.
- Dark mode produced by inverting light mode.

Process:
- Shipping first-draft generated UI without a contrast, keyboard and screen-reader pass.
- Mixed icon sets and inconsistent stroke weights; inconsistent spacing off the 4px grid.

## 6. Open items and risks

- Apple HIG, Material 3, Notion, Slack, WhatsApp Business, Front, HubSpot and mobile Linear/Intercom were not verified from primary sources. A follow-up pass with a browser tool (Playwright or Chrome DevTools) on the listed URLs is advised before design sign-off.
- Exact Vercel Geist and Raycast token values were not captured; Geist Markdown endpoints are available (see 2.5).
- Accent hue, brand typeface and density defaults need client and user-testing input.
- React Native OKLCH support, Dynamic Island and Android edge-to-edge behaviour change across OS versions; confirm against the SDK versions the project targets.
- Competitive observations derived from product use are [U] and should be validated with screenshots stored in the repo.

## 7. Source index (all retrieved 2026-11-13)

Read in full [V]:
- https://linear.app/now/how-we-redesigned-the-linear-ui
- https://stripe.com/blog/accessible-color-systems
- https://vercel.com/geist/introduction
- https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html

Seen only via search results [S]:
- https://attio.com/help/reference/managing-your-data/views
- https://attio.com/help/reference/managing-your-data/views/filter-and-sort-views
- https://techcrunch.com/2021/11/24/attio-wants-to-build-the-crm-for-the-airtable-generation/
- https://manual.raycast.com/action-panel
- https://developers.raycast.com/api-reference/user-interface/action-panel
- https://raycast.com/blog/a-fresh-look-and-feel
- https://www.intercom.com/blog/fundamentals-good-interaction-design
- https://www.intercom.com/blog/shared-inbox
- https://www.intercom.com/blog/designing-for-clarity-restructuring-intercoms-information-architecture
- https://www.saasframe.io/examples/intercom-help-desk-inbox

Attempted but not extractable (client-rendered); content is [U]:
- https://developer.apple.com/design/human-interface-guidelines/tab-bars
- https://developer.apple.com/design/human-interface-guidelines/layout
- https://m3.material.io/foundations/designing/structure
