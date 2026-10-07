import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const {
  REQUIRED_FOREIGN_KEYS,
  RESTRICTIVE_FOREIGN_KEYS,
  verifyPostgresReleaseState
} = require('./postgresIntegrity.cjs');
const { MIGRATIONS: productionMigrations } = require('../../../ops/deploy/migrateProduction.cjs');
const { verifyFreshPostgres16TestEnvironment } = require('../../../scripts/verify/verify-pg16-test-env.cjs');

const exactMigrations = [
  'schema.sql',
  'deploy_active_party_migration.sql',
  'deploy_operator_auth_migration.sql',
  'deploy_operator_auth_rate_limit_migration.sql',
  'deploy_reconciliation_migration.sql',
  'deploy_ticket_identity_party_fk_migration.sql',
  'deploy_exact_party_2_policy_migration.sql',
  'deploy_activation_migration.sql',
  'deploy_business_mutations_migration.sql',
  'deploy_activation_company_scope_migration.sql',
  'deploy_activation_policy_revision_migration.sql',
  'deploy_exact_party_2_company_scope_migration.sql',
  'deploy_activation_policy_device_sync_migration.sql',
  'deploy_free_mode_ticket_party_migration.sql',
  'deploy_patta_work_quantity_migration.sql',
  'deploy_canonical_ids_global_patta_sequence.sql',
  'deploy_production_adjustment_provenance_migration.sql',
  'deploy_patta_series_sequence_migration.sql',
  'deploy_patta_sequence_runtime_grant_migration.sql',
  'deploy_voided_ticket_patta_reuse_migration.sql'
].map((name, index) => ({ version: index + 1, name }));

const exactForeignKeys = [
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
].map(([source_table, source_columns, target_table, target_columns]) => ({
  source_table,
  source_columns,
  target_table,
  target_columns,
  definition: source_table === 'activation_companies'
    ? 'FOREIGN KEY (company_id) REFERENCES company_batch_settings(company_id) ON DELETE RESTRICT'
    : 'FOREIGN KEY (...)',
  validated: true
}));

