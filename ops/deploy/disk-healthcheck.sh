#!/usr/bin/env bash
set -Eeuo pipefail

backup_dir=/srv/novda/backups
max_use_percent="${NOVDA_DISK_MAX_USE_PERCENT:-85}"

if [[ ! "$max_use_percent" =~ ^[0-9]+$ ]] || (( max_use_percent < 50 || max_use_percent > 95 )); then
  printf '%s\n' 'NOVDA_DISK_THRESHOLD_INVALID' >&2
  exit 1
fi

disk_use="$(df -P "$backup_dir" | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
if [[ ! "$disk_use" =~ ^[0-9]+$ ]] || (( disk_use >= max_use_percent )); then
  printf 'NOVDA_DISK_HEALTH_FAIL used_percent=%s threshold_percent=%s\n' "$disk_use" "$max_use_percent" >&2
  exit 1
fi

api_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' novda-api 2>/dev/null || true)"
postgres_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' novda-postgres 2>/dev/null || true)"
if [[ "$api_health" != healthy || "$postgres_health" != healthy ]]; then
  printf 'NOVDA_SERVICE_HEALTH_FAIL api=%s postgres=%s\n' "$api_health" "$postgres_health" >&2
  exit 1
fi

printf 'NOVDA_HOST_HEALTH_PASS disk_used_percent=%s api=%s postgres=%s\n' "$disk_use" "$api_health" "$postgres_health"
