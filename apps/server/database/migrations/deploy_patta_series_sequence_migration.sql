-- Version 18: number pattas within the currently active party series.
BEGIN;

DROP INDEX IF EXISTS idx_tickets_company_global_patta;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_party_patta
  ON tickets(company_id, party_record_id, patta_number)
  WHERE party_record_id IS NOT NULL;

UPDATE company_patta_sequences sequence_row
SET next_patta_number = COALESCE((
  SELECT MAX(active_ranges.patta_end_number) + 1
  FROM (
    SELECT party.patta_end_number
    FROM parties party
    WHERE party.company_id = sequence_row.company_id
      AND party.status != 'CLOSED' AND party.is_archived = FALSE
      AND party.patta_end_number IS NOT NULL
    UNION ALL
    SELECT protected_range.patta_end_number
    FROM protected_party_patta_ranges protected_range
    JOIN parties party ON party.company_id = protected_range.company_id
      AND party.id = protected_range.party_record_id
    WHERE party.company_id = sequence_row.company_id
      AND party.status != 'CLOSED' AND party.is_archived = FALSE
  ) active_ranges
), 1),
updated_at = NOW();

INSERT INTO schema_migrations(version, name)
VALUES (18, 'deploy_patta_series_sequence_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
