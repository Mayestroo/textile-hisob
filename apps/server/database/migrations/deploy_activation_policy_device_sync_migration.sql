-- Version 13: record how many approved device activations a policy change refreshed.
BEGIN;

ALTER TABLE activation_policy_events
  ADD COLUMN IF NOT EXISTS synchronized_device_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE activation_events DROP CONSTRAINT IF EXISTS activation_events_event_type_check;
ALTER TABLE activation_events
  ADD CONSTRAINT activation_events_event_type_check
  CHECK (event_type IN ('APPROVED', 'REJECTED', 'REVOKED', 'POLICY_UPDATED'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'activation_policy_events'::regclass
      AND conname = 'activation_policy_events_sync_count_check'
  ) THEN
    ALTER TABLE activation_policy_events
      ADD CONSTRAINT activation_policy_events_sync_count_check CHECK (synchronized_device_count >= 0);
  END IF;
END
$$;

INSERT INTO schema_migrations (version, name)
VALUES (13, 'deploy_activation_policy_device_sync_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
