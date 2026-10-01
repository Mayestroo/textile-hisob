-- ==============================================================================
-- Novda Hisob-Kitob V2 — Production Least-Privilege Database Roles
-- ==============================================================================
-- Execute as postgres superuser during initial database provisioning.

-- 1. Create dedicated application runtime user (NO superuser, NO createdb)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'novda_app') THEN
    CREATE ROLE novda_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
  END IF;
END
$$;

-- Re-apply security attributes when this script is replayed for an existing role.
ALTER ROLE novda_app WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;

-- 2. Connect to production database
-- \c novda_prod

-- 3. Revoke all default public permissions
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO novda_app;

-- 4. Grant table permissions (DML only: SELECT, INSERT, UPDATE, DELETE)
-- novda_app cannot ALTER or DROP tables
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  operations_dedup,
  change_log,
  models,
  workers,
  tickets,
  ticket_entries,
  production_adjustments,
  worker_adjustments,
  parties,
  periods,
  legacy_party_collision_exceptions,
  migration_party_resolutions,
  printed_pattas,
  printed_patta_operations,
  migration_baseline_decisions,
  baseline_import_runs,
  migration_baseline_exclusions,
  party_sequence_leases,
  server_devices,
  operator_login_attempts,
  migration_reconciliation_candidates,
  migration_reconciliation_resolutions,
  server_operators,
  operator_sessions,
  activation_companies,
  activation_requests,
  activation_request_limits,
  activation_events,
  activation_policy_events,
  worker_credentials,
  worker_telegram_bindings,
  worker_binding_limits,
  company_batch_settings,
  patta_batch_settings,
  period_archives
TO novda_app;

GRANT SELECT ON TABLE schema_migrations TO novda_app;

-- 5. Grant sequence usage for auto-incrementing change_log
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO novda_app;

-- 6. Ensure future tables created by migrations also grant permissions
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO novda_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO novda_app;
