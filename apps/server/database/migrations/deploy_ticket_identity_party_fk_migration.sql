-- Forward-only, fail-closed migration. Run only by an operator on a confirmed disposable/staged database.
BEGIN;

DO $$
DECLARE bad_records TEXT;
BEGIN
  SELECT string_agg(company_id || '/' || id, ', ' ORDER BY company_id, id) INTO bad_records
  FROM (
     SELECT t.company_id, t.id
     FROM tickets t
     LEFT JOIN parties p ON p.company_id = t.company_id AND p.id = t.party_record_id
     WHERE t.id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR t.party_record_id IS NULL OR btrim(t.party_record_id) = '' OR p.id IS NULL
     ORDER BY t.company_id, t.id LIMIT 20
  ) invalid;
  IF bad_records IS NOT NULL THEN
    RAISE EXCEPTION 'TICKET_IDENTITY_MIGRATION_BLOCKED: repair ticket UUID/party links before migration: %', bad_records;
  END IF;

  SELECT string_agg(company_id || '/' || id, ', ' ORDER BY company_id, id) INTO bad_records
  FROM (
    SELECT t.company_id, t.id
    FROM tickets t
    LEFT JOIN models m ON m.company_id = t.company_id AND m.id = t.model_id
    WHERE m.id IS NULL
    ORDER BY t.company_id, t.id LIMIT 20
  ) invalid_models;
  IF bad_records IS NOT NULL THEN
    RAISE EXCEPTION 'TICKET_MODEL_FK_MIGRATION_BLOCKED: repair ticket model links before migration: %', bad_records;
  END IF;

  SELECT string_agg(company_id || '/' || id, ', ' ORDER BY company_id, id) INTO bad_records
  FROM (
    SELECT e.company_id, e.id
    FROM ticket_entries e
    LEFT JOIN workers w ON w.company_id = e.company_id AND w.id = e.worker_id
    WHERE w.id IS NULL
    ORDER BY e.company_id, e.id LIMIT 20
  ) invalid_workers;
  IF bad_records IS NOT NULL THEN
    RAISE EXCEPTION 'TICKET_ENTRY_WORKER_FK_MIGRATION_BLOCKED: repair ticket entry worker links before migration: %', bad_records;
  END IF;
END $$;

ALTER TABLE tickets ALTER COLUMN party_record_id SET NOT NULL;
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS fk_tickets_party_record;
ALTER TABLE tickets ADD CONSTRAINT fk_tickets_party_record
  FOREIGN KEY (company_id, party_record_id) REFERENCES parties(company_id, id) ON DELETE RESTRICT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'tickets'::regclass AND conname = 'fk_tickets_model'
  ) THEN
    ALTER TABLE tickets ADD CONSTRAINT fk_tickets_model
      FOREIGN KEY (company_id, model_id) REFERENCES models(company_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ticket_entries'::regclass AND conname = 'fk_ticket_entries_worker'
  ) THEN
    ALTER TABLE ticket_entries ADD CONSTRAINT fk_ticket_entries_worker
      FOREIGN KEY (company_id, worker_id) REFERENCES workers(company_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'tickets'::regclass AND conname = 'ck_tickets_id_rfc4122'
  ) THEN
    ALTER TABLE tickets ADD CONSTRAINT ck_tickets_id_rfc4122
      CHECK (id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') NOT VALID;
  END IF;
END
$$;
ALTER TABLE tickets VALIDATE CONSTRAINT fk_tickets_model;
ALTER TABLE ticket_entries VALIDATE CONSTRAINT fk_ticket_entries_worker;
ALTER TABLE tickets VALIDATE CONSTRAINT ck_tickets_id_rfc4122;

INSERT INTO schema_migrations (version, name)
VALUES (6, 'deploy_ticket_identity_party_fk_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
