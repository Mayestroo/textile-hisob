-- Version 20: release a party/patta key after its ticket is voided.
BEGIN;

DROP INDEX IF EXISTS idx_tickets_party_patta;
CREATE UNIQUE INDEX idx_tickets_party_patta
  ON tickets(company_id, party_record_id, patta_number)
  WHERE party_record_id IS NOT NULL AND status <> 'VOIDED';

INSERT INTO schema_migrations(version, name)
VALUES (20, 'deploy_voided_ticket_patta_reuse_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