function createEvidenceClient(overrides: Record<string, any> = {}) {
  const evidence = {
    migrations: exactMigrations,
    foreignKeys: exactForeignKeys,
    orphans: [{
      tickets_parties: '0',
      tickets_models: '0',
      ticket_entries_tickets: '0',
      ticket_entries_workers: '0',
      worker_adjustments_workers: '0',
      printed_pattas_parties: '0',
      printed_pattas_models: '0',
      printed_patta_operations_pattas: '0',
      worker_credentials_workers: '0',
      worker_bindings_workers: '0',
      tickets_periods: '0',
      worker_adjustments_periods: '0',
      batch_settings_models: '0',
      period_archives_periods: '0'
    }],
    partyTrigger: [{
      trigger_name: 'trg_parties_active_uniqueness',
      function_name: 'check_active_party_uniqueness',
      function_definition: "IF NEW.status != 'CLOSED' THEN SELECT 1 FROM legacy_party_collision_exceptions current_exception JOIN legacy_party_collision_exceptions other_exception ON other_exception.collision_group_id = current_exception.collision_group_id WHERE current_exception.company_id = NEW.company_id AND current_exception.party_id = NEW.id AND current_exception.party_number = NEW.party_number AND COUNT(*) = 2; RAISE EXCEPTION 'ACTIVE_PARTY_EXISTS'; END IF"
    }],
    constraints: [{ constraint_name: 'ck_tickets_id_rfc4122', validated: true }],
    businessIndexes: [],
    operations: [{ unmatched_change_log_operations: '0', duplicate_operation_identities: '0' }],
    partyPattaIndexes: [{
      indexname: 'idx_tickets_party_patta',
      indexdef: "CREATE UNIQUE INDEX idx_tickets_party_patta ON public.tickets USING btree (company_id, party_record_id, patta_number) WHERE ((party_record_id IS NOT NULL) AND ((status)::text <> 'VOIDED'::text))"
    }],
    pattaSequencePrivileges: [{ can_select: true, can_insert: true, can_update: true }],
    baseline: [{ owner_exclusion_rows: '0', owner_excluded_quantity: '0', owner_scope_mismatch_rows: '0' }],
    activationTables: [
      'activation_companies', 'activation_requests', 'activation_request_limits',
      'activation_events', 'worker_credentials', 'worker_telegram_bindings', 'worker_binding_limits'
    ].map((table_name) => ({ table_name })),
    businessTables: ['company_batch_settings', 'patta_batch_settings', 'period_archives'].map((table_name) => ({ table_name })),
    businessColumns: [
      ['models', 'status'], ['models', 'server_revision'], ['models', 'hisob_sheet_name'],
      ['models', 'title'], ['models', 'party'], ['models', 'color'], ['models', 'size'],
      ['models', 'patta_ops_order_json'], ['workers', 'server_revision'], ['workers', 'staj'],
      ['workers', 'role'], ['periods', 'name'], ['periods', 'server_revision'], ['periods', 'closed_at'], ['periods', 'created_at'],
      ['tickets', 'period_id'], ['worker_adjustments', 'period_id'], ['parties', 'is_archived']
    ].map(([table_name, column_name]) => ({ table_name, column_name })),
    workerStajColumn: [{ column_name: 'staj' }],
    ...overrides
  };

  const queries: string[] = [];
  return {
    queries,
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM schema_migrations')) return { rows: evidence.migrations };
      if (sql.includes("'company_batch_settings'")) return { rows: evidence.businessTables };
      if (sql.includes("table_name = 'models'")) return { rows: evidence.businessColumns };
      if (sql.includes('FROM information_schema.tables')) return { rows: evidence.activationTables };
      if (sql.includes('FROM information_schema.columns')) return { rows: evidence.workerStajColumn };
      if (sql.includes('ARRAY_AGG(source_attribute.attname')) return { rows: evidence.foreignKeys };
      if (sql.includes('AS tickets_parties')) return { rows: evidence.orphans };
      if (sql.includes('trg_parties_active_uniqueness')) return { rows: evidence.partyTrigger };
      if (sql.includes("'ck_tickets_id_rfc4122'")) return { rows: evidence.constraints };
      if (sql.includes("'idx_tickets_company_global_patta', 'idx_tickets_party_patta'")) return { rows: evidence.partyPattaIndexes };
      if (sql.includes('has_table_privilege(current_user, \'company_patta_sequences\'')) return { rows: evidence.pattaSequencePrivileges };
      if (sql.includes('FROM pg_indexes')) return { rows: evidence.businessIndexes };
      if (sql.includes('unmatched_change_log_operations')) return { rows: evidence.operations };
      if (sql.includes('owner_exclusion_rows')) return { rows: evidence.baseline };
      if (sql.includes('FROM migration_baseline_decisions decision_row')) return { rows: evidence.retrospectiveBaselines || [] };
      throw new Error(`Unexpected PostgreSQL integrity query: ${sql}`);
    })
  };
}

