-- Version 12: bind the exact historical Party #2 pair to its production company.
-- This is a schema-only correction; it does not rewrite or resolve business rows.
BEGIN;

LOCK TABLE parties IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  v_group RECORD;
  v_exact_count INTEGER;
BEGIN
  FOR v_group IN
    SELECT company_id, party_number, COUNT(*) AS active_count
    FROM parties
    WHERE status != 'CLOSED'
    GROUP BY company_id, party_number
    HAVING COUNT(*) > 1
    ORDER BY company_id, party_number
  LOOP
    SELECT COUNT(*) INTO v_exact_count
    FROM parties
    WHERE company_id = 'comp_novda'
      AND party_number = '2'
      AND status != 'CLOSED'
      AND id IN ('rec_1788774889449_vrbkv', 'rec_1788930871307_cg1iv');

    IF v_group.company_id <> 'comp_novda'
      OR v_group.party_number <> '2'
      OR v_group.active_count <> 2
      OR v_exact_count <> 2 THEN
      RAISE EXCEPTION
        'EXACT_PARTY_2_COMPANY_SCOPE_MIGRATION_BLOCKED: unexpected active duplicate for company % party %',
        v_group.company_id, v_group.party_number;
    END IF;
  END LOOP;
END $$;

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
      NEW.company_id = 'comp_novda'
      AND NEW.party_number = '2'
      AND NEW.id IN ('rec_1788774889449_vrbkv', 'rec_1788930871307_cg1iv')
      AND v_other_active_count = 1
      AND EXISTS (
        SELECT 1 FROM parties p
        WHERE p.company_id = 'comp_novda'
          AND p.company_id = NEW.company_id
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
VALUES (12, 'deploy_exact_party_2_company_scope_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
