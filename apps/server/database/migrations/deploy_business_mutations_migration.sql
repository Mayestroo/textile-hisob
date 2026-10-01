-- Workbook business mutation schema (source migration 9).
-- This migration is additive. It must be applied to production only after the
-- Business mutation runtime and client release are ready.
BEGIN;

ALTER TABLE models
  ADD COLUMN IF NOT EXISTS hisob_sheet_name TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS party TEXT,
  ADD COLUMN IF NOT EXISTS color TEXT,
  ADD COLUMN IF NOT EXISTS size TEXT,
  ADD COLUMN IF NOT EXISTS patta_ops_order_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS server_revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS staj NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS role TEXT,
  ADD COLUMN IF NOT EXISTS legacy_avans NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS legacy_jarima NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS server_revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE periods
  ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'Unnamed period',
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS archive_filename TEXT,
  ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
  ADD COLUMN IF NOT EXISTS server_revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE parties ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS period_id VARCHAR(128);
ALTER TABLE worker_adjustments ADD COLUMN IF NOT EXISTS period_id VARCHAR(128);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'tickets'::regclass AND conname = 'fk_tickets_period'
  ) THEN
    ALTER TABLE tickets ADD CONSTRAINT fk_tickets_period
      FOREIGN KEY (company_id, period_id) REFERENCES periods(company_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'worker_adjustments'::regclass AND conname = 'fk_worker_adjustments_period'
  ) THEN
    ALTER TABLE worker_adjustments ADD CONSTRAINT fk_worker_adjustments_period
      FOREIGN KEY (company_id, period_id) REFERENCES periods(company_id, id) NOT VALID;
  END IF;
END
$$;
ALTER TABLE tickets VALIDATE CONSTRAINT fk_tickets_period;
ALTER TABLE worker_adjustments VALIDATE CONSTRAINT fk_worker_adjustments_period;

CREATE INDEX IF NOT EXISTS idx_models_company_status ON models(company_id, status);
CREATE INDEX IF NOT EXISTS idx_workers_company_status ON workers(company_id, status);
CREATE INDEX IF NOT EXISTS idx_periods_company_status ON periods(company_id, status, start_date);
CREATE INDEX IF NOT EXISTS idx_tickets_company_period ON tickets(company_id, period_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_worker_adjustments_company_period
  ON worker_adjustments(company_id, period_id, worker_id, type);

CREATE TABLE IF NOT EXISTS company_batch_settings (
  company_id VARCHAR(64) PRIMARY KEY,
  available_sizes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  server_revision INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS patta_batch_settings (
  company_id VARCHAR(64) NOT NULL,
  model_id VARCHAR(128) NOT NULL,
  party_number VARCHAR(64) NOT NULL DEFAULT '',
  is_custom_party BOOLEAN NOT NULL DEFAULT FALSE,
  total_ish_soni TEXT NOT NULL DEFAULT '',
  color TEXT,
  sizes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  server_revision INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, model_id),
  FOREIGN KEY (company_id, model_id) REFERENCES models(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS period_archives (
  company_id VARCHAR(64) NOT NULL,
  period_id VARCHAR(128) NOT NULL,
  archive_json JSONB NOT NULL,
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, period_id),
  FOREIGN KEY (company_id, period_id) REFERENCES periods(company_id, id) ON DELETE RESTRICT
);

INSERT INTO schema_migrations (version, name)
VALUES (9, 'deploy_business_mutations_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