describe('PostgreSQL release-integrity evidence', () => {
  it('deploys exactly the migration lineage required by release verification', () => {
    expect(productionMigrations).toEqual(exactMigrations.map(({ name }) => name));
  });

  it('returns named PostgreSQL evidence for the complete ordered schema', async () => {
    const client = createEvidenceClient();

    const report = await verifyPostgresReleaseState(client);

    expect(report.evidenceType).toBe('postgresql_release_integrity');
    expect(report.migrations.contiguous).toBe(true);
    expect(report.migrations.namesMatch).toBe(true);
    expect(report.activation).toMatchObject({ requiredTables: 7, presentTables: 7, stajColumnExists: true });
    expect(report.businessMutations).toMatchObject({ requiredTables: 3, presentTables: 3, requiredColumns: 18, presentColumns: 18 });
    expect(report.foreignKeys.requiredCount).toBe(REQUIRED_FOREIGN_KEYS.length);
    expect(report.foreignKeys.presentAndValidated).toBe(REQUIRED_FOREIGN_KEYS.length);
    expect(report.foreignKeys.restrictiveRequiredCount).toBe(RESTRICTIVE_FOREIGN_KEYS.length);
    expect(report.foreignKeys.presentAndRestrictive).toBe(RESTRICTIVE_FOREIGN_KEYS.length);
    expect(report.orphanCounts).toMatchObject({ tickets_parties: 0, printed_patta_operations_pattas: 0 });
    expect(report.partyPolicy.callsExactPolicyFunction).toBe(true);
    expect(report.constraints.ticketUuidCheckValidated).toBe(true);
    expect(report.constraints.businessKeyAbsent).toBe(true);
    expect(report.constraints).toMatchObject({ partyPattaUnique: true, voidedTicketPattaReusable: true, companyWidePattaIndexAbsent: true });
    expect(report.pattaSequencePrivileges).toEqual({ canSelect: true, canInsert: true, canUpdate: true });
    expect(report.operations).toEqual({ unmatchedChangeLogOperations: 0, duplicateOperationIdentities: 0 });
    expect(report.baseline.scopePreserved).toBe(true);
  });

  it('fails closed on migration gaps, unvalidated relationships, orphans, business-key constraints, and scope drift', async () => {
    const client = createEvidenceClient({
      migrations: exactMigrations.filter((row) => row.version !== 4),
      foreignKeys: exactForeignKeys.slice(1),
      orphans: [{ tickets_models: '1' }],
      constraints: [
        { constraint_name: 'ck_tickets_id_rfc4122', validated: false },
        { constraint_name: 'uq_tickets_business_key', validated: true }
      ],
      businessIndexes: [{ indexname: 'idx_tickets_business_key' }],
      partyPattaIndexes: [],
      operations: [{ unmatched_change_log_operations: '1', duplicate_operation_identities: '1' }],
      baseline: [{ owner_exclusion_rows: '5', owner_excluded_quantity: '748', owner_scope_mismatch_rows: '1' }]
    });

    await expect(verifyPostgresReleaseState(client)).rejects.toMatchObject({
      code: 'POSTGRES_RELEASE_INTEGRITY_FAILED',
      details: {
        problems: expect.arrayContaining([
          expect.stringContaining('schema_migrations'),
          expect.stringContaining('foreign keys'),
          expect.stringContaining('orphan'),
          expect.stringContaining('business-key'),
          expect.stringContaining('patta uniqueness'),
          expect.stringContaining('operation'),
          expect.stringContaining('baseline')
        ])
      }
    });
  });

  it('fails closed when the party/patta index still reserves keys for voided tickets', async () => {
    const client = createEvidenceClient({
      partyPattaIndexes: [{
        indexname: 'idx_tickets_party_patta',
        indexdef: 'CREATE UNIQUE INDEX idx_tickets_party_patta ON public.tickets USING btree (company_id, party_record_id, patta_number) WHERE (party_record_id IS NOT NULL)'
      }]
    });

    await expect(verifyPostgresReleaseState(client)).rejects.toMatchObject({
      code: 'POSTGRES_RELEASE_INTEGRITY_FAILED',
      details: {
        problems: expect.arrayContaining([expect.stringContaining('release keys for voided tickets')]),
        report: { constraints: { voidedTicketPattaReusable: false } }
      }
    });
  });

  it('fails closed when the activation policy reference is not restrictive', async () => {
    const client = createEvidenceClient({
      foreignKeys: exactForeignKeys.map((row) => row.source_table === 'activation_companies'
        ? { ...row, definition: 'FOREIGN KEY (company_id) REFERENCES company_batch_settings(company_id) ON DELETE CASCADE' }
        : row)
    });

    await expect(verifyPostgresReleaseState(client)).rejects.toMatchObject({
      code: 'POSTGRES_RELEASE_INTEGRITY_FAILED',
      details: {
        problems: expect.arrayContaining([expect.stringContaining('not restrictive')]),
        report: { foreignKeys: { presentAndRestrictive: 0 } }
      }
    });
  });

  it('fails closed when the persisted Party #2 exception is not company-scoped', async () => {
    const client = createEvidenceClient({
      partyTrigger: [{
        trigger_name: 'trg_parties_active_uniqueness',
        function_name: 'check_active_party_uniqueness',
        function_definition: "IF NEW.party_number = '2' THEN SELECT 1 FROM legacy_party_collision_exceptions WHERE party_id = NEW.id AND party_number = NEW.party_number AND collision_group_id = 'group'; END IF"
      }]
    });

    await expect(verifyPostgresReleaseState(client)).rejects.toMatchObject({
      code: 'POSTGRES_RELEASE_INTEGRITY_FAILED',
      details: { problems: expect.arrayContaining([expect.stringContaining('company-scoped persisted exception policy')]) }
    });
  });

  it('retains the owner-approved 747-unit exclusion category and baseline scope', async () => {
    const client = createEvidenceClient({
      baseline: [{
        owner_decision_count: '1',
        owner_exclusion_rows: '5',
        owner_excluded_quantity: '747',
        owner_scope_mismatch_rows: '0',
        owner_decision_quantity_mismatch_count: '0'
      }]
    });

    const report = await verifyPostgresReleaseState(client);

    expect(report.baseline).toMatchObject({
      ownerDecisionCount: 1,
      ownerExclusionRows: 5,
      ownerExcludedQuantity: 747,
      ownerDecisionQuantityMismatchCount: 0,
      scopePreserved: true
    });
  });

  it('validates fresh-source exclusion totals instead of forcing a historical total', async () => {
    const client = createEvidenceClient({
      baseline: [{
        owner_decision_count: '1',
        owner_exclusion_rows: '783',
        owner_excluded_quantity: '591028',
        owner_scope_mismatch_rows: '0',
        owner_decision_quantity_mismatch_count: '0'
      }]
    });

    const report = await verifyPostgresReleaseState(client);
    const baselineQuery = client.queries.find((query) => query.includes('owner_exclusion_rows'));

    expect(report.baseline).toMatchObject({
      ownerDecisionCount: 1,
      ownerExclusionRows: 783,
      ownerExcludedQuantity: 591028,
      ownerDecisionQuantityMismatchCount: 0,
      scopePreserved: true
    });
    expect(baselineQuery).toContain("scope_json->>'excludedEvidenceQuantityTotal'");
    expect(baselineQuery).toContain("scope_json->>'excludedEvidenceRowCount'");
  });

  it('accepts current operations after a complete retrospective import snapshot', async () => {
    const sourceSnapshotHash = 'b'.repeat(64);
    const client = createEvidenceClient({
      baseline: [{
        owner_decision_count: '1', owner_exclusion_rows: '0', owner_excluded_quantity: '0',
        owner_scope_mismatch_rows: '0', owner_decision_quantity_mismatch_count: '0'
      }],
      retrospectiveBaselines: [{
        company_id: 'company-a', decision: 'CLEAN_PRODUCTION_LEDGER_BASELINE',
        source_snapshot_hash: sourceSnapshotHash,
        scope_json: {
          decisionType: 'CLEAN_PRODUCTION_LEDGER_BASELINE',
          recordingMode: 'RETROSPECTIVE_EVIDENCE_RECONCILIATION',
          businessRowsReimported: false,
          localOutboxImported: false,
          source: {
            sha256: sourceSnapshotHash, stagedSha256: sourceSnapshotHash,
            sqliteSchemaVersion: 15, integrityCheck: 'ok'
          },
          sourceTableCounts: { tickets: 1, ticket_entries: 2, production_adjustments: 1 },
          evidence: {
            historicalTransactionalImportDocumented: true,
            postgresSchemaMigrations: [16, 17],
            baselineTicketIds: ['baseline-ticket'],
            baselineTicketEntries: 2,
            currentPostImportAcceptedSubmitTicketOperations: 1,
            currentTicketRows: 2,
            baselineProductionAdjustments: 1,
            currentAcceptedProductionAdjustmentOperations: 1,
            currentProductionAdjustments: 2
          }
        },
        current_ticket_rows: '3', present_baseline_ticket_rows: '1',
        present_baseline_ticket_entries: '2', accepted_submit_operations: '2',
        current_production_adjustments: '3', accepted_production_adjustment_operations: '2',
        baseline_exclusion_rows: '0'
      }]
    });

    const report = await verifyPostgresReleaseState(client);
    expect(report.baseline).toMatchObject({
      ownerDecisionCount: 1,
      ownerDecisionQuantityMismatchCount: 0,
      scopePreserved: true
    });
  });

  it('fails closed when retrospective baseline counts no longer reconcile with server rows', async () => {
    const sourceSnapshotHash = 'c'.repeat(64);
    const client = createEvidenceClient({
      baseline: [{
        owner_decision_count: '1', owner_exclusion_rows: '0', owner_excluded_quantity: '0',
        owner_scope_mismatch_rows: '0', owner_decision_quantity_mismatch_count: '0'
      }],
      retrospectiveBaselines: [{
        company_id: 'company-a', decision: 'CLEAN_PRODUCTION_LEDGER_BASELINE',
        source_snapshot_hash: sourceSnapshotHash,
        scope_json: {
          decisionType: 'CLEAN_PRODUCTION_LEDGER_BASELINE',
          recordingMode: 'RETROSPECTIVE_EVIDENCE_RECONCILIATION',
          businessRowsReimported: false,
          localOutboxImported: false,
          source: {
            sha256: sourceSnapshotHash, stagedSha256: sourceSnapshotHash,
            sqliteSchemaVersion: 15, integrityCheck: 'ok'
          },
          sourceTableCounts: { tickets: 1, ticket_entries: 2, production_adjustments: 1 },
          evidence: {
            historicalTransactionalImportDocumented: true,
            postgresSchemaMigrations: [16, 17],
            baselineTicketIds: ['baseline-ticket'],
            baselineTicketEntries: 2,
            currentPostImportAcceptedSubmitTicketOperations: 2,
            currentTicketRows: 4,
            baselineProductionAdjustments: 1,
            currentAcceptedProductionAdjustmentOperations: 1,
            currentProductionAdjustments: 2
          }
        },
        current_ticket_rows: '3', present_baseline_ticket_rows: '1',
        present_baseline_ticket_entries: '2', accepted_submit_operations: '2',
        current_production_adjustments: '2', accepted_production_adjustment_operations: '1',
        baseline_exclusion_rows: '0'
      }]
    });

    await expect(verifyPostgresReleaseState(client)).rejects.toMatchObject({
      code: 'POSTGRES_RELEASE_INTEGRITY_FAILED',
      details: { problems: expect.arrayContaining([expect.stringContaining('baseline')]) }
    });
  });

  it('refuses PostgreSQL preflight before creating a client without explicit disposable opt-in', async () => {
    const ClientClass = vi.fn();

    await expect(verifyFreshPostgres16TestEnvironment(undefined, {
      env: { NOVDA_DISPOSABLE_PG: '0' },
      ClientClass
    })).rejects.toThrow('DISPOSABLE_POSTGRES_REQUIRED');

    expect(ClientClass).not.toHaveBeenCalled();
  });

  it('returns actual database and PostgreSQL 16 version only after disposable preflight', async () => {
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ rows: [{ database: 'novda_regression_test', server_version_num: '160004' }] }),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const ClientClass = vi.fn(function ClientCtor() { return mockClient; });

    await expect(verifyFreshPostgres16TestEnvironment('postgresql://isolated', {
      env: { NOVDA_DISPOSABLE_PG: '1' },
      ClientClass
    })).resolves.toEqual({ database: 'novda_regression_test', serverVersion: '160004' });

    expect(ClientClass).toHaveBeenCalledWith({ connectionString: 'postgresql://isolated' });
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.end).toHaveBeenCalledTimes(1);
  });
});

