-- Forward-only lifecycle provenance; existing CLOSED rows have unknown cause.
ALTER TABLE parties ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
ALTER TABLE parties ADD COLUMN IF NOT EXISTS ended_operation_id VARCHAR(128);
ALTER TABLE parties ADD COLUMN IF NOT EXISTS month_closed_period_id VARCHAR(128);
ALTER TABLE periods ADD COLUMN IF NOT EXISTS close_operation_id VARCHAR(128);
ALTER TABLE parties ADD CONSTRAINT patta_lifecycle_finish_pair
  CHECK ((ended_at IS NULL) = (ended_operation_id IS NULL));
ALTER TABLE parties ADD CONSTRAINT patta_lifecycle_month_period_company
  FOREIGN KEY (company_id, month_closed_period_id) REFERENCES periods(company_id, id);

INSERT INTO schema_migrations (version, name)
VALUES (28, 'deploy_patta_lifecycle_provenance_migration.sql')
ON CONFLICT (version) DO NOTHING;
