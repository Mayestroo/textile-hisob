import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { buildFastifyServer } = require('../../../app.cjs');
const { getServerPool, resetServerDatabase, closeServerPool } = require('../../../infrastructure/db.cjs');
const { provisionDevice } = require('../../../auth/deviceProvisioning.cjs');
const { provisionOperator } = require('../../../auth/operatorAuth.cjs');
const { verifyFreshPostgres16TestEnvironment } = require('../../../../../scripts/verify/database/verify-pg16-test-env.cjs');
const manager = require('../../../../desktop/electron/database/core/databaseManager.cjs');
const { insertOutboxOperation, getOperation } = require('../../../../desktop/electron/database/outbox/outboxManager.cjs');
const { loadWorkbookProjectionFromSqlite } = require('../../../../desktop/electron/database/readers/projectionReader.cjs');
const { executeSubmitTicketCommand } = require('../../../../desktop/electron/database/commands/commandPipeline.cjs');
const { SyncClient } = require('../../../../desktop/electron/sync/syncClient.cjs');
const { executeReconnectProtocol } = require('../../../../desktop/electron/sync/reconnectManager.cjs');
const { canonicalStringify, computePayloadHash } = require('../canonicalPayload.cjs');

const postgres = process.env.NOVDA_DISPOSABLE_PG === '1' && process.env.NOVDA_PG_URL && !process.env.DATABASE_URL
  ? describe : describe.skip;

