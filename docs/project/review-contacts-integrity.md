# Contacts slice: data-integrity and correctness review

Reviewer: independent, read-only on the repo. Date: 2026-11-13. Scope: contacts, tags, stages, custom fields, notes, tasks, activities, saved views, CSV import/export, migrations 0004-0007.
Method: code read, `psql` inspection of the live `crm` DB (pg_policies, grants, forced RLS), existing tests re-run, and throwaway scripts under `/tmp/claude-1000/ci-review/` (r1..r5.mts, run with `CRM_DB_NAME=crm_scratch ./node_modules/.bin/tsx <file>` from `apps/api`; they go through the real Hono app and RLS role). Line numbers refer to the files as read; `routes/contacts.ts` was edited by someone else mid-review, so lines may have drifted by a few.

Existing suites re-run: `apps/api` contacts, contacts-config, contacts-list, imports = 4 files, 78 tests pass; `packages/core` contacts = 25 pass. A `pg` deprecation warning ("client.query() when the client is already executing a query") appears in every run: `toSummaries` (`crm-service.ts:57`) fires three queries with `Promise.all` on one transaction client. It works today and breaks on pg 9 (minor).

## Summary

| Severity | Count |
|---|---|
| blocker | 0 |
| major | 8 |
| minor | 17 |

No blocker: nothing loses committed data silently and tenant isolation held. The majors are soft-delete leaks, two unguarded races, a lossy export/import round trip, a bulk import that holds one transaction for 41 s, and a rollback test that proves less than the roadmap claims.

---

## Major findings

### M1. A soft-deleted contact can still be mutated through note and task endpoints
- Repro: `/tmp/claude-1000/ci-review/r1.mts`. Create contact + note + task, DELETE the contact, then PATCH/DELETE the note and PATCH/DELETE the task. Output: `PATCH note on deleted contact OK`, `DELETE note ... OK`, `PATCH task ... OK {"status":"done"}`, `DELETE task OK`. DB afterwards: activities `...,note.deleted,task.completed` appended to the deleted contact, and `last_activity_at` is later than `deleted_at`.
- Files: `apps/api/src/routes/contacts.ts` `noteWrite` (~336-341, 344) and `taskWrite` (~413-428) look up the note/task but never call `loadContact`. GET/POST variants do check it.
- Impact: writes and timeline entries on a contact the user believes is gone; any future "restore" or admin view shows post-delete activity. Violates "deleted contact invisible/immutable everywhere".
- Fix: in both helpers join or call `loadContact(tx, workspaceId, note.contactId)` and return 404 when null. Add a test that asserts 404 for update/delete of notes and tasks after contact delete.

### M2. Tag `contactCount` includes soft-deleted contacts
- Repro: r1.mts. Tag a contact, delete the contact: `tag count after delete 1 (expect 0)`. Stage counts were correct (`[0,0,0,0,0]`).
- File: `apps/api/src/routes/crm-config.ts:91` counts `contact_tags` without joining `contacts.deleted_at IS NULL`.
- Impact: tag settings page shows counts for contacts nobody can see; the same bug will leak into any later dashboard that reuses the pattern.
- Fix: `JOIN contacts c ON c.workspace_id=ct.workspace_id AND c.id=ct.contact_id AND c.deleted_at IS NULL` in the count query. Extend the "soft delete hides everywhere" test to cover tag counts, notes, tasks, activity, export.

### M3. Duplicate detection is check-then-insert with no constraint; simultaneous creates all succeed
- Repro: r3.mts, 10 parallel `createContact` with the same email and no `allowDuplicate`: `race creates ok: 7 of 10; dup contacts in DB: 7`.
- Files: `contacts.ts:144-147` (create), `:203-206` (PATCH), `imports.ts:132-174` (import vs concurrent manual create); schema `crm.ts:53-54` only has non-unique indexes.
- Impact: the feature's promise (warn about duplicates) fails exactly when two agents, an import and a web-form webhook, or a double click hit at once. Duplicates are expensive to clean (no merge exists).
- Fix (cheap): take `pg_advisory_xact_lock(hashtextextended(workspace_id || ':' || email_normalized, 0))` (and one for phone) in the create/PATCH/import-create transaction before `findDuplicates`. Alternative: partial unique index on `(workspace_id, email_normalized) WHERE deleted_at IS NULL` plus an explicit "allow duplicate" path via a second column. Add a concurrency test mirroring M3's script.

