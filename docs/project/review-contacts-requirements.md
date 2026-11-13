# Independent review: Contacts slice (requirements, accessibility, UX)

Reviewer: independent, read-only. Date 2026-11-13. Evidence: code reading, live dev instance (web :3300, API :8788, demo workspace) driven with throwaway Playwright scripts at 375/768/1440, docs and tests. I did not re-run the full test suites; test claims below come from reading the test files. Paths are relative to the repo root.

Verdict: the slice is substantially real (API, isolation, import, settings, list/detail all work and are well tested at API level). No blocker. Seven major findings, mostly in error handling, stale-state races, and over-reading of the performance evidence.

## 1. Requirement table

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Default columns in order: Contact (name + email/phone), Lifecycle stage, Owner, Tags, Source, Last activity, Created | MET | Live table headers at 768/1440: Contact, Lifecycle stage, Owner, Tags, Source, Last activity, Created. `lib/contacts.ts` DEFAULT_COLUMNS. |
| 2 | Column visibility, ordering, saved views | PARTIAL | Show/hide/reorder dialog and save/apply/delete views work (`contacts-view.tsx` 316-340, e2e contacts.spec.ts:83,102). No view rename or update-in-place; Columns hidden below md; layout is per-device localStorage; applying a view overwrites it (F14). Only 3 of 7 columns sortable. |
| 3 | Clean, information-dense default table | PARTIAL | Visually clean (list-1440 screenshot). Density good. Defects: stray chevron on desktop (F10), "Unassigned"/"None" repeated in every row, lifecycle badge and tag badges look alike (F18). |
| 4 | Mobile list/card layout, not a shrunken table | MET | Separate `<ul>` cards at <md (`ContactCard`), verified live at 375, no overflow. Caveats: tablet 768 still uses the table, scrolls in a region (known limitation); cards drop Source/Created; mobile sort has 3 options only (F19). |
| 5 | Default lifecycle stages New, Engaged, Qualified, Customer, Inactive | MET | Live stage select and settings list; API test "five default lifecycle stages in order". |
| 6 | Stages workspace-configurable (rename, reorder, add, archive) | MET | Settings page + contacts-config.test.ts (last-stage guard, duplicate names, archived stage keeps contacts) + e2e. Gap: archive has no confirmation or impact text (F17). |
| 7 | Lifecycle stage separate from pipeline stage | MET | Own table `lifecycle_stages`, schema comment, UI copy "separate from any pipeline". No pipeline exists yet, so separation is design-only. |
| 8 | One unified CRM record for lead/opportunity (D20), optional deal fields preserved | NOT MET (deferred) | No lead/opportunity entity, no deal fields in `packages/db/src/schema/crm.ts`. Only a static placeholder (F3). Slice scope may legitimately defer it, but the requirement list includes it. |
| 9 | Contact detail: profile/contact info, owner+lifecycle, custom fields, tags, notes, activity timeline, tasks | MET | Live detail at 375/1440: headings Details, Tags, Notes, Activity, Tasks. Timeline newest first with cursor. |
| 10 | Related conversations; related pipeline records | NOT MET (placeholder) | Static EmptyStates (`contact-detail.tsx` 71-78). Honest copy, but cannot ever show data. e2e only asserts the placeholder text. |
| 11 | Implementation order (model, isolation/permissions, API, list/search/filters/pagination, detail, tags/notes/timeline, CSV import/export + duplicates) | MET | All layers exist and are tested; roadmap order matches. |
| 12 | CSV import with preview, mapping, validation, duplicate resolution before commit | MET | Wizard steps 1-4, per-row and global duplicate decisions, invalid-row skip, atomic commit (API tests). Defects: F5 (race), F13 (error summary). |
| 13 | Workspace isolation tests on every contact operation | MET | contacts.test.ts: read/change/delete/tag/note/task/view, lists, stages/tags/owner cross-use, export (line 61), import cross-workspace. |
| 14 | Permission boundaries for agents/viewers/admins/owners | MET | API role-matrix tests (viewers, agents, admins/owners, note/task ownership) + e2e permissions-in-UI per role. |
| 15 | Pagination/filter/search tests | MET | contacts-list.test.ts: every sort paged exactly once, cursor mismatch, concurrent inserts, wildcards, SQL metacharacters, filters combined. e2e covers one Load more. |
| 16 | Duplicate detection and import rollback tests | MET | Duplicate tests (email/phone, cross-workspace); import all-or-nothing with injected failure; double commit race. |
| 17 | API client compatible with the mobile app | MET (API level) | Bearer path test "mobile compatibility" and shared `@crm/api-client`. No mobile screen consumes it; never run on a device (testing-report says so). |
| 18 | Responsive UI | MET | No overflow at 3 widths (verified live); touch-target e2e. |
| 19 | Loading/empty/error/success states | PARTIAL | loading.tsx for list and detail, empty/filtered-empty/error states exist. 401, export failure and stale-after-error are wrong (F1, F2). |
| 20 | Skills used, with honest records | PARTIAL | Usage log is candid, but the matrix table is stale and several required practices were not done (F20). |
| 21 | Perf: list p95 < 300 ms, search p95 < 500 ms on 10k | PARTIAL | Test is valid for what it measures; claim is broader than the evidence (F4). |

