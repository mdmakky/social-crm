# Web remediation plan: findings F1-F23

Source: `docs/project/review-contacts-requirements.md` (2026-11-13). Planning only; no source changed. Line refs are against the current files (verified by reading). Paths relative to repo root; `W` = `apps/web`, `CV` = `W/app/w/[workspaceId]/contacts`.

Conventions applied: no dead buttons; loading/empty/error states; web talks to the API only through the same-origin proxy (no new endpoint is needed by any default below); docs stay in sync (WP-D); never claim done without `pnpm exec turbo run lint typecheck test` plus `cd apps/web && pnpm exec playwright test`.

## 0. Report vs current code (mismatches)

| Finding | Report says | Code says |
|---|---|---|
| F2 | `<a download>` at ~119 | `contacts-view.tsx:126`. `endpoints.exportContacts` (`packages/contracts/src/crm.ts:189`, `responseType: "text"`) already exists, so `browserApi` can fetch it; no API change. API filename is `contacts.csv` (`apps/api/src/routes/contacts.ts:130`); `export.json` was the browser default for the JSON error body. 413 carries `too_many_rows` with a usable message (line 114); `errorMessage` already surfaces `e.message` for 4xx. |
| F5 | `runPreview` 38-47, radios 130-140, select 149 | `import-wizard.tsx:51-58` (runPreview), radios `:165`, decision select `:179`. Also `Button loading={busy}` already disables Commit while any preview runs, but `setBusy(false)` from the FIRST response re-enables it while a second preview is still in flight, so the race is real. Extra defect: the "skip problem rows" checkbox (`:151`) changes `plan().skipInvalid` but does NOT re-run preview, so the count on the Import button (from `preview`) can disagree with what commit sends. Fold into F5. |
| F10 | select at ~157 | `contacts-view.tsx:160`; `Select` at `components/ui/input.tsx:12-21` (confirmed: `md:hidden` lands on the inner `<select>`, wrapper `div.relative` and chevron stay). |
| F13 | `summaryRef` at 25 | `import-wizard.tsx:31`, used only on the `<div>` at `:145`, never `.focus()`ed. |
| F15 | "Skip to content" 24x16 | Skip link is `W/components/shell/app-shell.tsx:47` (outside Contacts; shell file). Sort buttons `contacts-view.tsx:222`, tag remove `contact-detail.tsx:225`. |
| F19 | add missing sort options | `CONTACT_SORTS = ["name","created","lastActivity"]` (`packages/contracts/src/crm.ts:87`): Lifecycle/Owner/Source/Tags sorting needs a contract + API change. Not web-only. |
| F20 | `apps/web/AGENTS.md` demands Next docs | No `AGENTS.md` or `CLAUDE.md` exists in `apps/web` or repo root (only the project CLAUDE.md). The "read Next docs first" rule cannot be cited from the repo; record as "rule not found in repo". |
| F22 | all note AND task buttons share names | Task buttons already carry the title (`contact-detail.tsx:392,402`: `Delete task: <title>`, `Complete: <title>`). Only the note buttons (`:293,294`) are generic. |
| F12 | add rename/update | `endpoints.updateView` (PATCH, `{name?, config?}`) already exists (`crm.ts:209`). Web-only. |
| F23 | `refreshActivity ~34` | `contact-detail.tsx:40-43`. `dirty` computed at `:116`, only used for the Save button/`Discard`. |
| F3 / F10 / F7 line numbers | approx | F3 `contact-detail.tsx:71-78`; F7 Tags `:233`, Notes `:277`, Tasks `:410,412,413`. |

All other claims (F1, F4, F6, F8, F9, F11, F14, F16, F17, F18, F21) match the code as described.

## 1. Product decisions and API-change flags (propose default, proceed unless overruled)

