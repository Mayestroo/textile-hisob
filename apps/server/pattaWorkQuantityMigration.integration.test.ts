import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const { verifyFreshPostgres16TestEnvironment } = require('../../scripts/verify/verify-pg16-test-env.cjs');
const { verifyPostgresReleaseState } = require('./infrastructure/postgresIntegrity.cjs');

const disposableUrl = process.env.NOVDA_DISPOSABLE_PG === '1'
  && !process.env.DATABASE_URL
  ? process.env.NOVDA_PG_URL
  : undefined;
const describeDisposablePostgres = disposableUrl ? describe : describe.skip;
const priorMigrations = [
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
  'deploy_free_mode_ticket_party_migration.sql'
];

describeDisposablePostgres('PostgreSQL 16 Patta work-quantity migration 15', () => {
  let adminPool: Pool | undefined;
  const isolatedPools: Pool[] = [];
  const createdSchemas: string[] = [];
  let schemaSequence = 0;

  async function createMigratedSchema(label: string) {
    if (!adminPool || !disposableUrl) throw new Error('DISPOSABLE_POSTGRES_REQUIRED');
    schemaSequence += 1;
    const schemaName = `novda_patta_quantity_${label}_${process.pid}_${Date.now().toString(36)}_${schemaSequence}`;
    const quotedSchema = `"${schemaName}"`;
    await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
    createdSchemas.push(schemaName);
    const pool = new Pool({ connectionString: disposableUrl, options: `-c search_path=${schemaName},public` });
    isolatedPools.push(pool);

    await pool.query(fs.readFileSync(path.join(__dirname, 'database', 'schema.sql'), 'utf8'));
    for (const filename of priorMigrations.slice(1)) {
      await pool.query(fs.readFileSync(path.join(__dirname, 'database', 'migrations', filename), 'utf8'));
    }
    return pool;
  }

  async function insertParty(
    pool: Pool,
    party: {
      id: string;
      companyId: string;
      pattaCount: number;
      sourceTotal: string | null;
      sizes?: Record<string, number | string> | number[] | null;
      createdAt?: string;
    }
  ) {
    const sourceValue = party.sourceTotal;
    await pool.query(`INSERT INTO parties (
      id, company_id, party_number, physical_party_number, model_id, model_name,
      patta_count, cumulative_patta_count, ish_soni_per_patta, total_ish_soni,
      ish_soni, cumulative_ish_soni, sizes_json, printed_at, is_closed, closed_at,
      archived_patta_numbers_json, status, server_revision, created_at, updated_at
    ) VALUES ($1, $2, $1, $1, 'model-1', 'Fixture Model', $3, $3, $4::numeric, $4::numeric,
      COALESCE($4::numeric, 0), COALESCE($4::numeric, 0), $5::jsonb, '2026-09-20T08:00:00Z', 0, NULL, '[]'::jsonb,
      'ACTIVE', 7, $6::timestamptz, $6::timestamptz)`, [
      party.id,
      party.companyId,
      party.pattaCount,
      sourceValue,
      party.sizes === undefined ? null : JSON.stringify(party.sizes),
      party.createdAt || '2026-09-20T08:00:00Z'
    ]);
  }

  async function snapshot(pool: Pool) {
    const [parties, lineage] = await Promise.all([
      pool.query('SELECT to_jsonb(party) AS row FROM parties party ORDER BY company_id, id'),
      pool.query('SELECT version, name FROM schema_migrations ORDER BY version')
    ]);
    return { parties: parties.rows, lineage: lineage.rows };
  }

  async function applyMigration(pool: Pool) {
    return pool.query(fs.readFileSync(path.join(__dirname, 'database', 'migrations', 'deploy_patta_work_quantity_migration.sql'), 'utf8'));
  }

  async function expectMigrationBlockedAtomically(pool: Pool, expectedDetails: string[]) {
    const before = await snapshot(pool);
    const client = await pool.connect();
    let migrationError: Error | undefined;
    try {
      await client.query(fs.readFileSync(path.join(__dirname, 'database', 'migrations', 'deploy_patta_work_quantity_migration.sql'), 'utf8'));
    } catch (error) {
      migrationError = error as Error;
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect(migrationError?.message).toContain('PATTA_WORK_QUANTITY_MIGRATION_BLOCKED');
    for (const detail of expectedDetails) expect(migrationError?.message).toContain(detail);
    expect(await snapshot(pool)).toEqual(before);
  }

  beforeAll(async () => {
    if (!disposableUrl || process.env.NOVDA_DISPOSABLE_PG !== '1' || process.env.DATABASE_URL) {
      throw new Error('DISPOSABLE_POSTGRES_REQUIRED: use NOVDA_PG_URL with NOVDA_DISPOSABLE_PG=1 and DATABASE_URL unset');
    }
    await verifyFreshPostgres16TestEnvironment(disposableUrl);
    adminPool = new Pool({ connectionString: disposableUrl });
  }, 120_000);

  afterAll(async () => {
    await Promise.all(isolatedPools.map((pool) => pool.end()));
    if (adminPool) {
      try {
        for (const schemaName of createdSchemas) {
          await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        }
      } finally {
        await adminPool.end();
      }
    }
  });

  it('corrects legacy party totals, preserves ticket quantities, and emits a complete deterministic UPDATE', async () => {
    const pool = await createMigratedSchema('success');
    await pool.query(`INSERT INTO models (id, company_id, name, operations_json)
      VALUES ('model-1', 'company-patta-success', 'Fixture Model', '[]'::jsonb)`);
    await insertParty(pool, {
      id: 'party-earlier', companyId: 'company-patta-success', pattaCount: 2,
      sourceTotal: '40', sizes: { S: 2 }, createdAt: '2026-09-20T08:00:00Z'
    });
    await insertParty(pool, {
      id: 'party-9-pattas', companyId: 'company-patta-success', pattaCount: 9,
      sourceTotal: '972', sizes: { M: '9', L: '' }, createdAt: '2026-09-20T09:00:00Z'
    });
    await insertParty(pool, {
      id: 'party-b-tie', companyId: 'company-patta-success', pattaCount: 3,
      sourceTotal: '60', sizes: { L: 3 }, createdAt: '2026-09-20T09:00:00Z'
    });
    await insertParty(pool, {
      id: 'party-zero-size-zero', companyId: 'company-patta-success', pattaCount: 0,
      sourceTotal: null, sizes: { M: '', L: ' \t ' }, createdAt: '2026-09-20T07:00:00Z'
    });
    await insertParty(pool, {
      id: 'party-zero-empty-sizes', companyId: 'company-patta-success', pattaCount: 0,
      sourceTotal: '0', sizes: {}, createdAt: '2026-09-20T07:30:00Z'
    });
    await insertParty(pool, {
      id: 'party-zero-absent-sizes', companyId: 'company-patta-success', pattaCount: 0,
      sourceTotal: '0', sizes: null, createdAt: '2026-09-20T07:45:00Z'
    });
    await insertParty(pool, {
      id: 'party-null-sizes', companyId: 'company-no-size-data', pattaCount: 2, sourceTotal: '20', sizes: null
    });
    await insertParty(pool, {
      id: 'party-empty-sizes', companyId: 'company-empty-size-data', pattaCount: 3, sourceTotal: '30', sizes: {}
    });
    await pool.query(`UPDATE parties SET cumulative_ish_soni = 972 WHERE company_id = 'company-patta-success'
      AND id = 'party-zero-size-zero'`);
    const zeroRowsBefore = await pool.query(`SELECT id, to_jsonb(party) AS row FROM parties party
      WHERE company_id = 'company-patta-success' AND patta_count = 0 ORDER BY id`);
    await pool.query(`INSERT INTO tickets (
      id, company_id, model_id, party_number, party_record_id, patta_number, qty, submitted_at, server_revision
    ) VALUES (
      '00000000-0000-4000-8000-000000000015', 'company-patta-success', 'model-1',
      'party-9-pattas', 'party-9-pattas', 1, 37, '2026-09-20T08:30:00Z', 11
    )`);
    const ticketBefore = await pool.query(`SELECT * FROM tickets WHERE id = '00000000-0000-4000-8000-000000000015'`);

    await applyMigration(pool);

    const corrected = await pool.query(`SELECT patta_count, ish_soni_per_patta, total_ish_soni, ish_soni, sizes_json,
      cumulative_ish_soni, server_revision FROM parties WHERE company_id = 'company-patta-success' AND id = 'party-9-pattas'`);
    expect(corrected.rows[0]).toMatchObject({ patta_count: 9, server_revision: 8 });
    expect(Number(corrected.rows[0].ish_soni_per_patta)).toBe(108);
    expect(Number(corrected.rows[0].total_ish_soni)).toBe(972);
    expect(Number(corrected.rows[0].ish_soni)).toBe(972);
    expect(Number(corrected.rows[0].cumulative_ish_soni)).toBe(1012);
    expect(corrected.rows[0].sizes_json).toEqual({ M: '9', L: '' });

    const orderedPositiveParties = await pool.query(`SELECT id, ish_soni_per_patta, total_ish_soni,
      cumulative_ish_soni FROM parties WHERE company_id = 'company-patta-success'
      AND patta_count > 0 ORDER BY created_at, id`);
    expect(orderedPositiveParties.rows.map((row) => [
      row.id, Number(row.ish_soni_per_patta), Number(row.total_ish_soni), Number(row.cumulative_ish_soni)
    ])).toEqual([
      ['party-earlier', 20, 40, 40],
      ['party-9-pattas', 108, 972, 1012],
      ['party-b-tie', 20, 60, 1072]
    ]);

    const zeroRowsAfter = await pool.query(`SELECT id, to_jsonb(party) AS row FROM parties party
      WHERE company_id = 'company-patta-success' AND patta_count = 0 ORDER BY id`);
    expect(zeroRowsAfter.rows).toEqual(zeroRowsBefore.rows);

    const noSizeData = await pool.query(`SELECT patta_count, ish_soni_per_patta, ish_soni FROM parties
      WHERE company_id IN ('company-no-size-data', 'company-empty-size-data') ORDER BY company_id`);
    expect(noSizeData.rows.map((row) => [Number(row.patta_count), Number(row.ish_soni_per_patta), Number(row.ish_soni)]))
      .toEqual([[3, 10, 30], [2, 10, 20]]);

    const ticketAfter = await pool.query(`SELECT * FROM tickets WHERE id = '00000000-0000-4000-8000-000000000015'`);
    expect(ticketAfter.rows).toEqual(ticketBefore.rows);

    const events = await pool.query(`SELECT entity_revision, operation_id, change_type, payload_json
      FROM change_log WHERE company_id = 'company-patta-success' AND entity_id = 'party-9-pattas'`);
    expect(events.rows).toHaveLength(1);
    const event = events.rows[0];
    expect(event.entity_revision).toBe(8);
    expect(event.change_type).toBe('UPDATE');
    expect(event.operation_id).toBe(`migration-patta-quantity-v1-${crypto.createHash('md5').update('company-patta-success:party-9-pattas').digest('hex')}`);
    expect(Object.keys(event.payload_json).sort()).toEqual([
      'archivedPattaNumbers', 'closedAt', 'color', 'cumulativeIshSoni', 'cumulativePattaCount',
      'ishSoni', 'ishSoniPerPatta', 'isClosed', 'modelId', 'modelName', 'partyNumber',
      'partyRecordId', 'pattaCount', 'physicalPartyNumber', 'printedAt', 'sizes', 'status',
      'totalIshSoni', 'updatedAt'
    ].sort());
    expect(event.payload_json).toMatchObject({
      partyRecordId: 'party-9-pattas',
      partyNumber: 'party-9-pattas',
      physicalPartyNumber: 'party-9-pattas',
      modelId: 'model-1',
      pattaCount: 9,
      ishSoniPerPatta: 108,
      totalIshSoni: 972,
      ishSoni: 972,
      cumulativeIshSoni: 1012,
      sizes: { M: '9', L: '' },
      status: 'ACTIVE',
      isClosed: false
    });
    expect((await pool.query('SELECT version, name FROM schema_migrations WHERE version = 15')).rows)
      .toEqual([{ version: 15, name: 'deploy_patta_work_quantity_migration.sql' }]);

    await applyMigration(pool);
    expect((await pool.query(`SELECT server_revision FROM parties WHERE id = 'party-9-pattas'`)).rows[0].server_revision).toBe(8);
    expect((await pool.query(`SELECT COUNT(*)::integer AS count FROM change_log WHERE operation_id LIKE 'migration-patta-quantity-v1-%'`)).rows[0].count)
      .toBe(5);
    const integrityReport = await verifyPostgresReleaseState(pool);
    expect(integrityReport.operations).toEqual({ unmatchedChangeLogOperations: 0, duplicateOperationIdentities: 0 });
  });

  it('preflights all rows and rolls back data and migration lineage for null and non-divisible totals', async () => {
    const pool = await createMigratedSchema('invalid_totals');
    await insertParty(pool, {
      id: 'null-total', companyId: 'z-company', pattaCount: 9, sourceTotal: null, sizes: {}
    });
    await insertParty(pool, {
      id: 'non-divisible', companyId: 'a-company', pattaCount: 9, sourceTotal: '973', sizes: {}
    });
    await insertParty(pool, {
      id: 'valid-row', companyId: 'm-company', pattaCount: 3, sourceTotal: '90', sizes: null
    });
    await expectMigrationBlockedAtomically(pool, ["('a-company','non-divisible'), ('z-company','null-total')"]);
  });

  it('rolls back data and lineage when a source total exceeds the safe-integer range', async () => {
    const pool = await createMigratedSchema('invalid_unsafe_integer');
    await insertParty(pool, {
      id: 'unsafe-total', companyId: 'company-unsafe', pattaCount: 2, sourceTotal: '9007199254740992', sizes: null
    });
    await expectMigrationBlockedAtomically(pool, ["('company-unsafe','unsafe-total')"]);
  });

  it('rolls back data and lineage when non-empty sizes do not sum to the party count', async () => {
    const pool = await createMigratedSchema('invalid_sizes');
    await insertParty(pool, {
      id: 'size-mismatch', companyId: 'company-sizes', pattaCount: 9, sourceTotal: '972', sizes: { M: 8, L: 0 }
    });
    await expectMigrationBlockedAtomically(pool, ["('company-sizes','size-mismatch')"]);
  });

  it('rejects negative patta counts atomically and reports their company and party IDs', async () => {
    const pool = await createMigratedSchema('invalid_negative_count');
    await insertParty(pool, {
      id: 'negative-count', companyId: 'company-negative', pattaCount: -1, sourceTotal: null, sizes: null
    });
    await expectMigrationBlockedAtomically(pool, ["('company-negative','negative-count')"]);
  });

  it('rejects zero-count rows with non-zero work atomically', async () => {
    const pool = await createMigratedSchema('invalid_zero_work');
    await insertParty(pool, {
      id: 'zero-with-work', companyId: 'company-zero-work', pattaCount: 0, sourceTotal: '1', sizes: {}
    });
    await expectMigrationBlockedAtomically(pool, ["('company-zero-work','zero-with-work')"]);
  });

  it('rejects zero-count rows with non-zero size quantities atomically', async () => {
    const pool = await createMigratedSchema('invalid_zero_sizes');
    await insertParty(pool, {
      id: 'zero-with-size-work', companyId: 'company-zero-size-work', pattaCount: 0,
      sourceTotal: null, sizes: { M: '1' }
    });
    await expectMigrationBlockedAtomically(pool, ["('company-zero-size-work','zero-with-size-work')"]);
  });

  it('rejects non-object saved size distributions atomically', async () => {
    const pool = await createMigratedSchema('invalid_size_shape');
    await insertParty(pool, {
      id: 'array-sizes', companyId: 'company-size-shape', pattaCount: 9, sourceTotal: '972', sizes: [9]
    });
    await expectMigrationBlockedAtomically(pool, ["('company-size-shape','array-sizes')"]);
  });

  it.each([
    { name: 'exponent-form', sizeValue: '1e0' },
    { name: 'hex-form', sizeValue: '0x1' },
    { name: 'fractional-form', sizeValue: '1.0' },
    { name: 'negative-form', sizeValue: '-1' },
    { name: 'unsafe-value', sizeValue: '9007199254740992' }
  ])('rejects $name size strings atomically', async ({ name, sizeValue }) => {
    const pool = await createMigratedSchema(`invalid_string_${name}`);
    await insertParty(pool, {
      id: `invalid-${name}`, companyId: `company-invalid-${name}`, pattaCount: 1,
      sourceTotal: '10', sizes: { M: sizeValue }
    });
    await expectMigrationBlockedAtomically(pool, [`('company-invalid-${name}','invalid-${name}')`]);
  });
}, 120_000);
