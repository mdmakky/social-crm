# Critique round 2: Phase 1 web shell (independent verification)

Scope: round-1 findings re-checked against code and the 19 current PNGs in `docs/design/screenshots/phase1-shell/`; then a fresh review. Static review plus one Node URL-parser check; the app was not run. Items marked "verify" need a live repro. Paths are under `apps/web/` unless stated.

Overall: the round-1 blockers are really fixed and the shell is calmer. But one fix introduced a visible regression (Members at 768), the resolution table overclaims in four places, there is one security-relevant defect (`?next=`), and the error/empty/loading story is mostly untested.

## 1. Verification of round-1 findings

| ID | Claim | Verdict | Evidence |
|---|---|---|---|
| B1 focus rule unlayered | Fixed | **Verified fixed** | `app/globals.css:63,79` inside `@layer base`, no radius. `command-menu-1440.png` input has no detached box; `login-errors-*.png` ring is clean. |
| B2 dead nav / phase language | Fixed | **Verified fixed** | `lib/nav.ts:12,53-57`, `sidebar-nav.tsx:16-55`; every screenshot shows 3-4 real links. e2e asserts no `Phase \d` (`auth-and-shell.spec.ts:120`). New weaknesses in 2.14. |
| M1 fake links | Fixed | **Verified fixed** | Planned items are `<li>` text (`sidebar-nav.tsx:47-52`), not tabbable. |
| M2 drawer across md | Fixed | **Fixed in code, unproven** | `app-shell.tsx:23-28` listener present. No test resizes with drawer open (the e2e closes it only by clicking a link, `responsive-and-a11y.spec.ts:92`). |
| M3 command menu | Fixed | **Partly fixed** | Only built items + footer verified (`command-menu.tsx:19,60`). Still no current-page marker; Home is pre-highlighted while on Members (`command-menu-1440.png`), which reads as "you are here". |
| M4 type hierarchy / duplicate title | Fixed | **Fixed at md+, regressed at 375** | h1 is 24px (`panel.tsx:24`). Topbar no longer duplicates at md+. At <md the bar prints the workspace name (`app-shell.tsx:78`) directly above an identical h1 on Home (`home-375.png`). |
| M5 members table | Fixed | **REGRESSED** | `members-table.tsx:113` `whitespace-nowrap` made the table wider than the 664px viewport at 768: "Nov 12, 202" is clipped and the actions kebab is off-screen (`members-768.png`). Other M5 sub-points not fixed: row hover is `hover:bg-canvas` (`table.tsx:14`, #F6F7F9 on white, about 1.07:1); Owner row still has an empty actions cell with no explanation (`members-1440.png` row 1); no member count or disabled Invite; name column still greedy (Role at x=1022); fixture-looking emails still the only data on screen. |
| M6 dialog focus / disabled Save | Fixed | **Partly fixed** | Focus on select and hint text verified (`overlays.tsx:54`, `role-dialog-1440.png`). Disabled Save is still `disabled:opacity-50` (`button.tsx:8`), pale lavender with white text; round 1 asked for explicit disabled tokens. Close X still present. |
| M7 auth | Partly fixed | **Partly fixed, and the table understates** | First invalid field focused (`auth-form.tsx:33-37`, screenshots). Not fixed and not listed in the table: hint vanishes on error and `aria-describedby` still points at it (`field.tsx:10,15`); cards still 384 vs 448px (`(auth)/layout.tsx:7`, `onboarding/page.tsx:16`); no show/hide toggle; copy still "Pick up your conversations." (`auth-form.tsx:63`). Onboarding Sign out exists (verified). |
| M8 iOS zoom | Fixed for touch | **Fixed for inputs, not for the palette; unverified** | `input.tsx:6` `pointer-coarse:text-md`. Command input is 14px with no coarse override (`command-menu.tsx:30`), and at <sm the Search icon opens it. See 2.5. |
| M9 skeletons / meta | Fixed | **Partly fixed** | theme-color, icon, accent-color, autofill verified (`layout.tsx:7`, `globals.css:66,84`). There is no Home-specific skeleton: `w/[workspaceId]/loading.tsx` is the Home shape and also serves Members and Audit (single panel). Double announcement remains (`loading.tsx:6,27`, `settings/loading.tsx:5,15`). |
| M10 dark mode | Deferred | **Accepted** | Matches PRODUCT.md. |
| M11 audit log | "Partly" | **Overstated** | Change fields named (`audit-text.ts:13`). Year still absent (`format.ts:2`); 375 still puts the timestamp beside a 3-line sentence (`audit-375.png`); avatar still sits about 2px low (`audit-1440.png`). The table is silent on these three. |
| M12 token bypasses | Mostly | **Partly fixed** | Chevron and tracking fixed (`input.tsx:18`, `globals.css:51`). `pl-11` remains (`members-table.tsx:92`); `disabled:opacity-50` (`button.tsx:8`, `overlays.tsx:38`); raw hex in dark semantic (`tokens.ts:47,50-65`) is still not primitives. |
| m: Ctrl K, icon+lg, danger hover, Recent activity | Fixed | **Verified fixed** | `app-shell.tsx:29-33`; `button.tsx:27`; `button.tsx:15`; `page.tsx:33` (`items-start`). |
| m1 switcher | Deferred | **Still open** | Workspace avatar reads "NT" for "...Marketing Team" (`initials.ts`), truncated name has no `title` (`workspace-switcher.tsx:22`). |
| m: 768 rail labels | Deferred | **Still open** | Touch tablets get no labels (`Tooltip` is hover/focus only). |

Roadmap claims contradicted by evidence: item 15 "Met" (Members at 768 is broken); item 8 "Met": the round-1 resolution lists M7/M11 as partly done but omits the items above.

## 2. New and remaining findings, ranked

### Blocker

**2.1 Open redirect via `?next=` (security).** `app/(auth)/login/page.tsx:8` accepts any value starting with `/` but not `//`. `/\evil.com` and `/<TAB>/evil.com` both pass and resolve to `https://evil.com/` in the WHATWG parser (checked with Node `new URL`). After a successful sign-in `router.replace(next)` (`auth-form.tsx:55`) will navigate off-origin (verify live in Next 15 router). Phishing vector: attacker sends a genuine login URL. Fix: parse instead of prefix-match: `const u = new URL(next, "http://x"); ok = u.origin === "http://x" && !/[\\\t\r\n]/.test(next)`, then use `u.pathname + u.search`. Add an e2e/unit test with `/\evil.com`, `//evil.com`, `/%5Cevil.com`, `https://evil.com`.

### Major

**2.2 Members at 768 clips data and hides the actions column** (regression, see M5). Table min width exceeds the content box (`table.tsx:7` scrolls, but nothing signals it). Kebab is unreachable by sight. `noOverflow` (`responsive-and-a11y.spec.ts:31`) deliberately ignores elements inside an `overflow-x` ancestor, so the test cannot see this. Fix: switch to the stacked list up to `md` (change `sm:hidden`/`hidden sm:block` to `md`) or truncate email with `max-w-[...]`/`min-w-0` and `table-fixed`; add a test asserting the actions button is within the viewport at 768.

**2.3 API outage is shown as "page not found".** `apiGet` returns `status 500/0, data null` (`lib/api.ts:15-17`) and callers do `if (!ws) notFound()` (`w/[workspaceId]/layout.tsx:14`, `page.tsx:26`, `members/page.tsx:18`, `audit-log/page.tsx:16`, `settings/page.tsx:16`). During a backend failure users read "The page may have moved, or you may not have access" and the error boundary (with Retry) never runs. Also `ws.data ?? [current]` (`layout.tsx:18`) silently hides the user's other workspaces. Fix: `notFound()` only on 404/403; otherwise `throw new Error(...)`. Add a test that stubs the API with 500.

**2.4 Keyboard focus and selection are indicated only by `bg-hover` (#EEF0F3 on white, about 1.15:1).** Menu items (`overlays.tsx:38` `data-[highlighted]:bg-hover`, `outline-none`), command rows (`command-menu.tsx:13`), table kebab. Fails WCAG 2.4.7/1.4.11 intent for keyboard users; axe does not flag it. Fix: use `bg-selected` plus a 2px inset accent bar or `outline` on highlighted rows (3:1 against surface).

**2.5 Touch behaviour is untested and one control is wrong.** Playwright runs `Desktop Chrome` with no `hasTouch` (`playwright.config.ts`), so every `pointer-coarse:` rule (44px targets, 16px inputs) was never exercised; the 375 screenshots show 32px buttons (`settings-375.png`). Command input is 14px on touch (`command-menu.tsx:30`) so iOS zooms when the palette opens from the 375 Search icon. Fix: add a project with `isMobile: true, hasTouch: true` that asserts `box.height >= 44` for nav links, buttons, inputs, and computed `font-size >= 16px` for inputs including the palette; set `text-md` on the cmdk input under `pointer-coarse`.

**2.6 Server text shown verbatim.** `lib/client-api.ts:30` prefers `r.message` (server-supplied, e.g. Zod issue text from `apps/api/src/routes/workspaces.ts:87`) over the curated `MESSAGES`; `auth-form.tsx:50` prints `res.error.message` on any register failure. Any future 500 or provider error string becomes UI copy. Fix: map by `code` first, allow server text only for an explicit allowlist (`invalid_body`), otherwise the generic line; same for register. Unit-test `errorMessage`.

**2.7 No security response headers.** `next.config.ts` sets only `poweredByHeader: false`. No `frame-ancestors`/`X-Frame-Options` (clickjacking of the Remove member and Change role dialogs), no CSP, `X-Content-Type-Options`, or `Referrer-Policy`. May be handled at a proxy that does not exist yet (verify). Fix: `headers()` in `next.config.ts` with at least `frame-ancestors 'none'`, `nosniff`, `strict-origin-when-cross-origin`.

**2.8 Home gives a first-time owner nothing to do.** Three of four "Getting started" rows are inert "Coming soon" text (`page.tsx:16-21,37-46`); nothing links to Members or Settings, which are the only things that work. Attio/Linear/Intercom onboarding always has one live CTA. Fix: make "Create your workspace" step lead to "Review settings" and "See members" links; collapse not-yet-possible steps into one muted line.

### Minor

**2.9 `?next=` after registration is dropped**: `register/page.tsx:6` hard-codes `/`; a user deep-linked then registering loses the target. Cheap to forward through the same validated helper.

**2.10 Field a11y** (`field.tsx:10`): `aria-describedby` includes the hint id even when the hint is not rendered (`!error` guard at line 15). Render the hint always (it is useful next to the error) or drop the id. Same for `Select` hints in dialogs.

**2.11 Heading structure.** EmptyState and ErrorState use `<h3>` (`states.tsx:10,21`) with no h2 above on Members/Audit error pages (`members/page.tsx:26`) and as the only heading on 404/500 (`not-found.tsx`, `error.tsx`, `w/.../error.tsx`). Give states a `headingLevel` prop; 404/500 get an `h1`.

**2.12 Layout-shift and hydration risks.** (a) Mac users see "Ctrl K" then "⌘K" (`app-shell.tsx:29-33`), changing the search button content after hydration. (b) `Button` loading prepends a spinner (`button.tsx:52`), widening "Save changes" and the auth submit. (c) Settings inserts the saved/error Alert above the fields (`workspace-form.tsx:40-41`), pushing the form down under the pointer. (d) Time-zone options come from `Intl.supportedValuesOf` on both server and client (`workspace-form.tsx:13-16`); different ICU versions produce different option lists, a hydration mismatch risk (verify). Fix: reserve space (absolute spinner or fixed min-width), render alerts below the button, and send the zone list from the server only.

**2.13 Success state is sticky.** "Workspace settings saved." stays after the user edits again (`setSaved(false)` only on next submit, `workspace-form.tsx:26`); no dirty state, no toast. Clear on `onChange`.

**2.14 Coming soon disclosure.** (a) `mt-auto` pins it 800px below the group it relates to at 1440 (`home-1440.png`), 12px muted, easy to miss. (b) Row styling differs from live links: 13px/28px vs 14px/32px, and `pl-1` puts icons 4px left of the live icons (`sidebar-nav.tsx:48` vs `:30`); same icons, same grey, so they still look like links. (c) Nothing on the rows says "unavailable" except the parent label; give the list `aria-label="Planned features"` and drop icons. (d) The rail at md omits it entirely (no way to learn). (e) Single "Workspace" group label over three items plus a loose "Home" (`nav.ts`, `sidebar-nav.tsx:18`) is now meaningless noise at 11px; drop the label when only one group remains. Move the disclosure directly under the groups.

**2.15 Skeleton mismatch.** Members and Audit get the Home-shaped two-panel skeleton (`loading.tsx:9-25`) then render one panel; no `app/loading.tsx`, so login to workspace shows a blank page during the layout's three API calls. Add `members/loading.tsx` and `audit-log/loading.tsx` (single panel) and keep one accessible label (remove the sr-only duplicate).

**2.16 Audit log.** Year missing (ambiguous across years); 375 layout; avatar offset (`audit-list.tsx:34-37`). Cursor is concatenated unencoded (`audit-list.tsx:22`, use `encodeURIComponent`). After "Load older entries" focus stays on a button that may vanish, and nothing announces new rows (`aria-live` or move focus to the first new item).

**2.17 Members page leftovers.** Mobile stacked list drops Joined (`members-table.tsx:87-97`); two full renderings of every row stay in the DOM; Owner row's empty actions cell has no explanation; hover implies clickability (`table.tsx:14`); `pl-11` magic number. Add a disabled "Invite member" with reason per PRODUCT.md ("unavailable with a reason").

**2.18 Role dialog.** Disabled primary via `opacity-50`; redundant X with Cancel; error Alert sits above the field, far from the footer button that triggered it (`members-table.tsx:127`). Remove dialog does not name consequences for the actor's own role.

**2.19 Auth polish.** No show/hide password, no forgot-password (even disabled with reason, per PRODUCT.md "unavailable with a reason"), `autoFocus` pops the keyboard on mobile and hides the heading (`auth-form.tsx:68,72`), form-level error alert does not take focus, copy "Pick up your conversations" promises an inbox. Register's "An account with this email already exists" (`auth-form.tsx:46`) is an account-enumeration oracle; acceptable only with rate limiting (verify API).

**2.20 Switcher / topbar.** Switcher name has no `title` when truncated; compact switcher has no tooltip (`workspace-switcher.tsx:14`); logo and switcher still two stacked identity rows; user menu shows no role/workspace. At 375 the bar shows the workspace name above the identical Home h1.

**2.21 Muted text and icons.** `text-fg-disabled` (#9AA1AE, about 2.6:1 on white) is used for pending-step circles (`page.tsx:39`); state is also carried by text, so not color-only, but the glyph fails 3:1. Use `fg-subtle`. `fg-subtle` (#596070) on canvas passes (about 6:1); 11px labels (`text-2xs`) are legibility-poor for the group label and 24px avatar initials.

**2.22 Cookie and focus management.** `crm_last_ws` is written client-side without `Secure` (`app-shell.tsx:20`); low risk (non-secret id, membership re-checked in `app/page.tsx:12-13`). Route changes leave focus on the clicked link; consider moving focus to `#main` or the h1 after navigation.

**2.23 Screenshot hygiene.** `onboarding-1440.png` is actually 1280x720; no screenshots exist for register, 404, error boundary, loading, expanded Coming soon, switcher/user menu open, empty states, or any touch viewport. The e2e overwrites files under `docs/` on every run (`responsive-and-a11y.spec.ts:7-8`), so a failing run changes tracked evidence.

## 3. Automated coverage gap for roadmap item 6

The roadmap's own list (forbidden audit, forbidden activity, not-found, no skeleton or error boundary test) is accurate but incomplete. grep of `e2e/` and `test/` for loading, skeleton, error boundary, "could not be loaded", "No activity", "No entries", `route(` and `errorMessage` returns nothing.

No automated coverage at all:
- Loading: `w/[workspaceId]/loading.tsx`, `settings/loading.tsx` (no `app/loading.tsx` exists).
- Error boundaries: `app/error.tsx`, `w/[workspaceId]/error.tsx`, including the Try again/`reset` path; layout throw `layout.tsx:15`.
- Data-load error states: Members `ErrorState` (`members/page.tsx:26`), Audit `ErrorState` (`audit-log/page.tsx:30`), Audit "Load older" failure (`audit-list.tsx:24,43`).
- Empty states: Home "No activity yet" (`page.tsx:54`), Audit "No entries yet" (`audit-list.tsx:29`).
- Mutation errors: settings save failure and name validation (`workspace-form.tsx:28,33`), onboarding validation and server failure (`create-workspace-form.tsx:23,29`), role dialog server errors such as `last_owner`, `admin_cannot_grant_owner` (`members-table.tsx:48,127`), remove failure.
- Network branch: `client-api.ts:16-18`, `auth-form.tsx:47`, generic register failure `auth-form.tsx:50`.
- `errorMessage` mapping (`client-api.ts:30`) has zero unit tests; `lib/api.ts` (`status 0`) has none.
- Global unknown route `/nope` (only the non-member workspace 404 is tested, `auth-and-shell.spec.ts:151`).
- Responsive logic: drawer auto-close on resize (`app-shell.tsx:23-28`), coarse-pointer sizes, Coming soon at 768/375, Members actions visible at 768.
- Security: `?next=` handling (`auth-and-shell.spec.ts:59` is titled "and back after login" but only asserts the redirect URL).

Covered: forbidden audit, forbidden Home activity, read-only settings, workspace 404, auth field validation and wrong password, duplicate email, role change, remove with confirmation, sole owner, audit paging (weak, see below), axe on shell/auth/onboarding/drawer/palette/role dialog.

Test-quality problems that inflate confidence:
- `permissions-and-members.spec.ts:123-124,129`: `toHaveCount(...).catch(() => {})` and `signIn(...).catch(() => {})` swallow failures.
- `noOverflow` (`responsive-and-a11y.spec.ts:24-42`) exempts any element inside an `overflow-x` ancestor, which is exactly how 2.2 escaped; it also carries debug-style `SCROLLY`/`ANY` strings in the assertion.
- axe never runs with Coming soon expanded, a menu open, an error or empty state, or the 768 Members table with actions.
- One `signUpAndCreate` per test with `workers: 1` makes the suite slow and order-sensitive; not a design issue but it explains why error paths were skipped.

## Resolution status (2026-11-13, after round-2 fixes)

| Finding | Status | Evidence |
|---|---|---|
| Blocker: open redirect via `?next=` | Fixed | `lib/safe-next.ts` rejects `//`, `/\`, control characters, absolute URLs; 17 unit cases plus an e2e test signing in with three hostile `next` values and asserting the origin. Not tested against a real browser's handling of every encoding; the guard is allow-list shaped (`/` then not `/` or `\`). |
| Regression: Members at 768 clipped | Fixed | Name column absorbs shrink; new `noInnerScroll` guard in the responsive test fails when a table needs its own scrollbar; screenshot re-checked. |
| Mobile topbar repeats the workspace name | Fixed | Logo shown instead. |
| API 5xx or network failure shown as "page not found" | Fixed | Server pages use `must()`: 401 redirects, 404 is not-found, anything else reaches the error boundary. Component-level tests cover the boundary; no test forces a real server-side 5xx. |
| Server error text shown verbatim | Fixed | Auth form shows generic text; `errorMessage` limits server messages to 4xx and known codes. |
| No security headers | Partly fixed | CSP limited to `frame-ancestors`, `base-uri`, `form-action`, `object-src`; X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy; tested. **No script-src CSP yet** (needs nonces); API rate limiting not reviewed. |
| Keyboard focus on menus only `bg-hover` | Fixed for menus, partly for the palette | Menu items show the 2px focus outline (e2e asserts it); palette rows use selected background plus a 1px accent ring. |
| Command input 14px on touch; no touch tests | Fixed | 16px on coarse pointers; Pixel 7 emulation tests assert 44px targets and 16px inputs. Emulation is not a real device. |
| Coming soon pinned far below, link-like, lone group label | Fixed | Sits under the nav, quiet text style; group labels only appear when more than one group exists. Still absent from the 768 rail by design. |
| Dangling `aria-describedby`; "Pick up your conversations" copy | Fixed | Field references only elements that exist; copy now "Sign in to continue to your workspace." |
| No Home-specific or list skeletons | Fixed | Home-shaped default, table-shaped for Members and Audit, form-shaped for Settings; markup tests. |
| Test quality (`.catch` swallowing, unasserted "back after login", e2e rewriting docs screenshots, 1280x720 onboarding shot) | Fixed | Assertions made real; screenshots only overwrite the docs set with `UPDATE_SCREENSHOTS=1`; onboarding viewport set. |
| Home offers no live next action | Deferred | Every checklist step depends on unbuilt features; revisit when contacts exist (Phase 2). |
| Auth card width and layout polish; dark mode switch; rail labels | Deferred | Unchanged from round 1 decisions. |

No third independent review has been run; these fixes are verified by the automated suite and by viewing screenshots.
