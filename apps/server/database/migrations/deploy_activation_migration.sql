-- Forward-only activation authority and signed-license persistence migration.
BEGIN;

CREATE TABLE IF NOT EXISTS activation_companies (
  company_id VARCHAR(100) PRIMARY KEY,
  company_name VARCHAR(160) NOT NULL,
  allowed_roles TEXT[] NOT NULL DEFAULT ARRAY['admin', 'type', 'print']::TEXT[],
  require_ticket_validation BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by_telegram_id VARCHAR(24) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT activation_companies_id_check CHECK (company_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  CONSTRAINT activation_companies_name_check CHECK (length(btrim(company_name)) BETWEEN 1 AND 160),
  CONSTRAINT activation_companies_roles_check CHECK (
    cardinality(allowed_roles) BETWEEN 1 AND 3
    AND allowed_roles <@ ARRAY['admin', 'type', 'print']::TEXT[]
  )
);

CREATE TABLE IF NOT EXISTS activation_requests (
  request_id UUID PRIMARY KEY,
  machine_id VARCHAR(19) NOT NULL,
  request_token_hash CHAR(64) NOT NULL,
  client_context JSONB NOT NULL DEFAULT '{}'::JSONB,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  company_id VARCHAR(100),
  company_name VARCHAR(160),
  role VARCHAR(16),
  require_ticket_validation BOOLEAN,
  activation_id UUID UNIQUE,
  signed_payload JSONB,
  signature VARCHAR(128),
  approved_by_telegram_id VARCHAR(24),
  approved_at TIMESTAMPTZ,
  rejected_by_telegram_id VARCHAR(24),
  rejected_at TIMESTAMPTZ,
  rejection_reason VARCHAR(500),
  revoked_by_telegram_id VARCHAR(24),
  revoked_at TIMESTAMPTZ,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT activation_requests_machine_id_check CHECK (machine_id ~ '^[A-F0-9]{4}(-[A-F0-9]{4}){3}$'),
  CONSTRAINT activation_requests_token_hash_check CHECK (request_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT activation_requests_status_check CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED')),
  CONSTRAINT activation_requests_binding_check CHECK (
    (status = 'PENDING' AND company_id IS NULL AND role IS NULL AND signed_payload IS NULL AND signature IS NULL)
    OR (status = 'REJECTED' AND company_id IS NULL AND role IS NULL AND rejection_reason IS NOT NULL)
    OR (status IN ('APPROVED', 'REVOKED') AND company_id IS NOT NULL AND role IS NOT NULL AND signed_payload IS NOT NULL AND signature IS NOT NULL)
  ),
  CONSTRAINT activation_requests_company_fk FOREIGN KEY (company_id) REFERENCES activation_companies(company_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_activation_requests_pending ON activation_requests(requested_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_activation_requests_machine ON activation_requests(machine_id, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_activation_requests_machine_approved
  ON activation_requests(machine_id) WHERE status = 'APPROVED';

CREATE TABLE IF NOT EXISTS activation_request_limits (
  machine_id VARCHAR(19) PRIMARY KEY,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 5),
  window_started_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT activation_request_limits_machine_check CHECK (machine_id ~ '^[A-F0-9]{4}(-[A-F0-9]{4}){3}$')
);

CREATE TABLE IF NOT EXISTS activation_events (
  event_id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES activation_requests(request_id) ON DELETE RESTRICT,
  event_type VARCHAR(16) NOT NULL CHECK (event_type IN ('APPROVED', 'REJECTED', 'REVOKED')),
  actor_telegram_id VARCHAR(24) NOT NULL,
  signed_payload JSONB,
  signature VARCHAR(128),
  event_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activation_events_request ON activation_events(request_id, event_id);

ALTER TABLE workers ADD COLUMN IF NOT EXISTS staj NUMERIC NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS worker_credentials (
  company_id VARCHAR(64) NOT NULL,
  worker_id INTEGER NOT NULL,
  pin_salt BYTEA NOT NULL,
  pin_hash BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, worker_id),
  CONSTRAINT worker_credentials_salt_length CHECK (octet_length(pin_salt) = 16),
  CONSTRAINT worker_credentials_hash_length CHECK (octet_length(pin_hash) = 64),
  FOREIGN KEY (company_id, worker_id) REFERENCES workers(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS worker_telegram_bindings (
  telegram_id VARCHAR(24) PRIMARY KEY,
  company_id VARCHAR(64) NOT NULL,
  worker_id INTEGER NOT NULL,
  username VARCHAR(64) NOT NULL DEFAULT '',
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT worker_telegram_bindings_id_check CHECK (telegram_id ~ '^[0-9]{1,24}$'),
  UNIQUE (company_id, worker_id),
  FOREIGN KEY (company_id, worker_id) REFERENCES workers(company_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_worker_bindings_company_worker ON worker_telegram_bindings(company_id, worker_id);

CREATE TABLE IF NOT EXISTS worker_binding_limits (
  telegram_id VARCHAR(24) NOT NULL,
  company_id VARCHAR(64) NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count BETWEEN 0 AND 5),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (telegram_id, company_id)
);

INSERT INTO schema_migrations (version, name)
VALUES (8, 'deploy_activation_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
