-- Migration: Deploy Reconciliation Resolution Engine & Audit Persistence
-- Phase 2 — Operator Reconciliation Resolution

BEGIN;

-- 1. Create migration_reconciliation_candidates table
CREATE TABLE IF NOT EXISTS migration_reconciliation_candidates (
  candidate_id VARCHAR(128) NOT NULL,
  company_id VARCHAR(64) NOT NULL,
  model_id VARCHAR(128) NOT NULL,
  worker_id INTEGER NOT NULL,
  operation_name TEXT NOT NULL,
  legacy_qty NUMERIC NOT NULL,
  ticket_derived_qty NUMERIC NOT NULL,
  delta_qty NUMERIC NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING_REVIEW',
  reason TEXT NOT NULL,
  notes TEXT,
  source_snapshot_hash CHAR(64),
  resolution_decision VARCHAR(64),
  resolution_operator_id VARCHAR(128),
  resolved_at TIMESTAMPTZ,
  created_adjustment_id VARCHAR(128),
  source_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS idx_reconcile_cand_comp ON migration_reconciliation_candidates(company_id, status);
CREATE INDEX IF NOT EXISTS idx_reconcile_cand_model_worker ON migration_reconciliation_candidates(company_id, model_id, worker_id);

-- 2. Create migration_reconciliation_resolutions audit table
CREATE TABLE IF NOT EXISTS migration_reconciliation_resolutions (
  resolution_id VARCHAR(128) PRIMARY KEY,
  candidate_id VARCHAR(128) NOT NULL,
  company_id VARCHAR(64) NOT NULL,
  decision VARCHAR(64) NOT NULL,
  operator_id VARCHAR(128) NOT NULL,
  operator_role VARCHAR(64) NOT NULL,
  reason TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  source_snapshot_hash CHAR(64) NOT NULL,
  legacy_qty NUMERIC NOT NULL,
  derived_qty NUMERIC NOT NULL,
  delta_qty NUMERIC NOT NULL,
  created_adjustment_id VARCHAR(128),
  source_reference TEXT,
  resolution_provenance VARCHAR(64) NOT NULL DEFAULT 'OPERATOR_RECONCILIATION_RESOLUTION',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reconcile_res_cand ON migration_reconciliation_resolutions(company_id, candidate_id);

-- 3. Immutability Trigger for Reconciliation Resolutions
CREATE OR REPLACE FUNCTION prevent_reconciliation_resolution_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_AUDIT_RECORD: migration_reconciliation_resolutions records cannot be modified or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reconcile_res_immutable ON migration_reconciliation_resolutions;
CREATE TRIGGER trg_reconcile_res_immutable
BEFORE UPDATE OR DELETE ON migration_reconciliation_resolutions
FOR EACH ROW
EXECUTE FUNCTION prevent_reconciliation_resolution_mutation();

INSERT INTO schema_migrations (version, name)
VALUES (5, 'deploy_reconciliation_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
