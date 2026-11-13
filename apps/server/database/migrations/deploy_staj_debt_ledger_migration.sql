BEGIN;

CREATE TABLE IF NOT EXISTS staj_debt_claims (
  company_id VARCHAR(64) NOT NULL,
  debt_id VARCHAR(128) NOT NULL,
  worker_id INTEGER NOT NULL,
  original_amount NUMERIC(20,2) NOT NULL CHECK (original_amount > 0),
  evidence_reference TEXT NOT NULL CHECK (length(btrim(evidence_reference)) > 0),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  verification_note TEXT NOT NULL CHECK (length(btrim(verification_note)) > 0),
  verified_by VARCHAR(128) NOT NULL,
  registered_operation_id VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, debt_id),
  UNIQUE (company_id, registered_operation_id),
  UNIQUE (company_id, evidence_sha256),
  FOREIGN KEY (company_id, worker_id) REFERENCES workers(company_id, id)
);

CREATE TABLE IF NOT EXISTS staj_debt_events (
  event_id VARCHAR(128) NOT NULL,
  company_id VARCHAR(64) NOT NULL,
  debt_id VARCHAR(128) NOT NULL,
  operation_id VARCHAR(128) NOT NULL,
  event_type VARCHAR(32) NOT NULL CHECK (event_type IN ('DEDUCTION', 'DEFICIT_REVIEW', 'REVERSAL')),
  amount NUMERIC(20,2) NOT NULL CHECK (amount > 0),
  period_id VARCHAR(128),
  reverses_event_id VARCHAR(128),
  actor_id VARCHAR(128) NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, event_id),
  UNIQUE (company_id, operation_id, event_type),
  FOREIGN KEY (company_id, debt_id) REFERENCES staj_debt_claims(company_id, debt_id),
  FOREIGN KEY (company_id, reverses_event_id) REFERENCES staj_debt_events(company_id, event_id),
  CHECK ((event_type = 'REVERSAL') = (reverses_event_id IS NOT NULL)),
  CHECK ((event_type = 'DEDUCTION') = (period_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_staj_debt_single_deduction
  ON staj_debt_events(company_id, debt_id) WHERE event_type = 'DEDUCTION';
CREATE UNIQUE INDEX IF NOT EXISTS uq_staj_debt_single_deficit_review
  ON staj_debt_events(company_id, debt_id) WHERE event_type = 'DEFICIT_REVIEW';
CREATE UNIQUE INDEX IF NOT EXISTS uq_staj_debt_reversal
  ON staj_debt_events(company_id, reverses_event_id) WHERE event_type = 'REVERSAL';
CREATE INDEX IF NOT EXISTS idx_staj_debt_worker ON staj_debt_claims(company_id, worker_id, debt_id);
CREATE INDEX IF NOT EXISTS idx_staj_debt_review ON staj_debt_events(company_id, event_type, created_at);

CREATE OR REPLACE FUNCTION prevent_staj_debt_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'STAJ_DEBT_LEDGER_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_staj_debt_claims_immutable ON staj_debt_claims;
CREATE TRIGGER trg_staj_debt_claims_immutable BEFORE UPDATE OR DELETE ON staj_debt_claims
  FOR EACH ROW EXECUTE FUNCTION prevent_staj_debt_ledger_mutation();
DROP TRIGGER IF EXISTS trg_staj_debt_events_immutable ON staj_debt_events;
CREATE TRIGGER trg_staj_debt_events_immutable BEFORE UPDATE OR DELETE ON staj_debt_events
  FOR EACH ROW EXECUTE FUNCTION prevent_staj_debt_ledger_mutation();

INSERT INTO schema_migrations(version, name) VALUES (32, 'deploy_staj_debt_ledger_migration.sql')
ON CONFLICT(version) DO NOTHING;
COMMIT;
