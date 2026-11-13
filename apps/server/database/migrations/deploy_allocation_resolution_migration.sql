BEGIN;

CREATE TABLE IF NOT EXISTS allocation_review_candidates (
  company_id VARCHAR(64) NOT NULL,
  original_operation_id VARCHAR(128) NOT NULL,
  command_type VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(128) NOT NULL,
  original_payload_hash CHAR(64) NOT NULL CHECK (original_payload_hash ~ '^[0-9a-f]{64}$'),
  original_payload_json JSONB NOT NULL,
  review_code VARCHAR(64) NOT NULL CHECK (review_code = 'ALLOCATION_REVIEW_REQUIRED'),
  review_reason TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, original_operation_id)
);
CREATE OR REPLACE FUNCTION prevent_allocation_review_candidate_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ALLOCATION_REVIEW_CANDIDATE_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_allocation_review_candidates_immutable ON allocation_review_candidates;
CREATE TRIGGER trg_allocation_review_candidates_immutable
BEFORE UPDATE OR DELETE ON allocation_review_candidates
FOR EACH ROW EXECUTE FUNCTION prevent_allocation_review_candidate_mutation();

CREATE TABLE IF NOT EXISTS allocation_resolution_fences (
  company_id VARCHAR(64) NOT NULL,
  original_operation_id VARCHAR(128) NOT NULL,
  original_payload_hash CHAR(64) NOT NULL CHECK (original_payload_hash ~ '^[0-9a-f]{64}$'),
  resolution_operation_id VARCHAR(128) NOT NULL,
  action VARCHAR(32) NOT NULL CHECK (action IN ('CANCEL')),
  actor_id VARCHAR(128) NOT NULL,
  original_payload_json JSONB NOT NULL,
  reason TEXT NOT NULL,
  resulting_status VARCHAR(32) NOT NULL DEFAULT 'CANCELLED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, original_operation_id),
  UNIQUE (company_id, resolution_operation_id)
);

CREATE TABLE IF NOT EXISTS allocation_resolution_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(64) NOT NULL,
  original_operation_id VARCHAR(128) NOT NULL,
  original_payload_hash CHAR(64) NOT NULL,
  resolution_operation_id VARCHAR(128) NOT NULL,
  reviewer_id VARCHAR(128) NOT NULL,
  action VARCHAR(32) NOT NULL,
  issuance_reference VARCHAR(128),
  previous_status VARCHAR(32) NOT NULL,
  resulting_status VARCHAR(32) NOT NULL,
  reason TEXT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, resolution_operation_id)
);

CREATE OR REPLACE FUNCTION prevent_allocation_resolution_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ALLOCATION_RESOLUTION_AUDIT_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_allocation_resolution_audit_immutable ON allocation_resolution_audit;
CREATE TRIGGER trg_allocation_resolution_audit_immutable
BEFORE UPDATE OR DELETE ON allocation_resolution_audit
FOR EACH ROW EXECUTE FUNCTION prevent_allocation_resolution_audit_mutation();

CREATE OR REPLACE FUNCTION prevent_allocation_resolution_fence_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ALLOCATION_RESOLUTION_FENCE_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_allocation_resolution_fences_immutable ON allocation_resolution_fences;
CREATE TRIGGER trg_allocation_resolution_fences_immutable
BEFORE UPDATE OR DELETE ON allocation_resolution_fences
FOR EACH ROW EXECUTE FUNCTION prevent_allocation_resolution_fence_mutation();

INSERT INTO schema_migrations (version, name)
VALUES (31, 'deploy_allocation_resolution_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
