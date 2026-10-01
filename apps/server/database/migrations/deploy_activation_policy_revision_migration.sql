-- Version 11: auditable company-scoped strict/free validation mode revisions.
-- Reuses activation_companies.require_ticket_validation; no second mode flag.
BEGIN;

ALTER TABLE activation_companies
  ADD COLUMN IF NOT EXISTS policy_revision INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'activation_companies'::regclass
      AND conname = 'activation_companies_policy_revision_check'
  ) THEN
    ALTER TABLE activation_companies
      ADD CONSTRAINT activation_companies_policy_revision_check CHECK (policy_revision >= 1);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS activation_policy_events (
  event_id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(100) NOT NULL REFERENCES activation_companies(company_id) ON DELETE RESTRICT,
  actor_telegram_id VARCHAR(24) NOT NULL,
  previous_require_ticket_validation BOOLEAN NOT NULL,
  require_ticket_validation BOOLEAN NOT NULL,
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activation_policy_events_company
  ON activation_policy_events(company_id, event_id DESC);

CREATE OR REPLACE FUNCTION prevent_activation_policy_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_AUDIT_RECORD: activation_policy_events records cannot be modified or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_activation_policy_events_immutable ON activation_policy_events;
CREATE TRIGGER trg_activation_policy_events_immutable
BEFORE UPDATE OR DELETE ON activation_policy_events
FOR EACH ROW EXECUTE FUNCTION prevent_activation_policy_event_mutation();

INSERT INTO schema_migrations (version, name)
VALUES (11, 'deploy_activation_policy_revision_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
