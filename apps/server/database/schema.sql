-- Authoritative PostgreSQL Schema
-- Phase 2 — Step 4: Authoritative Distributed Synchronization & Leases

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1. Operations Deduplication & Distributed Idempotency
CREATE TABLE IF NOT EXISTS operations_dedup (
  company_id VARCHAR(64) NOT NULL,
  operation_id VARCHAR(128) NOT NULL,
  command_type VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(128) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  result_json JSONB NOT NULL,
  server_revision INTEGER NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_ops_dedup_entity ON operations_dedup(company_id, entity_type, entity_id);

-- 2. Append-Only Change Log (Cursor / Change Feed)
CREATE TABLE IF NOT EXISTS change_log (
  change_id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(128) NOT NULL,
  entity_revision INTEGER NOT NULL,
  operation_id VARCHAR(128) NOT NULL,
  change_type VARCHAR(32) NOT NULL, -- 'INSERT', 'UPDATE', 'DELETE'
  payload_json JSONB NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_change_log_company_cursor ON change_log(company_id, change_id ASC);

-- 3. Authoritative Models Table
CREATE TABLE IF NOT EXISTS models (
  id VARCHAR(128) NOT NULL,
  company_id VARCHAR(64) NOT NULL,
  name TEXT NOT NULL,
  operations_json JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, id)
);

-- 4. Authoritative Workers Table
CREATE TABLE IF NOT EXISTS workers (
  id INTEGER NOT NULL,
  company_id VARCHAR(64) NOT NULL,
  name TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, id)
);

