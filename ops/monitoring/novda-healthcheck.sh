#!/usr/bin/env bash
set -euo pipefail

: "${NOVDA_HEALTH_URL:?Set NOVDA_HEALTH_URL, for example https://sync.example/api/health}"
curl --fail --silent --show-error --max-time 10 \
  --proto '=https' --tlsv1.2 \
  -H 'Accept: application/json' "$NOVDA_HEALTH_URL" \
  | node -e "let s=''; process.stdin.on('data', d => s += d).on('end', () => { const v=JSON.parse(s); if (v.status !== 'ok') process.exit(1); console.log(JSON.stringify({status:v.status, service:v.service, version:v.version})); })"
