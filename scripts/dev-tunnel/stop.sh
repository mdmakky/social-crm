#!/usr/bin/env bash
cd "$(dirname "$0")/../.."
for n in cloudflared gate; do
  [ -f ".dev-tunnel/$n.pid" ] && kill "$(cat ".dev-tunnel/$n.pid")" 2>/dev/null || true
  rm -f ".dev-tunnel/$n.pid"
done
rm -f .dev-tunnel/url
echo "tunnel stopped"
