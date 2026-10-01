-- Deployable PostgreSQL Migration for Phase 2 Active-Party Uniqueness & Ticket Identity
-- Historical Party #2 provenance is retained, but never grants eligibility.
-- Safe, idempotent, transactional migration for existing Step 4 databases

BEGIN;

-- 1. Create parties table if not exists with authoritative active-party uniqueness schema
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
  ish_soni_per_patta NUMERIC,
  total_ish_soni NUMERIC,
  ish_soni NUMERIC NOT NULL DEFAULT 0,
  cumulative_ish_soni NUMERIC NOT NULL DEFAULT 0,
  sizes_json JSONB,
  printed_at TIMESTAMPTZ,
  is_closed INTEGER NOT NULL DEFAULT 0,
  closed_at TIMESTAMPTZ,
  archived_patta_numbers_json JSONB,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE', -- every status except CLOSED reserves the number
  server_revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, id)
);

CREATE INDEX IF NOT EXISTS idx_parties_comp ON parties(company_id);
CREATE INDEX IF NOT EXISTS idx_parties_model ON parties(company_id, model_id);
CREATE INDEX IF NOT EXISTS idx_parties_num ON parties(company_id, party_number);

-- 2. Grandfather Exception Table: legacy_party_collision_exceptions
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

-- Serialize migration preflight and trigger replacement against party writes.
LOCK TABLE parties IN ACCESS EXCLUSIVE MODE;

-- 3. Migration Detection, Verification & Historical Provenance Registration
DO $$
DECLARE
  v_rec1_exists BOOLEAN;
  v_rec2_exists BOOLEAN;
  v_comp1 VARCHAR(64);
  v_comp2 VARCHAR(64);
  v_group RECORD;
  v_exact_active_count INTEGER;
BEGIN
  -- Record the exact historical IDs only as provenance.
  SELECT EXISTS (SELECT 1 FROM parties WHERE id = 'rec_1788774889449_vrbkv' AND party_number = '2' AND status != 'CLOSED') INTO v_rec1_exists;
  SELECT EXISTS (SELECT 1 FROM parties WHERE id = 'rec_1788930871307_cg1iv' AND party_number = '2' AND status != 'CLOSED') INTO v_rec2_exists;

  IF v_rec1_exists THEN
    SELECT company_id INTO v_comp1 FROM parties WHERE id = 'rec_1788774889449_vrbkv';
    INSERT INTO legacy_party_collision_exceptions (
      exception_id, company_id, party_number, party_id, collision_group_id,
      approved_by, approved_at, reason, status
    ) VALUES (
      'exc_' || v_comp1 || '_rec_1788774889449_vrbkv',
      v_comp1,
      '2',
      'rec_1788774889449_vrbkv',
      'col_group_' || v_comp1 || '_party_2',
      'OWNER_BUSINESS_DECISION',
      NOW(),
       'Historical exact Party #2 provenance; eligibility is determined only from persisted Party rows.',
      'ACTIVE'
    ) ON CONFLICT (company_id, party_id) DO NOTHING;
  END IF;

  IF v_rec2_exists THEN
    SELECT company_id INTO v_comp2 FROM parties WHERE id = 'rec_1788930871307_cg1iv';
    INSERT INTO legacy_party_collision_exceptions (
      exception_id, company_id, party_number, party_id, collision_group_id,
      approved_by, approved_at, reason, status
    ) VALUES (
      'exc_' || v_comp2 || '_rec_1788930871307_cg1iv',
      v_comp2,
      '2',
      'rec_1788930871307_cg1iv',
      'col_group_' || v_comp2 || '_party_2',
      'OWNER_BUSINESS_DECISION',
      NOW(),
       'Historical exact Party #2 provenance; eligibility is determined only from persisted Party rows.',
      'ACTIVE'
    ) ON CONFLICT (company_id, party_id) DO NOTHING;
  END IF;

  -- Fail closed on every duplicate group except two independently persisted
  -- exact IDs in the same company, number 2, and non-CLOSED state.
  FOR v_group IN
    SELECT company_id, party_number, COUNT(*) AS active_count
    FROM parties
    WHERE status != 'CLOSED'
    GROUP BY company_id, party_number
    HAVING COUNT(*) > 1
  LOOP
    SELECT COUNT(*) INTO v_exact_active_count
    FROM parties
    WHERE company_id = v_group.company_id
      AND party_number = '2'
      AND status != 'CLOSED'
      AND id IN ('rec_1788774889449_vrbkv', 'rec_1788930871307_cg1iv');

    IF v_group.party_number <> '2' OR v_group.active_count <> 2 OR v_exact_active_count <> 2 THEN
      RAISE EXCEPTION 'MIGRATION BLOCKED: Unexpected non-CLOSED duplicate for company % party %', v_group.company_id, v_group.party_number;
    END IF;
  END LOOP;
END $$;

-- 4. Drop obsolete plain partial unique index if it exists
DROP INDEX IF EXISTS idx_parties_active_unique;

-- 5. Install exact persisted-row trigger function and trigger
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

    -- Every status other than CLOSED, including CLOSE_PENDING, reserves it.
    SELECT COUNT(*) INTO v_other_active_count
    FROM parties
    WHERE company_id = NEW.company_id
      AND party_number = NEW.party_number
      AND status != 'CLOSED'
      AND id != NEW.id;

    IF v_other_active_count > 0 AND NOT (
      NEW.party_number = '2'
      AND NEW.id IN ('rec_1788774889449_vrbkv', 'rec_1788930871307_cg1iv')
      AND v_other_active_count = 1
      AND EXISTS (
        SELECT 1 FROM parties p
        WHERE p.company_id = NEW.company_id
          AND p.party_number = '2'
          AND p.status != 'CLOSED'
          AND p.id != NEW.id
          AND p.id IN ('rec_1788774889449_vrbkv', 'rec_1788930871307_cg1iv')
      )
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

-- 6. Decommission obsolete compound business key constraint from tickets
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS uq_tickets_business_key;

-- 7. Add index for party_record_id lookups on tickets
CREATE INDEX IF NOT EXISTS idx_tickets_party_record ON tickets(company_id, party_record_id);

-- 8. Operator Resolution Audit Trail Table for Historical Collisions
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

INSERT INTO schema_migrations (version, name)
VALUES (2, 'deploy_active_party_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