### M4. Archiving the last two active lifecycle stages concurrently can leave zero active stages
- Repro: r5.mts, 15 runs, each archives the final two active stages in parallel: `0 active stages in 1 of 15 runs`. (A single run in r4 happened to serialise correctly.)
- File: `crm-config.ts:55-66`. The "last stage" guard reads all stages without a lock and both transactions pass it.
- Impact: contact create then fails for everyone with "Choose an active lifecycle stage" and import errors "no active lifecycle stage", until an admin restores one. Same read-then-write pattern allows duplicate positions on concurrent stage create (`:39-41`), and two admins hitting `GET /lifecycle-stages` on a legacy workspace can both run `ensureDefaultStages` (`crm-service.ts:9-14`, no unique constraint) and create 10 stages.
- Fix: `SELECT ... FROM workspaces WHERE id=$1 FOR UPDATE` (or `pg_advisory_xact_lock(workspace)`) at the start of every stage mutation and in `ensureDefaultStages`; add `UNIQUE (workspace_id, position)` deferrable or recompute positions in the same lock.

### M5. Tag delete cascades silently: no timeline entry, no version/last-activity change, stale "tag added" history
- Repro: r3.mts. Contact with a tag, admin deletes the tag: activities `6 -> 6`, version unchanged (`2`), contact no longer shows the tag.
- File: `crm-config.ts:134-137` writes only an audit row; `contact_tags` rows vanish via `ON DELETE CASCADE` (`crm.ts:86`).
- Impact: the contact timeline says "tag X added" with no removal; a stale open edit form still holds the removed tag with the old `version`; "last activity" sorting does not move. The review brief asked for "tag delete cascade correctness and activity text": the cascade itself is correct (row removal, no orphan) but nothing records it per contact.
- Fix: before deleting, `INSERT INTO activities SELECT ... 'contact.tag_removed' ... FROM contact_tags JOIN contacts WHERE tag_id=$1 AND deleted_at IS NULL` with `data.tag = name, via = 'tag_deleted'`, and bump `last_activity_at`/`version` for those rows in one statement. Same applies to adding/removing tags and notes: none of them bump `version` (see m5).

### M6. Export/import is not a lossless round trip, despite the roadmap and the test name
Repro: r5.mts exports one contact (archived stage "Gone", tag "A, B", multiselect option "a;b") then previews the same CSV:
`roundtrip preview errors [{"row":1,"messages":["Unknown lifecycle stage \"Gone\"","Choose only listed options"]}]`. Raw export line: `Round Trip,rt@x.io,'+1 (555) 010-4444,Co,Gone,<owner email>,"A, B",referral,...,a;b; c,false,2026-02-03`.
Causes and files:
- Archived stage name is exported but import only accepts active stages (`imports.ts:30`, `contacts.ts:115-118`). A contact in an archived stage cannot be re-imported (and the whole row is invalid).
- Tags are joined with `; ` on export (`contacts.ts:118`) and split on `, ; |` on import (`core/contacts.ts:206`): tag "A, B" becomes two tags. Tag names allow all three delimiters (`contracts/crm.ts:26`).
- Multiselect values containing `;` `,` `|` break the same way (`core/contacts.ts:216`, export `:118`). Option "a;b" fails import validation.
- Export drops archived custom fields (`customDefs` default filter, `contacts.ts:114`) so their stored values are lost on a round trip; export ignores the requested `sort` (`:107` always `name, id`).
- Export lower-cases emails (stored normalized) and keeps phone raw: fine, but formatting of the original email is not recoverable.
- The test `imports.test.ts:185-192` asserts only "1 duplicate, 0 errors, willCreate 0" for a vanilla contact, so none of the above is covered.
Fix: restrict tag names and select options to exclude `,;|` (contract refine) or use a single unambiguous delimiter plus quoting on both sides; accept archived stage names on import (map to the stage, keep archived) or export a stage id column; export archived fields; strengthen the round-trip test to delete the contact, re-import, and deep-compare every column including stage, owner, tags, custom, source.