Tally: MET 14, PARTIAL 5 (rows 2, 3, 19, 20, 21), NOT MET 2 (rows 8, 10). Row 17 counted MET with caveat.

## 2. Findings (severity, repro, files, impact, fix)

### Major

**F1. 401 mid-session leaves a lie on screen and no way out.** 
Repro: open /contacts, delete the session cookie (or let it expire), type "ana" in search. Result (screenshot /tmp/claude-1000/rv/401.png): red banner "Your session has ended. Sign in again to continue." with no link or redirect; the full unfiltered 16-row list remains; header reads "16 contacts match your filters"; footer "Showing 16 of 16". Mutations (save, tag, note) behave the same. 
Files: `apps/web/lib/client-api.ts:4` never passes `onUnauthorized` (supported at `packages/api-client/src/index.ts:75`); `contacts-view.tsx` 52-59 and 138-141 (error with items keeps stale items and the "match your filters" text). 
Impact: user believes the filter ran; edits lost without a path to recover. 
Fix: wire `onUnauthorized` in `browserApi` to navigate to `/login?next=<current>`; on a failed filter load, mark the list as stale (dim and label "Showing previous results") and do not print "match your filters".

**F2. Export link downloads error bodies as a file.** 
Repro: signed out (or a result >10,000 rows, `EXPORT_LIMIT` in `apps/api/src/routes/contacts.ts:11`, or 403) and click Export. Playwright observed a download named `export.json` containing `{"error":{"code":"unauthenticated"}}`; the page shows nothing. 
Files: `contacts-view.tsx:~119` (`<a href download>`), API returns JSON 401/413. 
Impact: user gets a junk file; the 413 "Narrow the filters" message is never seen. 
Fix: fetch the export with `browserApi`/`fetch`, check `res.ok`, then save the blob; show `errorMessage` otherwise. Add a e2e with a mocked 413.

**F3. Related conversations and pipeline records are inert placeholders; D20 unified record absent.** 
Files: `contact-detail.tsx:71-78`, `packages/db/src/schema/crm.ts` (no lead/deal columns), e2e contacts.spec.ts:196 asserts only the placeholder. 
Impact: two listed detail sections and the D20 requirement cannot be demonstrated. Copy "Leads and opportunities for this contact will appear here" promises a feature with no backing model. 
Fix: either build the lead entity and the read endpoint (contact id filter) now, or record both as explicit deferred requirements in roadmap/known-limitations with the owning phase, and drop "appear here" wording until then.

**F4. Performance evidence is valid but narrower than the claim.** 
`apps/api/test/perf.test.ts` is genuine (10,000 rows inserted, 30 timed runs after warm-up, p95 asserted, deep page 200). It does not cover: the HTTP/Next.js path (in-process client, no network, no SSR, no JSON over the wire); concurrency (sequential runs only); 30 samples make "p95" the 29th value; contacts have no tags, owners, notes, or activities (`toSummaries` tag/owner aggregation is trivially cheap); one tenant only, so RLS plus workspace index selectivity with many tenants is untested; single stage and 3 sources; filters by tag/owner and sort by created/other keys untested; short or no-match search terms; cold cache; 100k rows; export of 10k rows (an `inArray` of 10,000 ids); the per-request `count(*)` total. Also `g0` helper is dead code. 
Impact: roadmap.md:124 and testing-report.md:35 state the gate as met without these qualifiers. 
Fix: reword the claim ("DB and query layer, single client, 10k rows, one tenant"); add multi-tenant seed, tags/owners, a 20-way concurrent run, and one HTTP-level run through the web server (Lighthouse or k6) before calling the gate passed.

**F5. Import review can commit a plan different from the one shown.** 
Repro: in step 3 with several duplicates, change two "Decision for row N" selects quickly (or click radios). Each triggers `runPreview` with no sequence guard and the controls are not disabled while `busy` (`import-wizard.tsx` 38-47 for the call, 130-140 radios, 149 select). Responses can return out of order, and `setPreview` shows counts for an older plan, while `commit()` sends the latest `rowDecisions`. 
Impact: the "Import N contacts" button label can disagree with what will be written; the review step is the one safety net. 
Fix: sequence-guard `runPreview` (ignore stale responses), disable decision controls while busy, and make the commit button disabled until the preview matches the current plan (store the plan hash with the preview).

