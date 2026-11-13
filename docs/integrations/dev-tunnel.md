# Development tunnel for Meta webhooks (Cloudflare Quick Tunnel)

**Status: VERIFIED 2026-11-13** with a real public `https://*.trycloudflare.com` URL and MOCK-signed fixtures (no Meta traffic): handshake right/wrong token, signed POST stored, bad/missing signature 403, and `/v1/me`, `/api/auth/*`, `/health` all 404 through the tunnel. Real Meta delivery through it is NOT tested.

## Why a Quick Tunnel
No account, no domain, no cost. Meta needs a public HTTPS callback for webhooks only; the OAuth redirect goes to the browser, so it can use `http://localhost:3000` (acceptance of a localhost redirect URI by Meta is UNVERIFIED: the docs fetched do not say; fallback is a second quick tunnel to the web app). A named Cloudflare tunnel (stable hostname) needs a Cloudflare account and a domain on it: a later option once a domain exists. Not needed now.

## What is exposed
Only `GET|POST /webhooks/meta/messenger` and `/instagram`, through `scripts/dev-tunnel/gate.mjs` (allow-list proxy on 127.0.0.1:8788, forwards a few headers, everything else 404). The tunnel never points at the API directly. The API verifies the HMAC over the raw body, caps the body at 1 MB, rate limits per source and stores rejected attempts without the body (Slice 2, 19 tests).

## Start, stop, recover
1. Run the API with the webhook enabled (`DATABASE_URL_INGEST`, `DATABASE_URL_WORKER`, `META_APP_SECRET`, `META_VERIFY_TOKEN`; see `.env.example`), e.g. `pnpm --filter @crm/api dev`.
2. `scripts/dev-tunnel/start.sh` prints the URL and writes `.dev-tunnel/url`. Callback URLs: `<url>/webhooks/meta/messenger` and `<url>/webhooks/meta/instagram`.
3. Check: `cd apps/api && pnpm exec tsx dev/tunnel-smoke.mts` (mock-signed fixtures; 8 lines, expected 200/403/200/403/403/404/404/404).
4. Stop: `scripts/dev-tunnel/stop.sh`. Logs: `.dev-tunnel/*.log`. Not running = nothing is reachable.
- Recover: if cloudflared dies or the laptop sleeps, run `start.sh` again (it stops leftovers first). If the API restarts nothing changes; the gate returns 502 until it is back.

## The URL changes on every start
A Quick Tunnel URL is random and temporary. After each restart update the callback URL in the Meta app dashboard (Webhooks, per object) and re-verify; Meta calls the old URL otherwise and, after about an hour of failures, unsubscribes the app (documented Meta behaviour). Events sent while the tunnel was down are NOT replayed unless Meta retries within its window: expect gaps in development. A stable named tunnel avoids the manual update.

## Keep separate from production
Everything lives in `scripts/dev-tunnel/` and `.dev-tunnel/` (gitignored). No production host exists yet; the webhook URL and secrets for production will be set with hosting.
