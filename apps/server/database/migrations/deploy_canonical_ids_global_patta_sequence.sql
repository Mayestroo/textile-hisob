-- Version 16: canonical UUID identities and company-wide patta allocation.
BEGIN;

LOCK TABLE models, parties IN ACCESS EXCLUSIVE MODE;

ALTER TABLE parties ADD COLUMN IF NOT EXISTS patta_start_number BIGINT;
ALTER TABLE parties ADD COLUMN IF NOT EXISTS patta_end_number BIGINT;

CREATE TABLE IF NOT EXISTS model_id_aliases (
  company_id VARCHAR(64) NOT NULL,
  legacy_model_id VARCHAR(128) NOT NULL,
  canonical_model_id VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, legacy_model_id),
  UNIQUE (company_id, canonical_model_id)
);

CREATE TABLE IF NOT EXISTS party_id_aliases (
  company_id VARCHAR(64) NOT NULL,
  legacy_party_id VARCHAR(128) NOT NULL,
  canonical_party_id VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, legacy_party_id),
  UNIQUE (company_id, canonical_party_id)
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

-- Snapshot existing duplicate groups into data-managed approvals before replacing
-- the historical row-ID policy. Only already-persisted pairs are grandfathered.
DO $$
DECLARE
  v_group RECORD;
  v_collision_group_id TEXT;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  FOR v_group IN
    SELECT company_id, party_number, COUNT(*) AS active_count
    FROM parties
    WHERE status != 'CLOSED'
    GROUP BY company_id, party_number
    HAVING COUNT(*) > 1
    ORDER BY company_id, party_number
  LOOP
    IF v_group.active_count <> 2 THEN
      RAISE EXCEPTION 'ACTIVE_PARTY_MIGRATION_BLOCKED: expected two pre-existing rows for company % party %',
        v_group.company_id, v_group.party_number;
    END IF;
    v_collision_group_id := gen_random_uuid()::text;
    INSERT INTO legacy_party_collision_exceptions (
      exception_id, company_id, party_number, party_id, collision_group_id,
      approved_by, approved_at, reason, status
    )
    SELECT gen_random_uuid()::text, p.company_id, p.party_number, p.id, v_collision_group_id,
      'schema-migration', v_now, 'Existing active collision preserved as persisted approval', 'ACTIVE'
    FROM parties p
    WHERE p.company_id = v_group.company_id
      AND p.party_number = v_group.party_number
      AND p.status != 'CLOSED'
    ON CONFLICT (company_id, party_id) DO UPDATE SET
      collision_group_id = EXCLUDED.collision_group_id,
      status = 'ACTIVE';
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
    SELECT COUNT(*) INTO v_other_active_count FROM parties
    WHERE company_id = NEW.company_id AND party_number = NEW.party_number
      AND status != 'CLOSED' AND id != NEW.id;
    IF v_other_active_count > 0 AND NOT EXISTS (
      SELECT 1 FROM legacy_party_collision_exceptions current_exception
      JOIN legacy_party_collision_exceptions other_exception
        ON other_exception.company_id = current_exception.company_id
       AND other_exception.party_number = current_exception.party_number
       AND other_exception.collision_group_id = current_exception.collision_group_id
       AND other_exception.party_id <> current_exception.party_id
      JOIN parties other_party
        ON other_party.company_id = other_exception.company_id AND other_party.id = other_exception.party_id
      WHERE current_exception.company_id = NEW.company_id
        AND current_exception.party_id = NEW.id
        AND current_exception.party_number = NEW.party_number
        AND current_exception.status = 'ACTIVE' AND other_exception.status = 'ACTIVE'
        AND other_party.status != 'CLOSED' AND v_other_active_count = 1
        AND (SELECT COUNT(*) FROM legacy_party_collision_exceptions group_exception
          WHERE group_exception.company_id = current_exception.company_id
            AND group_exception.party_number = current_exception.party_number
            AND group_exception.collision_group_id = current_exception.collision_group_id
            AND group_exception.status = 'ACTIVE') = 2
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
FOR EACH ROW EXECUTE FUNCTION check_active_party_uniqueness();

-- Normalize older rows whose source contains only the party total.
DO $$
DECLARE
  v_invalid TEXT;
BEGIN
  SELECT string_agg(format('(%L,%L)', company_id, id), ', ' ORDER BY company_id, id)
  INTO v_invalid
  FROM parties
  WHERE patta_count > 0
    AND (ish_soni_per_patta IS NULL OR ish_soni_per_patta <= 0)
    AND (ish_soni IS NULL OR ish_soni <= 0 OR mod(ish_soni, patta_count) <> 0);
  IF v_invalid IS NOT NULL THEN
    RAISE EXCEPTION 'PATTA_WORK_QUANTITY_MIGRATION_BLOCKED: invalid source totals for %', v_invalid;
  END IF;
  UPDATE parties
  SET ish_soni_per_patta = ish_soni / patta_count,
      total_ish_soni = ish_soni
  WHERE patta_count > 0
    AND ish_soni_per_patta IS NULL;
END $$;

-- Make existing identity foreign keys deferrable while both ends of each
-- company-scoped reference are remapped inside this transaction.
DO $$
DECLARE
  v_constraint RECORD;
BEGIN
  FOR v_constraint IN
    SELECT conrelid::regclass AS relation_name, conname
    FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid IN ('models'::regclass, 'parties'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED',
      v_constraint.relation_name, v_constraint.conname);
  END LOOP;
END $$;
SET CONSTRAINTS ALL DEFERRED;

CREATE OR REPLACE FUNCTION canonical_entity_uuid(entity_type TEXT, company_key TEXT, previous_id TEXT)
RETURNS UUID AS $$
  WITH hashed AS (
    SELECT md5(entity_type || chr(31) || company_key || chr(31) || previous_id) AS value
  )
  SELECT (
    substr(value, 1, 8) || '-' || substr(value, 9, 4) || '-3' || substr(value, 14, 3) || '-'
    || substr('89ab', ((strpos('0123456789abcdef', substr(value, 17, 1)) - 1) % 4) + 1, 1)
    || substr(value, 18, 3) || '-' || substr(value, 21, 12)
  )::uuid FROM hashed;
$$ LANGUAGE SQL IMMUTABLE STRICT;

CREATE TEMP TABLE model_id_remap ON COMMIT DROP AS
SELECT company_id, id AS old_id, canonical_entity_uuid('model', company_id, id)::text AS new_id
FROM models
WHERE id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

CREATE TEMP TABLE party_id_remap ON COMMIT DROP AS
SELECT p.company_id, p.id AS old_id, canonical_entity_uuid('party', p.company_id, p.id)::text AS new_id
FROM parties p
WHERE p.status != 'CLOSED' AND p.is_archived = FALSE
  AND p.id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND NOT EXISTS (
    SELECT 1 FROM legacy_party_collision_exceptions e
    WHERE e.company_id = p.company_id AND e.party_id = p.id
      AND e.party_number = p.party_number AND e.status = 'ACTIVE'
  );

-- Keep a compact alias map for already-issued change-feed events; current rows
-- and every new write use canonical UUIDs.
INSERT INTO model_id_aliases(company_id, legacy_model_id, canonical_model_id)
SELECT m.company_id, m.old_id, m.new_id
FROM model_id_remap m
ON CONFLICT (company_id, legacy_model_id) DO UPDATE SET canonical_model_id = EXCLUDED.canonical_model_id;

INSERT INTO party_id_aliases(company_id, legacy_party_id, canonical_party_id)
SELECT company_id, old_id, new_id FROM party_id_remap
ON CONFLICT (company_id, legacy_party_id) DO UPDATE SET canonical_party_id = EXCLUDED.canonical_party_id;

UPDATE parties p SET model_id = m.new_id
FROM model_id_remap m
WHERE p.company_id = m.company_id AND p.model_id = m.old_id
  AND NOT EXISTS (
    SELECT 1 FROM legacy_party_collision_exceptions e
    WHERE e.company_id = p.company_id AND e.party_id = p.id
      AND e.party_number = p.party_number AND e.status = 'ACTIVE'
  );
UPDATE tickets t SET model_id = m.new_id FROM model_id_remap m
WHERE t.company_id = m.company_id AND t.model_id = m.old_id;
UPDATE production_adjustments a SET model_id = m.new_id FROM model_id_remap m
WHERE a.company_id = m.company_id AND a.model_id = m.old_id;
UPDATE patta_batch_settings b SET model_id = m.new_id FROM model_id_remap m
WHERE b.company_id = m.company_id AND b.model_id = m.old_id;
UPDATE printed_pattas p SET model_id = m.new_id FROM model_id_remap m
WHERE p.company_id = m.company_id AND p.model_id = m.old_id;
UPDATE migration_quarantine_parties q SET model_id = m.new_id FROM model_id_remap m
WHERE q.company_id = m.company_id AND q.model_id = m.old_id;
UPDATE migration_quarantine_tickets q SET model_id = m.new_id FROM model_id_remap m
WHERE q.company_id = m.company_id AND q.model_id = m.old_id;
UPDATE migration_reconciliation_candidates q SET model_id = m.new_id FROM model_id_remap m
WHERE q.company_id = m.company_id AND q.model_id = m.old_id;

UPDATE models m SET id = r.new_id FROM model_id_remap r
WHERE m.company_id = r.company_id AND m.id = r.old_id;

DROP TRIGGER IF EXISTS trg_parties_identity_immutable ON parties;
UPDATE tickets t SET party_record_id = r.new_id FROM party_id_remap r
WHERE t.company_id = r.company_id AND t.party_record_id = r.old_id;
UPDATE printed_pattas p SET party_record_id = r.new_id FROM party_id_remap r
WHERE p.company_id = r.company_id AND p.party_record_id = r.old_id;
UPDATE migration_party_resolutions q SET party_id = r.new_id FROM party_id_remap r
WHERE q.company_id = r.company_id AND q.party_id = r.old_id;
UPDATE migration_quarantine_parties q SET resolved_party_id = r.new_id FROM party_id_remap r
WHERE q.company_id = r.company_id AND q.resolved_party_id = r.old_id;
UPDATE parties p SET id = r.new_id FROM party_id_remap r
WHERE p.company_id = r.company_id AND p.id = r.old_id;

CREATE TRIGGER trg_parties_identity_immutable
BEFORE UPDATE ON parties FOR EACH ROW EXECUTE FUNCTION prevent_party_identity_mutation();

-- Retire closed/archived parties and their dependent production rows as the
-- owner requested; retain all active rows and both explicitly protected rows.
DELETE FROM tickets t WHERE EXISTS (
  SELECT 1 FROM parties p WHERE p.company_id = t.company_id AND p.id = t.party_record_id
    AND (p.status = 'CLOSED' OR p.is_archived = TRUE)
);
DELETE FROM printed_pattas pp WHERE EXISTS (
  SELECT 1 FROM parties p WHERE p.company_id = pp.company_id AND p.id = pp.party_record_id
    AND (p.status = 'CLOSED' OR p.is_archived = TRUE)
);
DELETE FROM legacy_party_collision_exceptions e WHERE NOT EXISTS (
  SELECT 1 FROM parties p WHERE p.company_id = e.company_id AND p.id = e.party_id
);
DELETE FROM parties WHERE status = 'CLOSED' OR is_archived = TRUE;
DELETE FROM tickets t WHERE EXISTS (
  SELECT 1 FROM periods p WHERE p.company_id = t.company_id AND p.id = t.period_id
    AND (p.is_closed = 1 OR p.status = 'CLOSED')
);
DELETE FROM worker_adjustments w WHERE EXISTS (
  SELECT 1 FROM periods p WHERE p.company_id = w.company_id AND p.id = w.period_id
    AND (p.is_closed = 1 OR p.status = 'CLOSED')
);
DELETE FROM period_archives a WHERE EXISTS (
  SELECT 1 FROM periods p WHERE p.company_id = a.company_id AND p.id = a.period_id
    AND (p.is_closed = 1 OR p.status = 'CLOSED')
);
DELETE FROM periods WHERE is_closed = 1 OR status = 'CLOSED';

DO $$
DECLARE
  v_company RECORD;
  v_party RECORD;
  v_next BIGINT;
  v_end BIGINT;
BEGIN
  FOR v_company IN SELECT DISTINCT company_id FROM parties ORDER BY company_id LOOP
    v_next := 1;
    FOR v_party IN
      SELECT id, patta_count FROM parties
      WHERE company_id = v_company.company_id
      ORDER BY COALESCE(printed_at, created_at), id
    LOOP
      IF v_party.patta_count <= 0 THEN CONTINUE; END IF;
      v_end := v_next + v_party.patta_count - 1;
      IF NOT EXISTS (
        SELECT 1 FROM legacy_party_collision_exceptions e
        WHERE e.company_id = v_company.company_id AND e.party_id = v_party.id AND e.status = 'ACTIVE'
      ) THEN
        UPDATE parties SET patta_start_number = v_next, patta_end_number = v_end,
          cumulative_patta_count = v_end
        WHERE company_id = v_company.company_id AND id = v_party.id;
      ELSE
        INSERT INTO protected_party_patta_ranges(company_id, party_record_id, patta_start_number, patta_end_number)
        VALUES (v_company.company_id, v_party.id, v_next, v_end)
        ON CONFLICT (company_id, party_record_id) DO UPDATE SET
          patta_start_number = EXCLUDED.patta_start_number,
          patta_end_number = EXCLUDED.patta_end_number;
      END IF;
      v_next := v_end + 1;
    END LOOP;
    INSERT INTO company_patta_sequences(company_id, next_patta_number)
    VALUES (v_company.company_id, v_next)
    ON CONFLICT (company_id) DO UPDATE SET next_patta_number = EXCLUDED.next_patta_number, updated_at = NOW();
  END LOOP;
END $$;

-- Convert ticket-level relative patta input into the assigned company-wide
-- number range after all ranges have been reserved.
UPDATE tickets t
SET patta_number = r.patta_start_number + t.patta_number - 1
FROM (
  SELECT company_id, id AS party_record_id, patta_start_number
  FROM parties WHERE patta_start_number IS NOT NULL
  UNION ALL
  SELECT company_id, party_record_id, patta_start_number
  FROM protected_party_patta_ranges
) r
JOIN parties p ON p.company_id = r.company_id AND p.id = r.party_record_id
WHERE t.company_id = r.company_id AND t.party_record_id = r.party_record_id
  AND t.patta_number BETWEEN 1 AND p.patta_count
  AND r.patta_start_number > 1;

UPDATE printed_pattas pp
SET patta_number = r.patta_start_number + pp.patta_number - 1
FROM (
  SELECT company_id, id AS party_record_id, patta_start_number FROM parties WHERE patta_start_number IS NOT NULL
  UNION ALL
  SELECT company_id, party_record_id, patta_start_number FROM protected_party_patta_ranges
) r
JOIN parties p ON p.company_id = r.company_id AND p.id = r.party_record_id
WHERE pp.company_id = r.company_id AND pp.party_record_id = r.party_record_id
  AND pp.patta_number BETWEEN 1 AND p.patta_count
  AND r.patta_start_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_company_global_patta
  ON tickets(company_id, patta_number) WHERE party_record_id IS NOT NULL;

INSERT INTO schema_migrations(version, name)
VALUES (16, 'deploy_canonical_ids_global_patta_sequence.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