### M7. A 5,000-row commit runs as one 41-second transaction
- Repro: r5.mts: `5000-row commit ms 41121` (50 distinct tags, local Postgres, no network). About 8 ms per row from ~5 sequential statements per row (`imports.ts:143-174`, `attachTags` one insert per tag).
- Impact: holds the `import_jobs` row lock, a connection, and RLS context for the whole time; any proxy/serverless timeout (30 s typical) turns into `import_failed` (500) after the work is done and rolled back, retry repeats it. Also blocks concurrent import of the same job (by design) and leaves 5,000 sequential `lastActivityAt` updates.
- Fix: batch inserts (multi-row `insert ... returning` for contacts, one activity insert, one `contact_tags` insert after resolving tag ids once), keep the single transaction. Target < 3 s for 5,000 rows. Add a timing assertion test with a generous bound.
- Related (minor, m11): 5 MB limit is counted in UTF-16 code units (`core/contacts.ts:96`, `contracts/crm.ts:142`), so a CJK/emoji file can be ~15 MB of body before rejection.

### M8. The "atomic rollback" test proves much less than the roadmap claims
Evidence the implementation IS atomic: r4.mts injected failure at row 3 of a file that (a) updates an existing contact, (b) creates two new tags, (c) creates contacts. Before/after counts: contacts 15/15, tags 4/4, activities 20/20, audit 35/35, existing contact version 3/3, job status still `uploaded`. So rollback of contacts, tags, activities, audit, version bump and job status holds.
But `imports.test.ts:137-150`:
- CSV has no tags, so `tags.every(t => t.name !== "never-committed")` (line 147) is vacuous: that name appears nowhere in the file.
- No assertion on activities, audit log, update-path rows, or `import_jobs.status` (only indirectly via the retry creating 4).
- The failure point is a test hook (`afterRow`), which cannot detect a statement that autocommits outside the tx, but a real DB error mid-file (constraint) is untested.
Fix: seed the CSV with new tags and an update-existing row; assert tag list, `listActivity` of the updated contact, `auditLog` (no `data.imported`), contact version, and job status through a direct DB check (or expose it). Also test a genuine DB failure (e.g. name 1 MB or NUL byte, see m1).

---

## Minor findings

m1. NUL byte makes the API return 500. `createContact {name:"a\u0000b"}` and `listContacts?search=a%00b` both: `ERR 500 http_500` (r2.mts). Postgres rejects `\u0000` in text. Fix: zod `.refine(s => !s.includes("\u0000"))` in `trimmed`/`nullableText`/search/note/CSV cells (and import: a NUL in a CSV cell fails the whole commit with a generic 500 after rolling back). Lone UTF-16 surrogates are silently replaced by U+FFFD (`name:"a\ud800b"` stored as `a?b`); reject or normalise.

m2. Tampered cursor can 500. `contacts.ts:75-78` casts `cur.k` with `::timestamptz` for created/lastActivity sorts. r2.mts: keys `garbage`, ``, `9999-99-99` => 500 (SQLSTATE 22007); `infinity`/`-infinity` are accepted. The existing test only covers a non-base64 cursor (`contacts-list.test.ts:82`). Fix: validate `k` with `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$` in `dec()` (and for name sort, a length cap). The cursor is also not bound to the filter: reusing a cursor after changing `search`/filters returns a page from that position instead of an error (r2.mts "cursor for filter-change reuse OK"). Harmless but undocumented; embed a hash of the filter set in the cursor if "cursor does not match" is intended.

m3. Keyset ordering is correct (sound, see below), but pages are not snapshot-stable: a contact whose `last_activity_at` is bumped while someone pages `lastActivity desc` jumps to the top and is neither duplicated nor shown again in the remaining pages; one that is edited into a later position can be skipped. Inherent to keyset paging; add a line to known-limitations and, for the UI, a "list changed, refresh" hint using `total`.

m4. Search does no accent folding. `search "emile"` finds 0 for "Émile Zola"; `"émile"` and `"ÉMILE"` find 1 (r2.mts). `lower()` follows the DB collation (`en_US.utf8` here); under a `C` locale non-ASCII would not case-fold at all. Fix: `unaccent` extension + `lower(unaccent(...))` in the indexed expressions, or document. Phone heuristic (`contacts.ts:24`): digits count only when the whole query looks like a phone number and has >= 3 digits; "+1" or "55" never match phones; "555" matches every US number in a region (acceptable).

m5. Version semantics are narrower than "version bump on every writer". Verified (r3.mts): `version` bumps only on PATCH and soft delete, import update. Tag add/remove, notes, tasks, owner-less activity bumps leave `version` at 1 while `last_activity_at` moves. No lost update is possible because PATCH does not write tags/notes, but the summary's `tags` can change under a client holding the same `version`, so a client cannot use `version` as an ETag for what it displays. Decide and document: either bump on tag changes (recommended, tags are in `ContactSummary`) or state that version covers scalar fields + custom + stage + owner only. Soft delete double-submit bumps version twice and writes two audit rows (`contacts.ts:250-253`, no `deleted_at IS NULL` in the UPDATE).