**F6. Load more can append rows for the wrong filter.** 
Repro: scroll to Load more on a large list, click it, then change a filter before the response returns. `loadMore` (`contacts-view.tsx` 80-88) has no `seq` check and merges into `page` with `[...p.items, ...res.data.items]` of the old query, on top of the new filtered list. 
Impact: rows that do not match the filter, wrong total. 
Fix: capture `seq.current` at start and drop the response when it changed; also disable filters or cancel via AbortController during loadMore.

**F7. Visible labels missing on detail-page inputs (WCAG 3.3.2, 2.5.3 risk).** 
Live DOM: Add a tag (aria-label + placeholder only), note textarea (placeholder "Write a note about this contact", aria-label "Add a note"), New task, "Due date and time" (native `mm/dd/yyyy --:--` with no visible text), Assignee select (no visible label). Placeholders disappear on typing; the date field shows no purpose to sighted users, and aria-labels differ from placeholder text. 
Files: `contact-detail.tsx` TagsPanel ~197-215, NotesPanel, TasksPanel ~380-420. 
Fix: use `Field` with visible labels (or visually clear "Due" and "Assign to" text), make accessible name equal visible text.

### Minor

**F8. Window.confirm for tag delete.** `settings/contacts/contact-settings.tsx:65`. Native dialog is unstyled, blocked by some embedded webviews, inconsistent with the Dialog used for contact delete, and e2e must special-case it. Fix: use the existing `Dialog` pattern with the contact count in the body.

**F9. Version conflict discards the user's edits.** `contact-detail.tsx` conflict Alert: "Load latest" replaces the form; no diff or "keep my values". Fix: on conflict keep the form dirty, show which fields changed remotely, offer "Apply my changes on top".

**F10. Stray chevron on desktop.** The mobile-only Sort select (`contacts-view.tsx:~157`) is `md:hidden` on the `<select>`, but `Select` (`components/ui/input.tsx:14-18`) wraps it in a `div.relative` with an absolutely positioned ChevronDown that stays visible (wrapper width 0). Visible in list-1440 and 401.png next to Views, a dead-looking control that the axe test cannot catch. Fix: put the hiding class on the wrapper (add `wrapperClassName` prop).

