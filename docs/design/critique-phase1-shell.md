# Critique: Phase 1 web shell

Scope: `docs/design/screenshots/phase1-shell/*` (19 PNGs) and the code in `apps/web/app/**`, `apps/web/components/**`, `apps/web/lib/nav.ts`, `packages/design-tokens/src/tokens.ts`, `apps/web/app/globals.css`. Reviewed against `PRODUCT.md` and `docs/design/design-system.md`. Static review of screenshots and source; nothing was run. Findings marked "verify" rest on code reading, not a live repro.

Severity: blocker = ship-stopper or breaks a stated requirement; major = clearly hurts quality or accessibility, fix before Phase 2 builds on it; minor = polish or consistency.

Overall: the shell is clean and restrained, but it reads as a competent shadcn default. It has no point of view yet, and the nav carries a lot of promise (7 of 11 items disabled). Phase 1 has real bugs in focus styling and the drawer, one product-honesty problem (roadmap phases shown to customers), and a weak type hierarchy.

---

## Blockers

### B1. Global focus rule is unlayered and overrides Tailwind utilities, so focus and radius break everywhere
- Where: `apps/web/app/globals.css:75-76`. Visible in `command-menu-1440.png` (search input has a detached blue box offset up and left of the field) and `role-dialog-1440.png`.
- Problem: `:focus-visible { outline: 2px solid; outline-offset: 2px; border-radius: 4px; }` sits outside any `@layer`. Unlayered CSS beats Tailwind v4's layered utilities. So `outline-none` on the command input, dropdown items and `<main>` is ignored, and `border-radius: 4px` rewrites the radius of whatever is focused. A `rounded-full` avatar trigger becomes a 4px square on focus. Buttons, inputs and nav links change shape when focused.
- Why it matters: focus indication is the most-used a11y affordance and it is visibly wrong. The command palette is the flagship interaction. `<main tabindex=-1>` will also show a ring after the skip link.
- Fix: wrap the base rules in `@layer base { ... }`. Drop `border-radius` from the rule and set the ring with `outline` only. Use `outline-offset: 2px` on controls and `-2px` on inputs inside bordered containers (the cmdk input). Then delete the stray `outline-none` classes that were fighting it, or keep them only where the ring is deliberately replaced (cmdk selected rows).

### B2. Product roadmap leaks into customer UI and the nav is mostly dead
- Where: `lib/nav.ts:22-38`, `app/w/[workspaceId]/page.tsx:16-21`, `sidebar-nav.tsx:21-31`, `home-1440.png`, `drawer-375.png`, `command-menu-1440.png`.
- Problem: 7 of the 11 nav entries are disabled "Soon". Their reasons are tooltips reading "Contacts arrive in Phase 2" and "Meta integration arrives in Phase 3". Home's checklist repeats the same phase numbers. "Phase N" is internal planning vocabulary. `PRODUCT.md` says unavailable features are shown "as unavailable with a reason", but a customer cannot act on "Phase 2".
- Why it matters: the first screen of the product advertises what does not exist. The three working destinations (Members, Audit log, Settings) look like footnotes under a wall of grey. Attio, Linear, Stripe and Intercom do not ship greyed-out nav; users learn to ignore the grey and start distrusting the rest.
- Fix (pick one, in order of preference):
  1. Remove unbuilt items from the primary nav. Home's "Getting started" becomes the single honest roadmap: "Connect Messenger or Instagram: not available yet", with no phase numbers.
  2. If the product wants to show the shape, collapse all unbuilt items into one "Coming soon" disclosure at the bottom of the nav (`<details>` or a button with `aria-expanded`, closed by default). Render items as plain non-interactive text, not links. One line of copy, not seven tooltips.
  3. Keep at most Inbox, Contacts and Pipeline visible as the "spine", with one shared "Soon" treatment.
  Either way, strip "Phase N" from every user-facing string.

---

## Major

