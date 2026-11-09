BEGIN;

-- Existing server adjustment facts are authoritative/posted; retain all rows.
ALTER TABLE worker_adjustments
  ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'POSTED';

-- Expand only the existing worker_adjustments.type check. Keep existing facts
-- untouched and tolerate the automatically generated legacy constraint name.
DO $$
DECLARE
  existing_constraint TEXT;
BEGIN
  SELECT c.conname INTO existing_constraint
  FROM pg_constraint c
  WHERE c.conrelid = 'worker_adjustments'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%type%AVANS%JARIMA%'
  ORDER BY c.conname
  LIMIT 1;

  IF existing_constraint IS NULL THEN
    RAISE EXCEPTION 'WORKER_ADJUSTMENTS_TYPE_CHECK_NOT_FOUND';
  END IF;

  EXECUTE format('ALTER TABLE worker_adjustments DROP CONSTRAINT %I', existing_constraint);
  ALTER TABLE worker_adjustments
    ADD CONSTRAINT worker_adjustments_type_check
    CHECK (type IN ('AVANS', 'JARIMA', 'OKLAD', 'MAGAZIN'));
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'worker_adjustments'::regclass
      AND conname = 'worker_adjustments_manual_period_posted_check'
  ) THEN
    ALTER TABLE worker_adjustments
      ADD CONSTRAINT worker_adjustments_manual_period_posted_check
      CHECK (type NOT IN ('OKLAD', 'MAGAZIN') OR (period_id IS NOT NULL AND status = 'POSTED'));
  END IF;
END
$$;

INSERT INTO schema_migrations (version, name)
VALUES (25, 'deploy_worker_adjustment_manual_payroll_types.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
