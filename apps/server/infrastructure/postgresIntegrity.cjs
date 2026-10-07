'use strict';

const EXPECTED_MIGRATIONS = Object.freeze({
  1: 'schema.sql',
  2: 'deploy_active_party_migration.sql',
  3: 'deploy_operator_auth_migration.sql',
  4: 'deploy_operator_auth_rate_limit_migration.sql',
  5: 'deploy_reconciliation_migration.sql',
  6: 'deploy_ticket_identity_party_fk_migration.sql',
  7: 'deploy_exact_party_2_policy_migration.sql',
  8: 'deploy_activation_migration.sql',
  9: 'deploy_business_mutations_migration.sql',
  10: 'deploy_activation_company_scope_migration.sql',
  11: 'deploy_activation_policy_revision_migration.sql',
  12: 'deploy_exact_party_2_company_scope_migration.sql',
  13: 'deploy_activation_policy_device_sync_migration.sql',
  14: 'deploy_free_mode_ticket_party_migration.sql',
  15: 'deploy_patta_work_quantity_migration.sql',
  16: 'deploy_canonical_ids_global_patta_sequence.sql',
  17: 'deploy_production_adjustment_provenance_migration.sql',
  18: 'deploy_patta_series_sequence_migration.sql',
  19: 'deploy_patta_sequence_runtime_grant_migration.sql',
  20: 'deploy_voided_ticket_patta_reuse_migration.sql'
});

const REQUIRED_FOREIGN_KEYS = Object.freeze([
  ['tickets', ['company_id', 'party_record_id'], 'parties', ['company_id', 'id']],
  ['tickets', ['company_id', 'model_id'], 'models', ['company_id', 'id']],
  ['ticket_entries', ['company_id', 'ticket_id'], 'tickets', ['company_id', 'id']],
  ['ticket_entries', ['company_id', 'worker_id'], 'workers', ['company_id', 'id']],
  ['worker_adjustments', ['company_id', 'worker_id'], 'workers', ['company_id', 'id']],
  ['printed_pattas', ['company_id', 'party_record_id'], 'parties', ['company_id', 'id']],
  ['printed_pattas', ['company_id', 'model_id'], 'models', ['company_id', 'id']],
  ['printed_patta_operations', ['company_id', 'patta_id'], 'printed_pattas', ['company_id', 'id']],
  ['worker_credentials', ['company_id', 'worker_id'], 'workers', ['company_id', 'id']],
  ['worker_telegram_bindings', ['company_id', 'worker_id'], 'workers', ['company_id', 'id']],
  ['tickets', ['company_id', 'period_id'], 'periods', ['company_id', 'id']],
  ['worker_adjustments', ['company_id', 'period_id'], 'periods', ['company_id', 'id']],
  ['patta_batch_settings', ['company_id', 'model_id'], 'models', ['company_id', 'id']],
  ['period_archives', ['company_id', 'period_id'], 'periods', ['company_id', 'id']],
  ['activation_companies', ['company_id'], 'company_batch_settings', ['company_id']]
]);

const RESTRICTIVE_FOREIGN_KEYS = Object.freeze([
  ['activation_companies', ['company_id'], 'company_batch_settings', ['company_id']]
]);