m6. PATCH silently drops display-only phone changes. `phone "555 010 7777"` then PATCH `"(555) 010-7777"`: returns OK, stored value unchanged (r3.mts) because the comparison uses `phone_normalized` (`contacts.ts:201`). Fix: compare raw `d.phone` to `cur.phone` too.

m7. Phone/email normalization limits (r3.mts, DB `phone_normalized`): `0044 20 7946 0958` -> `00442079460958`, `+44 20 7946 0958` -> `+442079460958` (same number, not detected as duplicate); `020 7946 0958` stays national; extensions (`ext 12`, `x5`) are rejected with the "7 to 15 digits" message (ok but the message is misleading); `user@localhost` rejected; quoted local parts accepted; plus-addressing is kept verbatim (`a+tag@x.io` is a different contact than `a@x.io`; probably intended). Fix: map leading `00` to `+`; strip `x\d+`/`ext` into a separate field or document. Email unicode: `Ünï@Example.COM` lower-cases to `ünï@example.com` (no IDNA/NFC normalisation, so composed vs decomposed forms differ).

m8. Date filters (`contacts.ts:37-44`): `Date.parse` accepts junk like `createdFrom=1` (-> year 2001) and parses zone-less datetimes in the server's local zone; date-only values are UTC days, ignoring the viewer's time zone (the UI hint says "whole day"); sub-millisecond precision is truncated so a range `.123456Z..123457Z` is empty for a row at `.123456Z` (r2.mts). `createdTo` is exclusive for datetimes but inclusive-by-day for plain dates. Fix: require ISO 8601 with offset or `YYYY-MM-DD`, pass the string to Postgres, and document the semantics.

m9. Custom field rules (r4.mts):
- Number precision: `9007199254740993` is stored as `9007199254740992` (JSON number, no safe-integer check, `core/contacts.ts:58`); `1e21` accepted. Use `Number.isSafeInteger` or store decimals as strings.
- Removing a select option leaves old values stored (`"gold"` stays after the option is removed) and then every PATCH of any other custom field on that contact fails with 422 on the stale value (`contacts.ts:228`). Fix: only validate keys present in the request, or ignore unchanged stored values.
- Adding `required` after contacts exist: PATCH of `name` works but PATCH of any custom field on a contact missing the new required value fails 422 for the unrelated field. Same fix.
- Archived field keeps values (sound), key cannot be reused (`409 key_taken`, sound but undocumented), type cannot be changed (the contract has no `type`, sound). Archived fields also vanish from export (see M6). `custom_field_definitions.required` is an `integer` 0/1 instead of boolean (`crm.ts:103`); harmless but inconsistent.

m10. Import numbering and mapping details. `parseCsv` reports ragged rows as "Row N" with spreadsheet numbering (`core/contacts.ts:114`, header is row 1; r4.mts: data row 2 reported as `Row 3`), while preview/commit use 1-based data rows (`imports.ts:35`, first data row = 1). `skip_empty_lines: true` and quoted embedded newlines make both numbers diverge from file line numbers. Fix: pick one convention (data row, header excluded) everywhere and label it "Row N (not counting the header)". Unquoted quote characters fail the whole file (`Bob "B" Smith` -> `Invalid Opening Quote`); consider `relax_quotes: true`. Delimiter detection only inspects the first physical line (`:99-100`) so a quoted header containing commas in a semicolon file can mis-detect (the tested `"Name, Full",Email` case works).

m11. Import bypasses create-time limits. A CSV with a 500-char name, 300-char company is committed (`name len stored: 500, company 300`, r4.mts) while `createContact` caps them at 120 (`contracts/crm.ts:62-65`). Names with embedded `\r\n` are stored as-is. Fix: run `CreateContactBody` field schemas inside `buildContactFromRow`.

m12. Import update path (`imports.ts:150-163`): (a) custom values are silently not merged when validation of the merged object fails (`check.ok ? ... : cur.custom`, line 159), so an update can "succeed" and lose the row's custom data with no error; (b) mapped `lifecycle_stage` and `source` are ignored on update; (c) update always bumps version and writes `contact.updated {fields:["from import"]}` even if nothing changed; (d) phone/email on the existing contact are overwritten without a duplicate check against third contacts; (e) a row matching two different existing contacts (email -> A, phone -> B) updates only A (`:45`). Fix: report these in the preview, or fail the row.

