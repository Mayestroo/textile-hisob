BEGIN;

CREATE TABLE IF NOT EXISTS server_operators (
  operator_id VARCHAR(128) PRIMARY KEY,
  company_id VARCHAR(64) NOT NULL,
  display_name TEXT NOT NULL,
  role VARCHAR(32) NOT NULL CHECK (role IN ('admin', 'accountant')),
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_server_operators_company ON server_operators(company_id, is_active);

CREATE TABLE IF NOT EXISTS operator_sessions (
  session_id UUID PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  operator_id VARCHAR(128) NOT NULL REFERENCES server_operators(operator_id),
  company_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(128) NOT NULL REFERENCES server_devices(device_id),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_scope ON operator_sessions(operator_id, company_id, device_id);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_expiry ON operator_sessions(expires_at);

INSERT INTO schema_migrations (version, name)
VALUES (3, 'deploy_operator_auth_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
