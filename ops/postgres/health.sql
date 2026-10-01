-- Read-only production PostgreSQL readiness checks.
SELECT current_setting('server_version') AS postgres_version,
       current_database() AS database_name,
       pg_is_in_recovery() AS is_replica;

SELECT current_database() AS database_name,
       pg_size_pretty(pg_database_size(current_database())) AS database_size;

SELECT conname, conrelid::regclass AS table_name, contype
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
ORDER BY table_name, conname;

SELECT tgname, tgrelid::regclass AS table_name, tgenabled
FROM pg_trigger
WHERE NOT tgisinternal
ORDER BY table_name, tgname;

SELECT COUNT(*) AS orphan_ticket_entries
FROM ticket_entries entry
LEFT JOIN tickets ticket
  ON ticket.company_id = entry.company_id AND ticket.id = entry.ticket_id
WHERE ticket.id IS NULL;

SELECT COUNT(*) AS unresolved_reconciliation
FROM migration_reconciliation_candidates
WHERE status IN ('PENDING_REVIEW', 'LINKED_SOURCE_PENDING');
