BEGIN;
CREATE TABLE IF NOT EXISTS operator_login_attempts (
  company_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(128) NOT NULL,
  operator_key CHAR(64) NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0,
  window_expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, device_id, operator_key),
  CONSTRAINT operator_login_attempts_failed_count_check CHECK (failed_count >= 0),
  CONSTRAINT operator_login_attempts_operator_key_check CHECK (operator_key ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_operator_login_attempts_expiry ON operator_login_attempts(window_expires_at);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'operator_login_attempts'::regclass
      AND conname = 'operator_login_attempts_failed_count_check'
  ) THEN
    ALTER TABLE operator_login_attempts
      ADD CONSTRAINT operator_login_attempts_failed_count_check CHECK (failed_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'operator_login_attempts'::regclass
      AND conname = 'operator_login_attempts_operator_key_check'
  ) THEN
    ALTER TABLE operator_login_attempts
      ADD CONSTRAINT operator_login_attempts_operator_key_check CHECK (operator_key ~ '^[0-9a-f]{64}$');
  END IF;
END
$$;

INSERT INTO schema_migrations (version, name)
VALUES (4, 'deploy_operator_auth_rate_limit_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