-- 5. Authoritative Tickets Table
CREATE TABLE IF NOT EXISTS tickets (
  id VARCHAR(128) NOT NULL,
  company_id VARCHAR(64) NOT NULL,
  model_id VARCHAR(128) NOT NULL,
  party_number VARCHAR(64) NOT NULL,
  party_record_id VARCHAR(128) NOT NULL,
  patta_number INTEGER NOT NULL,
  qty NUMERIC NOT NULL,
  size VARCHAR(64),
  color VARCHAR(64),
  konveyer VARCHAR(64),
  status VARCHAR(32) NOT NULL DEFAULT 'CONFIRMED',
  is_closed INTEGER NOT NULL DEFAULT 0,
  submitted_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  server_revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, id),
  CONSTRAINT fk_tickets_model FOREIGN KEY (company_id, model_id) REFERENCES models(company_id, id),
  CONSTRAINT ck_tickets_id_rfc4122
    CHECK (id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
CREATE INDEX IF NOT EXISTS idx_tickets_comp ON tickets(company_id);
CREATE INDEX IF NOT EXISTS idx_tickets_party ON tickets(company_id, party_number);
CREATE INDEX IF NOT EXISTS idx_tickets_party_record ON tickets(company_id, party_record_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'tickets'::regclass AND conname = 'fk_tickets_model'
  ) THEN
    ALTER TABLE tickets ADD CONSTRAINT fk_tickets_model
      FOREIGN KEY (company_id, model_id) REFERENCES models(company_id, id) NOT VALID;
  END IF;
END
$$;
ALTER TABLE tickets VALIDATE CONSTRAINT fk_tickets_model;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'tickets'::regclass AND conname = 'ck_tickets_id_rfc4122'
  ) THEN
    ALTER TABLE tickets ADD CONSTRAINT ck_tickets_id_rfc4122
      CHECK (id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') NOT VALID;
  END IF;
END
$$;
ALTER TABLE tickets VALIDATE CONSTRAINT ck_tickets_id_rfc4122;

-- 6. Authoritative Ticket Entries Table
CREATE TABLE IF NOT EXISTS ticket_entries (
  id VARCHAR(128) NOT NULL,
  ticket_id VARCHAR(128) NOT NULL,
  company_id VARCHAR(64) NOT NULL,
  op_name TEXT NOT NULL,
  worker_id INTEGER NOT NULL,
  worker_name_snapshot TEXT,
  rate_snapshot NUMERIC,
  brak TEXT,
  qty NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, ticket_id) REFERENCES tickets(company_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_entries_worker FOREIGN KEY (company_id, worker_id) REFERENCES workers(company_id, id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_entries_ticket ON ticket_entries(company_id, ticket_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ticket_entries'::regclass AND conname = 'fk_ticket_entries_worker'
  ) THEN
    ALTER TABLE ticket_entries ADD CONSTRAINT fk_ticket_entries_worker
      FOREIGN KEY (company_id, worker_id) REFERENCES workers(company_id, id) NOT VALID;
  END IF;
END
$$;
ALTER TABLE ticket_entries VALIDATE CONSTRAINT fk_ticket_entries_worker;

-- 7. Authoritative Production Adjustments Table
CREATE TABLE IF NOT EXISTS production_adjustments (
  adjustment_id VARCHAR(128) NOT NULL,
  company_id VARCHAR(64) NOT NULL,
  model_id VARCHAR(128) NOT NULL,
  worker_id INTEGER NOT NULL,
  op_name TEXT NOT NULL,
  delta_qty NUMERIC NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'APPROVED', -- 'APPROVED', 'REVERSED'
  server_revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL,
  original_adjustment_id VARCHAR(128),
  PRIMARY KEY (company_id, adjustment_id)
);
CREATE INDEX IF NOT EXISTS idx_prod_adj_comp ON production_adjustments(company_id);

-- 8. Authoritative Party Sequence Leases Table
CREATE TABLE IF NOT EXISTS party_sequence_leases (
  lease_id VARCHAR(128) PRIMARY KEY,
  company_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(128) NOT NULL,
  range_start INTEGER NOT NULL,
  range_end INTEGER NOT NULL,
  next_value INTEGER NOT NULL,
  issued_at_server TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at_server TIMESTAMPTZ NOT NULL,
  revoked_at_server TIMESTAMPTZ,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' -- 'ACTIVE', 'EXHAUSTED', 'REVOKED'
);
CREATE INDEX IF NOT EXISTS idx_party_leases_comp ON party_sequence_leases(company_id, status);

-- 9. Authoritative Registered Devices Table
CREATE TABLE IF NOT EXISTS server_devices (
  device_id VARCHAR(128) PRIMARY KEY,
  company_id VARCHAR(64) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  client_version VARCHAR(32) NOT NULL,
  is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_server_devices_comp ON server_devices(company_id);

-- 10. Authoritative operator identities and device-bound sessions
CREATE TABLE IF NOT EXISTS server_operators (
  operator_id VARCHAR(128) PRIMARY KEY,
  company_id VARCHAR(64) NOT NULL,
  display_name TEXT NOT NULL,
  role VARCHAR(32) NOT NULL CHECK (role IN ('admin', 'accountant')),
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_server_operators_company ON server_operators(company_id, is_active);

CREATE TABLE IF NOT EXISTS operator_sessions (
  session_id UUID PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  operator_id VARCHAR(128) NOT NULL REFERENCES server_operators(operator_id),
  company_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(128) NOT NULL REFERENCES server_devices(device_id),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_scope ON operator_sessions(operator_id, company_id, device_id);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_expiry ON operator_sessions(expires_at);

CREATE TABLE IF NOT EXISTS operator_login_attempts (
  company_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(128) NOT NULL,
  operator_key CHAR(64) NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0,
  window_expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, device_id, operator_key),
  CONSTRAINT operator_login_attempts_failed_count_check CHECK (failed_count >= 0),
  CONSTRAINT operator_login_attempts_operator_key_check CHECK (operator_key ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_operator_login_attempts_expiry ON operator_login_attempts(window_expires_at);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'operator_login_attempts'::regclass
      AND conname = 'operator_login_attempts_failed_count_check'
  ) THEN
    ALTER TABLE operator_login_attempts
      ADD CONSTRAINT operator_login_attempts_failed_count_check CHECK (failed_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'operator_login_attempts'::regclass
      AND conname = 'operator_login_attempts_operator_key_check'
  ) THEN
    ALTER TABLE operator_login_attempts
      ADD CONSTRAINT operator_login_attempts_operator_key_check CHECK (operator_key ~ '^[0-9a-f]{64}$');
  END IF;
END
$$;

-- 10. Authoritative Parties Table (Option D: Active-Party Uniqueness / INV-05)
CREATE TABLE IF NOT EXISTS parties (
  id VARCHAR(128) NOT NULL,
  company_id VARCHAR(64) NOT NULL,
  party_number VARCHAR(64) NOT NULL,
  physical_party_number VARCHAR(64) NOT NULL,
  model_id VARCHAR(128) NOT NULL,
  model_name TEXT,
  color VARCHAR(64),
  patta_count INTEGER NOT NULL DEFAULT 0,
  cumulative_patta_count INTEGER NOT NULL DEFAULT 0,
  patta_start_number INTEGER,
  patta_end_number INTEGER,
  ish_soni_per_patta NUMERIC,
  total_ish_soni NUMERIC,
  ish_soni NUMERIC NOT NULL DEFAULT 0,
  cumulative_ish_soni NUMERIC NOT NULL DEFAULT 0,
  sizes_json JSONB,
  printed_at TIMESTAMPTZ,
  is_closed INTEGER NOT NULL DEFAULT 0,
  closed_at TIMESTAMPTZ,
  archived_patta_numbers_json JSONB,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'CLOSED'
  server_revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS idx_parties_comp ON parties(company_id);
CREATE INDEX IF NOT EXISTS idx_parties_model ON parties(company_id, model_id);
CREATE INDEX IF NOT EXISTS idx_parties_num ON parties(company_id, party_number);
CREATE TABLE IF NOT EXISTS model_id_aliases (
  company_id VARCHAR(64) NOT NULL,
  legacy_model_id VARCHAR(128) NOT NULL,
  canonical_model_id VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, legacy_model_id),
  UNIQUE (company_id, canonical_model_id)
);
CREATE TABLE IF NOT EXISTS company_patta_sequences (
  company_id VARCHAR(64) PRIMARY KEY,
  next_patta_number BIGINT NOT NULL CHECK (next_patta_number > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS protected_party_patta_ranges (
  company_id VARCHAR(64) NOT NULL,
  party_record_id VARCHAR(128) NOT NULL,
  patta_start_number BIGINT NOT NULL CHECK (patta_start_number > 0),
  patta_end_number BIGINT NOT NULL CHECK (patta_end_number >= patta_start_number),
  PRIMARY KEY (company_id, party_record_id)
);
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS fk_tickets_party_record;
ALTER TABLE tickets ADD CONSTRAINT fk_tickets_party_record
  FOREIGN KEY (company_id, party_record_id) REFERENCES parties(company_id, id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION prevent_party_identity_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'IMMUTABLE_PARTY_IDENTITY: parties.id and parties.company_id cannot be modified';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_parties_identity_immutable ON parties;
CREATE TRIGGER trg_parties_identity_immutable
BEFORE UPDATE ON parties
FOR EACH ROW
EXECUTE FUNCTION prevent_party_identity_mutation();

CREATE TABLE IF NOT EXISTS periods (
  id VARCHAR(128) NOT NULL,
  company_id VARCHAR(64) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  is_closed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS idx_periods_company_dates ON periods(company_id, start_date, end_date);

-- 11. Historical Party Collision Provenance (never an eligibility authority)
CREATE TABLE IF NOT EXISTS legacy_party_collision_exceptions (
  exception_id VARCHAR(128) PRIMARY KEY,
  company_id VARCHAR(64) NOT NULL,
  party_number VARCHAR(64) NOT NULL,
  party_id VARCHAR(128) NOT NULL,
  collision_group_id VARCHAR(128) NOT NULL,
  approved_by VARCHAR(128) NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE', -- provenance only; never an eligibility decision
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, party_id)
);
CREATE INDEX IF NOT EXISTS idx_legacy_exceptions_lookup ON legacy_party_collision_exceptions(company_id, party_number, status);

-- 12. Active-Party Uniqueness Enforcement Function & Trigger
-- Enforces at most one non-CLOSED party per company + party_number. The only
-- exception is the two exact persisted Party #2 rows below. The provenance
-- table is intentionally not consulted for eligibility.
CREATE OR REPLACE FUNCTION check_active_party_uniqueness()
RETURNS TRIGGER AS $$
DECLARE
  v_other_active_count INTEGER := 0;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
    RAISE EXCEPTION 'IMMUTABLE_PARTY_IDENTITY: parties.id and parties.company_id cannot be modified';
  END IF;

  IF NEW.status != 'CLOSED' THEN
    -- Serialize all authoritative checks for this company and party number.
    PERFORM pg_advisory_xact_lock(hashtext(NEW.company_id || ':party:' || NEW.party_number));

    -- CLOSE_PENDING and every other non-CLOSED status reserve the number.
    SELECT COUNT(*) INTO v_other_active_count
    FROM parties
    WHERE company_id = NEW.company_id
      AND party_number = NEW.party_number
      AND status != 'CLOSED'
      AND id != NEW.id;

    IF v_other_active_count > 0 AND NOT EXISTS (
      SELECT 1
      FROM legacy_party_collision_exceptions current_exception
      JOIN legacy_party_collision_exceptions other_exception
        ON other_exception.company_id = current_exception.company_id
       AND other_exception.party_number = current_exception.party_number
       AND other_exception.collision_group_id = current_exception.collision_group_id
       AND other_exception.party_id <> current_exception.party_id
      JOIN parties other_party
        ON other_party.company_id = other_exception.company_id
       AND other_party.id = other_exception.party_id
      WHERE current_exception.company_id = NEW.company_id
        AND current_exception.party_id = NEW.id
        AND current_exception.party_number = NEW.party_number
        AND current_exception.status = 'ACTIVE'
        AND other_exception.status = 'ACTIVE'
        AND other_party.status != 'CLOSED'
        AND v_other_active_count = 1
        AND (
          SELECT COUNT(*) FROM legacy_party_collision_exceptions group_exception
          WHERE group_exception.company_id = current_exception.company_id
            AND group_exception.party_number = current_exception.party_number
            AND group_exception.collision_group_id = current_exception.collision_group_id
            AND group_exception.status = 'ACTIVE'
        ) = 2
    ) THEN
      RAISE EXCEPTION 'ACTIVE_PARTY_EXISTS: Active party #% already exists for company %', NEW.party_number, NEW.company_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_parties_active_uniqueness ON parties;
CREATE TRIGGER trg_parties_active_uniqueness
BEFORE INSERT OR UPDATE OF id, company_id, status, party_number ON parties
FOR EACH ROW
EXECUTE FUNCTION check_active_party_uniqueness();

-- 13. Operator Resolution Audit Trail Table for Historical Collisions
CREATE TABLE IF NOT EXISTS migration_party_resolutions (
  resolution_id VARCHAR(128) PRIMARY KEY,
  quarantine_id VARCHAR(128) NOT NULL,
  company_id VARCHAR(64) NOT NULL,
  party_id VARCHAR(128) NOT NULL,
  decision VARCHAR(64) NOT NULL,
  operator_id VARCHAR(128) NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  source_snapshot_hash CHAR(64) NOT NULL,
  reason TEXT NOT NULL,
  original_is_closed INTEGER NOT NULL DEFAULT 0,
  original_closed_at TIMESTAMPTZ,
  resolution_provenance VARCHAR(64) NOT NULL DEFAULT 'OPERATOR_MIGRATION_DECISION',
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_party_res_quar ON migration_party_resolutions(quarantine_id);
CREATE INDEX IF NOT EXISTS idx_party_res_comp_party ON migration_party_resolutions(company_id, party_id);

-- 14. Authoritative Reconciliation Candidates Table
CREATE TABLE IF NOT EXISTS migration_reconciliation_candidates (
  candidate_id VARCHAR(128) NOT NULL,
  company_id VARCHAR(64) NOT NULL,
  model_id VARCHAR(128) NOT NULL,
  worker_id INTEGER NOT NULL,
  operation_name TEXT NOT NULL,
  legacy_qty NUMERIC NOT NULL,
  ticket_derived_qty NUMERIC NOT NULL,
  delta_qty NUMERIC NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING_REVIEW', -- 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'LINKED_SOURCE_PENDING'
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

-- 15. Reconciliation Resolution Audit Trail Table
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

-- 16. Immutability Trigger for Reconciliation Resolutions
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

-- 17. Owner-approved clean baseline records (migration-only, never a public write route)
CREATE TABLE IF NOT EXISTS migration_baseline_decisions (
  baseline_decision_id VARCHAR(160) PRIMARY KEY,
  company_id VARCHAR(64) NOT NULL,
  decision VARCHAR(64) NOT NULL CHECK (decision = 'CLEAN_PRODUCTION_LEDGER_BASELINE'),
  scope_json JSONB NOT NULL,
  source_path TEXT NOT NULL,
  source_size BIGINT NOT NULL,
  source_mtime TIMESTAMPTZ NOT NULL,
  source_snapshot_hash CHAR(64) NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, source_snapshot_hash, decision)
);

CREATE TABLE IF NOT EXISTS baseline_import_runs (
  baseline_import_run_id VARCHAR(160) NOT NULL,
  company_id VARCHAR(64) NOT NULL,
  source_snapshot_hash CHAR(64) NOT NULL,
  baseline_decision_id VARCHAR(160) NOT NULL REFERENCES migration_baseline_decisions(baseline_decision_id),
  status VARCHAR(32) NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, baseline_import_run_id, source_snapshot_hash, baseline_decision_id)
);

CREATE TABLE IF NOT EXISTS worker_adjustments (
  id VARCHAR(160) PRIMARY KEY,
  company_id VARCHAR(64) NOT NULL,
  worker_id INTEGER NOT NULL,
  type VARCHAR(16) NOT NULL CHECK (type IN ('AVANS', 'JARIMA')),
  amount NUMERIC NOT NULL,
  source_id VARCHAR(160) NOT NULL,
  provenance VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (company_id, worker_id) REFERENCES workers(company_id, id)
);

CREATE TABLE IF NOT EXISTS printed_pattas (
  id VARCHAR(160) NOT NULL,
  company_id VARCHAR(64) NOT NULL,
  legacy_source_id VARCHAR(160),
  party_record_id VARCHAR(128) NOT NULL,
  party_number VARCHAR(64) NOT NULL,
  patta_number INTEGER NOT NULL,
  model_id VARCHAR(128) NOT NULL,
  model_name TEXT,
  model_code TEXT,
  color TEXT,
  planned_qty NUMERIC,
  size_json JSONB,
  printed_at TIMESTAMPTZ,
  issue_state TEXT,
  operator_metadata_json JSONB,
  model_snapshot_json JSONB NOT NULL,
  source_provenance VARCHAR(64) NOT NULL,
  PRIMARY KEY(company_id, id),
  FOREIGN KEY (company_id, party_record_id) REFERENCES parties(company_id, id),
  FOREIGN KEY (company_id, model_id) REFERENCES models(company_id, id)
);

CREATE TABLE IF NOT EXISTS printed_patta_operations (
  company_id VARCHAR(64) NOT NULL,
  patta_id VARCHAR(160) NOT NULL,
  operation_index INTEGER NOT NULL,
  operation_id VARCHAR(128),
  operation_name TEXT NOT NULL,
  operation_rate NUMERIC,
  operation_snapshot_json JSONB NOT NULL,
  PRIMARY KEY(company_id, patta_id, operation_index),
  FOREIGN KEY (company_id, patta_id) REFERENCES printed_pattas(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS migration_baseline_exclusions (
  exclusion_id VARCHAR(200) PRIMARY KEY,
  company_id VARCHAR(64) NOT NULL,
  baseline_decision_id VARCHAR(160) NOT NULL REFERENCES migration_baseline_decisions(baseline_decision_id),
  category VARCHAR(96) NOT NULL,
  source_reference TEXT NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  source_snapshot_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION prevent_baseline_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_BASELINE_RECORD: owner baseline records cannot be modified or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_baseline_decision_immutable ON migration_baseline_decisions;
CREATE TRIGGER trg_baseline_decision_immutable
BEFORE UPDATE OR DELETE ON migration_baseline_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_baseline_mutation();

INSERT INTO schema_migrations (version, name)
VALUES (1, 'schema.sql')
ON CONFLICT (version) DO NOTHING;
