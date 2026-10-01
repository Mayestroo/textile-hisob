-- Forward-only PostgreSQL correction for the exact persisted Party #2 policy.
-- Exception rows remain historical provenance and are never consulted below.

BEGIN;

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
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  server_revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, id)
);

CREATE TABLE IF NOT EXISTS legacy_party_collision_exceptions (
  exception_id VARCHAR(128) PRIMARY KEY,
  company_id VARCHAR(64) NOT NULL,
  party_number VARCHAR(64) NOT NULL,
  party_id VARCHAR(128) NOT NULL,
  collision_group_id VARCHAR(128) NOT NULL,
  approved_by VARCHAR(128) NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, party_id)
);

CREATE INDEX IF NOT EXISTS idx_parties_comp ON parties(company_id);
CREATE INDEX IF NOT EXISTS idx_parties_model ON parties(company_id, model_id);
CREATE INDEX IF NOT EXISTS idx_parties_num ON parties(company_id, party_number);
CREATE INDEX IF NOT EXISTS idx_legacy_exceptions_lookup
  ON legacy_party_collision_exceptions(company_id, party_number, status);

-- Serialize migration preflight and trigger replacement against party writes.
LOCK TABLE parties IN ACCESS EXCLUSIVE MODE;

DROP INDEX IF EXISTS idx_parties_active_unique;

-- Preflight is deterministic and fail-closed. It never closes, renames, or
-- rewrites historical rows and never treats exception-table state as proof.
DO $$
DECLARE
  v_group RECORD;
  v_exact_active_count INTEGER;
BEGIN
  FOR v_group IN
    SELECT company_id, party_number, COUNT(*) AS active_count
    FROM parties
    WHERE status != 'CLOSED'
    GROUP BY company_id, party_number
    HAVING COUNT(*) > 1
    ORDER BY company_id, party_number
  LOOP
    SELECT COUNT(*) INTO v_exact_active_count
    FROM parties
    WHERE company_id = v_group.company_id
      AND party_number = '2'
      AND status != 'CLOSED'
      AND id IN ('rec_1788774889449_vrbkv', 'rec_1788930871307_cg1iv');

    IF v_group.party_number <> '2' OR v_group.active_count <> 2 OR v_exact_active_count <> 2 THEN
      RAISE EXCEPTION 'EXACT_PARTY_2_POLICY_MIGRATION_BLOCKED: unexpected non-CLOSED duplicate for company % party %', v_group.company_id, v_group.party_number;
    END IF;
  END LOOP;
END $$;

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
    PERFORM pg_advisory_xact_lock(hashtext(NEW.company_id || ':party:' || NEW.party_number));

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

INSERT INTO schema_migrations (version, name)
VALUES (7, 'deploy_exact_party_2_policy_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