m13. Preview and commit can disagree in one case (r5.mts). Existing contact X has phone P. Row 1 = `email A + phone P` (duplicate of X, action skip), row 2 = `email A` only with decision `update`. Preview: `willUpdate 1, willSkip 1`; commit: `created 1, skipped 1, updated 0`. Cause: row 2 is classed "duplicate of row 1 in file" (`imports.ts:48-53`), target comes from `createdByKey` which is empty because row 1 was skipped, so line 165's `else` branch creates a new contact (`:146-147`, `:150`). Fix: when `pr.action === "update"` and no target, resolve the original row's existing target (store the first row's `existing.id` in `seen`) or treat as skip, and make preview use the same resolver.

m14. Contact timeline gaps ("every state change recorded exactly once"; r3.mts). Recorded exactly once: create, scalar field update (one `contact.updated` with the field list), owner change, stage change, tag add/remove (idempotent via `ON CONFLICT`), note add/delete, task create/complete/reopen, import create/update. Not recorded: note edit, task edit (title, due, assignee), task delete, contact delete (audit only), custom-field-only changes list `custom fields` without which keys, tag delete cascade (M5), saved-view changes (not contact state). Activities are append-only for the app role (verified: `permission denied for table activities`, grants are INSERT, SELECT only). `last_activity_at` is bumped by `recordActivity` using the API server's JS clock (`crm-service.ts:33`) while `created_at` uses the DB clock; multiple app servers with clock skew can make `last_activity_at` go backwards. Use `now()` in SQL. Ordering by `uuidv7()` is generated by Postgres (`DEFAULT uuidv7()`), monotonic per backend, so API-server skew does not affect timeline order; across backends it is commit-time approximate (acceptable).

m15. Tag create/rename and add-by-name race to a 500. Six parallel `addContactTag {name:"NewRaceTag"}`: statuses `500,500,500,200,500,500` (r3.mts); the unique `tags_ws_name` violation is not handled (`contacts.ts:272-274`, `crm-config.ts:103-105`). Also `tags_ws_name` is case-sensitive while all lookups use `lower(name)`, so two writers racing "VIP"/"vip" both insert. Fix: `INSERT ... ON CONFLICT (workspace_id, name) DO NOTHING RETURNING`, then re-select, and make the unique index `(workspace_id, lower(name))`. The same unhandled-unique pattern exists for custom field key create (`crm-config.ts:155`).

m16. Restoring an archived stage skips the name-uniqueness check: with an active "Temp" and an archived "Temp", restore returns 200 and the workspace has two active stages with the same name (r4.mts); import then picks the first by name (`core/contacts.ts:193`). Stage rules otherwise hold: archived stage cannot be assigned on create/PATCH (400 `invalid_stage`), contacts keep it, PATCH of other fields still works, counts exclude deleted contacts.

m17. Migrations and docs.
- `0006_contacts_last_activity_not_null.sql` runs `SET NOT NULL` with no backfill. On a database that already has contacts written under 0004 with `last_activity_at IS NULL`, it fails and blocks every later migration. Add `UPDATE contacts SET last_activity_at = COALESCE(last_activity_at, created_at) WHERE last_activity_at IS NULL;` first. (The dev DB has none, so it passed.)
- `pg_trgm` is created only in `packages/db/sql/001_roles_and_probe.sql` (bootstrap), not in the drizzle migrations; `0004` fails on a database that was not bootstrapped with that script. Add `CREATE EXTENSION IF NOT EXISTS pg_trgm;` to 0004 or document the order.
- Roadmap says "30 typed endpoints"; `crmEndpoints` defines 35 (`contracts/crm.ts:170-212`). The roadmap is honest that the independent review had not run; this file is that review, so acceptance should stay open until M1-M8 are triaged.
- `import_jobs.csv` keeps the full uploaded file (PII) indefinitely and includes rows of contacts later deleted; the roadmap lists "no retention job", but a delete-contact request cannot purge it.

---

## Verified sound (with evidence)

- RLS: live DB shows all 10 CRM tables with `relrowsecurity` and `relforcerowsecurity` true (`psql ... pg_class`). Policies per table cover exactly the needed commands (activities INSERT,SELECT; contact_tags DELETE,INSERT,SELECT; contacts INSERT,SELECT,UPDATE; custom_field_definitions, import_jobs, lifecycle_stages, notes INSERT,SELECT,UPDATE; saved_views and tags and tasks all four) = 32 policies, matching 32 `DROP`/`CREATE POLICY` in `0007`, all wrapping helpers in `(SELECT ...)`. Table grants to `crm_app` match (no DELETE on contacts, activities INSERT+SELECT only; UPDATE on activities fails with `permission denied`). Saved-view policies restrict shared views to owner/admin and private views to their owner.
- Keyset pagination: ties on 12 identical `created_at`, `last_activity_at` and `name` page without loss or duplication in all 6 sort/dir combinations (r2.mts `ties ... 12 12`). Microsecond keys via `to_char(... US)` order correctly (`us3, us2` for rows 1 us apart). Cursor binds sort and dir; cross-sort cursor returns 400. Row-value comparison and `ORDER BY` use the same collation. Inserts between pages do not duplicate (existing test), deletes simply disappear.
- Optimistic concurrency: stale `expectedVersion` returns 409 with the current record; 4 simultaneous PATCH with the same version give exactly 1 success and 3 conflicts (r3.mts); no-op PATCH leaves version unchanged. The UPDATE is guarded by `AND version = expectedVersion`.
- Soft delete (the parts that work): get, list, search, stage counts, export, duplicate detection, activity/notes/tasks listing and tag add/remove return 404 or exclude the contact; re-creating the same email after delete succeeds (r1.mts).
- Import atomicity (see M8 evidence), double commit (`FOR UPDATE` plus status check; existing concurrent test passes), in-file duplicate merge into the created row, BOM, semicolon and tab delimiters, CRLF with quoted embedded newline, duplicate headers, `=`-prefixed cells (formula guard unwrapped on re-import) all committed correctly (r4.mts). Tags created during import roll back with the transaction.
- Lifecycle: last active stage cannot be archived sequentially; archived stage blocks new assignments; contacts in it keep working.
- Custom field date validity (`2026-02-30` rejected by `validDate`), url scheme check, multiselect de-duplication, unknown keys rejected.
- Search: LIKE wildcards escaped (`%`, `_` literal), SQL metacharacters inert, whitespace-only search ignored; `tagIds` capped at 10 and uuid-validated; combining filters with search works.
- Activity ordering uses DB-generated `uuidv7`; app role cannot update or delete activities.

## Test-quality notes (beyond M8)
- `contacts.test.ts:217` is titled "does not bump the version or add activity" but only asserts version.
- `contacts.test.ts:222` "soft delete hides the contact everywhere" checks get, list and duplicates only. It would have caught M1/M2 had it covered notes, tasks, tag counts, stage counts, export, activity.
- `contacts.test.ts:211` "exactly one wins" never asserts the final stored value equals the winner's.
- `contacts-list.test.ts:138` uses the UTC calendar day of `new Date()` (flaky within seconds of 00:00 UTC) and `:127,:138` depend on earlier tests in the same file (order-coupled counts: "Late Arrival" makes 21 and 61).
- `contacts-list.test.ts:57-59` compares DB name order to JS `<`; it passes only because all seeded names are ASCII, title-case. A mixed-case or accented name would expose a collation difference between JS and `en_US.utf8`.
- Pagination tests never include ties, NULLs (none exist: sort keys are NOT NULL), tampered cursors beyond non-base64, or a bump of `last_activity_at` between pages.
- `perf.test.ts`: all 10,000 rows share one lifecycle stage and have distinct timestamps, no tags/notes/activities, `afterAll` deletes the rows with the admin connection; p95 over 30 runs is effectively the max. The worst case (a search that matches most rows, e.g. `person`, with `count(*)` plus sort) and queries under 3 characters (no trigram use) are not measured. Measured in-process with no network, as the file header says.
- No test covers: concurrent create duplicates (M3), concurrent stage archive (M4), tag cascade timeline (M5), full round trip (M6), import update with invalid stored custom values (m12), NUL/invalid input (m1).

## Suggested order of work
1. M1, M2 (small, mechanical), then M3/M4 with advisory locks and tests.
2. M6 contract changes (tag/option delimiter rules) before more data accumulates in production-like workspaces.
3. M7 batching, then M8 test hardening, then the minors (m1, m2, m6, m10-m13 first).