| # | Item | Needs | Proposed default |
|---|---|---|---|
| P1 | F3 build vs defer related conversations/pipeline panels (D20 unified record not built, `packages/db/src/schema/crm.ts` has no lead/deal fields) | Product | DEFER. Keep the two panels (no dead buttons, they have no controls) but relabel as "Not available yet": titles "Conversations" and "Pipeline records" with copy that states the feature is not built and which phase owns it; remove "will appear here" promises. Record D20 + related-records as deferred requirements in roadmap and known-limitations. Building the lead entity is Phase 2 scope, out of this plan. |
| P2 | F4 | Docs only | Reword claim now; load evidence (multi-tenant, concurrency, HTTP path) is a separate API task (see WP-D, optional). |
| P3 | F19 extra sort keys (lifecycle/owner/source/tags) | API + contracts | NOT in this plan. Web default: derive select value from `sort:dir`, add the six options the contract supports (name asc/desc, created asc/desc, lastActivity asc/desc), show "Custom" when unmatched. Log the other four sorts in known-limitations. |
| P4 | F18 per-stage colour | Schema change (stages have no colour) | Default: stage rendered as dot + plain text (state), tags stay pills. No colour-per-stage. |
| P5 | F16 mailto/tel | Product nicety | Do it on the DETAIL page only (header + Email/Phone fields get adjacent "Email"/"Call" links). Do NOT nest anchors inside the list card (the whole card is one `<Link>`, nested anchors are invalid HTML); mobile list taps go to detail where tap-to-call lives. |
| P6 | F20 | Docs honesty | Documentation only. Do not back-fill "Used" for skills not invoked. Update stale matrix row, add record of the Playwright-MCP responsive check and impeccable critique only if actually run in the final gate (WP-D step 4). |
| P7 | F9 conflict UX | UX | Keep user's form values, list differing fields, offer "Apply my changes on top" and "Discard mine, load latest". |
| P8 | F23 unsaved guard | UX | `beforeunload` guard while `dirty` only (Next app-router link interception is not reliably guardable; document). Back/forward and `replaceState` behaviour documented as known limitation, not changed. Strict-mode double fetch: dev-only, document, no code. |

## 2. Work packages (disjoint file ownership)

Step 0 (single agent, ~10 min, mechanical, before parallel start): split test files so ownership is disjoint.
- Move tests at `W/e2e/contacts.spec.ts` lines 135-222 (edits/concurrency, tags/notes/tasks, related placeholders, delete) verbatim into new `W/e2e/contacts-detail.spec.ts` (owned by WP-B). Leave 17-134 and 223-end (create, duplicate, list, columns, views, roles) in `contacts.spec.ts` (owned by WP-A). Copy the file's imports/helpers header.
- Verify `pnpm exec playwright test e2e/contacts` still green before dispatch.

| WP | Scope | Findings | Owned files (exclusive) | Effort |
|---|---|---|---|---|
| A: List and shared UI | list screen, shared primitives, client | F1, F2, F6, F10, F11, F12, F14, F15 (sort btn, skip link), F18, F19, F23 (sort announce) | `CV/contacts-view.tsx`; `W/lib/client-api.ts`; `W/components/ui/input.tsx`; `W/components/shell/app-shell.tsx`; `W/lib/contacts.ts`; `W/e2e/contacts.spec.ts`; `W/e2e/contacts-responsive.spec.ts`; NEW `W/e2e/contacts-list-states.spec.ts` | 8-10 h |
| B: Contact detail | detail screen | F3 (UI), F7, F9, F15 (tag remove), F16, F21, F22, F23 (unsaved guard) | `CV/[contactId]/contact-detail.tsx`; `W/e2e/contacts-detail.spec.ts` (new, from Step 0); NEW `W/e2e/contacts-detail-a11y.spec.ts` | 8-10 h |
| C: Import and settings | import wizard, settings | F5, F8, F13, F17 | `CV/import/import-wizard.tsx`; `W/app/w/[workspaceId]/settings/contacts/contact-settings.tsx`; `W/e2e/contacts-import-settings.spec.ts` | 5-6 h |
| D: Docs and evidence | documentation, perf wording | F3 (docs), F4, F20, F23 (docs) | `docs/project/roadmap.md`, `known-limitations.md`, `testing-report.md`, `skill-utilization-matrix.md`, `progress.md`, `decisions.md` (only if P1 is recorded as a new decision), `CLAUDE.md` Status line; OPTIONAL API-side `apps/api/test/perf.test.ts` | 3-4 h docs, +4-6 h only if the load-evidence tests are built |

