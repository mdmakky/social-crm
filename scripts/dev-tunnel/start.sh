#!/usr/bin/env bash
# Starts the allow-list gate and a Cloudflare QUICK tunnel (temporary https://<random>.trycloudflare.com, no account, no domain).
# The URL changes on every start. Writes it to .dev-tunnel/url. Stop with scripts/dev-tunnel/stop.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .dev-tunnel
"$(dirname "$0")/stop.sh" >/dev/null 2>&1 || true
command -v cloudflared >/dev/null || { echo "cloudflared not installed (brew install cloudflared)"; exit 1; }
nohup node scripts/dev-tunnel/gate.mjs > .dev-tunnel/gate.log 2>&1 & echo $! > .dev-tunnel/gate.pid
nohup cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8788 > .dev-tunnel/cloudflared.log 2>&1 & echo $! > .dev-tunnel/cloudflared.pid
for _ in $(seq 1 40); do
  url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' .dev-tunnel/cloudflared.log | head -1 || true)
  [ -n "$url" ] && { echo "$url" > .dev-tunnel/url; echo "tunnel: $url"; echo "Meta callback URLs: $url/webhooks/meta/messenger  and  $url/webhooks/meta/instagram"; exit 0; }
  sleep 1
done
echo "no tunnel URL after 40s; see .dev-tunnel/cloudflared.log"; exit 1