postgres('legacy printed batch recovery over HTTP / PostgreSQL / SQLite', () => {
  const companyId = 'legacy-print-recovery';
  const now = '2026-11-13T08:00:00.000Z';
  let pool: any;
  let app: any;
  let client: any;
  let directory: string;
  let db: any;
  beforeAll(async () => {
    await verifyFreshPostgres16TestEnvironment();
    pool = getServerPool();
    await resetServerDatabase();
    app = buildFastifyServer({ pool, businessMutationsEnabled: true });
    await app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    if (app) await app.close();
    await closeServerPool();
  });
  beforeEach(async () => {
    await resetServerDatabase();
    const { token } = await provisionDevice(pool, { companyId, deviceId: 'print-recovery-device' });
    await provisionOperator(pool, { companyId, operatorId: 'print-recovery-admin', displayName: 'Admin', role: 'admin', password: 'print-recovery-password' });
    client = new SyncClient({ baseUrl: `http://127.0.0.1:${app.server.address().port}`, allowHttp: true,
      token, deviceId: 'print-recovery-device', clientVersion: '2.1.2' });
    const session = await client.loginOperator('print-recovery-admin', 'print-recovery-password');
    client.operatorToken = session.token;
    await pool.query(`INSERT INTO models(id,company_id,name,operations_json)
      VALUES ('model', $1, 'Model', '[{"name":"Sew","rate":5}]')`, [companyId]);
    await pool.query(`INSERT INTO workers(id,company_id,name) VALUES (1,$1,'Worker')`, [companyId]);
    await pool.query(`INSERT INTO periods(id,company_id,start_date,is_closed) VALUES ('period',$1,'2026-11-01',0)`, [companyId]);
    await pool.query(`INSERT INTO company_batch_settings(company_id,available_sizes_json,server_revision)
      VALUES ($1,'["XL"]',7)`, [companyId]);
    await pool.query(`INSERT INTO company_patta_sequences(company_id,next_patta_number) VALUES ($1,900)`, [companyId]);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hisob-legacy-print-'));
    db = manager.getCompanyDatabase(directory, companyId);
    db.prepare(`INSERT INTO models(id,company_id,name,operations_json,created_at,updated_at)
      VALUES ('model',?,'Model','[{"name":"Sew","rate":5}]',?,?)`).run(companyId, now, now);
    db.prepare(`INSERT INTO workers(id,company_id,name,created_at,updated_at) VALUES (1,?,'Worker',?,?)`).run(companyId, now, now);
    db.prepare(`INSERT INTO periods(id,company_id,name,start_date,created_at) VALUES ('period',?,'November','2026-11-01',?)`).run(companyId, now);
  });
  afterEach(() => {
    manager.closeAllCompanyDatabases();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  function batch(index = 1, extras: any = {}) {
    const operationId = `print-${index}`;
    return { commandId: operationId, operationId, companyId, batchId: `batch-${index}`,
      availableSizes: ['M'], configs: [], ...extras,
      parties: [{ commandId: operationId, operationId, companyId, partyRecordId: `party-${index}`,
        partyNumber: String(index), modelId: 'model', modelName: 'Model', pattaCount: 2,
        cumulativePattaCount: index * 2 + 100, ishSoniPerPatta: 10, totalIshSoni: 20,
        ishSoni: 20, cumulativeIshSoni: 20, sizes: { M: 2 }, sizeOrder: ['M'], printedAt: now }] };
  }
  function wire(payload: any) {
    return { companyId, operationId: payload.operationId, commandType: 'CompletePattaBatch',
      entityType: 'patta_batch', entityId: payload.batchId, baseRevision: 0, payload,
      payloadHash: computePayloadHash(canonicalStringify(payload)) };
  }
  function queue(payload: any, status = 'CONFLICT') {
    const party = payload.parties[0];
    db.prepare(`INSERT INTO parties(id,company_id,party_number,physical_party_number,model_id,patta_count,
      cumulative_patta_count,patta_start_number,patta_end_number,ish_soni_per_patta,sizes_json,size_order_json,created_at,updated_at)
      VALUES (?,?,?,?,?,2,?,?,?,10,'{"M":2}','["M"]',?,?)`).run(party.partyRecordId, companyId, party.partyNumber,
      party.partyNumber, 'model', party.cumulativePattaCount, party.cumulativePattaCount - 1, party.cumulativePattaCount, now, now);
    const operation = wire(payload);
    insertOutboxOperation(db, { company_id: companyId, operation_id: payload.operationId,
      command_type: operation.commandType, entity_type: operation.entityType, entity_id: operation.entityId,
      base_revision: 0, payload_json: canonicalStringify(payload), payload_hash: operation.payloadHash,
      status, causal_sequence: Number(party.partyNumber), attempt_count: 1,
      last_error: JSON.stringify({ code: 'REVISION_CONFLICT', message: 'Batch settings revision is missing or invalid; reload before printing', details: null }) });
    return operation;
  }

  it('recovers multiple old batches unchanged, retains printed numbers and releases dependent ticket sync', async () => {
    const first = queue(batch());
    const second = queue(batch(2, { batchSettingsBaseRevision: null }), 'DEAD_LETTER');
    const ticketId = '00000000-0000-4000-8000-000000000931';
    expect(executeSubmitTicketCommand(directory, companyId, { companyId, commandId: 'ticket-command', operationId: 'ticket-op',
      ticketId, modelId: 'model', partyNumber: '1', partyRecordId: 'party-1', periodId: 'period',
      pattaNumber: 101, qty: 10, submittedAt: now, dependsOnOperationId: first.operationId,
      entries: [{ workerId: 1, opName: 'Sew', rateSnapshot: 5 }] }).committed).toBe(true);
    const result = await executeReconnectProtocol(db, companyId, client);
    expect(result).toMatchObject({ recoveredLegacyPattaBatchCount: 2, pushed: { synced: 1, conflict: 0, deadLetter: 0 } });
    await executeReconnectProtocol(db, companyId, client);
    await executeReconnectProtocol(db, companyId, client);
    for (const operation of [first, second]) {
      expect(getOperation(db, companyId, operation.operationId)).toMatchObject({ status: 'SYNCED',
        payload_json: canonicalStringify(operation.payload), payload_hash: operation.payloadHash,
        accepted_payload_hash: operation.payloadHash });
    }
    expect(getOperation(db, companyId, 'ticket-op').status).toBe('SYNCED');
    expect((await pool.query('SELECT patta_start_number,patta_end_number FROM parties WHERE company_id=$1 ORDER BY party_number', [companyId])).rows)
      .toEqual([{ patta_start_number: 101, patta_end_number: 102 }, { patta_start_number: 103, patta_end_number: 104 }]);
    expect((await pool.query('SELECT patta_number FROM tickets WHERE company_id=$1', [companyId])).rows).toEqual([{ patta_number: 101 }]);
    expect((await pool.query('SELECT available_sizes_json,server_revision FROM company_batch_settings WHERE company_id=$1', [companyId])).rows[0])
      .toEqual({ available_sizes_json: ['XL'], server_revision: 7 });
    expect(Number((await pool.query('SELECT next_patta_number FROM company_patta_sequences WHERE company_id=$1', [companyId])).rows[0].next_patta_number)).toBe(900);
    expect(loadWorkbookProjectionFromSqlite(db, companyId).printedPartyHistory)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'party-1', pattaStartNumber: 101, pattaEndNumber: 102 })]));
  });

  it('replays an acceptance after a lost acknowledgement without duplicating issuance', async () => {
    const operation = queue(batch());
    expect((await client.pushOperations([operation])).results[0]).toMatchObject({ status: 'APPLIED', isReplay: false });
    // The local row still records the obsolete conflict, as after a process crash.
    await executeReconnectProtocol(db, companyId, client);
    expect(getOperation(db, companyId, operation.operationId).status).toBe('SYNCED');
    expect((await client.pushOperations([operation])).results[0]).toMatchObject({ status: 'APPLIED', isReplay: true });
    expect((await pool.query('SELECT COUNT(*)::int n FROM parties WHERE company_id=$1', [companyId])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT COUNT(*)::int n FROM operations_dedup WHERE company_id=$1', [companyId])).rows[0].n).toBe(1);
  });

  it('recovers an old ACTIVE_PARTY_EXISTS refusal for the same authoritative issuance', async () => {
    expect((await client.pushOperations([wire(batch())])).results[0].status).toBe('APPLIED');
    const duplicate = batch(2);
    duplicate.parties = batch().parties.map(p => ({ ...p, commandId: duplicate.commandId, operationId: duplicate.operationId }));
    const operation = queue(duplicate, 'DEAD_LETTER');
    db.prepare('UPDATE local_outbox SET last_error=? WHERE operation_id=?').run(
      JSON.stringify({ code: 'ACTIVE_PARTY_EXISTS', message: 'Active party already exists' }), operation.operationId);
    const result = await executeReconnectProtocol(db, companyId, client);
    expect(result.recoveredLegacyPattaBatchCount).toBe(1);
    expect(getOperation(db, companyId, operation.operationId)).toMatchObject({ status: 'SYNCED',
      payload_json: canonicalStringify(operation.payload), payload_hash: operation.payloadHash });
    expect((await pool.query('SELECT COUNT(*)::int n FROM parties WHERE company_id=$1', [companyId])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT available_sizes_json,server_revision FROM company_batch_settings WHERE company_id=$1', [companyId])).rows[0])
      .toEqual({ available_sizes_json: ['XL'], server_revision: 7 });
    expect((await executeReconnectProtocol(db, companyId, client)).recoveredLegacyPattaBatchCount).toBe(0);
  });

  it('rejects overlapping printed paper atomically and does not loop the new conflict', async () => {
    const first = wire(batch());
    expect((await client.pushOperations([first])).results[0].status).toBe('APPLIED');
    const overlap = batch(2);
    overlap.parties[0].cumulativePattaCount = 102;
    queue(overlap);
    const result = await executeReconnectProtocol(db, companyId, client);
    expect(result.pushed.deadLetter).toBe(1);
    expect(JSON.parse(getOperation(db, companyId, overlap.operationId).last_error).code).toBe('LEGACY_PATTA_RANGE_CONFLICT');
    expect((await executeReconnectProtocol(db, companyId, client)).recoveredLegacyPattaBatchCount).toBe(0);
    expect((await pool.query('SELECT id FROM parties WHERE company_id=$1', [companyId])).rows).toEqual([{ id: 'party-1' }]);
  });

  it('matches existing issuance without overwriting it, and rejects mismatched issuance', async () => {
    expect((await client.pushOperations([wire(batch())])).results[0].status).toBe('APPLIED');
    await pool.query("UPDATE parties SET status='CLOSED',is_closed=1,server_revision=5 WHERE company_id=$1", [companyId]);
    const duplicate = batch(2);
    duplicate.parties = batch().parties.map(p => ({ ...p, commandId: duplicate.commandId, operationId: duplicate.operationId }));
    expect((await client.pushOperations([wire(duplicate)])).results[0].status).toBe('APPLIED');
    expect((await pool.query('SELECT status,server_revision FROM parties WHERE company_id=$1', [companyId])).rows[0])
      .toEqual({ status: 'CLOSED', server_revision: 5 });
    const mismatch = batch(3);
    mismatch.parties = duplicate.parties.map(p => ({ ...p, commandId: mismatch.commandId, operationId: mismatch.operationId, ishSoniPerPatta: 20 }));
    expect((await client.pushOperations([wire(mismatch)])).results[0]).toMatchObject({ status: 'REJECTED', error: { code: 'LEGACY_PATTA_ISSUANCE_CONFLICT' } });
  });

  it('keeps modern CAS enforcement and rejects malformed legacy evidence', async () => {
    expect((await client.pushOperations([wire(batch(1, { batchSettingsBaseRevision: 0 }))])).results[0])
      .toMatchObject({ status: 'CONFLICT', error: { code: 'REVISION_CONFLICT' } });
    expect((await pool.query('SELECT id FROM parties WHERE company_id=$1', [companyId])).rows).toEqual([]);
    const invalid = batch(2);
    invalid.parties[0].cumulativePattaCount = 0;
    expect((await client.pushOperations([wire(invalid)])).results[0])
      .toMatchObject({ status: 'REJECTED', error: { code: 'LEGACY_PATTA_EVIDENCE_REQUIRED' } });
    expect((await client.pushOperations([wire(batch(3, { batchSettingsBaseRevision: '7' }))])).results[0])
      .toMatchObject({ status: 'CONFLICT', error: { code: 'REVISION_CONFLICT' } });
  });
});
