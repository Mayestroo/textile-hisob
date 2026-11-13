-- Migration v30: Historical purge era & anti-resurrection tombstone fence
CREATE TABLE IF NOT EXISTS historical_purge_eras (
  purge_id VARCHAR(128) PRIMARY KEY,
  company_id VARCHAR(128) NOT NULL,
  purge_generation BIGINT NOT NULL CHECK (purge_generation >= 1),
  cutoff_date DATE NOT NULL,
  cutoff_utc TIMESTAMPTZ NOT NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Tashkent',
  min_valid_cursor BIGINT NOT NULL CHECK (min_valid_cursor >= 0),
  manifest_sha256 CHAR(64) NOT NULL,
  executor_mode VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'COMMITTED' CHECK (status IN ('COMMITTED')),
  baseline_purged BOOLEAN NOT NULL DEFAULT FALSE,
  summary_json JSONB NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, purge_generation)
);

CREATE OR REPLACE FUNCTION prevent_historical_purge_era_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'HISTORICAL_PURGE_ERA_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_historical_purge_eras_immutable ON historical_purge_eras;
CREATE TRIGGER trg_historical_purge_eras_immutable
BEFORE UPDATE OR DELETE ON historical_purge_eras
FOR EACH ROW EXECUTE FUNCTION prevent_historical_purge_era_mutation();

CREATE TABLE IF NOT EXISTS purged_entity_tombstones (
  company_id VARCHAR(128) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(255) NOT NULL,
  purge_generation BIGINT NOT NULL,
  authoritative_at TIMESTAMPTZ,
  cutoff_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_purged_entity_tombstones_generation
ON purged_entity_tombstones (company_id, purge_generation, entity_type);

CREATE TABLE IF NOT EXISTS purged_operation_tombstones (
  company_id VARCHAR(128) NOT NULL,
  operation_id VARCHAR(255) NOT NULL,
  purge_generation BIGINT NOT NULL,
  command_type VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(255) NOT NULL,
  authoritative_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_purged_operation_tombstones_generation
ON purged_operation_tombstones (company_id, purge_generation);

INSERT INTO schema_migrations (version, name)
VALUES (30, 'deploy_historical_purge_fence_migration.sql')
ON CONFLICT (version) DO NOTHING;

