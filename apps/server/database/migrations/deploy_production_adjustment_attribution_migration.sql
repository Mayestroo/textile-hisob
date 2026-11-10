-- Version 23: frozen original-work attribution; legacy adjustments remain unresolved.
BEGIN;
ALTER TABLE production_adjustments
  ADD COLUMN IF NOT EXISTS original_ticket_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS original_entry_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS original_period_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS original_rate_snapshot NUMERIC,
  ADD COLUMN IF NOT EXISTS attribution_status VARCHAR(16) NOT NULL DEFAULT 'UNRESOLVED';
CREATE INDEX IF NOT EXISTS idx_prod_adj_source ON production_adjustments(company_id, original_ticket_id, original_entry_id);
INSERT INTO schema_migrations(version, name)
VALUES (23, 'deploy_production_adjustment_attribution_migration.sql')
ON CONFLICT (version) DO NOTHING;
COMMIT;
