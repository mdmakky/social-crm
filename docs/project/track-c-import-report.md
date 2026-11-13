# Track C: CSV import integrity and performance report

Date: 2026-11-13. Code under test: `apps/api/src/routes/imports.ts` at commit 92a17ca (batched implementation). No source file was changed.
Environment: Node 24, Postgres 18 in Docker (127.0.0.1:5436), own database `crm_import`, requests via `app.request` (in process, no socket).
The machine was shared with other agents: load average 13-22 on 12 cores during the runs, so timings are noisy (see run-to-run spread).

## Commands
```
CRM_DB_NAME=crm_import bash scripts/db-create.sh crm_import
cd apps/api
CRM_DB_NAME=crm_import pnpm exec vitest run test/imports-integrity.test.ts
BENCH_OUT=/tmp/bench.out IMPORT_BENCH=1 CRM_DB_NAME=crm_import pnpm exec vitest run test/imports-bench.test.ts
```
The benchmark is opt-in (`IMPORT_BENCH=1`); without it the file skips. Results are appended to `$BENCH_OUT` because vitest swallowed console output here.

## 1. Real mid-batch database failure (`test/imports-integrity.test.ts`, 4 tests, all pass)
Failures are raised by PostgreSQL itself through temporary BEFORE INSERT triggers (SECURITY DEFINER helper functions) created via the superuser connection. Triggers and functions are dropped in `finally`/`afterAll` (verified: 0 `poison%` triggers left).
Each scenario uses a fresh workspace with 1 existing contact and a 1,101-row file (1 update of the existing contact + 1,100 new rows = 3 insert batches; 2 tags per row = 2,200 links = 2 link batches).
- contact_tags insert fails in the second link batch (contacts, update, activities, new tags all already written): 500 `import_failed`.
- activities insert fails in the second activity batch (contacts and update already written): 500 `import_failed`.
- audit_log insert (last statement) fails: 500 `import_failed`.

After each failure: counts of contacts, tags, contact_tags, activities, audit_log and the existing contact (version, company, name) equal the snapshot taken before; import_jobs is `uploaded` with the CSV retained; no backend is `idle in transaction`; no advisory lock is held (pg_locks); the same job then commits successfully (created 1100, updated 1, version +1, 2,201 contact_tags) once the trigger is gone. A different workspace commits fine afterwards.
Result: no bug found. Rollback is complete and the lock and connection are released.

## 2. Performance, 5,000 rows, 50 tags (`test/imports-bench.test.ts`)
File: 259,753 bytes; 5,000 rows = 500 updates of pre-existing contacts, 4,300 new, 200 in-file duplicates (the plan counts them as updates: updated 700); 3 tags per row from 50 distinct tags (50 tags created). Fresh workspace per run; 500 existing contacts were seeded first (not timed).

| run | upload ms | preview ms | commit ms | total ms | RSS before / after / peak MB |
|---|---|---|---|---|---|
| final 1 | 71 | 174 | 4,741 | 4,986 | 262 / 275 / 275 |
| final 2 | 152 | 353 | 11,074 | 11,579 | 277 / 277 / 280 |
| final 3 | 109 | 202 | 4,413 | 4,724 | 278 / 288 / 288 |

Two earlier full runs (same code, same load noise) gave commit 6,496 / 3,806 / 3,524 ms and 7,310 / 3,914 / 4,211 ms. Overall commit range 3.5 to 11.1 s, typically 4 to 5 s.
Comparison with the pre-batching implementation (41,121 ms for the 5,000-row commit with 50 tags): about 4 s typical (roughly 9x faster) and 11.1 s in the worst run (3.7x faster). Caveat: the old figure came from a different run, load and file mix, so the ratio is indicative only. RSS grew 0 to 25 MB; this is the whole test process (API, test client, pg pools), not only the import.
During the commit only 1 `crm_app` backend was active (sampled every 100 ms): one commit holds one connection.

### Update-heavy case (finding)
Updates are applied one UPDATE statement per contact (a loop in imports.ts, not batched). A file of 5,000 rows that all update existing contacts took 16.7 s in one run and 26.9 s in another; creating the same 5,000 contacts took 7.1 s / 10.6 s in the same runs. The batching win applies to inserts; update-heavy files cost about 3-5 ms per row. Not a correctness bug, but it makes the 20 s lock_timeout reachable.

### Concurrent commit in the same workspace
- Two 5,000-row files, same workspace, committed concurrently: both succeeded, the later one waited on the advisory lock (finish times 9.0 s / 14.7 s, 4.4 s / 9.2 s, 3.4 s / 19.0 s, 3.4 s / 36.1 s across runs; wide spread, see load note).
- FINDING: while a 5,000-update commit was running (26.9 s), a 1-row commit queued behind it in the same workspace failed after 21.7 s with 409 `import_busy` (`SET LOCAL lock_timeout = '20s'`, imports.ts:222). In an earlier run the same scenario succeeded because the big commit took only 16.7 s. So "the second commit waits, does not fail" holds only while the first takes under 20 s; update-heavy files or a slow host turn it into a 409 the client must retry. The job stays `uploaded`, so a retry works. Expected: wait, or a clear retry hint; actual: 409 after 20 s (documented behaviour, but 20 s is short for 5,000-row updates).
- A sequential control (two files back to back, one workspace) showed unexplained spread (5.3 s / 5.3 s in one run, 8.7 s / 29.4 s in another) at load average 14-22. Cannot be attributed to the import code from this data; rerun on an idle machine.

## 3. Pool behaviour
12 concurrent commits (12 workspaces, 1,500 rows each), pool max 10: all 12 succeeded in about 3.9-4.5 s. `/v1/me` polled during the run: p50 7-88 ms, max 2.7-3.2 s (only 6 samples, the batch is short), 5-8 active `crm_app` backends sampled. Other routes stay responsive, but the roughly 3 s maximum shows requests queue behind commits once the 10 connections are saturated. Sampling is coarse (100 ms).

## Limitations
- In-process `app.request`: no real socket or HTTP body parsing cost.
- Noisy shared host; numbers are not a stable benchmark. Postgres in Docker on the same machine.
- Triggers are database-wide, so the integrity test must own its database and must not run in parallel with other files on `crm_import`.
- Rate limits were raised to 10,000 in the test; default limits (10 commits per workspace per 10 min) were not exercised.
