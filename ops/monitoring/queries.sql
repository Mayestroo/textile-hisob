-- Operational metrics. Export values to a metrics system; do not log tokens.
SELECT 'outbox_pending' AS metric, 0::bigint AS value;
-- The outbox is local SQLite; collect the real value with the client diagnostic
-- command. The query below covers authoritative PostgreSQL-side metrics.
SELECT 'server_devices_revoked' AS metric, COUNT(*)::bigint AS value
FROM server_devices WHERE is_revoked;
SELECT 'reconciliation_unresolved' AS metric, COUNT(*)::bigint AS value
FROM migration_reconciliation_candidates
WHERE status IN ('PENDING_REVIEW', 'LINKED_SOURCE_PENDING');
SELECT 'operator_sessions_expired' AS metric, COUNT(*)::bigint AS value
FROM operator_sessions WHERE expires_at <= NOW() AND revoked_at IS NULL;
SELECT 'database_size_bytes' AS metric, pg_database_size(current_database())::bigint AS value;
SELECT 'oldest_change_age_seconds' AS metric,
       COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(committed_at))), 0)::bigint AS value
FROM change_log;
