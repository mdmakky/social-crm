# Security assessment (`/cso`)

## 1. Scope and commit
- Repository `main` at `9282e1e`, clean working tree, no code modified during the assessment.
- Mode: `/cso` daily static run, default scope, 600 s budget (the helper accepts 120 to 600 s). No agents were launched.
- Snapshot: 302 sanitised inputs captured, 75 in-scope inputs unread (binary assets), 4 non-executable exclusions (`.env.example`, `CLAUDE.md`, agent configuration). Git history: newest 39 of 73 commits retained.

## 2. Tool setup and execution status
- Trusted gstack checkout `~/.claude/skills/gstack` (MIT, commit `b9bbc31`, on upstream `main`). The launcher is built locally by the documented `scripts/build-cso.sh` (reads no network, writes only to `bin/`). The first build failed on the missing static C library; after `glibc-static` was installed the build succeeded (`result=ok launcher=yes`).
- `gstack-cso doctor`: static snapshot **ready**; Docker isolation ready; application preparation **missing** (the helper's Node profile expects `package-lock.json`; this repository uses pnpm). So comprehensive (runtime reproduction) mode is unavailable.
- **`/cso` did run**: run `1794570331449-c72b016e1bfdc334`, status `finished`, completeness **partial**. Findings were submitted and persisted through the helper; the helper's saved report is `report.md` in its run store.
- Not run: gitleaks, osv, semgrep, trivy, zizmor, schemathesis scanners (no runtime profile; time box).
- Independent challenge: no independent reviewer was available (agents were not allowed); each finding carries the labelled sequential challenge.

## 3. Executive summary
No confirmed P0 or P1 vulnerability was found in the sampled code. The assessment is **partial and static**, so this is not a clean bill of health. Most tenant-isolation, authorization, import and audit evidence comes from earlier independent reviews and the test suite, not from this run. Counts: **P0 0, P1 0, P2 5, P3 2.** Two were accepted by the helper as supported findings; five are hardening observations recorded in the same run but not accepted as supported (the helper's daily report holds only findings with an attacker-reachable entry point).

## 4. Findings
### P0
None.
### P1
None confirmed. See the readiness decision for the items that become P1 gates before external users.

### P2
1. **Client-controlled `X-Forwarded-For` keys the password-reset throttles** (confirmed in code; exploitability depends on deployment). `apps/api/src/app.ts:52` `clientIp`. Attack: send reset requests or token attempts with a rotating header to exceed per-IP limits; `audit_log.ip` is also attacker-chosen. Per-email limit and single-use high-entropy tokens still hold. Affects reset throttling and audit IP accuracy. Fix: trust the header only from a configured proxy hop, validate it as an IP. *Submitted as a supported finding.*
2. **System path chosen by a transaction setting** (suspected, defense in depth). `apps/api/src/events.ts:26` `withSystem`, `packages/db/drizzle/0013_notif_rls.sql:4` `app_is_system()`. Any session running as the app role can set `app.system='dispatcher'`; no injection or code-execution path to do so was found. Impact if one appeared: read `domain_events` and insert notifications for members of the workspace in context (still not cross-tenant). Fix: give the dispatcher its own database login role and grant the system policies only to it. *Observation, not accepted as supported.*
3. **`audit_log` inserts are not bound to the acting user** (policy confirmed; no HTTP path). `packages/db/drizzle/0008_rls_backing_matrix.sql:11`. With SQL access a member could append entries that name another actor; rows stay immutable. Fix: require `actor_user_id = app_user_id()` or NULL for system. *Observation.*
4. **Registration does not require a verified email** (config confirmed; latent). `apps/api/src/auth.ts:17`. No invite-by-email endpoint exists yet, so nothing is exploitable today; once invitations exist an attacker who registered a victim's address first would receive the invited access. **Becomes a P1 gate before external users.** Fix: require email verification and bind invites to verified identities. *Observation.*
5. **`memberships_select` keeps a workspace-context branch** (known, documented). `packages/db/drizzle/0002_tenancy_rls.sql:29`. Mitigated: the API proves membership before it sets the workspace context; a future bug could expose a workspace's member list only. All other tables deny a forged context (`packages/db/test/rls-matrix.test.ts`). *Observation.*

### P3
6. **No rate limit on authenticated CRM routes outside imports** (confirmed). `apps/api/src/app.ts`. A member can send unlimited list, search and write requests (1 MB body and 100-row page caps exist). Fine for owner-only use; add per-user limits before external users. Better Auth's own limiter in production was not verified. *Submitted as a supported finding.*
7. **Content-Security-Policy has no script or default source** (confirmed). `apps/web/next.config.ts:20`. No XSS sink was located in the readable files, so no exploit; nothing would contain one if introduced. Fix: `script-src 'self'` with nonces, `default-src 'self'`. *Observation.*

## 5. Verified and unverified areas
Verified in this run (source read through the launcher): `app.ts` (origin check for mutating requests, body limits, `onError`, reset throttles and redirect allow-list), `auth.ts` (30-day sliding sessions, bearer plus cookie, reset token lifetime and session revocation on reset), `server.ts` (secret length check, production fails closed without a mail provider), `events.ts` and notification policies (per-user notification reads, system-only event reads, append-only guards), search route (workspace and role scoped), RLS migrations 0002, 0008, 0013, security headers.

Supported by earlier evidence, not by this run (reviews and tests, listed in `docs/project/contacts-acceptance-report.md`): tenant isolation tests on every CRM table, role boundaries in the database (13 mutation-checked RLS tests), CSV import and export hardening (ReDoS, byte limits, NUL, formula guard, rate limits, atomic commit), request body limits, error logging without SQL parameters, deleted-contact guards.

**Not verified:** secrets scan; dependency advisories; CI/CD; infrastructure and hosting (undecided); Meta webhook signature and replay handling, token storage (the code does not exist yet); SSRF and outbound requests beyond the sampled files; XSS sinks in web components; cookie `Secure`/`SameSite` flags in a production configuration; mobile token storage and session handling (`apps/mobile` sources were outside the retained snapshot inventory and the runtime was never verified); runtime reproduction of any finding.

## 6. External-user readiness decision
**BLOCKED** for external businesses and non-owner users. Not because a P0 or P1 was confirmed, but because the assessment is partial and these preconditions are unmet:
- Email verification and verified invitations (P2 now, P1 gate once invitations exist).
- Trusted client-IP handling and per-user rate limits.
- Separate database role for the system path, and `audit_log` actor binding.
- A complete assessment: scanners (secrets, dependencies), a comprehensive run with runtime reproduction, and review of Meta webhook and token-storage code once written.
- Production mail provider, hosting decision, and verified mobile token storage.
- Meta App Review and Business Verification conditions.

**Owner-only Meta Development-mode work is not blocked** by any P2 or P3 item above.
