-- Version 15: normalize historical party work quantities and publish corrections.
BEGIN;

LOCK TABLE parties IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  v_party RECORD;
  v_size RECORD;
  v_size_text TEXT;
  v_size_count NUMERIC;
  v_size_total NUMERIC;
  v_invalid BOOLEAN;
  v_invalid_parties TEXT := '';
  v_existing_name TEXT;
BEGIN
  SELECT name INTO v_existing_name
  FROM schema_migrations
  WHERE version = 15;

  IF FOUND THEN
    IF v_existing_name <> 'deploy_patta_work_quantity_migration.sql' THEN
      RAISE EXCEPTION 'PATTA_WORK_QUANTITY_MIGRATION_VERSION_CONFLICT: version 15 is recorded as %', v_existing_name;
    END IF;
    RETURN;
  END IF;

  FOR v_party IN
    SELECT company_id, id, patta_count, ish_soni_per_patta, total_ish_soni, ish_soni, sizes_json
    FROM parties
    ORDER BY company_id, id
  LOOP
    v_invalid := FALSE;
    IF v_party.patta_count IS NULL OR v_party.patta_count < 0 THEN
      v_invalid := TRUE;
    ELSIF v_party.patta_count = 0 THEN
      v_invalid := (v_party.ish_soni_per_patta IS NOT NULL AND v_party.ish_soni_per_patta <> 0)
        OR (v_party.total_ish_soni IS NOT NULL AND v_party.total_ish_soni <> 0)
        OR (v_party.ish_soni IS NOT NULL AND v_party.ish_soni <> 0);
    ELSE
      v_invalid := v_party.ish_soni_per_patta IS NULL
        OR v_party.ish_soni_per_patta <= 0
        OR v_party.ish_soni_per_patta <> trunc(v_party.ish_soni_per_patta)
        OR v_party.ish_soni_per_patta > 9007199254740991
        OR mod(v_party.ish_soni_per_patta, v_party.patta_count) <> 0;
    END IF;

    IF v_party.sizes_json IS NOT NULL AND v_party.sizes_json <> 'null'::jsonb AND v_party.sizes_json <> '{}'::jsonb THEN
      IF jsonb_typeof(v_party.sizes_json) IS DISTINCT FROM 'object' THEN
        v_invalid := TRUE;
      ELSE
        v_size_total := 0;
        FOR v_size IN SELECT entry.value FROM jsonb_each(v_party.sizes_json) AS entry
        LOOP
          v_size_count := NULL;
          IF jsonb_typeof(v_size.value) = 'number' THEN
            v_size_count := (v_size.value #>> '{}')::numeric;
          ELSIF jsonb_typeof(v_size.value) = 'string' THEN
            v_size_text := regexp_replace(
              v_size.value #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g'
            );
            IF v_size_text = '' THEN
              v_size_count := 0;
            ELSIF v_size_text !~ '^[0123456789]+$' THEN
              v_invalid := TRUE;
            ELSE
              v_size_text := regexp_replace(v_size_text, '^0+', '');
              IF v_size_text = '' THEN
                v_size_text := '0';
              END IF;
              IF length(v_size_text) > 16 THEN
                v_invalid := TRUE;
              ELSE
                v_size_count := v_size_text::numeric;
              END IF;
            END IF;
          ELSE
            v_invalid := TRUE;
          END IF;

          IF v_size_count IS NOT NULL THEN
            IF v_size_count < 0
              OR v_size_count <> trunc(v_size_count)
              OR v_size_count > 9007199254740991 THEN
              v_invalid := TRUE;
            ELSE
              v_size_total := v_size_total + v_size_count;
            END IF;
          END IF;
        END LOOP;

        IF v_size_total <> v_party.patta_count THEN
          v_invalid := TRUE;
        END IF;
      END IF;
    END IF;

    IF v_invalid THEN
      v_invalid_parties := v_invalid_parties
        || CASE WHEN v_invalid_parties = '' THEN '' ELSE ', ' END
        || format('(%L,%L)', v_party.company_id, v_party.id);
    END IF;
  END LOOP;

  IF v_invalid_parties <> '' THEN
    RAISE EXCEPTION
      'PATTA_WORK_QUANTITY_MIGRATION_BLOCKED: invalid party rows in company_id/id order: %',
      v_invalid_parties;
  END IF;
END
$$;

WITH source AS (
  SELECT company_id, id, patta_count, ish_soni_per_patta AS party_total,
         SUM(ish_soni_per_patta) OVER (
           PARTITION BY company_id ORDER BY created_at, id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS corrected_cumulative
  FROM parties
  WHERE patta_count > 0
    AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 15)
), updated AS (
  UPDATE parties AS party
  SET ish_soni_per_patta = source.party_total / source.patta_count,
      total_ish_soni = source.party_total,
      ish_soni = source.party_total,
      cumulative_ish_soni = source.corrected_cumulative,
      server_revision = party.server_revision + 1,
      updated_at = NOW()
  FROM source
  WHERE party.company_id = source.company_id AND party.id = source.id
  RETURNING party.*
)
INSERT INTO change_log (
  company_id, entity_type, entity_id, entity_revision, operation_id,
  change_type, payload_json, committed_at
)
SELECT company_id, 'party', id, server_revision,
       'migration-patta-quantity-v1-' || substr(md5(company_id || ':' || id), 1, 32),
       'UPDATE', jsonb_build_object(
         'partyRecordId', id, 'partyNumber', party_number,
         'physicalPartyNumber', physical_party_number, 'modelId', model_id,
         'modelName', model_name, 'color', color,
         'pattaCount', patta_count, 'cumulativePattaCount', cumulative_patta_count,
         'ishSoniPerPatta', ish_soni_per_patta, 'totalIshSoni', total_ish_soni,
         'ishSoni', ish_soni, 'cumulativeIshSoni', cumulative_ish_soni,
         'sizes', sizes_json, 'printedAt', printed_at, 'status', status,
         'isClosed', is_closed = 1, 'closedAt', closed_at,
         'archivedPattaNumbers', archived_patta_numbers_json, 'updatedAt', updated_at
       ), NOW()
FROM updated;

INSERT INTO schema_migrations (version, name)
VALUES (15, 'deploy_patta_work_quantity_migration.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
