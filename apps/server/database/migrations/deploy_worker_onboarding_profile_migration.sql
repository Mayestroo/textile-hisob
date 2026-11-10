-- Worker onboarding contact and optional face photo captured with explicit WebApp camera permission.
BEGIN;

ALTER TABLE workers ADD COLUMN IF NOT EXISTS phone_number VARCHAR(32);
ALTER TABLE workers ADD COLUMN IF NOT EXISTS profile_photo BYTEA;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS profile_photo_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS worker_onboarding_contacts (
  telegram_id VARCHAR(24) PRIMARY KEY CHECK (telegram_id ~ '^[0-9]{1,24}$'),
  company_id VARCHAR(64) NOT NULL,
  phone_number VARCHAR(32) NOT NULL,
  contact_name VARCHAR(160) NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name)
VALUES (29, 'deploy_worker_onboarding_profile_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
