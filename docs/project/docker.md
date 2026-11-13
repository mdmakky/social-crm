# Running the whole stack with Docker (development)

**Status: VERIFIED on 2026-11-13 (macOS arm64, Docker 29.6.1) for build, first start on an empty volume, fresh migrations, health, restart persistence.** Development image only (dev passwords, `next dev`, `tsx`); not for the internet and not a production image (hosting is undecided).

## Commands
```
docker compose -f docker-compose.full.yml up --build -d --wait   # web http://localhost:3000, API http://localhost:8787
docker compose -f docker-compose.full.yml logs -f api
docker compose -f docker-compose.full.yml down                   # keeps data (volume pgdata)
docker compose -f docker-compose.full.yml down -v                # also deletes the database volume
```
Use `-p <name>` for an isolated copy (own containers, network and volume). Ports 3000 and 8787 are fixed, so only one copy can run at a time. No `.env` file is needed; every variable is in the compose file.

## Services
`db` (postgres:18; roles created from `packages/db/sql/001_roles_and_probe.sql` on first init only) -> `migrate` (runs `pnpm --filter @crm/db migrate`, exits 0) -> `api` (healthcheck on `/health`) -> `web` (starts after api is healthy; proxies `/api` and `/v1` to `http://api:8787`).

## Environment variables (set in `docker-compose.full.yml`)
| Service | Variable | Value / note |
|---|---|---|
| migrate | `DATABASE_URL_MIGRATOR` | `postgres://crm_migrator:migrator_dev@db:5432/crm` |
| api | `DATABASE_URL_APP` | `postgres://crm_app:app_dev@db:5432/crm` |
| api | `BETTER_AUTH_SECRET` | dev value, 32+ chars; change for anything shared |
| api | `BETTER_AUTH_URL`, `WEB_ORIGIN` | `http://localhost:8787`, `http://localhost:3000` |
| web | `API_URL` | `http://api:8787` |
Meta Inbox is OFF by default. To enable the webhook and worker add to `api`: `DATABASE_URL_INGEST` (`crm_ingest`), `DATABASE_URL_WORKER` (`crm_worker`), `META_APP_SECRET`, `META_VERIFY_TOKEN`. Not tested in Docker; mock only.

## Verification record (project `dockverify`, fresh volume, `build --no-cache`)
- Build: 3 images built (api, web, migrate share one 2.15 GB image), exit 0.
- First start: db healthy, migrate exit 0, api and web healthy.
- Migrations: 20 applied from zero (0000 to 0019), 126 policies, roles crm_app / crm_ingest / crm_migrator / crm_worker present.
- Health: `GET /health` 200 `{"ok":true}`; `/v1/me` 401 unauthenticated (expected); web `/` 307 to `/login`, `/login` 200; web proxy `/api/auth/get-session` 200.
- Persistence: signed up a user through the API, `down` then `up` (no `-v`): the user row was still present and sign-in returned 200.
- Logs: no error, fatal, missing-variable or connection lines after startup.

## Problems found and fixed
- `api` had no healthcheck, so `up --wait` returned before the API listened (first request after restart failed). Added a `/health` healthcheck; `web` now waits for it.

## Known limitations
- Dev servers inside the image (`next dev`, `tsx`), 2.15 GB image, source baked in with `COPY .`: code changes need a rebuild.
- Role passwords and the auth secret are dev values. Role creation runs only when the data volume is empty; an existing volume is not re-initialised.
- Ports fixed (3000, 8787); `db` is not exposed to the host (use `docker compose exec db psql -U postgres crm`). Not the same as `pnpm db:up` (port 5436, used by tests).
- Mobile (Expo) is not part of the stack. Meta ingress/worker not exercised in Docker. No real Meta call was made.
