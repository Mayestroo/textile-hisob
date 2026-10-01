#!/usr/bin/env bash
set -Eeuo pipefail

readonly checkout="${NOVDA_REPOSITORY_CHECKOUT:-/srv/novda/repository}"
readonly branch="${NOVDA_PRODUCTION_BRANCH:-main}"
readonly compose_file="ops/deploy/compose.yaml"
readonly env_file="/srv/novda/secrets/compose.env"

die() { printf 'DEPLOY_FAILED: %s\n' "$*" >&2; exit 1; }

[[ "$(id -un)" != root ]] || die 'run as the dedicated deploy user, not root'
[[ -d "$checkout/.git" ]] || die "canonical repository checkout missing: $checkout"
[[ -r "$env_file" ]] || die "production Compose environment unavailable: $env_file"
[[ -f "$checkout/$compose_file" ]] || die "Compose file missing: $checkout/$compose_file"
command -v docker >/dev/null || die 'Docker is required'
docker compose version >/dev/null

cd "$checkout"
[[ "$(git remote get-url origin)" ]] || die 'origin remote is not configured'
git fetch --prune origin "$branch"
git reset --hard "origin/$branch"
git submodule sync --recursive
git submodule update --init --recursive --force

compose=(docker compose --env-file "$env_file" -f "$compose_file")
"${compose[@]}" config --quiet

# Apply replay-safe forward migrations before replacing application containers.
"${compose[@]}" --profile migrate run --rm novda-migrations

# Compose removes orphaned containers without deleting persistent named volumes.
"${compose[@]}" build --pull
"${compose[@]}" up -d --remove-orphans --wait --wait-timeout 180

# Probe the actual API route inside the production container (no public host port).
docker exec novda-api node -e \
  "fetch('http://127.0.0.1:3474/health').then(async r => { if (!r.ok) process.exit(1); const b = await r.json(); if (b.status !== 'ok') process.exit(1); }).catch(() => process.exit(1))" \
  || die 'application /health probe failed'

for service in novda-postgres novda-api novda-admin-bot novda-worker-bot; do
  state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$service")"
  [[ "$state" == healthy ]] || die "$service is not healthy (state=$state)"
done

if [[ -n "${NOVDA_PUBLIC_HEALTH_URL:-}" ]]; then
  curl --fail --silent --show-error --retry 12 --retry-delay 5 \
    "$NOVDA_PUBLIC_HEALTH_URL"
fi

printf 'DEPLOY_SUCCESS branch=%s commit=%s\n' "$branch" "$(git rev-parse HEAD)"
