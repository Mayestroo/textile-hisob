#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

backup_dir=/srv/novda/backups
postgres_container=novda-postgres
compose_env=/srv/novda/secrets/compose.env
compose_file=/srv/novda/repository/ops/deploy/compose.yaml

if [[ "$(id -u)" -ne 0 ]]; then
  printf '%s\n' 'ROOT_REQUIRED_FOR_RESTORE_DRILL' >&2
  exit 1
fi
[[ -f "$compose_env" && -f "$compose_file" ]] || { printf '%s\n' 'NOVDA_RESTORE_CONFIG_MISSING' >&2; exit 1; }

shopt -s nullglob
backups=("$backup_dir"/novda_prod_auto_*.dump)
if (( ${#backups[@]} == 0 )); then
  printf '%s\n' 'NOVDA_AUTOMATED_BACKUP_NOT_FOUND' >&2
  exit 1
fi

backup_file="${backups[0]}"
newest_mtime="$(stat -c '%Y' "$backup_file")"
for candidate in "${backups[@]}"; do
  candidate_mtime="$(stat -c '%Y' "$candidate")"
  if (( candidate_mtime > newest_mtime )); then
    backup_file="$candidate"
    newest_mtime="$candidate_mtime"
  fi
done

restore_database="novda_restore_drill_$(date -u +%Y%m%d%H%M%S)"
created=false
cleanup() {
  if [[ "$created" == true ]]; then
    docker exec "$postgres_container" dropdb --if-exists --username=novda_owner "$restore_database" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker exec "$postgres_container" createdb --username=novda_owner "$restore_database"
created=true
# Production's novda_migrator role owns novda_prod; match that for public-schema privileges.
docker exec "$postgres_container" psql \
  --username=novda_owner --dbname=postgres --set=ON_ERROR_STOP=1 \
  --command="ALTER DATABASE $restore_database OWNER TO novda_migrator"
docker exec -i "$postgres_container" pg_restore \
  --exit-on-error --clean --if-exists \
  --username=novda_owner --dbname="$restore_database" < "$backup_file"

docker compose \
  --env-file "$compose_env" \
  --project-name novda-prod \
  -f "$compose_file" \
  --profile migrate \
  run --rm --no-deps \
  -e "NOVDA_VERIFY_DATABASE_NAME=$restore_database" \
  novda-migrations node ops/deploy/verifyProductionDatabase.cjs

printf 'NOVDA_POSTGRES_RESTORE_DRILL_PASS source=%s restore_database=%s\n' \
  "$(basename "$backup_file")" "$restore_database"
