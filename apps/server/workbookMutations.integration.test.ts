import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalStringify, computePayloadHash } from './modules/sync/canonicalPayload.cjs';

const { processSingleOperation } = require('./modules/sync/handlers/operations.cjs');
const { getPeriodArchive } = require('./modules/sync/workbookOperations.cjs');
const { buildFastifyServer } = require('./app.cjs');
const { verifyFreshPostgres16TestEnvironment } = require('../../scripts/verify/verify-pg16-test-env.cjs');

const disposableUrl = process.env.NOVDA_DISPOSABLE_PG === '1' && !process.env.DATABASE_URL
  ? process.env.NOVDA_PG_URL
  : undefined;
const describeDisposable = disposableUrl ? describe : describe.skip;

describeDisposable('PostgreSQL 16 workbook business mutation operations', () => {
  const companyId = `company_workbook_${process.pid}`;
  const schemaName = `novda_workbook_mutations_${process.pid}_${Date.now().toString(36)}`;
  const quotedSchema = `"${schemaName}"`;
  const req = { auth: { companyId, deviceId: 'device-workbook-test', clientVersion: '1.0.0' } };
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;
  let schemaCreated = false;

  beforeAll(async () => {
    if (!disposableUrl || process.env.NOVDA_DISPOSABLE_PG !== '1' || process.env.DATABASE_URL) {
      throw new Error('DISPOSABLE_POSTGRES_REQUIRED: workbook mutation integration requires explicit disposable PostgreSQL opt-in');
    }
    await verifyFreshPostgres16TestEnvironment(disposableUrl);
    adminPool = new Pool({ connectionString: disposableUrl });
    await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
    schemaCreated = true;
    pool = new Pool({ connectionString: disposableUrl, options: `-c search_path=${schemaName},public` });
    const migrations = [
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
      'deploy_production_adjustment_provenance_migration.sql'
    ];
    for (const migration of migrations) {
      const sqlPath = migration === 'schema.sql'
        ? path.join(__dirname, 'database', 'schema.sql')
        : path.join(__dirname, 'database', 'migrations', migration);
      await pool.query(fs.readFileSync(sqlPath, 'utf8'));
    }
  }, 120_000);

  afterAll(async () => {
    try {
      if (schemaCreated && adminPool) await adminPool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
    } finally {
      if (pool) await pool.end();
      if (adminPool) await adminPool.end();
    }
  });

  function operation(commandType: string, entityType: string, entityId: string, payload: Record<string, any>, baseRevision = 0) {
    const wirePayload = JSON.parse(canonicalStringify(payload));
    return {
      operationId: wirePayload.operationId,
      companyId,
      commandType,
      entityType,
      entityId,
      baseRevision,
      payloadHash: computePayloadHash(canonicalStringify(wirePayload)),
      payload: wirePayload
    };
  }

  async function apply(commandType: string, entityType: string, entityId: string, payload: Record<string, any>, baseRevision = 0) {
    return processSingleOperation(pool, req, operation(commandType, entityType, entityId, payload, baseRevision));
  }

  it('creates and updates stable model identity with replay and revision conflict handling', async () => {
    const create = {
      commandId: 'cmd_model_create', operationId: 'op_model_create', companyId,
      modelId: 'Futbolka Erkaklar', name: 'Futbolka Erkaklar', title: 'Futbolka',
      operations: [{ id: 'op-cut', name: 'Cut', rate: 5 }], pattaOpsOrder: ['Cut']
    };
    const first = await apply('UpsertModel', 'model', create.modelId, create);
    const replay = await apply('UpsertModel', 'model', create.modelId, create);
    expect(first).toMatchObject({ status: 'APPLIED', serverRevision: 1 });
    expect(replay).toMatchObject({ status: 'APPLIED', isReplay: true });
    await pool!.query(`INSERT INTO workers (id, company_id, name) VALUES (99, $1, 'Rename Worker')`, [companyId]);
    await pool!.query(`INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status)
      VALUES ('party_model_rename', $1, '88', '88', $2, 'ACTIVE')`, [companyId, create.modelId]);
    const ticketId = '00000000-0000-4000-8000-000000000811';
    await pool!.query(`INSERT INTO tickets (id, company_id, model_id, party_number, party_record_id, patta_number, qty, submitted_at)
      VALUES ($1, $2, $3, '88', 'party_model_rename', 1, 5, '2026-09-23T10:00:00Z')`, [ticketId, companyId, create.modelId]);
    await pool!.query(`INSERT INTO company_patta_sequences(company_id, next_patta_number)
      VALUES ($1, 2) ON CONFLICT (company_id) DO UPDATE SET next_patta_number = 2`, [companyId]);
    await pool!.query(`INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id, qty)
      VALUES ('entry_model_rename', $1, $2, 'Cut', 99, 5)`, [ticketId, companyId]);

    const update = {
      ...create,
      commandId: 'cmd_model_update',
      operationId: 'op_model_update',
      name: 'Futbolka New',
      operations: [{ id: 'op-cut', name: 'Sew', rate: 5 }],
      pattaOpsOrder: ['Sew'],
      operationRenames: [{ fromName: 'Cut', toName: 'Sew' }]
    };
    expect(await apply('UpsertModel', 'model', create.modelId, update, 1)).toMatchObject({ status: 'APPLIED', serverRevision: 2 });
    expect(await apply('UpsertModel', 'model', create.modelId, { ...update, commandId: 'cmd_model_stale', operationId: 'op_model_stale' }, 1))
      .toMatchObject({ status: 'CONFLICT', error: { code: 'REVISION_CONFLICT' } });
    expect(await apply('DeactivateModel', 'model', create.modelId, {
      commandId: 'cmd_model_deactivate', operationId: 'op_model_deactivate', companyId, modelId: create.modelId
    }, 2)).toMatchObject({ status: 'APPLIED', serverRevision: 3 });
    const row = await pool!.query('SELECT id, name, server_revision FROM models WHERE company_id = $1 AND id = $2', [companyId, create.modelId]);
    expect(row.rows[0]).toMatchObject({ id: create.modelId, name: 'Futbolka New', server_revision: 3 });
    const operations = await pool!.query('SELECT operations_json, patta_ops_order_json FROM models WHERE company_id = $1 AND id = $2', [companyId, create.modelId]);
    expect(operations.rows[0].operations_json).toEqual([{ id: 'op-cut', name: 'Sew', rate: 5 }]);
    expect(operations.rows[0].patta_ops_order_json).toEqual(['Sew']);
    const renamedEntry = await pool!.query('SELECT op_name FROM ticket_entries WHERE company_id = $1 AND id = $2', [companyId, 'entry_model_rename']);
    expect(renamedEntry.rows[0].op_name).toBe('Sew');
    const inactive = await pool!.query('SELECT status FROM models WHERE company_id = $1 AND id = $2', [companyId, create.modelId]);
    expect(inactive.rows[0].status).toBe('INACTIVE');
  });

  it('creates periods and workers with ledger adjustments, then creates party and batch rows', async () => {
    const model = {
      commandId: 'cmd_model_2', operationId: 'op_model_2', companyId,
      modelId: 'model_2', name: 'Model 2', operations: [], pattaOpsOrder: []
    };
    expect(await apply('UpsertModel', 'model', 'model_2', model)).toMatchObject({ status: 'APPLIED' });
    const period = {
      commandId: 'cmd_period', operationId: 'op_period', companyId,
      periodId: 'period_2026_09', name: 'September', startDate: '2026-09-01'
    };
    const createdPeriod = await apply('CreatePeriod', 'period', period.periodId, period);
    if (createdPeriod.status !== 'APPLIED') throw new Error(`CreatePeriod failed: ${JSON.stringify(createdPeriod)}`);
    expect(await apply('UpdatePeriod', 'period', period.periodId, {
      commandId: 'cmd_period_update', operationId: 'op_period_update', companyId,
      periodId: period.periodId, name: 'September 2026', startDate: '2026-09-01'
    }, 1)).toMatchObject({ status: 'APPLIED', serverRevision: 2 });
    await pool!.query(`INSERT INTO workers (id, company_id, name, staj, status)
      VALUES (71, $1, 'Ali', 0, 'ACTIVE')`, [companyId]);
    const worker = {
      commandId: 'cmd_worker', operationId: 'op_worker', companyId,
      workerId: 71, name: 'Ali', staj: 4, role: 'Bichuvchi', status: 'ACTIVE',
      balanceAdjustments: [{ adjustmentId: 'adj_avans_71', type: 'AVANS', amountDelta: 50, periodId: period.periodId }]
    };
    expect(await apply('UpsertWorker', 'worker', '71', worker, 1)).toMatchObject({ status: 'APPLIED', serverRevision: 2 });
    const balance = await pool!.query('SELECT SUM(amount) AS total FROM worker_adjustments WHERE company_id = $1 AND worker_id = 71 AND type = $2', [companyId, 'AVANS']);
    expect(Number(balance.rows[0].total)).toBe(50);
    expect(await apply('UpsertWorker', 'worker', '71', {
      commandId: 'cmd_worker_update', operationId: 'op_worker_update', companyId,
      workerId: 71, name: 'Ali New', staj: 5, role: 'Tikuvchi', status: 'ACTIVE', balanceAdjustments: []
    }, 2)).toMatchObject({ status: 'APPLIED', serverRevision: 3 });
    expect(await apply('DeactivateWorker', 'worker', '71', {
      commandId: 'cmd_worker_deactivate', operationId: 'op_worker_deactivate', companyId, workerId: 71
    }, 3)).toMatchObject({ status: 'APPLIED', serverRevision: 4 });

    const party = {
      commandId: 'cmd_party', operationId: 'op_party', companyId,
      partyRecordId: 'party_1', partyNumber: '1', modelId: 'model_2', modelName: 'Model 2',
      pattaCount: 2, cumulativePattaCount: 2, ishSoniPerPatta: 50, totalIshSoni: 100, ishSoni: 100,
      cumulativeIshSoni: 100, sizes: { M: 2 }, printedAt: '2026-09-23T10:00:00.000Z'
    };
    expect(await apply('CreateParty', 'party', party.partyRecordId, party)).toMatchObject({ status: 'APPLIED', serverRevision: 1 });
    const partyUpdate = await apply('UpdateParty', 'party', party.partyRecordId, {
      commandId: 'cmd_party_update', operationId: 'op_party_update', companyId,
      partyRecordId: party.partyRecordId, partyNumber: party.partyNumber, modelId: party.modelId,
      modelName: party.modelName, color: party.color, pattaCount: 2, cumulativePattaCount: 2,
      ishSoniPerPatta: 55, totalIshSoni: 110, ishSoni: 110, cumulativeIshSoni: 110, sizes: { M: 2 }
    }, 1);
    if (partyUpdate.status !== 'APPLIED') throw new Error(`UpdateParty failed: ${JSON.stringify(partyUpdate)}`);
    expect(partyUpdate).toMatchObject({ status: 'APPLIED', serverRevision: 2 });

    const batch = {
      commandId: 'cmd_batch', operationId: 'op_batch', companyId, batchId: 'batch_1',
      parties: [{ commandId: 'cmd_batch', operationId: 'op_batch', companyId, partyRecordId: 'party_2', partyNumber: '2', modelId: 'model_2', modelName: 'Model 2', pattaCount: 2, sizes: { L: 2 }, printedAt: '2026-09-23T10:00:00.000Z' }],
      availableSizes: ['M', 'L'], configs: [{ modelId: 'model_2', partyNumber: '', isCustomParty: false, totalIshSoni: '', color: 'Qora', sizes: { M: '', L: '' } }]
    };
    const batchResult = await apply('CompletePattaBatch', 'patta_batch', 'batch_1', batch);
    if (batchResult.status !== 'APPLIED') throw new Error(`CompletePattaBatch failed: ${JSON.stringify(batchResult)}`);
    const settings = await pool!.query('SELECT available_sizes_json FROM company_batch_settings WHERE company_id = $1', [companyId]);
    expect(settings.rows[0].available_sizes_json).toEqual(['M', 'L']);
    expect(await apply('UpdateBatchSettings', 'batch_settings', companyId, {
      commandId: 'cmd_batch_settings', operationId: 'op_batch_settings', companyId,
      availableSizes: ['M', 'L', 'XL'],
      configs: [{ modelId: 'model_2', partyNumber: '', isCustomParty: false, totalIshSoni: '', color: 'Qora', sizes: { M: '', L: '', XL: '' } }]
    }, 1)).toMatchObject({ status: 'APPLIED', serverRevision: 2 });
    const parties = await pool!.query(`SELECT id, party_number FROM parties WHERE company_id = $1 AND model_id = 'model_2' ORDER BY id`, [companyId]);
    expect(parties.rows.map((row) => row.party_number)).toEqual(['1', '2']);
  });

  it('accepts a canonical free-mode ticket without creating or inventing a printed party', async () => {
    const partyCountBefore = Number((await pool!.query('SELECT COUNT(*)::int AS count FROM parties WHERE company_id = $1', [companyId])).rows[0].count);
    await pool!.query(`INSERT INTO company_batch_settings (company_id, available_sizes_json) VALUES ($1, '[]')
      ON CONFLICT (company_id) DO UPDATE SET available_sizes_json = EXCLUDED.available_sizes_json`, [companyId]);
    await pool!.query(`
      INSERT INTO activation_companies (
        company_id, company_name, allowed_roles, require_ticket_validation, is_active,
        updated_by_telegram_id, updated_by_source
      ) VALUES ($1, 'Free Mode Fixture', ARRAY['admin'], FALSE, TRUE, '1526974123', 'TELEGRAM_ADMIN')
    `, [companyId]);
    await pool!.query(`INSERT INTO models (id, company_id, name, operations_json, status)
      VALUES ('free-model', $1, 'Free Model', '[{"name":"Cut","rate":1}]', 'ACTIVE')`, [companyId]);
    await pool!.query(`INSERT INTO workers (id, company_id, name, status) VALUES (601, $1, 'Free Worker', 'ACTIVE')`, [companyId]);

    const ticketId = '00000000-0000-4000-8000-000000000901';
    const result = await apply('SubmitTicket', 'ticket', ticketId, {
      commandId: 'cmd-free-ticket', operationId: 'op-free-ticket', companyId,
      ticketId, modelId: 'free-model', partyNumber: '1', partyRecordId: null, pattaNumber: 1,
      qty: 5, effectiveDate: '2026-09-25', entries: [{ opName: 'Cut', workerId: 601 }]
    });

    expect(result).toMatchObject({ status: 'APPLIED' });
    expect((await pool!.query('SELECT party_record_id FROM tickets WHERE company_id = $1 AND id = $2', [companyId, ticketId])).rows)
      .toEqual([{ party_record_id: null }]);
    expect((await pool!.query('SELECT COUNT(*)::int AS count FROM parties WHERE company_id = $1', [companyId])).rows[0].count).toBe(partyCountBefore);

    await pool!.query('UPDATE activation_companies SET require_ticket_validation = TRUE WHERE company_id = $1', [companyId]);
    const strictTicketId = '00000000-0000-4000-8000-000000000902';
    const strictResult = await apply('SubmitTicket', 'ticket', strictTicketId, {
      commandId: 'cmd-strict-ticket', operationId: 'op-strict-ticket', companyId,
      ticketId: strictTicketId, modelId: 'free-model', partyNumber: '1', partyRecordId: null, pattaNumber: 2,
      qty: 3, effectiveDate: '2026-09-25', entries: [{ opName: 'Cut', workerId: 601 }]
    });
    expect(strictResult).toMatchObject({ status: 'REJECTED', error: { code: 'PARTY_RECORD_REQUIRED' } });
    expect((await pool!.query('SELECT COUNT(*)::int AS count FROM tickets WHERE company_id = $1 AND id = $2', [companyId, strictTicketId])).rows[0].count).toBe(0);

    const perTicketFreeId = '00000000-0000-4000-8000-000000000903';
    const perTicketFreeResult = await apply('SubmitTicket', 'ticket', perTicketFreeId, {
      commandId: 'cmd-per-ticket-free', operationId: 'op-per-ticket-free', companyId,
      ticketId: perTicketFreeId, modelId: 'free-model', partyNumber: "No'malum Partiya",
      partyRecordId: null, pattaNumber: 0, strictParty: false, strictPatta: false,
      qty: 3, effectiveDate: '2026-09-25', entries: [{ opName: 'Cut', workerId: 601 }]
    });
    expect(perTicketFreeResult).toMatchObject({ status: 'APPLIED' });
    expect((await pool!.query('SELECT party_record_id, party_number, patta_number FROM tickets WHERE company_id = $1 AND id = $2', [companyId, perTicketFreeId])).rows)
      .toEqual([{ party_record_id: null, party_number: "No'malum Partiya", patta_number: 0 }]);
  });

  it('closes a period atomically, rolls parties, stores an archive, and archives history without deletes', async () => {
    await pool!.query(`UPDATE parties SET status = 'CLOSED', is_closed = 1 WHERE company_id = $1 AND id = 'party_model_rename'`, [companyId]);
    const periodTickets = [
      ['00000000-0000-4000-8000-000000000821', 'party_1', '2'],
      ['00000000-0000-4000-8000-000000000822', 'party_1', '3'],
      ['00000000-0000-4000-8000-000000000823', 'party_2', '4']
    ];
    for (const [ticketId, partyRecordId, pattaNumber] of periodTickets) {
      const partyNumber = partyRecordId === 'party_1' ? '1' : '2';
      await pool!.query(`INSERT INTO tickets (
        id, company_id, model_id, period_id, party_number, party_record_id, patta_number, qty, submitted_at
      ) VALUES ($1, $2, 'model_2', 'period_2026_09', $3, $4, $5, 10, '2026-09-15T10:00:00Z')`,
        [ticketId, companyId, partyNumber, partyRecordId, Number(pattaNumber)]);
    }
    const payload = {
      commandId: 'cmd_period_close', operationId: 'op_period_close', companyId,
      periodId: 'period_2026_09', endDate: '2026-09-30',
      nextPeriod: { id: 'period_2026_10', name: 'October', startDate: '2026-10-01' },
      archiveFilename: 'archive_2026_09.json'
    };
    const closed = await apply('ClosePeriod', 'period', payload.periodId, payload, 2);
    if (closed.status !== 'APPLIED') throw new Error(`ClosePeriod failed: ${JSON.stringify(closed)}`);
    expect(closed).toMatchObject({ status: 'APPLIED', serverRevision: 3 });
    const periodRows = await pool!.query('SELECT id, is_closed FROM periods WHERE company_id = $1 ORDER BY id', [companyId]);
    expect(periodRows.rows).toEqual([
      expect.objectContaining({ id: 'period_2026_09', is_closed: 1 }),
      expect.objectContaining({ id: 'period_2026_10', is_closed: 0 })
    ]);
    const archive = await getPeriodArchive(pool, companyId, 'period_2026_09');
    expect(archive.archive_json).toMatchObject({ period: { id: 'period_2026_09' }, completedPartiesCount: 1, rolledOverPartiesCount: 1 });
    const app = buildFastifyServer({ pool, allowTestTokens: true, minClientVersion: '2.0.0' });
    await app.ready();
    const archiveResponse = await app.inject({
      method: 'GET',
      url: '/api/periods/period_2026_09/archive',
      headers: { authorization: `Bearer novda-test-token:${companyId}:device-archive-read`, 'x-client-version': '2.0.0' }
    });
    expect(archiveResponse.statusCode).toBe(200);
    expect(archiveResponse.json().archive.archive_json).toMatchObject({ period: { id: 'period_2026_09' } });
    await app.close();
    const partyRows = await pool!.query(`SELECT id, status, is_archived, archived_patta_numbers_json FROM parties
      WHERE company_id = $1 AND id IN ('party_1', 'party_2') ORDER BY id`, [companyId]);
    expect(partyRows.rows).toEqual([
      expect.objectContaining({ id: 'party_1', status: 'CLOSED' }),
      expect.objectContaining({ id: 'party_2', status: 'ACTIVE', archived_patta_numbers_json: [4] })
    ]);

    expect(await apply('CloseParty', 'party', 'party_2', {
      commandId: 'cmd_party_close', operationId: 'op_party_close', companyId, partyRecordId: 'party_2'
    }, 2)).toMatchObject({ status: 'APPLIED', serverRevision: 3 });
    const nextParty = {
      commandId: 'cmd_party_next', operationId: 'op_party_next', companyId,
      partyRecordId: 'party_4', partyNumber: '4', modelId: 'model_2', modelName: 'Model 2',
      pattaCount: 1, cumulativePattaCount: 4, ishSoniPerPatta: 25, totalIshSoni: 25, ishSoni: 25,
      cumulativeIshSoni: 155, sizes: { M: 1 }, printedAt: '2026-10-05T10:00:00.000Z'
    };
    expect(await apply('CreateParty', 'party', 'party_4', nextParty)).toMatchObject({ status: 'APPLIED' });
    expect(await apply('CompletePartySeries', 'party_series', 'period_2026_10', {
      commandId: 'cmd_party_series', operationId: 'op_party_series', companyId,
      periodId: 'period_2026_10', endDate: '2026-10-31'
    })).toMatchObject({ status: 'APPLIED' });

    const archived = { commandId: 'cmd_archive', operationId: 'op_archive', companyId, partyRecordIds: ['party_1', 'party_2', 'party_4'] };
    expect(await apply('ArchivePartyHistory', 'party_history', companyId, archived)).toMatchObject({ status: 'APPLIED' });
    const archivedRows = await pool!.query('SELECT COUNT(*) AS count FROM parties WHERE company_id = $1 AND is_archived = TRUE', [companyId]);
    expect(Number(archivedRows.rows[0].count)).toBe(3);
  });

  it('rolls back every party when a completed batch contains an invalid model reference', async () => {
    const batch = {
      commandId: 'cmd_bad_batch', operationId: 'op_bad_batch', companyId, batchId: 'batch_bad',
      parties: [
        { commandId: 'cmd_bad_batch', operationId: 'op_bad_batch', companyId, partyRecordId: 'party_good', partyNumber: '91', modelId: 'model_2', pattaCount: 1 },
        { commandId: 'cmd_bad_batch', operationId: 'op_bad_batch', companyId, partyRecordId: 'party_bad', partyNumber: '92', modelId: 'missing_model', pattaCount: 1 }
      ]
    };
    expect(await apply('CompletePattaBatch', 'patta_batch', 'batch_bad', batch)).toMatchObject({ status: 'REJECTED', error: { code: 'MODEL_NOT_FOUND' } });
    const rows = await pool!.query('SELECT COUNT(*) AS count FROM parties WHERE company_id = $1 AND id IN ($2, $3)', [companyId, 'party_good', 'party_bad']);
    expect(Number(rows.rows[0].count)).toBe(0);
    const dedup = await pool!.query('SELECT COUNT(*) AS count FROM operations_dedup WHERE company_id = $1 AND operation_id = $2', [companyId, 'op_bad_batch']);
    expect(Number(dedup.rows[0].count)).toBe(0);
  });
});
