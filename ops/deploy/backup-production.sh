#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

backup_dir=/srv/novda/backups
database=novda_prod
postgres_container=novda-postgres
retention_days="${NOVDA_BACKUP_RETENTION_DAYS:-30}"

if [[ "$(id -u)" -ne 0 ]]; then
  printf '%s\n' 'ROOT_REQUIRED_FOR_DOCKER_BACKUP' >&2
  exit 1
fi
if [[ ! -d "$backup_dir" ]]; then
  printf '%s\n' 'NOVDA_BACKUP_DIRECTORY_MISSING' >&2
  exit 1
fi
if [[ ! "$retention_days" =~ ^[0-9]+$ ]] || (( retention_days < 7 )); then
  printf '%s\n' 'NOVDA_BACKUP_RETENTION_INVALID' >&2
  exit 1
fi
if [[ "$(docker inspect --format '{{.State.Running}}' "$postgres_container" 2>/dev/null)" != true ]]; then
  printf '%s\n' 'NOVDA_POSTGRES_NOT_RUNNING' >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
basename="${database}_auto_${timestamp}.dump"
destination="$backup_dir/$basename"
temporary="$backup_dir/.${basename}.$$.tmp"
trap 'rm -f -- "$temporary"' EXIT

docker exec "$postgres_container" pg_dump \
  --format=custom \
  --username=novda_owner --dbname="$database" > "$temporary"
[[ -s "$temporary" ]] || { printf '%s\n' 'NOVDA_BACKUP_EMPTY' >&2; exit 1; }
docker exec -i "$postgres_container" pg_restore --exit-on-error --list < "$temporary" >/dev/null
chmod 0600 "$temporary"
mv -- "$temporary" "$destination"
size="$(stat -c '%s' "$destination")"
sha256="$(sha256sum "$destination" | cut -d ' ' -f 1)"

now_epoch="$(date +%s)"
shopt -s nullglob
for old_backup in "$backup_dir"/novda_prod_auto_*.dump; do
  [[ "$old_backup" == "$destination" ]] && continue
  modified_epoch="$(stat -c '%Y' "$old_backup")"
  if (( now_epoch - modified_epoch > retention_days * 86400 )); then
    rm -- "$old_backup"
  fi
done

printf 'NOVDA_POSTGRES_BACKUP_PASS file=%s bytes=%s sha256=%s retention_days=%s\n' \
  "$basename" "$size" "$sha256" "$retention_days"
