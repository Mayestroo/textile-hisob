#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

secret_root=/srv/novda/secrets
bot_secret_dir="$secret_root/bots"
service_uid="${NOVDA_SERVICE_UID:-997}"
service_gid="${NOVDA_SERVICE_GID:-988}"
expected_signer_fingerprint=ce8ddbad7b368f8d0896e3f2d8d5c78545be0cb1c14755d3350a24f5a4bfdf68
slot_marker="$secret_root/.bot-secret-slots-prepared"
slots_prepared=false
unverified_token_blocked=0
signer_pin_match=1
owner_confirmed_rotation="${NOVDA_TOKENS_ROTATED:-0}"
if [[ -f "$slot_marker" || "$owner_confirmed_rotation" == 1 ]]; then slots_prepared=true; fi

if [[ "$(id -u)" -ne 0 ]]; then
  printf '%s\n' 'ROOT_REQUIRED_FOR_SECRET_PREPARATION' >&2
  exit 1
fi

install -d -o root -g deploy -m 0750 "$secret_root"
install -d -o "$service_uid" -g "$service_gid" -m 0700 "$bot_secret_dir"

ensure_empty_owner_slot() {
  local name="$1"
  local destination="$bot_secret_dir/$name"
  if [[ ! -e "$destination" ]]; then
    install -o "$service_uid" -g "$service_gid" -m 0600 /dev/null "$destination"
  else
    chown "$service_uid:$service_gid" "$destination"
    chmod 0600 "$destination"
  fi
  if [[ -s "$destination" && "$slots_prepared" != true && "$owner_confirmed_rotation" != 1 ]]; then
    printf 'TOKEN_VALUE_UNVERIFIED_ROTATION_REQUIRED name=%s\n' "$name" >&2
    unverified_token_blocked=1
  fi
}

ensure_random_secret() {
  local name="$1"
  local destination="$bot_secret_dir/$name"
  if [[ -s "$destination" && "$slots_prepared" == true ]]; then
    chown "$service_uid:$service_gid" "$destination"
    chmod 0600 "$destination"
    return
  fi
  local temporary="$destination.$$.tmp"
  openssl rand -hex 32 > "$temporary"
  chown "$service_uid:$service_gid" "$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$destination"
}

ensure_empty_owner_slot admin-bot-token
ensure_empty_owner_slot worker-bot-token
ensure_empty_owner_slot admin-telegram-ids
ensure_empty_owner_slot cloudflare-tunnel-token
ensure_random_secret admin-api-token
ensure_random_secret admin-webapp-session-secret
ensure_random_secret worker-api-token
ensure_random_secret worker-auth-hmac-secret

signer_file="$bot_secret_dir/novda-license-ed25519-private-key"
if [[ ! -s "$signer_file" ]]; then
  temporary="$signer_file.$$.tmp"
  openssl genpkey -algorithm ED25519 -out "$temporary"
  chown "$service_uid:$service_gid" "$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$signer_file"
fi
chown "$service_uid:$service_gid" "$signer_file"
chmod 0600 "$signer_file"

actual_signer_fingerprint="$(openssl pkey -in "$signer_file" -pubout -outform DER 2>/dev/null | openssl dgst -sha256 -r | cut -d ' ' -f 1)"
if [[ "$actual_signer_fingerprint" != "$expected_signer_fingerprint" ]]; then
  printf 'PRODUCTION_SIGNER_FINGERPRINT_MISMATCH expected=%s actual=%s NEW_CLIENT_RC_REQUIRED\n' \
    "$expected_signer_fingerprint" "$actual_signer_fingerprint" >&2
  signer_pin_match=0
else
  printf 'PRODUCTION_SIGNER_FINGERPRINT_MATCH fingerprint=%s\n' "$actual_signer_fingerprint"
fi

for name in admin-bot-token worker-bot-token admin-telegram-ids cloudflare-tunnel-token \
  admin-api-token admin-webapp-session-secret worker-api-token worker-auth-hmac-secret novda-license-ed25519-private-key; do
  file="$bot_secret_dir/$name"
  [[ "$(stat -c '%a' "$file")" == 600 ]] || { printf 'SECRET_MODE_INVALID name=%s\n' "$name" >&2; exit 1; }
  [[ "$(stat -c '%u:%g' "$file")" == "$service_uid:$service_gid" ]] || { printf 'SECRET_OWNER_INVALID name=%s\n' "$name" >&2; exit 1; }
done

[[ "$(stat -c '%a' "$secret_root")" == 750 ]] || { printf '%s\n' 'SECRET_DIRECTORY_MODE_INVALID' >&2; exit 1; }
[[ "$(stat -c '%u:%g' "$secret_root")" == "0:$(getent group deploy | cut -d: -f3)" ]] || { printf '%s\n' 'SECRET_DIRECTORY_OWNER_INVALID' >&2; exit 1; }
[[ "$(stat -c '%a' "$bot_secret_dir")" == 700 ]] || { printf '%s\n' 'BOT_SECRET_DIRECTORY_MODE_INVALID' >&2; exit 1; }

if [[ "$unverified_token_blocked" -eq 0 ]]; then
  printf 'BOT_SECRET_SLOTS_PREPARED\n' > "$slot_marker"
  chown root:root "$slot_marker"
  chmod 0600 "$slot_marker"
fi
[[ -s "$bot_secret_dir/admin-bot-token" ]] || printf '%s\n' 'ADMIN_BOT_TOKEN=BLOCKED'
[[ -s "$bot_secret_dir/worker-bot-token" ]] || printf '%s\n' 'WORKER_BOT_TOKEN=BLOCKED'
printf 'NOVDA_BOT_SECRET_SLOTS_PREPARED secret_directory_mode=750 bot_directory_mode=700 file_mode=600 owner=%s:%s\n' "$service_uid" "$service_gid"
if [[ "$signer_pin_match" -ne 1 ]]; then exit 2; fi
if [[ "$unverified_token_blocked" -ne 0 ]]; then exit 3; fi
