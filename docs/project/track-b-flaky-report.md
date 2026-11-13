# Track B: intermittent contacts-list.test.ts suite failure

## Verdict

Reproduced: 9 of 10 full-turbo runs failed. Root cause is NOT connection exhaustion. It is the vitest default `hookTimeout` (10 000 ms) expiring in `contacts-list.test.ts` `beforeAll` under CPU contention. After the timeout vitest runs `afterAll`, which calls `h.close()` (`db.$client.end()`), while the `beforeAll` body is still running. Its next query hits an ended pool.

## Evidence

Full error cause, captured in all 9 failing runs (the original "cause text not captured"):

```
ERROR [Better Auth]: INTERNAL_SERVER_ERROR DrizzleQueryError: Failed query: select ... from "session" where "session"."token" = $1
  cause: Error: Cannot use a pool after calling end on the pool   (pg-pool/index.js:45)
[APIError: Failed to get session] { code: 'FAILED_TO_GET_SESSION' }
FAIL test/contacts-list.test.ts [ test/contacts-list.test.ts ]
Error: Hook timed out in 10000ms.   (test/contacts-list.test.ts:24:1, the beforeAll)
Failed Suites 1;  21 tests skipped
```

- The suite shows `10 031-10 365 ms` in every failing run, i.e. exactly the hook timeout.
- `beforeAll` is slow by design: bootstrap, 2 sign-ups (password hashing, CPU bound) and 60 sequential `createContact` calls, each going through session lookup. It passes alone in a few seconds but exceeds 10 s when lint, typecheck, 11 test files and other host load share 12 cores (host load average was 12-24 during the runs).
- Connections were never close to the limit: `max_connections=100`, `superuser_reserved_connections=3`. Sampled every 0.1 s across all runs: server-wide max 37-44, max on `crm_flake` 27-29. No `53300`, `too many clients`, `ECONNRESET`, `57P01` or `terminating connection` in any log (0 matches in 10 runs).

## Pools per test file (static count)

Each `bootstrap()` = 1 `pg.Pool` (max 10, `packages/db/src/index.ts:9`) + 1 `pg.Client` admin. Files: contacts, imports, perf, contacts-config, contacts-list = 1 each; imports-hardening = 3; auth, contract, password-reset, workspaces create their own pool and client; pgboss has its own. Vitest runs files in parallel (default `fileParallelism`, workers about CPU count). Theoretical worst case about 11 files x 11 = 121 > 100, but observed peak was 29 on this DB because pools open lazily and queries are mostly sequential. This is a latent risk, not the cause here.

## Repro commands

Setup: `CRM_DB_NAME=crm_flake bash scripts/db-create.sh crm_flake`.

```
CRM_DB_NAME=crm_flake pnpm exec turbo run lint typecheck test --env-mode=loose --force
```

Results over 10 consecutive runs (pg_stat_activity polled every 0.1 s):

| run | result | max total conns | max crm_flake | failure |
|---|---|---|---|---|
| 1 | FAIL | 38 | 29 | contacts-list hook timeout |
| 2 | FAIL | 38 | 27 | contacts-list hook timeout |
| 3 | FAIL | 37 | 28 | contacts-list hook timeout |
| 4 | FAIL | 43 | 28 | contacts-list hook timeout + perf p95 < 300 ms |
| 5 | FAIL | 38 | 27 | contacts-list hook timeout |
| 6 | pass | 40 | 28 | none |
| 7 | FAIL | 44 | 28 | contacts-list hook timeout + perf p95 < 300 ms |
| 8 | FAIL | 40 | 29 | contacts-list hook timeout |
| 9 | FAIL | 38 | 27 | contacts-list hook timeout |
| 10 | FAIL | 40 | 29 | contacts-list hook timeout |

The higher failure rate here than the original single occurrence is explained by `--force` (no turbo cache, so lint and typecheck really execute) plus other agents loading the same host.

Secondary finding: `perf.test.ts > 10,000 contacts > list (default sort) p95 < 300 ms` also failed in 2 of 10 runs under the same CPU load. A latency assertion is inherently load sensitive. It is a separate flake of the same class.

## Fix validation

Temporary `apps/api/vitest.config.ts` (removed afterwards, not committed):

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { hookTimeout: 60000 } });
```

Same turbo command, 5 runs: 5 of 5 exit 0, API 156/156 passed, 0 hook timeouts, 0 "pool ended" errors (host load average 15-21 during these runs).

Note: `turbo run ... -- --hookTimeout=60000` does not work, turbo forwards the flag to lint and tsc too.

## Recommended fix (not applied; needs a vitest config in apps/api, outside the files I may touch for the fix)

1. Add `apps/api/vitest.config.ts` with `test: { hookTimeout: 60000, testTimeout: 30000 }`. Validated above.
2. Optional hardening: make the heavy `beforeAll` in contacts-list cheaper (insert the 60 contacts via the admin client in one SQL statement instead of 60 HTTP calls).
3. Optional: `poolOptions`/`maxWorkers` cap (e.g. `maxWorkers: 4`) and `createDb(url, { max })` for tests, to remove the latent 100-connection risk. Not the cause here and not tested.
4. `perf.test.ts` p95 assertion: skip under `CI`/loaded runs or widen the budget; run perf in its own task.
5. Harness: `close()` could await in-flight work; not needed once the timeout is raised.

## Unresolved

- Did not stress connection exhaustion deliberately (not the observed cause).
- Original failure was seen once on a shared DB `crm`; assumed same mechanism (identical error chain and suite), not proven for that run.
- Host was shared with other agents, so absolute timings are noisy.
