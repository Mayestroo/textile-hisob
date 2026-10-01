-- Link activation policy to a real business scope and seed the approved Novda policy.
BEGIN;

ALTER TABLE activation_companies
  ADD COLUMN IF NOT EXISTS updated_by_source VARCHAR(40) NOT NULL DEFAULT 'TELEGRAM_ADMIN';
ALTER TABLE activation_companies
  ALTER COLUMN updated_by_telegram_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'activation_companies'::regclass
      AND conname = 'activation_companies_updater_source_check'
  ) THEN
    ALTER TABLE activation_companies
      ADD CONSTRAINT activation_companies_updater_source_check CHECK (
        (updated_by_source = 'TELEGRAM_ADMIN'
          AND updated_by_telegram_id IS NOT NULL
          AND updated_by_telegram_id ~ '^[0-9]{1,24}$')
        OR (updated_by_source = 'APPROVED_PRODUCTION_BASELINE' AND updated_by_telegram_id IS NULL)
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'activation_companies'::regclass
      AND conname = 'activation_companies_company_scope_fk'
  ) THEN
    ALTER TABLE activation_companies
      ADD CONSTRAINT activation_companies_company_scope_fk
      FOREIGN KEY (company_id) REFERENCES company_batch_settings(company_id)
      ON DELETE RESTRICT NOT VALID;
  END IF;
END
$$;

ALTER TABLE activation_companies VALIDATE CONSTRAINT activation_companies_updater_source_check;
ALTER TABLE activation_companies VALIDATE CONSTRAINT activation_companies_company_scope_fk;

-- The business scope already exists in the approved imported baseline. This row
-- configures activation policy only; it does not create a business company.
INSERT INTO activation_companies (
  company_id, company_name, allowed_roles, require_ticket_validation, is_active,
  updated_by_telegram_id, updated_by_source
)
SELECT company_id, 'comp_novda', ARRAY['admin', 'type', 'print']::TEXT[], TRUE, TRUE,
       NULL, 'APPROVED_PRODUCTION_BASELINE'
FROM company_batch_settings
WHERE company_id = 'comp_novda'
ON CONFLICT (company_id) DO NOTHING;

INSERT INTO schema_migrations (version, name)
VALUES (10, 'deploy_activation_company_scope_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
