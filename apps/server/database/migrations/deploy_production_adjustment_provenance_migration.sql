-- Version 17: preserve production-adjustment provenance across bootstrap/import.
BEGIN;

ALTER TABLE production_adjustments
  ADD COLUMN IF NOT EXISTS provenance VARCHAR(128) NOT NULL DEFAULT 'MANUAL_CORRECTION';

INSERT INTO schema_migrations(version, name)
VALUES (17, 'deploy_production_adjustment_provenance_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
