# Free-tier hosting setup

**Status: the DATABASE side is VERIFIED on a real Neon project (2026-11-14); nothing else is deployed.** Render, Vercel and the GitHub workflows are untested. Everything marked UNVERIFIED was not confirmed against the provider's current docs or a real run.

## Verified on real Neon (free plan, PG 18.7, aws-ap-southeast-1)
- Project created without a card through the Vercel Marketplace: `vercel integration add neon --billing-plan free_v3 --name social-crm-db --no-connect --no-env-pull` (the owner's Neon organisation was managed by Vercel, so `neonctl projects create` was refused: `organization is managed by Vercel`). `neonctl projects get` shows `pg_version 18`, plan `free_v3`.
- `scripts/db-bootstrap-roles.mjs`: roles, `pg_trgm`, grants OK. Two findings fixed in the script: (1) `ALTER DEFAULT PRIVILEGES FOR ROLE crm_migrator` needs `GRANT crm_migrator TO CURRENT_USER WITH SET TRUE` first (the Neon owner is not a member of roles it creates); (2) the owner cannot `ALTER ROLE` a role it created, so a re-run now skips a role whose password already works. Re-run is idempotent (all steps `ok`).
- All four roles log in, none is superuser or bypasses RLS. `pnpm --filter @crm/db migrate` as `crm_migrator`: 21 migrations; `uuidv7()` works; 126 policies; 36 tables with forced RLS; the 4 tables without RLS are the Better Auth tables (same as the local database). The app role cannot read `integration_secrets` or `raw_body`; the ingest role can INSERT but not SELECT `webhook_events`.
- API against Neon (local process on another port, real Meta app settings but MOCK-signed fixture): signup, workspace create (RLS + seeding), lists, webhook ingress 200 and bad signature 403 + rejected row, event-driven worker processed the event within seconds (unknown account -> orphan). Request time about 0.4 to 1 s from the test machine to Singapore.
- Direct (unpooled) connection string used; the pooled endpoint was not tested. The connection string carries `channel_binding=require`; node-pg 8 accepts it today and logs an sslmode deprecation warning.
- NOT verified: how much of the free 100 CU-hours a day of use costs; behaviour after the compute scales to zero and wakes; the Neon free-plan limits beyond the pricing page.
 This is a development/demo setup, not production.

## Architecture
| Part | Where | Why |
|---|---|---|
| Web (Next.js) | Vercel Hobby, Root Directory `apps/web` | serverless is fine for the web |
| API + workers | ONE Render free web service (`render.yaml`) | the API also runs the webhook ingress, inbox worker and event dispatcher as timers, which need a long-running process |
| Database | Neon free Postgres | permanent free plan; roles, pg_trgm, PG 18 and all migrations VERIFIED (see above) |
| Wake-up | external free pinger on `GET <api>/health` every 10 min | Render free sleeps after 15 min without inbound traffic |
| Deploys | GitHub Actions on push to `main`: test, migrate, Render deploy hook; Vercel deploys the web by itself | |

Public URLs are `*.onrender.com` and `*.vercel.app`: no domain is bought and the Cloudflare tunnel is no longer needed.

## Owner checklist (one time)
1. **Neon:** create a free project (card not required per Neon's pricing page). Note the owner/admin connection string. Do not paste it in chat.
2. **Create the roles** (from your machine, passwords in your shell, never committed):
   ```
   DATABASE_URL_ADMIN='<neon owner connection string>' \
   CRM_MIGRATOR_PASSWORD=<24+ random chars> CRM_APP_PASSWORD=<...> CRM_INGEST_PASSWORD=<...> CRM_WORKER_PASSWORD=<...> \
   node scripts/db-bootstrap-roles.mjs --dry-run      # prints the plan, no passwords
   node scripts/db-bootstrap-roles.mjs                # runs it
   ```
   Generate passwords with `openssl rand -base64 24`. The script prints only which steps worked. If a step fails it names it and its error code; **expect to read errors here: whether Neon lets the owner role run `ALTER DEFAULT PRIVILEGES FOR ROLE crm_migrator` and `CREATE EXTENSION pg_trgm` is UNVERIFIED.**
3. **Run the migrations once by hand to learn the truth:** `DATABASE_URL_MIGRATOR='postgres://crm_migrator:<pw>@<neon host>/<db>?sslmode=require' pnpm --filter @crm/db migrate`. **Postgres 18 on Neon is UNVERIFIED.** The schema uses `uuidv7()`, a Postgres 18 function; on an older version the first migration fails with an error about that function. If so, stop: this provider cannot host the database as is (a compatibility function would need a new migration decision).
4. **Render:** New > Blueprint, pick this repo (`render.yaml`). The dashboard asks for the secret values (`sync: false` entries): the four `DATABASE_URL_*` for `crm_app`, `crm_ingest`, `crm_worker` (same Neon host, `?sslmode=require`), `BETTER_AUTH_SECRET` (`openssl rand -base64 48`), `SECRETS_ENCRYPTION_KEY` (`openssl rand -base64 32`), the Meta values, and the URLs: `BETTER_AUTH_URL` and `META_PUBLIC_BASE_URL` = the service URL, `WEB_ORIGIN` = the Vercel URL, `META_OAUTH_REDIRECT_URI` = `<vercel url>/v1/integrations/meta/callback`. Confirm the Node version in the build log (`NODE_VERSION=24` is UNVERIFIED as the setting Render reads; if the log shows another version, set it the way Render documents).
5. **Deploy Hook:** in the service settings find the Deploy Hook URL (exact UI label UNVERIFIED) and copy it.
6. **GitHub repo secrets:** `DATABASE_URL_MIGRATOR` (the `crm_migrator` URL) and `RENDER_DEPLOY_HOOK_URL`. Optionally create an `environment: production` with required reviewers and uncomment that line in `deploy.yml` to approve each migration.
7. **Vercel:** import the repo, set Root Directory to `apps/web`, env `API_URL=<render url>`. The monorepo install/build settings for pnpm are UNVERIFIED: read the first build log.
8. **Pinger:** create a monitor on cron-job.org or UptimeRobot (their current free terms are UNVERIFIED) calling `<render url>/health` every 10 minutes.
9. **Meta app:** webhook callback `<render url>/webhooks/meta/messenger` (and `/instagram`), data deletion `<render url>/meta/callbacks/data-deletion`, deauthorize `<render url>/meta/callbacks/deauthorize`, OAuth redirect as in step 4. Meta Live-mode (Publish) requirements are UNVERIFIED; see `docs/integrations/meta-oauth-readiness.md`.

After that, every push to `main` runs tests, applies new migrations, then redeploys the API. Never edit a migration that was already applied: migrations are forward only.

## Known limits
- **Render free** (page of 2026-11-14): 750 instance hours per month (one always-on service fits: 744 h), spins down after 15 min without inbound traffic, may be restarted at any time, one instance, no persistent disk. A cold start can exceed Meta's 5 second webhook window; Meta retries.
- **Neon free:** 100 CU-hours per month, compute scales to zero after 5 min and cannot be disabled. The API is built not to keep the database awake: the inbox worker is **event driven** (ingress signals it right after it stores a webhook; `INBOX_WORKER_INTERVAL_MS`, 900000 = 15 min, is only a slow safety net), and the notification/event dispatcher polls every second only while the API is being used (any request except `/health` counts for 2 minutes) and every `EVENT_DISPATCH_IDLE_INTERVAL_MS` (default 600000 = 10 min) otherwise; the first request after an idle period wakes it at once. The free pinger hits `/health`, which does not count as activity and does not touch the database. **Not yet measured on Neon:** check the CU-hour usage after a day, and note a 5 to 10 minute periodic query can still keep the compute awake part of the time.
- **Mail:** there is no production mail provider, and `apps/api/src/server.ts` refuses `NODE_ENV=production` for that reason, so the service runs with `NODE_ENV=staging`. Password-reset e-mails are written to local disk on the Render instance and are lost. Pick a provider (decision D22) before real users.
- **Release gates still open:** KMS for the token key (env key only), one API instance only (OAuth pending store and rate limits are in memory), e-mail verification, contact erasure.
- **CI** runs lint, typecheck and unit tests against `postgres:18`. Playwright is not in CI yet. The `postgres:18` service image tag and the action versions (`checkout@v4`, `setup-node@v4`) are UNVERIFIED. When `deploy.yml` calls `ci.yml`, a push to `main` also triggers `ci` once on its own.
- Costs: none expected if every limit above holds. Fly.io and Railway are not free (checked 2026-11-14).