const disposableUrl = process.env.NOVDA_DISPOSABLE_PG === '1'
  && !process.env.DATABASE_URL
  ? process.env.NOVDA_PG_URL
  : undefined;
const describeDisposablePostgres = disposableUrl ? describe : describe.skip;

describeDisposablePostgres('DISPOSABLE PostgreSQL 16 release-integrity integration', () => {
  const schemaName = `novda_release_integrity_${process.pid}_${Date.now().toString(36)}`;
  const quotedSchemaName = `"${schemaName}"`;
  let adminPool: Pool | undefined;
  let isolatedPool: Pool | undefined;
  let schemaCreated = false;

  beforeAll(async () => {
    if (!disposableUrl || process.env.NOVDA_DISPOSABLE_PG !== '1' || process.env.DATABASE_URL) {
      throw new Error('DISPOSABLE_POSTGRES_REQUIRED: use only NOVDA_PG_URL with NOVDA_DISPOSABLE_PG=1');
    }
    await verifyFreshPostgres16TestEnvironment(disposableUrl);
    adminPool = new Pool({ connectionString: disposableUrl });
    await adminPool.query(`CREATE SCHEMA ${quotedSchemaName}`);
    schemaCreated = true;
    isolatedPool = new Pool({
      connectionString: disposableUrl,
      options: `-c search_path=${schemaName},public`
    });
    await isolatedPool.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
    for (const filename of [
      'deploy_active_party_migration.sql',
      'deploy_operator_auth_migration.sql',
      'deploy_operator_auth_rate_limit_migration.sql',
      'deploy_reconciliation_migration.sql',
      'deploy_ticket_identity_party_fk_migration.sql',
      'deploy_exact_party_2_policy_migration.sql',
      'deploy_activation_migration.sql',
      'deploy_business_mutations_migration.sql',
      'deploy_activation_company_scope_migration.sql',
      'deploy_activation_policy_revision_migration.sql',
      'deploy_exact_party_2_company_scope_migration.sql',
      'deploy_activation_policy_device_sync_migration.sql',
      'deploy_free_mode_ticket_party_migration.sql',
      'deploy_patta_work_quantity_migration.sql',
      'deploy_canonical_ids_global_patta_sequence.sql',
      'deploy_production_adjustment_provenance_migration.sql',
      'deploy_patta_series_sequence_migration.sql',
      'deploy_patta_sequence_runtime_grant_migration.sql',
      'deploy_voided_ticket_patta_reuse_migration.sql'
    ]) {
      await isolatedPool.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', filename), 'utf8'));
    }
  }, 120_000);

  afterAll(async () => {
    try {
      if (schemaCreated && adminPool) await adminPool.query(`DROP SCHEMA ${quotedSchemaName} CASCADE`);
    } finally {
      if (isolatedPool) await isolatedPool.end();
      if (adminPool) await adminPool.end();
    }
  });

  it('verifies a fresh schema after applying all ordered deployment migrations', async () => {
    const freshReport = await verifyPostgresReleaseState(isolatedPool);
    expect(freshReport.migrations.rows.map((row: any) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(freshReport.foreignKeys.presentAndValidated).toBe(REQUIRED_FOREIGN_KEYS.length);
    expect(freshReport.partyPolicy.callsExactPolicyFunction).toBe(true);
    expect(freshReport.baseline.scopePreserved).toBe(true);

    const baselineDecisionId = 'decision_release_integrity_owner_baseline';
    const sourceSnapshotHash = 'a'.repeat(64);
    await isolatedPool!.query(`
      INSERT INTO migration_baseline_decisions (
        baseline_decision_id, company_id, decision, scope_json, source_path,
        source_size, source_mtime, source_snapshot_hash, decided_at
      ) VALUES ($1, 'company-a', 'CLEAN_PRODUCTION_LEDGER_BASELINE', $2, 'fixture.json', 1, NOW(), $3, NOW())
    `, [baselineDecisionId, JSON.stringify({
      preserved: ['workers', 'AVANS', 'JARIMA', 'parties', 'printed pattas', 'required reference rows'],
      excluded: ['submittedTickets', 'ticket entries derived from submittedTickets', 'hisobQuantities', 'legacy production reconciliation quantities']
    }), sourceSnapshotHash]);
    for (const [index, quantity] of [100, 150, 200, 150, 147].entries()) {
      await isolatedPool!.query(`
        INSERT INTO migration_baseline_exclusions (
          exclusion_id, company_id, baseline_decision_id, category, source_reference,
          quantity, reason, source_snapshot_hash
        ) VALUES ($1, 'company-a', $2, 'LEGACY_PRODUCTION_OUT_OF_SCOPE_BY_OWNER_DECISION', $3, $4,
          'LEGACY_PRODUCTION_OUT_OF_SCOPE_BY_OWNER_DECISION', $5)
      `, [`exclusion-${index}`, baselineDecisionId, `candidate-${index}`, quantity, sourceSnapshotHash]);
    }

    const seededReport = await verifyPostgresReleaseState(isolatedPool);
    expect(seededReport.baseline).toMatchObject({
      ownerDecisionCount: 1,
      ownerExclusionRows: 5,
      ownerExcludedQuantity: 747,
      ownerScopeMismatchRows: 0,
      ownerDecisionQuantityMismatchCount: 0,
      scopePreserved: true
    });
  });
});