### M1. Disabled nav items are fake links: focusable, `role="link"`, no action, reason partly tooltip-only
- Where: `sidebar-nav.tsx:23`.
- Problem: `<span tabindex=0 role="link" aria-disabled>` puts seven dead stops in the tab order, and Enter does nothing. A `role="link"` with no `href` and no activation breaks the ARIA contract. The reason is an sr-only description plus a hover/focus tooltip. Touch users never see the tooltip: that covers the 375 drawer (`drawer-375.png`) and the 768 rail, which is an iPad portrait width. `fg-disabled` (#9AA1AE) on white is about 2.6:1, so the labels are also hard to read.
- Fix: if kept, render as `<div aria-disabled="true">` with no `role=link`. Make it non-tabbable, or tabbable with `role="note"` (a deliberate choice). Put the reason inline as visible text, or reachable by tap through a popover, not hover only. Use `fg-subtle` (#596070, 6.4:1) for the label and distinguish disabled by dropping the icon, not by low contrast. Best resolved by B2.

### M2. Drawer stays "open" (modal state, aria-hidden, scroll lock) when the viewport crosses `md`
- Where: `app-shell.tsx:51-65`. The drawer content and overlay use `md:hidden`, but the Radix `open` state persists.
- Problem: rotating a tablet or resizing a window with the drawer open leaves the visual drawer gone while Radix still marks the page `aria-hidden` and applies `pointer-events: none` to the body. The app is dead until Esc (verify).
- Fix: close on `matchMedia("(min-width: 768px)")` change. Or render the drawer only below `md`, using a hook that returns `isMobile`.

### M3. Command menu: the useful items are below the fold and the list is mostly disabled
- Where: `command-menu.tsx:36-45`, `command-menu-1440.png`.
- Problem: "Go to" lists all 11 pages in nav order. The first screen shows Home plus six disabled "Not available yet" rows. Members, Audit log and Settings are cut off by `max-h-80`. There is no current-page marker, no footer hints, and no fuzzy aliases.
- Fix: do not list disabled items (consistent with B2). Sort enabled items first. Add a footer row ("↑↓ navigate, ↵ open, Esc close"). Add actions that are real now: "Invite member (not available)" is not one, but "Change workspace name" is. Mark the current page.

### M4. Type hierarchy is flat: page title is 20px, topbar title is 14px, and they duplicate
- Where: `panel.tsx:24` (h1 `text-lg`=20px), `app-shell.tsx:70` (topbar `<p>` 14px semibold), `tokens.ts:70`. Visible on every 1440 shot ("Home" in the bar, then the workspace name below it).
- Problem: the scale defines 11, 12, 13, 14, 16, 20, 24 and 28px. The app uses 11, 12, 13, 14 and 20 only, and 24/28 never appear. Four near-identical small sizes (11/12/13/14) carry all the information. The topbar repeats what the h1 says, and is a `<p>`, so there is no landmark title. On Home the h1 is the workspace name (long, wraps to 2 lines at 375) while the bar says "Home", so there are two competing titles.
- Fix:
  - Collapse the working scale to 12 / 14 / 16 / 20 / 28, and drop 11 and 13 unless a role needs them.
  - Make the topbar a breadcrumb or context ("Northwind Studio / Members") or empty, never a second title. The page h1 is the title.
  - Raise page h1 to 24px/600 with -0.02em, and give section h2s 14px/600 uppercase-free. That is the Linear/Stripe level of contrast.
  - Move the repeated `tracking-[-0.01em]` (4 uses) into a `--tracking-tight` token.

### M5. Members table: date wraps to 3 lines at 768, row density contradicts the spec, dead rows
- Where: `members-table.tsx:113`, `table.tsx:16`, `members-768.png`, `members-1440.png`.
- Problem:
  - At 768 "Nov 12, 2026" breaks into three lines ("Nov / 12, / 2026"). The TD lacks `whitespace-nowrap` and the email column is greedy.
  - Rows are about 61px against the design system's default of about 40px. Email as a second line plus a 32px avatar is "comfortable" density, but is presented as the default.
  - The Owner row has an empty actions cell with no explanation. The `TR` hover `bg-subtle` (#FAFAFB on white, about 1.04:1) is imperceptible and implies the row is clickable when it is not.
  - Name column dominates (about 700px at 1440) so Role and Joined float far from the name.
  - Seeded emails like `mayaokafor-mwehgm8a-27@example.com` look like test fixtures. The realistic-content rule is broken in the one screenshot that is all data.
  - There is no member count, search, or Invite action (disabled with a reason, per the product rules).
- Fix: `whitespace-nowrap tnum` on the Joined cell. Put email in its own column and keep a single-line row at about 44px. Make the name column `max-w`, not greedy. Show a muted "Owner" explanation, or an `aria-label` on a disabled kebab, for rows with no actions. Drop the row hover or give it a real affordance. Add a disabled "Invite member" button with an inline reason ("Invitations aren't available yet."). Re-seed with clean emails.

### M6. Role dialog: initial focus lands on the Close button; disabled primary has no explanation
- Where: `overlays.tsx:50-63`, `role-dialog-1440.png`. Focus ring is on the X. The primary "Save role" is `opacity-50` lavender with white text (about 2:1).
- Fix: put initial focus on the Select with `onOpenAutoFocus` and a ref. Drop the always-visible X in small confirm dialogs (Esc and Cancel already exist). Show "Save role" disabled only with the helper text "Choose a different role to save." Replace `disabled:opacity-50` with explicit disabled tokens that keep 3:1 for the UI component.

### M7. Auth: no recovery path, validation does not move focus, dead-end onboarding
- Where: `auth-form.tsx`, `create-workspace-form.tsx`, `login-errors-*.png`, `onboarding-1440.png`.
- Problem:
  - Sign-in has no "Forgot password" link. Show it disabled with a reason if the flow does not exist.
  - On submit with errors, focus stays on the button. Move focus to the first invalid field and consider an `aria-live` summary.
  - Register's password hint ("At least 10 characters.") disappears the moment an error shows. `Field` hides the hint but `aria-describedby` still points at its missing id (`field.tsx:10,15`).
  - Onboarding gives a first-time user no way out (no Sign out) unless `?new=1`. A wrong-account user is stuck.
  - Card widths differ: auth `max-w-sm` (384px), onboarding `max-w-md` (448px), at the same visual level.
  - The password field has no show/hide toggle, and `globals.css:79` explicitly hides the native one.
  - Welcome copy "Pick up your conversations." promises an inbox that does not exist.
- Fix: add the toggle, a first-error focus helper, and a Sign out link in onboarding. Align both cards to one width. Keep the hint visible alongside the error, or render both. Change the copy to what is true ("Sign in to your workspace.").

### M8. Inputs are 14px, which triggers iOS Safari zoom on focus
- Where: `input.tsx:5` (`text-base` = 14px). Relevant at 375 for login, settings and onboarding.
- Fix: `text-md` (16px) on controls at coarse pointers or below `md`. Verify: `pointer-coarse:text-md`.

### M9. Skeleton is one table-shaped placeholder for every route
- Where: `app/w/[workspaceId]/loading.tsx`.
- Problem: it shows a list of rows with avatars while Home is two panels and Settings is a form. The design system promises "skeleton loading shaped like the final content". This causes layout jump. It also double-announces (`role=status aria-label` plus an sr-only "Loading…").
- Fix: per-route `loading.tsx`, or a small `PageSkeleton` with `variant="list|panels|form"`. Keep a single accessible label.

### M10. Browser-surface theming is incomplete
- Where: `app/layout.tsx`, `globals.css:61-79`.
- Problem: no `viewport`/`themeColor` export (mobile address bar stays default), no favicon or app icons, no `accent-color` for native checkbox/radio, no autofill override (Chrome paints a yellow/blue fill on the auth inputs against the white card), no `color-scheme` meta. Dark mode switches only `color-scheme` on `html[data-theme=dark]` and nothing drives it. The Select chevron is a hard-coded data URI (see M12).
- Fix: export `viewport = { themeColor: [{ media: "(prefers-color-scheme: light)", color: "#F6F7F9" }, ...] }`. Add `accent-color: var(--accent)`. Add an `input:-webkit-autofill` rule using `box-shadow: inset 0 0 0 100px var(--bg-surface)` plus a text-fill color. Add `app/icon.svg`. Add `::-webkit-scrollbar` fallback for Safari.

### M11. Audit log: low information, awkward 375 layout
- Where: `audit-list.tsx`, `audit-1440.png`, `audit-375.png`.
- Problem:
  - "Maya Okafor updated workspace settings" does not say what changed. An audit log that hides the diff, target and time precision is a feed, not an audit record.
  - Timestamps have no year (`formatDateTime`). Ambiguous across years.
  - At 375 the timestamp sits beside the text and takes about 110px, squeezing the sentence to 2 lines.
  - The 24px avatar with 11px initials looks cramped and sits 2px low relative to the first text line (visible in both screenshots).
- Fix: show the change ("Name: 'Northwind' to 'Northwind Studio'", "Time zone: UTC to America/New_York"). Below `sm`, stack the time under the text. Include the year when it differs from the current one. Align avatar with `mt-0.5` or `items-center` for single-line rows.

### M12. Token bypasses and weak three-layer discipline
- Where:
  - `tokens.ts:47,50,51,52,53,56,58-65` (dark semantic values hard-coded as raw hex, not primitives). `tokens.ts:8` has a `dark` primitive group that is half used.
  - `input.tsx:13` (chevron stroke `%23596070` hard-coded, so it will not follow the theme).
  - Arbitrary values: `app-shell.tsx:54` (`w-[min(300px,85vw)]`), `command-menu.tsx:24` (`top-[12vh]`), `overlays.tsx:31` (`max-w-[calc(100vw-16px)]`), `members-table.tsx:92` (`pl-11`, a magic number tied to avatar 32px + gap 12px), `tracking-[-0.01em]` x4.
- Why it matters: the design system promises primitive, semantic and component layers with CI contrast checks. Raw hex in semantic dark breaks that and nothing validates the pairs.
- Fix: move the dark values into primitives. Use `currentColor` plus a mask or a lucide `ChevronDown` absolutely positioned for the select chevron. Add `--drawer-w`, `--palette-top` and `--tracking-tight` tokens, and use `pl-[calc(var(--avatar-md)+theme(spacing.3))]` or restructure so the badge is aligned by layout (grid with the avatar column), not padding.

---

## Minor

### m1. Workspace switcher and logo are redundant and the workspace avatar is ambiguous
- `app-shell.tsx:43-46`, `workspace-switcher.tsx`, `avatar.tsx:6-10`. Two identity rows stack (logo, then workspace). The workspace tile reads "NT" because `initials()` takes first and last word ("Northwind ... Team"). The workspace tile and user avatar share the same accent-subtle fill. Long names truncate at about 150px (`Northwind Studio Int…`) with no `title`.
- Fix: Linear/Attio fold the product mark into the switcher. Drop the separate "Social CRM" wordmark row in-app, or move it to the topbar corner. Use the first two letters or first two words for workspace initials, and a neutral square tile for workspaces versus a round tile for people. Allow the name two lines or add a `title`.
- Also: `ChevronsUpDown` is right; add a keyboard hint and a "Workspace settings" link in the menu. `aria-current="true"` on a `menuitem` is non-standard; use `DropdownMenuRadioItem`.

### m2. Brand is placeholder
- `logo.tsx`: "Social CRM" with a generic `MessagesSquare` icon in an indigo square. It is a category name, not a brand, and the same chat-bubble glyph is the default for every inbox product. Not a Phase 1 blocker, but it is the only brand element on the auth screens.

### m3. Rail at 768 is icon-only, labelled only by tooltip
- `home-768.png`, `members-768.png`, `sidebar-nav.tsx:46`. Tooltips do not work on touch. The rail uses `lg:` as the expand breakpoint, but 768 to 1023 is precisely where tablets live. Two stacked tiles (logo, then "NT") also read as two logos.
- Fix: expand the sidebar from `md`, or make the rail label-on-tap (press and hold or an expand toggle). Add a divider between the logo and the workspace tile.

### m4. `⌘K` is hard-coded; shown on touch and non-Mac
- `app-shell.tsx:72`. Linux and Windows users see ⌘. Show `Ctrl K` by platform, and hide the hint under `pointer-coarse`. The `sm:` breakpoint swap to an icon-only button below 640 is fine.

### m5. Active nav state is faint
- `sidebar-nav.tsx:40`. `bg-selected` is #F1F2FF on white (about 1.1:1). It reads through text color alone, so it is nearly invisible on low-quality displays. Fine for AA because of `aria-current`, but a 2px left indicator or `accent-subtle` at -100 would help. Compare Linear's explicit selected row.

### m6. Home page composition
- `page.tsx:33-69`, `home-1440.png`. "Getting started" is mostly non-actionable (three "later" rows, one auto-"Done" step). The "Recent activity" panel stretches to the full row height, leaving an empty box. The "Owner" badge top right duplicates the sidebar. The subtitle shows a raw IANA zone ("America/New_York") as a data point.
- Fix: show only real next actions (for example "Review members" linking to `/members`), remove the self-completing "Create your workspace" step, set `items-start` on the grid so panels size to content, format zone as "Eastern Time", drop the redundant badge.
- At 375 the h1 wraps to 2 lines and the metadata line breaks in the middle of the date; keep each fact unbreakable (`whitespace-nowrap` per segment).

### m7. Settings panel
- `workspace-form.tsx`, `settings-1440.png`. "Save changes" is always enabled (no dirty state). The success `Alert` mounts above the form and shifts the layout, and persists after further edits (`saved` clears only on submit). The time zone `<select>` is a native list of about 400 entries with no search. Read-only viewers see disabled inputs and no Save, which is fine because the panel description explains it. The account name and email silently become `""` if `/v1/me` fails.
- Fix: disable Save until dirty, show the "Saved" state inline on the button and clear it on change, replace the select with a searchable combobox (cmdk is already installed), render a visible error when `me` fails.

### m8. Page, error and 404 states lack structure
- `app/error.tsx`, `app/not-found.tsx`, `app/w/[workspaceId]/error.tsx`, `states.tsx:10,21`. `EmptyState` and `ErrorState` use `h3` with no `h1` above them on the standalone error and 404 pages (heading level skip). The error pages have no logo or navigation back besides Retry. The Members error state says "Reload the page" with no Retry button (`members/page.tsx`).
- Fix: allow a `level` prop (default `h2`, `h1` on full-page states), add "Go home" plus a support or digest line to global error, give Members a retry control.

### m9. Component variants are inconsistent or unused
- `button.tsx:22-26`: `icon` with `size="lg"` has no compound variant (renders `px-0` with no width, which collapses). `danger` hover is `opacity-90`, which looks like a disabled state. `ghost` and `secondary` have `active` identical to `hover`. Loading adds a spinner that shifts the label by 20px (no reserved width).
- Never used in the shell: `Badge` tones success/warning/danger, `Alert` info/warning, `Avatar` `lg` and `src`, `PanelHeader` `actions`. Either exercise them or drop them until needed.
- `Input` lacks a `readOnly` style and a visible hover on error. `Select` has no custom focus. Neither shows an icon alongside the red border for error (the text carries the meaning, so this is polish).
- `Table` header corners (`first:rounded-tl-xl`) rely on the Panel's radius while the table sits in an `overflow-x-auto` wrapper without clipping.

### m10. Dropdown rows are under 44px at coarse pointers
- `overlays.tsx:38`. `pointer-coarse:py-2.5` yields about 40px, below the 44pt iOS and 48dp Android targets the design doc cites.
- Fix: `pointer-coarse:min-h-11`. Also hamburger and kebab at coarse are 44px (good), but the `sm` search button is only `h-8` at pointer-fine.

### m11. Copy
- Three phrasings for one concept: "Soon", "Not available yet", "arrive in Phase N". Pick one.
- Tooltip text repeats the label ("Contacts: Contacts arrive in Phase 2.").
- "Visible to everyone who works here." is vague; say "Everyone in this workspace sees the name and time zone."
- Owner role help text promises "ownership transfer and deleting the workspace", which do not exist.
- Checklist "Done" for a step that is always done tells the user nothing.

### m12. Content width and alignment
- `app-shell.tsx:78`, `tokens.ts:74`. At 1440 the 1120px content is centered in the main area, so the left edge floats 60px in from the sidebar, while the Settings column hugs the left at 640px (`max-w-2xl`). Pick one: left-aligned with a max width, or consistently centered.

---

## Accessibility beyond axe (summary)

| Item | Status |
|---|---|
| Skip link, `main` landmark, `aria-current`, labelled icon buttons | Present, good |
| Disabled nav as focusable `role=link` | Fails the spirit of the ARIA spec (M1) |
| Reasons hidden in hover-only tooltips for touch | Fails (M1, m3) |
| Focus ring overridden by unlayered CSS; radius jumps | Fails (B1) |
| Drawer left modal after breakpoint change | Bug (M2) |
| Dialog initial focus on Close, not the control | Poor (M6) |
| Focus not moved to the first invalid field | Poor (M7) |
| Topbar title is a `<p>`; error pages lack `h1`; `aside` unlabelled | Structural (M4, m8) |
| `fg-disabled` text about 2.6:1; disabled primary about 2:1 | Readability (M1, M6) |
| Color-only meaning | Mostly OK: checklist uses shape plus sr-only text; alerts have icons; role badges are text |
| Reduced motion handled in CSS | Good |

---

## What is genuinely working

- Restraint: one accent, white surfaces, 1px borders, a single popover shadow, no gradients or glass. It matches the brief.
- Token-driven Tailwind theme (`--color-*: initial` reset) forces use of the system; most components consume it correctly.
- Real handling of coarse pointers (`pointer-coarse:h-11`) on buttons, inputs, nav and menu items.
- Radix and cmdk for overlays, a skip link, `aria-current`, labelled icon-only controls, `role=alert` on errors, `aria-busy` on loading buttons.
- Mobile members table is a purpose-built stacked list, not a squashed table, and role and actions stay visible.
- `Field` wires label, hint and error to the control with ids; error copy names the problem and the fix.
- Permission-aware nav and consistent Panel/PageHeader vocabulary across Home, Members, Audit and Settings.
- Truthful states where they exist: the Settings read-only explanation, the remove-member dialog consequence text, the connection-error message in auth.
- Browser-level touches already present: `::selection`, `caret-color`, thin scrollbars, placeholder color, reduced-motion.

## Suggested fix order
1. B1 (focus layer), M2 (drawer), M8 (iOS zoom): small, high-impact code fixes.
2. B2 plus M1 plus M3 (nav honesty, one decision that resolves three findings).
3. M4 (type scale and topbar), M5, M6, M7, M10, M12.
4. Everything else as polish before Phase 2 builds list views on this table and shell.
