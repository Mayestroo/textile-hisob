-- Version 19: allow the application role to allocate active-series patta ranges.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'novda_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE company_patta_sequences TO novda_app';
  END IF;
END;
$$;

INSERT INTO schema_migrations(version, name)
VALUES (19, 'deploy_patta_sequence_runtime_grant_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
