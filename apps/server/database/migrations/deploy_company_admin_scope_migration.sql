BEGIN;

CREATE TABLE IF NOT EXISTS activation_company_admins (
  company_id VARCHAR(100) NOT NULL REFERENCES activation_companies(company_id) ON DELETE RESTRICT,
  telegram_id VARCHAR(24) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_by_telegram_id VARCHAR(24),
  assignment_source VARCHAR(40) NOT NULL DEFAULT 'TELEGRAM_ADMIN',
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, telegram_id),
  CONSTRAINT activation_company_admins_telegram_id_check CHECK (telegram_id ~ '^[0-9]{1,24}$'),
  CONSTRAINT activation_company_admins_actor_check CHECK (
    assigned_by_telegram_id IS NULL OR assigned_by_telegram_id ~ '^[0-9]{1,24}$'
  ),
  CONSTRAINT activation_company_admins_source_check CHECK (
    assignment_source IN ('TELEGRAM_ADMIN', 'OWNER_BOOTSTRAP')
  )
);

CREATE INDEX IF NOT EXISTS activation_company_admins_telegram_active_idx
  ON activation_company_admins(telegram_id, company_id) WHERE is_active = TRUE;

INSERT INTO activation_company_admins (
  company_id, telegram_id, is_active, assigned_by_telegram_id, assignment_source
)
SELECT 'comp_novda', '274466315', TRUE, NULL, 'OWNER_BOOTSTRAP'
WHERE EXISTS (SELECT 1 FROM activation_companies WHERE company_id = 'comp_novda')
ON CONFLICT (company_id, telegram_id) DO NOTHING;

INSERT INTO schema_migrations (version, name)
VALUES (21, 'deploy_company_admin_scope_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