**F11. Focus lost in Columns dialog.** Repro: open Columns, press "Move Lifecycle stage up" (activeElement becomes BODY because that row's Up button is now disabled), press Hide (focus becomes the dialog container). No announcement of new position ("Lifecycle stage, position 1 of 7"). Fix: keep focus on the moved row's same action (or the opposite arrow), add a polite live region.

**F12. Saved view delete has no confirm and is discoverable only after the view is active; no rename/update.** `ViewsMenu` 296-316. Fix: add "Update view" and "Rename", confirm delete.

**F13. Import error summary is not focused or linked.** `summaryRef` is declared (`import-wizard.tsx:25`) and never used to move focus; `role="alert"` alone is announced once. Errors list rows as text (no "download problem rows"), limited to 100. Step 3 focus goes to the "Review" heading, not the summary. Fix: focus the summary when `invalid>0`, offer a CSV of failing rows, list column names in each message.

**F14. Applying a saved view overwrites the personal column layout.** `applyView` calls `saveColumns` (`contacts-view.tsx` 108-112), writing localStorage. The user's own layout is lost when they preview a shared view. Fix: keep view columns in `viewColumns` state only.

**F15. Touch/pointer target sizes.** Live at 1440: table sort buttons 61x16, 85x16; "Remove tag" 16x16; "Skip to content" 24x16. Below WCAG 2.2 SC 2.5.8 (24 px) except where spacing exemption applies; tag remove is the clear failure on desktop pointers. Fix: padding to 24 px minimum.

**F16. Email and phone are plain text.** No `mailto:` / `tel:` links on detail (0 found) or cards. On mobile, tap-to-call is the first thing agents expect. Header truncates phone at 375 (detail375.png). Fix: link and wrap.

**F17. Archiving a stage with contacts gives no warning.** Settings shows "12 contacts" yet Archive acts immediately. Fix: confirm text explaining archived stages stay on existing contacts but cannot be newly assigned.

**F18. Lifecycle badge looks like a tag badge.** Both neutral grey pills in the table and cards, so stage (a state) is not scannable against tags. Fix: tone per stage with text kept (not color-only) or place stage as plain text with a dot.

**F19. Mobile sort select is limited and can desync.** Options: Latest activity, Newest, Name A to Z. A URL `?sort=name&dir=desc` (reachable on desktop and shared) shows "Latest activity" selected while sorting differently. Lifecycle, Owner, Source, Tags columns are not sortable at all (`SORT_FOR_COLUMN`). Fix: add missing options, derive from `sort:dir` including desc variants.

**F20. Skill record gaps (honesty check).** The "Usage log" and Contacts slice section are candid (impeccable not re-invoked, independent review failed and is not counted, cso/security-review not run). But: the matrix table row "2 Core CRM" still says Planned/Pending and the header says "Last updated: Phase 0", against policy 2 (update in the same commit); ui-ux-pro-max was invoked for 4 searches only (no design-system run, no exploration of several visual options as the global workflow requires, no impeccable critique/polish); the global rule "verify responsive with Playwright MCP" is not recorded (only @playwright/test is); `apps/web/AGENTS.md` demands reading Next.js docs in node_modules before coding, and no Context7/Next doc lookup is logged for this slice; systematic-debugging is not recorded despite the RLS performance bug diagnosis. This review is the first independent pass; testing-report.md:38 and known-limitations.md:54 say it was outstanding.

**F21. Activity refresh resets paging.** `refreshActivity` (`contact-detail.tsx:~34`) replaces the list with page 1 after any mutation; older pages the user had loaded disappear and the scroll jumps. Fix: prepend new items only.

**F22. Non-unique accessible names.** Every note has "Edit note" / "Delete note" (28 px) and task buttons likewise; screen-reader users cannot tell which. Fix: include note author/time in the name.

**F23. Misc state notes.** URL state uses `replaceState` only, so browser Back does not step through filters and external URL changes are ignored (acceptable, but undocumented). No unsaved-changes guard on the Details form (`dirty` is computed, never used to warn). Dev strict mode double-fetches on mount (`first` ref). `Table` header sort changes are not announced; only "Showing N of M" in a `role=status` updates (this part is good).

## 3. What genuinely works

- Workspace isolation is strong: RLS plus composite FKs, 404 not 403 for cross-tenant, a test for each operation, including export and import.
- Cursor pagination is correct for every sort (paged exactly once, inserts between pages tested); total independent of page size; LIKE wildcards and SQL metacharacters tested; 66 ms p95 measurement is real for its scope; RLS per-row cost was found and fixed by measurement.
- Import is a sound pipeline: preview with no writes, per-row duplicate decisions, in-file duplicates, formula-injection guard both directions, atomic rollback proven with injected failure, double-commit race, export-to-reimport round trip.
- Optimistic concurrency (two simultaneous edits, one wins), no-op update does not bump version, activity recorded.
- Accessibility basics are above average: `aria-sort` on sortable headers, labelled and focusable scroll region (`tabindex=0`, labelled), skip link, `role=status` result count, inline tag removal reachable by keyboard, dialog titles and descriptions, dialog focus entry, 16px-input and 44px touch checks on mobile, axe at 3 widths on every screen.
- Mobile cards are purpose-built (name, contact, last activity, stage, tags, owner) with no horizontal overflow at 375.
- Copy is specific and calm ("Nothing is saved until the last step", honest placeholder copy); empty, filtered-empty and error states have actions.
- e2e tests assert real behaviour (about 140 expectations across the three contacts specs, include concurrent edit detection, duplicate deliberate-create, role matrices); not vacuous. Exceptions: the "honest about not being available" test asserts a placeholder.

## 4. Requirement areas with no (or thin) automated coverage

- 401 mid-session, 5xx and network loss on the contacts list/detail (states-and-errors.spec.ts covers members/audit/workspace only).
- Export download behaviour in the browser (only link visibility per role); 413 path.
- Load more error and race; filter race (request supersession) in the UI.
- Import wizard error branches: upload 413/422 from server, preview failure, commit failure, double-click commit, out-of-order previews.
- Applying a saved view with a different column set overwriting local layout; column dialog keyboard/focus.
- Keyboard-only traversal of list, detail, wizard; screen reader behaviour (testing-report lists it as not tested).
- Contact delete restore, unsaved-changes guard, custom field types in import mapping (API-covered, not UI).
- Related conversations/pipeline records and D20 (nothing to test).
- Mobile app consuming the client (contract only).
- Performance: HTTP path, concurrency, multi-tenant, 100k (see F4).

## 5. Priority order to fix

1. F1 (401 handling), F2 (export errors), F5 and F6 (races), F7 (labels).
2. F4 wording now; real load evidence before the Phase 2 gate is declared.
3. F3: decide build or explicit deferral of conversations, pipeline records and D20.
4. Minor items F8-F23, starting with F10 (visible defect) and F13 (import error summary).

Counts: blocker 0, major 7, minor 16.