Shared files and single owners (nobody else edits these):
- `W/lib/client-api.ts` (F1) - WP-A. Affects every `browserApi` caller (audit list, members, settings, onboarding, import, detail); B and C get the behaviour for free; no edits needed in their files.
- `W/components/ui/input.tsx` (F10 `wrapperClassName`) - WP-A. Additive prop, no other caller changes. B and C must not touch it.
- `W/components/ui/field.tsx`, `form-controls.tsx`, `badge.tsx`, `button.tsx`, `overlays.tsx`, `states.tsx`, `table.tsx` - nobody changes them; B/C consume as-is (Field already accepts any control; `Dialog` exists for F8/F17). If a change becomes unavoidable, the requester asks WP-A.
- `W/components/shell/app-shell.tsx` (F15 skip link) - WP-A (one-line class change).
- `W/e2e/helpers.ts` - read-only for all; a helper needed by two packages is added by WP-A in Step 0 (candidate: `signOut` already exists; add nothing unless required).

Order and parallelism:
1. Step 0 (10 min).
2. WP-A, WP-B, WP-C start in parallel (no shared files). Within WP-A do `client-api.ts`/`input.tsx` first (F1, F10) since they touch the widest blast radius, then the list file.
3. WP-D docs can run in parallel, but its final "record test counts" edits happen after A-C merge.
4. Final gate (serial, ~1.5-2 h): full `turbo run lint typecheck test`, full Playwright, Playwright MCP responsive pass at 375/768/1440 over list/detail/import/settings, impeccable critique/polish of the touched screens (these satisfy F20's missing practices only if really run, then recorded by WP-D).

## 3. Per-finding detail

Format: severity | files and lines | change | proof | risk.

### Major (WP-A: F1, F2, F6; WP-C: F5; WP-B: F7; WP-D: F3 docs, F4)

**F1 Major, 401 mid-session** (WP-A)
- Files: `W/lib/client-api.ts:4` (no `onUnauthorized`; supported at `packages/api-client/src/index.ts:26,75`); `CV/contacts-view.tsx:70-78` (`load` error keeps `page`), `:122` (header text), `:170` (error alert), `:195` (footer).
- Change: `createApiClient({..., onUnauthorized: () => window.location.assign("/login?next=" + encodeURIComponent(location.pathname + location.search)) })`, guarded with a module-level once-flag and `typeof window`. In `load`, on failure with existing items set `stale=true`: dim panel, header becomes "Showing previous results" (never "match your filters"), footer "Showing previous results; the last search failed", with a Retry button.
- Proof: e2e `contacts-list-states.spec.ts` "401 on search redirects to login with next": seed contacts, `context.clearCookies()`, type in search, `await expect(page).toHaveURL(/\/login\?next=%2Fw%2F.+%2Fcontacts/)`. Second test "failed filter marks results stale": `page.route("**/contacts?*search=*", r => r.fulfill({status:500, json:{error:{code:"internal"}}}))`, assert text "Showing previous results", assert NOT `getByText(/match your filters/)`, Retry button visible. Existing `safe-next.test.ts` already covers `next` sanitising.
- Risk: medium. Global side effect: any 401 (including intentional ones on public pages) navigates away. Auth forms do not use `browserApi` (verified: not in the importer list), so login/register errors are unaffected. Guard against redirect loops on `/login`.

**F2 Major, export downloads error bodies** (WP-A)
- Files: `CV/contacts-view.tsx:116` (`exportHref`), `:126` (`<a href download>`).
- Change: replace the anchor with `<Button onClick={doExport} loading={exporting}>` that calls `browserApi.call(endpoints.exportContacts, {params:{workspaceId}, query})` (query without sort/dir as today), on `ok` builds a `Blob` (`text/csv`) and triggers a download named `contacts.csv` via a temporary object URL (revoke after), on error sets an `exportError` Alert using `errorMessage` (413 shows "Narrow the filters").
- Proof: e2e "export success downloads contacts.csv with header row" (`page.waitForEvent("download")`, filename `contacts.csv`, content starts with `Name,`); "export 413 shows the message and no download" (route fulfils 413 `too_many_rows`, assert alert text "Narrow the filters", assert no download event within 500 ms); "export 401 redirects to login" (covered by F1 wiring).
- Risk: low-medium. Large 10k-row CSV is held in memory (text endpoint); acceptable, note in known-limitations. Existing permission test (role sees Export) must still find a `button` named Export instead of a link: update assertion in `contacts.spec.ts:223+` (WP-A owns).

**F3 Major, placeholders and D20** (WP-B for UI, WP-D for docs; decision P1)
- Files: `contact-detail.tsx:71-78`; `e2e/contacts-detail.spec.ts` (moved from `contacts.spec.ts:196-203`); docs per WP-D.
- Change: reword the two EmptyStates to state they are not built yet (for example title "Conversations are not available yet", description naming the owning phase and that nothing is stored); drop "will appear here" and "once a channel is connected". Keep the "lifecycle stage is separate from any pipeline" sentence (the e2e checks it).
- Proof: update the e2e (rename to "related records are labelled as not available") asserting the new headings and absence of `/will appear here/`; axe via `contacts-responsive.spec.ts` unchanged.
- Risk: low. If the product chooses BUILD instead, this becomes a Phase 2 task (lead table, `listLeadsByContact` endpoint, contracts); out of scope here.

**F4 Major, performance evidence wording** (WP-D)
- Files: `docs/project/roadmap.md:124` (quality-gates paragraph; Phase 2 gate text at line 18 also quotes p95), `docs/project/testing-report.md:35`, `docs/project/known-limitations.md` (new entry).
- Change: reword to "DB and query layer, in-process client, 10k rows, one tenant, sequential 30 samples". List the unmeasured items from the report as open. Do not mark the gate "met" without the qualifier.
- Proof: doc-only; review diff for the qualifier text in both files. OPTIONAL (API, not web): extend `apps/api/test/perf.test.ts` with multi-tenant seed, tags/owners, 20-way concurrency, 10k export, and delete the dead `g0` helper; one HTTP-level run via the web server. Separate ticket, effort 4-6 h.
- Risk: none for docs; the optional load tests may reveal real regressions (that is the point).

**F5 Major, import plan race** (WP-C)
- Files: `import-wizard.tsx:51-58` (`runPreview`), `:60-67` (`commit`), `:165` (radios), `:179` (decision select), `:151` (skip checkbox), `:194` (commit button).
- Change: add `previewSeq` ref; `runPreview` ignores responses with a stale seq and only the latest clears `busy`. Disable radios and decision selects while `busy`. Store the plan JSON used for the shown preview (`previewKey`) and disable Commit until `previewKey === JSON.stringify(plan())`. Re-run preview when `skipInvalid` toggles.
- Proof: e2e in `contacts-import-settings.spec.ts` "rapid decision changes never commit a plan different from the preview": route `previewImport` with a delayed first response (delay 600 ms, then 0 for the second), change two decisions quickly, assert the Import button label matches the second response and equals `created` count in the result step. Add "skip-problem-rows toggle updates the count" (assert button label changes after toggling).
- Risk: medium. The commit button temporarily disabled between change and new preview; acceptable (spinner already shown).

**F6 Major, Load more wrong-filter append** (WP-A)
- Files: `CV/contacts-view.tsx:90-98` (`loadMore`), `:196` (button).
- Change: capture `const mine = seq.current` at start; after await, `if (mine !== seq.current) { setMoreBusy(false); return; }`; disable Load more when `status === "loading"`.
- Proof: e2e "changing a filter while Load more is in flight does not mix rows": seed 30 contacts (helper `seedContacts`), delay the cursor request via `page.route` (600 ms), click Load more, immediately choose a stage filter, assert every visible row matches the filter and the footer total equals header total. Optionally unit-test nothing (no seam without jsdom; `test/*.test.ts` are node-only).
- Risk: low.

**F7 Major, visible labels on detail inputs** (WP-B)
- Files: `contact-detail.tsx:233` (tag Input), `:277` (note Textarea), `:410` (task title), `:412` (due), `:413` (assignee).
- Change: wrap each in `Field` with a visible label whose text equals the accessible name: "Add a tag", "Add a note", "New task" (shown as "Follow-up"), "Due", "Assign to". Remove duplicate `aria-label`s (WCAG 2.5.3 label-in-name). Keep placeholders as examples only. Tag form keeps the inline Add button (align with `items-end`).
- Proof: Playwright a11y test `contacts-detail-a11y.spec.ts` "detail inputs have visible labels": for each field `getByLabel(name)` resolves and `locator("label", {hasText})` is visible; axe at 375/768/1440 (reuse the pattern in `contacts-responsive.spec.ts:23`). Update selectors in `contacts-detail.spec.ts` that use `Due date and time` / `Assignee` / `New task`.
- Risk: low; layout shift in the narrow Tasks column, check at 375 and lg.

### Minor

**F8 Minor, window.confirm for tag delete** (WP-C)
- Files: `contact-settings.tsx:64-69`.
- Change: state `pendingDeleteTag`; render a `Dialog` (pattern of `contact-detail.tsx:95-103`) titled `Delete tag "<name>"?` with the contact count and Cancel/Delete (danger, loading, inline error).
- Proof: update `contacts-import-settings.spec.ts:142` test: remove the dialog handler, click Delete, `getByRole("dialog")` contains count text, confirm, tag gone; add "cancel keeps the tag".
- Risk: low.

**F9 Minor, version conflict discards edits** (WP-B; decision P7)
- Files: `contact-detail.tsx:114` (`conflict`), `:132-137`, `:149-155`, `:64` (`DetailsPanel key={c.version}` remounts and resets the form).
- Change: lift `carry` state to `ContactDetailView`; "Apply my changes on top" calls `onSaved(conflict)` with `carry = form`, the remounted `DetailsPanel` initialises `form` from `carry` and shows it dirty with expectedVersion = latest. Alert lists changed fields (name of each field where `conflict` differs from `initial`). Keep "Load latest" as discard.
- Proof: extend the existing concurrent-edit test (moved to `contacts-detail.spec.ts`): after the conflict, assert the alert lists the remotely changed field, click "Apply my changes on top", assert my value is still in the input and Save succeeds with the new version.
- Risk: medium (key/remount interplay, custom-field values). Keep the diff to the lifted state only.

**F10 Minor, stray chevron** (WP-A)
- Files: `W/components/ui/input.tsx:12-21`, `CV/contacts-view.tsx:160`.
- Change: add optional `wrapperClassName` to `Select` applied to the `div.relative`; in the Sort select pass `wrapperClassName="md:hidden"` and drop `md:hidden` from the select.
- Proof: e2e at 1440: `await expect(page.getByLabel("Sort by")).toBeHidden()` and no visible chevron: assert the Sort wrapper `boundingBox()` is null. Add to `contacts-responsive.spec.ts` (axe cannot catch it).
- Risk: low; additive prop; other Selects unaffected (verify by running the full responsive spec).

**F11 Minor, focus lost in Columns dialog** (WP-A)
- Files: `contacts-view.tsx:310-339` (`ColumnsDialog`).
- Change: after move/hide/show, refocus the same row's action by `data-col`/`data-act` attribute in a `useLayoutEffect` (if the action is disabled at the boundary, focus the opposite arrow); add an `sr-only` `role="status"` text "Lifecycle stage, position 1 of 7" updated on move, "hidden"/"shown" for Hide/Show.
- Proof: e2e in `contacts.spec.ts` (columns test 83): press "Move Lifecycle stage up", assert `document.activeElement` is within the dialog and a status text matching `/position 1 of 7/`; press Hide, assert focus is on a button in the dialog (not the dialog container).
- Risk: low-medium (focus timing with Radix; use `requestAnimationFrame`).

**F12 Minor, saved views delete/rename/update** (WP-A)
- Files: `contacts-view.tsx:286-308` (`ViewsMenu`), `:165` (onDelete), `:204`.
- Change: add "Update view with current filters" and "Rename…" items for the active view (use `endpoints.updateView`, exists) and a confirm `Dialog` for delete (same pattern as F8). Show update/rename only when `current.mine || (current.shared && canManageShared)`.
- Proof: extend `contacts.spec.ts:102` test: rename a view, update columns, delete asks confirmation (Cancel keeps it, Confirm removes it).
- Risk: medium (more state in the file; keep the delete dialog and rename dialog small and local).

**F13 Minor, import error summary** (WP-C)
- Files: `import-wizard.tsx:31` (`summaryRef`), `:35` (focus effect targets heading), `:144-153`.
- Change: in the step-3 effect focus `summaryRef` when `preview.invalid > 0`, else the heading; append column names to messages if the API already provides them (not available: use message text as is); add "Download problem rows" building a client-side CSV (row number + messages) from `preview.errors`.
- Proof: e2e in the import test: after step 3 with invalid rows, `await expect(page.getByRole("alert").filter({hasText: "problems"})).toBeFocused()`; download of `problem-rows.csv` contains the first error row number.
- Risk: low. Without API support the file lists only the first 100 (`preview.truncated`); keep the note.

**F14 Minor, applying view overwrites layout** (WP-A)
- Files: `contacts-view.tsx:108-112` (`applyView`), `:58-62` (`saveColumns`).
- Change: `applyView` calls `setViewColumns(v.config.columns)` only (no localStorage); `onChange` from the Columns dialog still saves to localStorage and clears `viewColumns`. Reset `viewColumns` to null on `set()`-driven un-apply, so personal layout returns.
- Proof: `contacts.spec.ts:102` extended: save custom layout, apply a view with different columns, reload, assert personal layout is back.
- Risk: low-medium: `columns = viewColumns ?? storedColumns` precedence stays.

**F15 Minor, target sizes** (WP-A for sort btn and skip link; WP-B for tag remove)
- Files: `contacts-view.tsx:222` (sort buttons), `app-shell.tsx:47` (skip link), `contact-detail.tsx:225` (tag remove).
- Change: add `min-h-6 min-w-6` and padding (`py-1` on sort buttons; `p-1` plus `size-3.5` icon on tag remove; `px-3 py-2` already on skip link only on focus: add `min-h-6`). Table header height changes slightly; check density.
- Proof: add to `contacts-responsive.spec.ts` (A) and `contacts-detail-a11y.spec.ts` (B): `boundingBox()` of sort buttons, tag Remove and the focused skip link are >= 24x24 px at 1440 (WCAG 2.5.8).
- Risk: low; visual density.

**F16 Minor, mailto/tel** (WP-B; decision P5)
- Files: `contact-detail.tsx:53` (header text).
- Change: render email and phone as `<a href="mailto:…">` / `<a href="tel:…">` (strip spaces for tel), allow wrapping (`break-words`, not `truncate`) in the header; leave `Input` values unchanged.
- Proof: e2e: `getByRole("link", {name: "ana@example.com"})` has `href="mailto:ana@example.com"` and phone link starts with `tel:`; at 375 the header has no horizontal overflow (existing overflow check).
- Risk: low. Email addresses with odd characters: `encodeURI` the href.

**F17 Minor, archive stage warning** (WP-C)
- Files: `contact-settings.tsx:42-46`, `:115`.
- Change: when `s.contactCount > 0` and archiving, open a `Dialog` explaining that archived stages stay on the N existing contacts but cannot be newly assigned; zero-contact stages archive immediately.
- Proof: extend `contacts-import-settings.spec.ts:86`: archive a stage with contacts asks first (dialog text matches `/cannot be newly assigned/`), Cancel leaves it active, confirm archives; zero-contact stage still archives directly.
- Risk: low.

**F18 Minor, lifecycle looks like a tag** (WP-A; decision P4)
- Files: `contacts-view.tsx:255` and `:276` (`<Badge>`); detail header `contact-detail.tsx:57` left unchanged (no tags adjacent).
- Change: render the stage as `<span class="inline-flex items-center gap-1.5 text-sm text-fg"><span class="size-1.5 rounded-full bg-accent" aria-hidden/>{name}</span>`; tags stay pills.
- Proof: add a visual assertion in `contacts-responsive.spec.ts` (computed style: stage element has no `border-radius` pill background) plus refreshed screenshots in `test-results/shots-contacts`; axe at 3 widths.
- Risk: low; screenshot-diffs expected.

**F19 Minor, mobile sort desync** (WP-A; decision P3)
- Files: `contacts-view.tsx:160-164`, `W/lib/contacts.ts:6`.
- Change: options for all six `sort:dir` combinations the contract supports; if `${sort}:${dir}` is not an option, add "Custom order" as selected. Tooltip text on columns without sort support stays as is.
- Proof: e2e at 375: load `?sort=name&dir=desc`, `getByLabel("Sort by")` value is `name:desc`; selecting `created:asc` updates URL and first row.
- Risk: low. Lifecycle/Owner/Source/Tags sort stays a documented gap (needs contracts + API).

**F20 Minor, skill records** (WP-D; decision P6)
- Files: `docs/project/skill-utilization-matrix.md` (header line 3, row 32 "2 Core CRM" Planned/Pending, usage log near line 60), `testing-report.md:38`, `known-limitations.md:54`.
- Change: mark row 32 per the real usage log; update "Last updated" to the current date and phase; record that this independent review ran (and the date) replacing "outstanding" in testing-report and known-limitations; record the gaps honestly (no design-system run, no Playwright-MCP responsive check, no Context7/Next doc lookup, no systematic-debugging record) and note `apps/web/AGENTS.md` does not exist in the repo. Only add "Used" entries for skills really run in the final gate.
- Proof: doc-only; grep that "outstanding" no longer appears for the independent review and that header date changed.
- Risk: none; honesty risk if a skill is claimed without being run.

**F21 Minor, activity refresh resets paging** (WP-B)
- Files: `contact-detail.tsx:40-43` (`refreshActivity`), `:323` (ActivityPanel append).
- Change: `refreshActivity` fetches page 1 and prepends only items whose `id` is not already present, keeping existing `nextCursor`; if the older list is empty, adopt the response as today.
- Proof: e2e in `contacts-detail.spec.ts`: create 25 activity items (via API helper), click "Load older activity", add a note, assert the older items are still present and the new item is first; count rows before/after.
- Risk: low; dedupe by id covers overlap.

**F22 Minor, non-unique names** (WP-B)
- Files: `contact-detail.tsx:293-294`, `:301` (Save/Cancel/Confirm in edit/confirm flow).
- Change: names like `Edit note by Ana on Nov 13, 10:02` / `Delete note by Ana on …` and `Confirm delete note by Ana`; task buttons already unique (see mismatch table).
- Proof: a11y test: with two notes, `getByRole("button", {name: /Edit note by/})` yields 2 elements with distinct names. Existing tests using substring `"Edit note"` still match (Playwright is substring by default); verify.
- Risk: low.

**F23 Minor, misc state notes** (split)
- (a) Unsaved-changes guard (WP-B, `contact-detail.tsx:116`, `DetailsPanel`): `beforeunload` listener while `dirty`; test via `page.on("dialog")` after editing then `page.reload()`.
- (b) Sort announcement (WP-A, `contacts-view.tsx:195`): footer `role="status"` text becomes "Sorted by Name, ascending. Showing N of M" when sorting changes; test asserts the status text after a header click.
- (c) URL/`replaceState`, back button not stepping filters, dev strict-mode double fetch (`first` ref, `contacts-view.tsx:43,81`) are documented only (WP-D known-limitations; P8). No code.
- Risk: low; the `beforeunload` prompt cannot guard in-app navigation.

## 4. Test matrix summary

- New specs: `e2e/contacts-list-states.spec.ts` (WP-A: F1, F2, F6 with `page.route` mocking, same pattern as `states-and-errors.spec.ts:28-36`), `e2e/contacts-detail-a11y.spec.ts` (WP-B: F7, F15, F22 plus axe at 375/768/1440).
- Extended: `contacts.spec.ts` (F10, F11, F12, F14, F19), `contacts-detail.spec.ts` (F3, F9, F16, F21, F23a), `contacts-import-settings.spec.ts` (F5, F8, F13, F17), `contacts-responsive.spec.ts` (F10 visibility, F15 sizes, F18).
- Unit (`W/test/*.test.ts`, node-only vitest, no DOM): only pure helpers if extracted (for example a `sortOptionFor(sort, dir)` in `lib/contacts.ts` for F19). Do not add a jsdom setup for this plan.
- Docs-only findings (F4, F20, F23c): verified by diff review, no test.
- Existing tests that will need edits: `contacts.spec.ts:223+` (Export is now a button), `contacts-import-settings.spec.ts:142` (confirm handler removed), detail tests using old labels (`Due date and time`, `Assignee`).

## 5. Effort and schedule (rough, one agent each, parallel)

| WP | Hours | Notes |
|---|---|---|
| Step 0 spec split | 0.2 | Mechanical |
| A | 8-10 | F1 (2), F2 (1.5), F6 (0.5), F10 (0.5), F11 (1.5), F12 (2), F14 (0.5), F15 (0.5), F18 (0.5), F19 (0.5), tests included |
| B | 8-10 | F3 (0.5), F7 (2), F9 (2.5), F15 (0.3), F16 (0.5), F21 (1), F22 (0.5), F23a (0.5), tests included |
| C | 5-6 | F5 (2.5), F8 (1), F13 (1.5), F17 (1) |
| D | 3-4 | docs; +4-6 optional load tests (API side) |
| Final gate | 1.5-2 | Serial: full checks, Playwright MCP 3-width pass, impeccable critique, doc counts |

Wall clock with 3 parallel agents: about 10-12 h plus gate; serial single agent about 28 h.

## 6. Done criteria

- `pnpm exec turbo run lint typecheck test` and `cd apps/web && pnpm exec playwright test` green, with the new test names above present.
- Axe clean at 375/768/1440 on list, detail, import, settings.
- Docs in sync (roadmap, progress, known-limitations, testing-report, skill matrix) and the CLAUDE.md Status line updated; no doc says "outstanding" for the independent review, none claims the perf gate without the qualifier.
- Deferred and recorded: D20 unified record and related-records (P1), four extra sort keys (P3), per-stage colours (P4), HTTP-level and load perf evidence (F4 optional).

## WP-B result

Fixed in `contact-detail.tsx`: F3 (panels relabelled "not available yet", Phase 4 inbox and Phase 2 leads named, no fake data), F7 (visible `Field` labels: Add a tag, Add a note, New task, Due, Assign to), F9 (edits kept on conflict; alert lists fields the other person changed; "Apply my changes on top" re-applies only the fields I changed over the latest version; "Discard mine, load latest"), F15 (tag remove 24x24), F16 (mailto/tel in header plus "Send email"/"Call" beside the fields, detail page only), F21 (refresh prepends unseen items, keeps older pages and cursor), F22 (note Edit/Delete/Confirm names include author, time and first 30 characters of the note), F23a (`beforeunload` while the form is dirty).

Not changed: note Save/Cancel keep their names (one editor open at a time; an existing test uses exact "Save"). In-app navigation is not guarded (P8).

Tests: `e2e/contacts-wpb-detail.spec.ts` (new); `e2e/contacts-detail.spec.ts` edited minimally (related-panel headings, "Due" label).

## WP-A result

Branch `worktree-agent-aa07138a330ae2f05`. Fixed: F1, F2, F6, F10, F11, F12, F14, F15 (sort buttons, skip link), F18, F19, F23b. Defaults applied: P3 (six supported sort orders plus "Custom order"), P4 (stage is dot plus text).
- F1: `browserApi` redirects to `/login?next=...` on any 401 (once, never from `/login`); failed refresh with rows shows "Showing previous results" and Retry.
- F2: Export is a button that fetches the CSV, downloads `contacts.csv`, and shows the server message on error (e.g. 413).
- F12: Update, Rename and confirmed Delete act on the last applied or saved view (`baseView`), so Update works after the filters changed. F14: applying a view overlays columns without touching the saved personal layout.
- Tests: `e2e/contacts-wpa-states.spec.ts` (F1, F2, F6, F11, F19, F23b), `e2e/contacts-wpa-layout.spec.ts` (F10, F15, F18, axe at 375/768/1440), extended `e2e/contacts.spec.ts` (F11, F12, F14; Export is now a button; view menu items use `.first()` because manage items repeat the view name). Full apps/web Playwright: 63 passed.
- Not done: extra sort keys (P3, needs API); Retry for a failed Load more (error alert only).