const ORPHAN_COUNTS_SQL = `
SELECT
  (SELECT COUNT(*) FROM tickets t LEFT JOIN parties p ON p.company_id = t.company_id AND p.id = t.party_record_id WHERE t.party_record_id IS NOT NULL AND p.id IS NULL) AS tickets_parties,
  (SELECT COUNT(*) FROM tickets t LEFT JOIN models m ON m.company_id = t.company_id AND m.id = t.model_id WHERE m.id IS NULL) AS tickets_models,
  (SELECT COUNT(*) FROM ticket_entries e LEFT JOIN tickets t ON t.company_id = e.company_id AND t.id = e.ticket_id WHERE t.id IS NULL) AS ticket_entries_tickets,
  (SELECT COUNT(*) FROM ticket_entries e LEFT JOIN workers w ON w.company_id = e.company_id AND w.id = e.worker_id WHERE w.id IS NULL) AS ticket_entries_workers,
  (SELECT COUNT(*) FROM worker_adjustments a LEFT JOIN workers w ON w.company_id = a.company_id AND w.id = a.worker_id WHERE w.id IS NULL) AS worker_adjustments_workers,
  (SELECT COUNT(*) FROM printed_pattas pp LEFT JOIN parties p ON p.company_id = pp.company_id AND p.id = pp.party_record_id WHERE p.id IS NULL) AS printed_pattas_parties,
  (SELECT COUNT(*) FROM printed_pattas pp LEFT JOIN models m ON m.company_id = pp.company_id AND m.id = pp.model_id WHERE m.id IS NULL) AS printed_pattas_models,
  (SELECT COUNT(*) FROM printed_patta_operations po LEFT JOIN printed_pattas pp ON pp.company_id = po.company_id AND pp.id = po.patta_id WHERE pp.id IS NULL) AS printed_patta_operations_pattas,
  (SELECT COUNT(*) FROM worker_credentials wc LEFT JOIN workers w ON w.company_id = wc.company_id AND w.id = wc.worker_id WHERE w.id IS NULL) AS worker_credentials_workers,
  (SELECT COUNT(*) FROM worker_telegram_bindings wb LEFT JOIN workers w ON w.company_id = wb.company_id AND w.id = wb.worker_id WHERE w.id IS NULL) AS worker_bindings_workers,
  (SELECT COUNT(*) FROM tickets t LEFT JOIN periods p ON p.company_id = t.company_id AND p.id = t.period_id WHERE t.period_id IS NOT NULL AND p.id IS NULL) AS tickets_periods,
  (SELECT COUNT(*) FROM worker_adjustments a LEFT JOIN periods p ON p.company_id = a.company_id AND p.id = a.period_id WHERE a.period_id IS NOT NULL AND p.id IS NULL) AS worker_adjustments_periods,
  (SELECT COUNT(*) FROM patta_batch_settings b LEFT JOIN models m ON m.company_id = b.company_id AND m.id = b.model_id WHERE m.id IS NULL) AS batch_settings_models,
  (SELECT COUNT(*) FROM period_archives a LEFT JOIN periods p ON p.company_id = a.company_id AND p.id = a.period_id WHERE p.id IS NULL) AS period_archives_periods
`;

function asCount(value) {
  const result = Number(value || 0);
  return Number.isSafeInteger(result) && result >= 0 ? result : Number.NaN;
}

function asColumns(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  return value.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
}

function foreignKeySignature(row) {
  return [
    String(row.source_table),
    asColumns(row.source_columns).join(','),
    String(row.target_table),
    asColumns(row.target_columns).join(',')
  ].join(':');
}

function expectedForeignKeySignature([sourceTable, sourceColumns, targetTable, targetColumns]) {
  return [sourceTable, sourceColumns.join(','), targetTable, targetColumns.join(',')].join(':');
}

function integrityFailure(problems, report) {
  const error = new Error(`POSTGRES_RELEASE_INTEGRITY_FAILED: ${problems.join('; ')}`);
  error.code = 'POSTGRES_RELEASE_INTEGRITY_FAILED';
  error.details = { problems, report };
  return error;
}

