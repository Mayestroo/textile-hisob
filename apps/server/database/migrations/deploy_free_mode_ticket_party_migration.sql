-- Version 14: allow canonical free-mode tickets without a fabricated Party record.
-- Strict-mode enforcement remains server-side against activation_companies policy.
BEGIN;

ALTER TABLE tickets ALTER COLUMN party_record_id DROP NOT NULL;

INSERT INTO schema_migrations (version, name)
VALUES (14, 'deploy_free_mode_ticket_party_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
