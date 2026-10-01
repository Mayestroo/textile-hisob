#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

secret_dir=/srv/novda/secrets
secret_file="$secret_dir/compose.env"

if [[ -e "$secret_file" ]]; then
  printf '%s\n' 'NOVDA_SECRETS_FILE_ALREADY_EXISTS; refusing to overwrite'
  exit 1
fi

install -d -o root -g deploy -m 0750 "$secret_dir"
POSTGRES_OWNER_PASSWORD="$(openssl rand -hex 32)"
NOVDA_MIGRATOR_PASSWORD="$(openssl rand -hex 32)"
NOVDA_APP_PASSWORD="$(openssl rand -hex 32)"

{
  printf 'POSTGRES_OWNER_PASSWORD=%s\n' "$POSTGRES_OWNER_PASSWORD"
  printf 'NOVDA_MIGRATOR_PASSWORD=%s\n' "$NOVDA_MIGRATOR_PASSWORD"
  printf 'NOVDA_APP_PASSWORD=%s\n' "$NOVDA_APP_PASSWORD"
} > "$secret_file"

chown root:deploy "$secret_file"
chmod 0640 "$secret_file"
unset POSTGRES_OWNER_PASSWORD NOVDA_MIGRATOR_PASSWORD NOVDA_APP_PASSWORD

printf 'NOVDA_SECRETS_FILE_CREATED mode=%s\n' "$(stat -c '%a' "$secret_file")"