async function verifyPostgresReleaseState(client) {
  if (!client || typeof client.query !== 'function') {
    throw integrityFailure(['a PostgreSQL client with query() is required'], {});
  }

  const problems = [];
  const report = {
    evidenceType: 'postgresql_release_integrity',
    migrations: { rows: [], contiguous: false, namesMatch: false },
    activation: { requiredTables: 6, presentTables: 0, stajColumnExists: false },
    foreignKeys: {
      requiredCount: REQUIRED_FOREIGN_KEYS.length,
      presentAndValidated: 0,
      missingOrUnvalidated: [],
      restrictiveRequiredCount: RESTRICTIVE_FOREIGN_KEYS.length,
      presentAndRestrictive: 0,
      missingOrNonRestrictive: []
    },
    orphanCounts: {},
    partyPolicy: { triggerExists: false, callsExactPolicyFunction: false, persistedExceptionPolicy: false },
    constraints: {
      ticketUuidCheckValidated: false, businessKeyAbsent: false,
      partyPattaUnique: false, voidedTicketPattaReusable: false, companyWidePattaIndexAbsent: false
    },
    pattaSequencePrivileges: { canSelect: false, canInsert: false, canUpdate: false },
    operations: { unmatchedChangeLogOperations: 0, duplicateOperationIdentities: 0 },
    businessMutations: { requiredTables: 3, presentTables: 0, requiredColumns: 18, presentColumns: 0 },
    baseline: {
      ownerExclusionRows: 0,
      ownerExcludedQuantity: 0,
      ownerScopeMismatchRows: 0,
      ownerDecisionQuantityMismatchCount: 0,
      ownerDecisionCount: 0,
      scopePreserved: true
    }
  };

  async function rowsFor(label, sql) {
    try {
      const result = await client.query(sql);
      return Array.isArray(result?.rows) ? result.rows : [];
    } catch (error) {
      problems.push(`${label} query failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  const migrationRows = await rowsFor('schema migration evidence', `
    SELECT version, name
    FROM schema_migrations
    ORDER BY version
  `);
  report.migrations.rows = migrationRows.map((row) => ({ version: asCount(row.version), name: String(row.name) }));
  report.migrations.contiguous = report.migrations.rows.length > 0
    && report.migrations.rows.every((row, index) => row.version === index + 1);
  report.migrations.namesMatch = report.migrations.rows.length > 0
    && report.migrations.rows.every((row) => EXPECTED_MIGRATIONS[row.version] === row.name);
  if (!report.migrations.contiguous) problems.push('schema_migrations versions are empty, duplicated, unordered, or contain gaps');
  if (!report.migrations.namesMatch) problems.push('schema_migrations names do not match the ordered migration definitions');
  if (report.migrations.rows.some((row) => !Number.isSafeInteger(row.version))) problems.push('schema_migrations contains an invalid version');

  const activationTableRows = await rowsFor('activation and worker service tables', `
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN (
        'activation_companies', 'activation_requests', 'activation_request_limits',
        'activation_events', 'worker_credentials', 'worker_telegram_bindings', 'worker_binding_limits'
      )
  `);
  const requiredActivationTables = [
    'activation_companies', 'activation_requests', 'activation_request_limits',
    'activation_events', 'worker_credentials', 'worker_telegram_bindings', 'worker_binding_limits'
  ];
  report.activation.requiredTables = requiredActivationTables.length;
  report.activation.presentTables = activationTableRows.length;
  if (activationTableRows.length !== requiredActivationTables.length) {
    problems.push('activation or worker API persistence tables are missing');
  }
  const workerStajRows = await rowsFor('worker payroll projection column', `
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'workers' AND column_name = 'staj'
  `);
  report.activation.stajColumnExists = workerStajRows.some((row) => row.column_name === 'staj');
  if (!report.activation.stajColumnExists) problems.push('workers.staj roster field is missing');

  const businessTableRows = await rowsFor('workbook mutation tables', `
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema()
       AND table_name IN ('company_batch_settings', 'patta_batch_settings', 'period_archives')
  `);
  const requiredBusinessTables = ['company_batch_settings', 'patta_batch_settings', 'period_archives'];
  report.businessMutations.presentTables = businessTableRows.length;
  if (businessTableRows.length !== requiredBusinessTables.length) {
    problems.push('workbook mutation persistence tables are missing');
  }

  const businessColumnRows = await rowsFor('workbook mutation columns', `
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND (
        (table_name = 'models' AND column_name IN ('status', 'server_revision', 'hisob_sheet_name', 'title', 'party', 'color', 'size', 'patta_ops_order_json'))
        OR (table_name = 'workers' AND column_name IN ('server_revision', 'staj', 'role'))
        OR (table_name = 'periods' AND column_name IN ('name', 'server_revision', 'closed_at', 'created_at'))
        OR (table_name = 'tickets' AND column_name = 'period_id')
        OR (table_name = 'worker_adjustments' AND column_name = 'period_id')
        OR (table_name = 'parties' AND column_name = 'is_archived')
      )
  `);
  const expectedBusinessColumns = [
    ['models', 'status'], ['models', 'server_revision'], ['models', 'hisob_sheet_name'],
    ['models', 'title'], ['models', 'party'], ['models', 'color'], ['models', 'size'],
    ['models', 'patta_ops_order_json'], ['workers', 'server_revision'], ['workers', 'staj'],
    ['workers', 'role'], ['periods', 'name'], ['periods', 'server_revision'], ['periods', 'closed_at'], ['periods', 'created_at'],
    ['tickets', 'period_id'], ['worker_adjustments', 'period_id'], ['parties', 'is_archived']
  ];
  report.businessMutations.requiredColumns = expectedBusinessColumns.length;
  const presentBusinessColumns = new Set(businessColumnRows.map((row) => `${row.table_name}:${row.column_name}`));
  report.businessMutations.presentColumns = expectedBusinessColumns
    .filter(([tableName, columnName]) => presentBusinessColumns.has(`${tableName}:${columnName}`)).length;
  if (report.businessMutations.presentColumns !== report.businessMutations.requiredColumns) {
    problems.push('workbook mutation columns are missing');
  }

  const fkRows = await rowsFor('foreign-key evidence', `
    SELECT
      constraint_row.conname AS constraint_name,
      source.relname AS source_table,
      ARRAY_AGG(source_attribute.attname ORDER BY source_key.ordinality) AS source_columns,
      target.relname AS target_table,
      ARRAY_AGG(target_attribute.attname ORDER BY source_key.ordinality) AS target_columns,
      pg_get_constraintdef(constraint_row.oid) AS definition,
      constraint_row.convalidated AS validated
    FROM pg_constraint constraint_row
    JOIN pg_class source ON source.oid = constraint_row.conrelid
    JOIN pg_namespace source_namespace ON source_namespace.oid = source.relnamespace
    JOIN pg_class target ON target.oid = constraint_row.confrelid
    JOIN LATERAL UNNEST(constraint_row.conkey) WITH ORDINALITY AS source_key(attnum, ordinality) ON TRUE
    JOIN LATERAL UNNEST(constraint_row.confkey) WITH ORDINALITY AS target_key(attnum, ordinality)
      ON target_key.ordinality = source_key.ordinality
    JOIN pg_attribute source_attribute ON source_attribute.attrelid = source.oid AND source_attribute.attnum = source_key.attnum
    JOIN pg_attribute target_attribute ON target_attribute.attrelid = target.oid AND target_attribute.attnum = target_key.attnum
    WHERE constraint_row.contype = 'f'
      AND source_namespace.nspname = current_schema()
    GROUP BY constraint_row.oid, constraint_row.conname, source.relname, target.relname, constraint_row.convalidated
  `);
  const validatedSignatures = new Set(
    fkRows.filter((row) => row.validated === true).map(foreignKeySignature)
  );
  report.foreignKeys.missingOrUnvalidated = REQUIRED_FOREIGN_KEYS
    .filter((foreignKey) => !validatedSignatures.has(expectedForeignKeySignature(foreignKey)))
    .map(([sourceTable, sourceColumns, targetTable, targetColumns]) => ({
      sourceTable,
      sourceColumns,
      targetTable,
      targetColumns
    }));
  report.foreignKeys.presentAndValidated = REQUIRED_FOREIGN_KEYS.length - report.foreignKeys.missingOrUnvalidated.length;
  if (report.foreignKeys.missingOrUnvalidated.length) problems.push('one or more required foreign keys are missing or unvalidated');
  const restrictiveSignatures = new Set(RESTRICTIVE_FOREIGN_KEYS.map(expectedForeignKeySignature));
  report.foreignKeys.missingOrNonRestrictive = RESTRICTIVE_FOREIGN_KEYS
    .filter((foreignKey) => {
      const signature = expectedForeignKeySignature(foreignKey);
      const row = fkRows.find((candidate) => foreignKeySignature(candidate) === signature && candidate.validated === true);
      return !row || !/ON DELETE RESTRICT/i.test(String(row.definition || ''));
    })
    .map(([sourceTable, sourceColumns, targetTable, targetColumns]) => ({
      sourceTable, sourceColumns, targetTable, targetColumns
    }));
  report.foreignKeys.presentAndRestrictive = restrictiveSignatures.size - report.foreignKeys.missingOrNonRestrictive.length;
  if (report.foreignKeys.missingOrNonRestrictive.length) problems.push('one or more required foreign keys are not restrictive');

  const orphanRows = await rowsFor('orphan evidence', ORPHAN_COUNTS_SQL);
  const orphanRow = orphanRows[0] || {};
  report.orphanCounts = Object.fromEntries(
    Object.keys(orphanRow).map((key) => [key, asCount(orphanRow[key])])
  );
  if (!Object.keys(report.orphanCounts).length || Object.values(report.orphanCounts).some((count) => count !== 0)) {
    problems.push('orphan queries returned missing, invalid, or non-zero counts');
  }

  const triggerRows = await rowsFor('active-party policy evidence', `
    SELECT trigger_row.tgname AS trigger_name,
      procedure_row.proname AS function_name,
      pg_get_functiondef(procedure_row.oid) AS function_definition
    FROM pg_trigger trigger_row
    JOIN pg_class relation_row ON relation_row.oid = trigger_row.tgrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    JOIN pg_proc procedure_row ON procedure_row.oid = trigger_row.tgfoid
    WHERE namespace_row.nspname = current_schema()
      AND relation_row.relname = 'parties'
      AND trigger_row.tgname = 'trg_parties_active_uniqueness'
      AND NOT trigger_row.tgisinternal
  `);
  const activePartyTrigger = triggerRows.find((row) => row.trigger_name === 'trg_parties_active_uniqueness');
  const triggerDefinition = String(activePartyTrigger?.function_definition || '');
  const compactTriggerDefinition = triggerDefinition.toLowerCase().replace(/\s+/g, '');
  report.partyPolicy.triggerExists = Boolean(activePartyTrigger);
  report.partyPolicy.persistedExceptionPolicy = [
    'legacy_party_collision_exceptions',
    'current_exception.company_id=new.company_id',
    'current_exception.party_id=new.id',
    'current_exception.party_number=new.party_number',
    'collision_group_id',
    'count(*)',
    ')=2',
    'active_party_exists'
  ].every((fragment) => compactTriggerDefinition.includes(fragment));
  report.partyPolicy.callsExactPolicyFunction = activePartyTrigger?.function_name === 'check_active_party_uniqueness'
    && report.partyPolicy.persistedExceptionPolicy;
  if (!report.partyPolicy.triggerExists || !report.partyPolicy.callsExactPolicyFunction) {
    problems.push('parties active-uniqueness trigger is missing or does not enforce the company-scoped persisted exception policy');
  }

  const constraintRows = await rowsFor('ticket identity constraints', `
    SELECT relation_row.relname AS table_name, constraint_row.conname AS constraint_name,
      constraint_row.convalidated AS validated
    FROM pg_constraint constraint_row
    JOIN pg_class relation_row ON relation_row.oid = constraint_row.conrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    WHERE namespace_row.nspname = current_schema()
      AND relation_row.relname = 'tickets'
      AND constraint_row.conname IN ('ck_tickets_id_rfc4122', 'uq_tickets_business_key')
  `);
  const ticketUuidConstraint = constraintRows.find((row) => row.constraint_name === 'ck_tickets_id_rfc4122');
  report.constraints.ticketUuidCheckValidated = ticketUuidConstraint?.validated === true;
  const businessIndexRows = await rowsFor('ticket identity index evidence', `
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'tickets'
      AND indexname IN ('uq_tickets_business_key', 'idx_tickets_business_key')
  `);
  report.constraints.businessKeyAbsent = !constraintRows.some((row) => row.constraint_name === 'uq_tickets_business_key')
    && businessIndexRows.length === 0;
  if (!report.constraints.ticketUuidCheckValidated) problems.push('validated RFC 4122 ticket identity check is missing');
  if (!report.constraints.businessKeyAbsent) problems.push('forbidden ticket business-key constraint or index is present');

  const pattaIndexRows = await rowsFor('active-series patta index evidence', `
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'tickets'
      AND indexname IN ('idx_tickets_company_global_patta', 'idx_tickets_party_patta')
  `);
  const pattaIndex = pattaIndexRows.find((row) => row.indexname === 'idx_tickets_party_patta');
  const pattaIndexDefinition = String(pattaIndex?.indexdef || '').toLowerCase().replace(/\s+/g, '');
  const pattaIndexPredicate = pattaIndexDefinition.split('where')[1] || '';
  report.constraints.partyPattaUnique = Boolean(pattaIndex)
    && pattaIndexDefinition.includes('uniqueindexidx_tickets_party_patta')
    && pattaIndexDefinition.includes('(company_id,party_record_id,patta_number)')
    && pattaIndexPredicate.includes('party_record_idisnotnull');
  report.constraints.voidedTicketPattaReusable = pattaIndexPredicate.includes('status')
    && pattaIndexPredicate.includes('<>')
    && pattaIndexPredicate.includes('voided');
  report.constraints.companyWidePattaIndexAbsent = !pattaIndexRows.some(
    (row) => row.indexname === 'idx_tickets_company_global_patta'
  );
  if (!report.constraints.partyPattaUnique || !report.constraints.voidedTicketPattaReusable
    || !report.constraints.companyWidePattaIndexAbsent) {
    problems.push('ticket patta uniqueness must be party-scoped and release keys for voided tickets');
  }

  const pattaSequencePrivilegeRows = await rowsFor('party sequence runtime permissions', `
    SELECT has_table_privilege(current_user, 'company_patta_sequences', 'SELECT') AS can_select,
      has_table_privilege(current_user, 'company_patta_sequences', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'company_patta_sequences', 'UPDATE') AS can_update
  `);
  const sequencePrivileges = pattaSequencePrivilegeRows[0] || {};
  report.pattaSequencePrivileges = {
    canSelect: sequencePrivileges.can_select === true,
    canInsert: sequencePrivileges.can_insert === true,
    canUpdate: sequencePrivileges.can_update === true
  };
  if (!report.pattaSequencePrivileges.canSelect || !report.pattaSequencePrivileges.canInsert
    || !report.pattaSequencePrivileges.canUpdate) {
    problems.push('application role cannot read or allocate active-series patta numbers');
  }

  const operationRows = await rowsFor('operation idempotency evidence', `
    SELECT
      (SELECT COUNT(*) FROM change_log change_row
       WHERE NOT EXISTS (
          SELECT 1 FROM operations_dedup dedup_row
          WHERE dedup_row.company_id = change_row.company_id
            AND dedup_row.operation_id = change_row.operation_id
        )
        AND NOT (
          change_row.entity_type = 'party'
          AND change_row.change_type = 'UPDATE'
          AND change_row.operation_id = 'migration-patta-quantity-v1-'
            || substr(md5(change_row.company_id || ':' || change_row.entity_id), 1, 32)
        )) AS unmatched_change_log_operations,
      (SELECT COUNT(*) FROM (
         SELECT company_id, operation_id
         FROM operations_dedup
         GROUP BY company_id, operation_id
         HAVING COUNT(*) > 1
       ) duplicate_rows) AS duplicate_operation_identities
  `);
  const operationRow = operationRows[0] || {};
  report.operations.unmatchedChangeLogOperations = asCount(operationRow.unmatched_change_log_operations);
  report.operations.duplicateOperationIdentities = asCount(operationRow.duplicate_operation_identities);
  if (report.operations.unmatchedChangeLogOperations !== 0 || report.operations.duplicateOperationIdentities !== 0) {
    problems.push('operation change-log and deduplication evidence is inconsistent');
  }

  const baselineRows = await rowsFor('owner baseline evidence', `
    WITH owner_decisions AS (
      SELECT baseline_decision_id, company_id, source_snapshot_hash, decision, scope_json
      FROM migration_baseline_decisions
      WHERE decision = 'CLEAN_PRODUCTION_LEDGER_BASELINE'
    ), owner_exclusions AS (
      SELECT exclusion_row.company_id, exclusion_row.baseline_decision_id,
        SUM(exclusion_row.quantity) AS excluded_quantity,
        COUNT(*) AS exclusion_rows,
        COUNT(*) FILTER (
          WHERE decision_row.baseline_decision_id IS NULL
            OR decision_row.company_id <> exclusion_row.company_id
            OR decision_row.source_snapshot_hash <> exclusion_row.source_snapshot_hash
            OR decision_row.decision <> 'CLEAN_PRODUCTION_LEDGER_BASELINE'
            OR exclusion_row.reason <> 'LEGACY_PRODUCTION_OUT_OF_SCOPE_BY_OWNER_DECISION'
        ) AS mismatch_rows
      FROM migration_baseline_exclusions exclusion_row
      LEFT JOIN migration_baseline_decisions decision_row
        ON decision_row.baseline_decision_id = exclusion_row.baseline_decision_id
      WHERE exclusion_row.category = 'LEGACY_PRODUCTION_OUT_OF_SCOPE_BY_OWNER_DECISION'
      GROUP BY exclusion_row.company_id, exclusion_row.baseline_decision_id
    ), owner_scope AS (
      SELECT decision_row.baseline_decision_id AS decision_id,
        exclusion_group.baseline_decision_id AS exclusion_decision_id,
        COALESCE(exclusion_group.excluded_quantity, 0) AS excluded_quantity,
        COALESCE(exclusion_group.exclusion_rows, 0) AS exclusion_rows,
        COALESCE(exclusion_group.mismatch_rows, 0) AS mismatch_rows,
        decision_row.scope_json
      FROM owner_decisions decision_row
      FULL OUTER JOIN owner_exclusions exclusion_group
        ON exclusion_group.company_id = decision_row.company_id
        AND exclusion_group.baseline_decision_id = decision_row.baseline_decision_id
    )
    SELECT
      COUNT(*) FILTER (WHERE decision_id IS NOT NULL) AS owner_decision_count,
      COALESCE(SUM(exclusion_rows), 0) AS owner_exclusion_rows,
      COALESCE(SUM(excluded_quantity), 0) AS owner_excluded_quantity,
      COALESCE(SUM(mismatch_rows), 0) AS owner_scope_mismatch_rows,
      COUNT(*) FILTER (
      WHERE (decision_id IS NOT NULL
        AND scope_json->>'recordingMode' IS DISTINCT FROM 'RETROSPECTIVE_EVIDENCE_RECONCILIATION'
        AND (
          excluded_quantity <> CASE
            WHEN scope_json ? 'excludedEvidenceQuantityTotal'
              THEN (scope_json->>'excludedEvidenceQuantityTotal')::numeric
            ELSE 747
          END
          OR (scope_json ? 'excludedEvidenceRowCount'
            AND exclusion_rows <> (scope_json->>'excludedEvidenceRowCount')::bigint)
          OR NOT COALESCE(scope_json->'preserved' ? 'workers', FALSE)
          OR NOT COALESCE(scope_json->'preserved' ? 'AVANS', FALSE)
          OR NOT COALESCE(scope_json->'preserved' ? 'JARIMA', FALSE)
          OR NOT COALESCE(scope_json->'preserved' ? 'parties', FALSE)
          OR NOT COALESCE(scope_json->'preserved' ? 'printed pattas', FALSE)
          OR NOT COALESCE(scope_json->'excluded' ? 'submittedTickets', FALSE)
          OR NOT COALESCE(scope_json->'excluded' ? 'ticket entries derived from submittedTickets', FALSE)
          OR NOT COALESCE(scope_json->'excluded' ? 'hisobQuantities', FALSE)
          OR NOT COALESCE(scope_json->'excluded' ? 'legacy production reconciliation quantities', FALSE)
        )) OR (decision_id IS NULL AND exclusion_decision_id IS NOT NULL)
      ) AS owner_decision_quantity_mismatch_count
    FROM owner_scope
  `);
  const baselineRow = baselineRows[0] || {};
  report.baseline.ownerExclusionRows = asCount(baselineRow.owner_exclusion_rows);
  report.baseline.ownerExcludedQuantity = Number(baselineRow.owner_excluded_quantity || 0);
  report.baseline.ownerScopeMismatchRows = asCount(baselineRow.owner_scope_mismatch_rows);
  report.baseline.ownerDecisionQuantityMismatchCount = asCount(baselineRow.owner_decision_quantity_mismatch_count);
  report.baseline.ownerDecisionCount = asCount(baselineRow.owner_decision_count);

  const retrospectiveBaselineRows = await rowsFor('retrospective clean-baseline evidence', `
    SELECT decision_row.company_id, decision_row.decision, decision_row.source_snapshot_hash,
      decision_row.scope_json,
      (SELECT COUNT(*) FROM tickets ticket_row
       WHERE ticket_row.company_id = decision_row.company_id) AS current_ticket_rows,
      (SELECT COUNT(*) FROM tickets ticket_row
       WHERE ticket_row.company_id = decision_row.company_id
         AND ticket_row.id IN (
           SELECT jsonb_array_elements_text(decision_row.scope_json->'evidence'->'baselineTicketIds')
         )) AS present_baseline_ticket_rows,
      (SELECT COUNT(*) FROM ticket_entries entry_row
       JOIN tickets ticket_row ON ticket_row.company_id = entry_row.company_id
         AND ticket_row.id = entry_row.ticket_id
       WHERE ticket_row.company_id = decision_row.company_id
         AND ticket_row.id IN (
           SELECT jsonb_array_elements_text(decision_row.scope_json->'evidence'->'baselineTicketIds')
         )) AS present_baseline_ticket_entries,
      (SELECT COUNT(*) FROM operations_dedup operation_row
       WHERE operation_row.company_id = decision_row.company_id
         AND operation_row.command_type = 'SubmitTicket') AS accepted_submit_operations,
      (SELECT COUNT(*) FROM production_adjustments adjustment_row
       WHERE adjustment_row.company_id = decision_row.company_id) AS current_production_adjustments,
      (SELECT COUNT(*) FROM operations_dedup operation_row
       WHERE operation_row.company_id = decision_row.company_id
         AND operation_row.command_type = 'RecordProductionAdjustment') AS accepted_production_adjustment_operations,
      (SELECT COUNT(*) FROM migration_baseline_exclusions exclusion_row
       WHERE exclusion_row.company_id = decision_row.company_id
         AND exclusion_row.baseline_decision_id = decision_row.baseline_decision_id) AS baseline_exclusion_rows
    FROM migration_baseline_decisions decision_row
    WHERE decision_row.decision = 'CLEAN_PRODUCTION_LEDGER_BASELINE'
      AND decision_row.scope_json->>'recordingMode' = 'RETROSPECTIVE_EVIDENCE_RECONCILIATION'
  `);
  const validNonnegativeInteger = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0;
  const retrospectiveBaselineMismatches = retrospectiveBaselineRows.filter((row) => {
    const scope = row.scope_json;
    const source = scope?.source;
    const sourceCounts = scope?.sourceTableCounts;
    const evidence = scope?.evidence;
    const baselineTicketIds = evidence?.baselineTicketIds;
    if (!scope || !source || !sourceCounts || !evidence || !Array.isArray(baselineTicketIds)) return true;
    const baselineTicketCount = Number(sourceCounts.tickets);
    const baselineEntryCount = Number(sourceCounts.ticket_entries);
    const baselineAdjustmentCount = Number(sourceCounts.production_adjustments);
    const currentSubmitCount = Number(evidence.currentPostImportAcceptedSubmitTicketOperations);
    const currentAdjustmentOperationCount = Number(evidence.currentAcceptedProductionAdjustmentOperations);
    const currentTicketCount = Number(evidence.currentTicketRows);
    const currentAdjustmentCount = Number(evidence.currentProductionAdjustments);
    return scope.decisionType !== row.decision
      || scope.businessRowsReimported !== false
      || scope.localOutboxImported !== false
      || source.integrityCheck !== 'ok'
      || Number(source.sqliteSchemaVersion) !== 15
      || source.sha256 !== row.source_snapshot_hash
      || source.stagedSha256 !== row.source_snapshot_hash
      || evidence.historicalTransactionalImportDocumented !== true
      || !Array.isArray(evidence.postgresSchemaMigrations)
      || ![16, 17].every((version) => evidence.postgresSchemaMigrations.includes(version))
      || !validNonnegativeInteger(baselineTicketCount)
      || !validNonnegativeInteger(baselineEntryCount)
      || !validNonnegativeInteger(baselineAdjustmentCount)
      || !validNonnegativeInteger(currentSubmitCount)
      || !validNonnegativeInteger(currentAdjustmentOperationCount)
      || !validNonnegativeInteger(currentTicketCount)
      || !validNonnegativeInteger(currentAdjustmentCount)
      || baselineTicketIds.length !== baselineTicketCount
      || Number(evidence.baselineTicketEntries) !== baselineEntryCount
      || Number(evidence.baselineProductionAdjustments) !== baselineAdjustmentCount
      || currentTicketCount !== Number(row.current_ticket_rows)
      || currentTicketCount !== baselineTicketCount + currentSubmitCount
      || Number(row.present_baseline_ticket_rows) !== baselineTicketCount
      || Number(row.present_baseline_ticket_entries) !== baselineEntryCount
      || currentSubmitCount !== Number(row.accepted_submit_operations)
      || currentAdjustmentCount !== Number(row.current_production_adjustments)
      || currentAdjustmentCount !== baselineAdjustmentCount + currentAdjustmentOperationCount
      || currentAdjustmentOperationCount !== Number(row.accepted_production_adjustment_operations)
      || Number(row.baseline_exclusion_rows) !== 0;
  });
  report.baseline.ownerDecisionQuantityMismatchCount += retrospectiveBaselineMismatches.length;
  report.baseline.scopePreserved = report.baseline.ownerScopeMismatchRows === 0
    && report.baseline.ownerDecisionQuantityMismatchCount === 0;
  if (!report.baseline.scopePreserved) problems.push('owner-approved baseline exclusion category, source, or source-scoped quantity changed');

  if (problems.length) throw integrityFailure(problems, report);
  return report;
}

module.exports = { EXPECTED_MIGRATIONS, REQUIRED_FOREIGN_KEYS, RESTRICTIVE_FOREIGN_KEYS, verifyPostgresReleaseState };
