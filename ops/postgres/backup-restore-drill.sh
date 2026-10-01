#!/usr/bin/env bash
set -euo pipefail

# Fixture-only drill. It intentionally refuses production-looking database names.
: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${DRILL_SOURCE_DB:?Set DRILL_SOURCE_DB to a test fixture database}"
: "${DRILL_RESTORE_DB:?Set DRILL_RESTORE_DB to a separate test database}"
: "${DRILL_OUTPUT_DIR:=./artifacts/postgres-drill}"

case "$DRILL_SOURCE_DB:$DRILL_RESTORE_DB" in
  *prod*|*production*|*live*)
    printf '%s\n' 'Refusing production-looking database name.' >&2
    exit 2
    ;;
esac
if [[ "$DRILL_SOURCE_DB" == "$DRILL_RESTORE_DB" ]]; then
  printf '%s\n' 'Source and restore databases must be different.' >&2
  exit 2
fi

mkdir -p "$DRILL_OUTPUT_DIR"
dump_file="$DRILL_OUTPUT_DIR/${DRILL_SOURCE_DB}-$(date -u +%Y%m%dT%H%M%SZ).dump"

pg_dump --format=custom --no-owner --no-privileges \
  --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" \
  --file="$dump_file" "$DRILL_SOURCE_DB"

createdb --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" "$DRILL_RESTORE_DB" 2>/dev/null || true
pg_restore --clean --if-exists --no-owner --no-privileges \
  --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" \
  --dbname="$DRILL_RESTORE_DB" "$dump_file"

psql --tuples-only --no-align --set= ON_ERROR_STOP=1 \
  --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" \
  --dbname="$DRILL_RESTORE_DB" <<'SQL'
SELECT 'orphan_ticket_entries=' || COUNT(*)
FROM ticket_entries entry
LEFT JOIN tickets ticket ON ticket.company_id = entry.company_id AND ticket.id = entry.ticket_id
WHERE ticket.id IS NULL;
SELECT 'active_party_trigger=' || COUNT(*)
FROM pg_trigger WHERE tgname = 'trg_parties_active_uniqueness';
SELECT 'reconciliation_immutability_trigger=' || COUNT(*)
FROM pg_trigger WHERE tgname = 'trg_reconcile_res_immutable';
SELECT 'operator_tables=' || COUNT(*)
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('server_operators', 'operator_sessions');
SQL

printf 'BACKUP_RESTORE_DRILL_PASS dump=%s restore_db=%s\n' "$dump_file" "$DRILL_RESTORE_DB"
