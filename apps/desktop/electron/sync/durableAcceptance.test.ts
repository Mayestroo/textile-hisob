import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const manager = require('../database/databaseManager.cjs');
const { canonicalStringify, computePayloadHash } = require('../database/canonicalPayload.cjs');
const { insertOutboxOperation } = require('../database/outboxManager.cjs');
const { dispatchOutbox } = require('./outboxDispatcher.cjs');
const { executeReconnectProtocol } = require('./reconnectManager.cjs');
const { applyChangesBatch } = require('./changeFeedApplier.cjs');
const { loadPayrollValuationFromSqlite } = require('../database/payrollReader.cjs');
const { SyncClient } = require('./syncClient.cjs');

const company = 'ack-proof-fixture';
const now = '2026-09-15T00:00:00Z';
describe('durable exact-operation payroll acceptance (own file and loopback HTTP)', () => {
  const dirs: string[] = [];
  afterEach(() => { manager.closeAllCompanyDatabases(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
  function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hisob-ack-proof-')); dirs.push(dir);
    const db = manager.getCompanyDatabase(dir, company);
    db.prepare(`INSERT INTO models(id,company_id,name,operations_json,created_at,updated_at)
      VALUES('m',?,'Model','[{"name":"Sew","rate":7}]',?,?)`).run(company, now, now);
    db.prepare(`INSERT INTO workers(id,company_id,name,created_at,updated_at)
      VALUES(7,?,'Worker',?,?)`).run(company, now, now);
    db.prepare(`INSERT INTO periods(id,company_id,name,start_date,created_at)
      VALUES('P',?,'Period','2026-09-01',?)`).run(company, now);
    const payload = { companyId: company, operationId: 'submit-1', ticketId: 't', modelId: 'm', periodId: 'P', qty: 15,
      entries: [{ opName: 'Sew', workerId: 7, rateSnapshot: null }] };
    const json = canonicalStringify(payload);
    db.prepare(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,patta_number,qty,
      status,submitted_at,created_at,provenance) VALUES('t',?,'m','P','1',1,15,'PENDING_SYNC',?,?,'LOCAL_COMMAND')`)
      .run(company, now, now);
    db.prepare(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,qty,created_at)
      VALUES('entry_t_0_Sew_7','t',?,'Sew',7,15,?)`).run(company, now);
    insertOutboxOperation(db, { operation_id: 'submit-1', company_id: company, command_type: 'SubmitTicket',
      entity_type: 'ticket', entity_id: 't', payload_json: json, payload_hash: computePayloadHash(json),
      causal_sequence: 1 });
    const read = () => loadPayrollValuationFromSqlite(db, company, 'P');
    return { dir, db, read, hash: computePayloadHash(json) };
  }
  it('keeps 15×7 provisional then accepts via HTTP; restart, replay, and rejects old receipt for newer entries', async () => {
    const { dir, db, read, hash } = fixture();
    expect(read().workers[0]).toMatchObject({ gross: 105, syncStatus: 'UNSYNCED' });
    let calls = 0;
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); calls++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, results: body.operations.map((op: any) => ({
        operationId: op.operationId, payloadHash: hash, status: 'APPLIED', serverRevision: 1, periodId: 'P'
      })) }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as any;
      const client = new SyncClient({ baseUrl: `http://127.0.0.1:${address.port}`, allowHttp: true });
      expect(await dispatchOutbox(db, company, client)).toMatchObject({ synced: 1 });
      expect(read().workers[0]).toMatchObject({ gross: 105, syncStatus: 'UNKNOWN' });
      expect(read().acceptanceEvidence.t).toMatchObject({ source: 'ACCEPTED_OPERATION', payloadHash: hash, serverRevision: 1 });
      manager.closeAllCompanyDatabases();
      const reopened = manager.getCompanyDatabase(dir, company);
      expect(loadPayrollValuationFromSqlite(reopened, company, 'P').workers[0].gross).toBe(105);
      applyChangesBatch(reopened, company, [{ entityType: 'ticket', entityId: 't', changeType: 'INSERT', entityRevision: 1,
        payload: { periodId: 'P', status: 'CONFIRMED' } }], '1');
      expect(loadPayrollValuationFromSqlite(reopened, company, 'P').workers[0].gross).toBe(105);
      expect(calls).toBe(1);
      reopened.prepare("UPDATE ticket_entries SET worker_id=7, op_name='Different' WHERE id='entry_t_0_Sew_7'").run();
      expect(loadPayrollValuationFromSqlite(reopened, company, 'P').acceptanceEvidence.t).toBeNull();
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('does not create a receipt on failed transport, mismatched hash or failed local transaction', async () => {
    const { db, read, hash } = fixture();
    await dispatchOutbox(db, company, { pushOperations: async () => { throw new Error('503'); } });
    expect(read().acceptanceEvidence.t).toBeNull();
    expect(read().workers[0].gross).toBe(105);
    expect(await dispatchOutbox(db, company, { pushOperations: async () => ({ results: [
      { operationId: 'submit-1', status: 'APPLIED', payloadHash: 'f'.repeat(64), serverRevision: 1 }
    ] }) })).toMatchObject({ conflict: 1 });
    expect(read().acceptanceEvidence.t).toBeNull();
    expect(db.prepare('SELECT accepted_payload_hash FROM local_outbox').get().accepted_payload_hash).toBeNull();
    expect(hash).not.toBe('f'.repeat(64));
  });
  it('rejects a foreign company dispatch and an impossible ticket revision', async () => {
    const { db, read, hash } = fixture();
    expect(await dispatchOutbox(db, 'other-tenant', { pushOperations: async () => { throw new Error('unexpected'); } }))
      .toMatchObject({ attempted: 0 });
    expect(await dispatchOutbox(db, company, { pushOperations: async () => ({ results: [{
      operationId: 'submit-1', payloadHash: hash, status: 'APPLIED', serverRevision: 9, periodId: 'P'
    }] }) })).toMatchObject({ conflict: 1 });
    expect(db.prepare('SELECT accepted_payload_hash FROM local_outbox').get().accepted_payload_hash).toBeNull();
    expect(read().workers[0]).toMatchObject({ gross: 105, syncStatus: 'UNSYNCED' });
  });
  it('does not certify a newer edit through an older in-flight ACK; company and void remain isolated', async () => {
    const { db, read, hash } = fixture();
    const response = { pushOperations: async () => ({ results: [
      { operationId: 'submit-1', status: 'APPLIED', payloadHash: hash, serverRevision: 1, periodId: 'P' }
    ] }) };
    await dispatchOutbox(db, company, response, { testHooks: { afterServerResponse: () => {
      db.prepare("UPDATE ticket_entries SET qty=16 WHERE id='entry_t_0_Sew_7'").run();
      const json = canonicalStringify({ companyId: company, operationId: 'edit-2', ticketId: 't',
        entries: [{ entryId: 'entry_t_0_Sew_7', opName: 'Sew', workerId: 7 }] });
      insertOutboxOperation(db, { operation_id: 'edit-2', company_id: company, command_type: 'UpdateTicket',
        entity_type: 'ticket', entity_id: 't', base_revision: 1, causal_sequence: 2,
        payload_json: json, payload_hash: computePayloadHash(json) });
    } } });
    expect(read().workers[0]).toMatchObject({ gross: 112, syncStatus: 'UNSYNCED' });
    expect(read().acceptanceEvidence.t).toBeNull();
    expect(loadPayrollValuationFromSqlite(db, 'other-tenant', null).accountingStatus).toBe('UNAVAILABLE');
    db.prepare("UPDATE tickets SET status='VOIDED' WHERE company_id=? AND id='t'").run(company);
    expect(read().workers[0].gross).toBe(0);
    expect(read().acceptanceEvidence.t).toBeUndefined();
  });
  it('binds a local correction to the accepted operation and retains 105+14=119 once', async () => {
    const { db, read } = fixture();
    db.prepare(`INSERT INTO production_adjustments(adjustment_id,company_id,model_id,worker_id,op_name,
      delta_qty,reason,status,provenance,created_at,created_by,original_period_id,attribution_status)
      VALUES('adj',?,'m',7,'Sew',2,'correction','APPROVED','MANUAL_CORRECTION',?,'operator','P','RESOLVED')`)
      .run(company, now);
    const json = canonicalStringify({ companyId: company, operationId: 'adjust-1', adjustmentId: 'adj',
      modelId: 'm', workerId: 7, opName: 'Sew', deltaQty: 2 });
    const hash = computePayloadHash(json);
    insertOutboxOperation(db, { operation_id: 'adjust-1', company_id: company,
      command_type: 'RecordProductionAdjustment', entity_type: 'production_adjustment', entity_id: 'adj',
      payload_json: json, payload_hash: hash });
    expect(read().workers[0]).toMatchObject({ gross: 119, syncStatus: 'UNSYNCED' });
    expect(await dispatchOutbox(db, company, { pushOperations: async (ops: any[]) => ({ results: ops.map(op => ({
      operationId: op.operationId, payloadHash: op.payloadHash, status: 'APPLIED', serverRevision: 1, periodId: 'P'
    })) }) })).toMatchObject({ synced: 2 });
    expect(read().workers[0]).toMatchObject({ gross: 119, syncStatus: 'UNKNOWN' });
    expect(read().adjustmentEvidence.adj).toMatchObject({ source: 'ACCEPTED_OPERATION', payloadHash: hash });
    db.prepare("UPDATE production_adjustments SET delta_qty=3 WHERE adjustment_id='adj'").run();
    // The receipt is about the submitted correction, not a modified local fact.
    expect(read().adjustmentEvidence.adj).toBeNull();
    expect(read().workers[0].gross).toBe(126);
  });
  it('recovers lost ACK by exact status replay and never re-sends the accepted operation', async () => {
    const { dir, db, hash } = fixture();
    let sends = 0;
    await expect(dispatchOutbox(db, company, { pushOperations: async () => {
      sends++;
      return { results: [{ operationId: 'submit-1', status: 'APPLIED', payloadHash: hash,
        serverRevision: 1, periodId: 'P' }] };
    } }, { testHooks: { afterServerResponse: () => { throw new Error('lost local ACK'); } } }))
      .rejects.toThrow('lost local ACK');
    manager.closeAllCompanyDatabases();
    const reopened = manager.getCompanyDatabase(dir, company);
    const client = {
      pullChanges: async (cursor: any) => ({ items: [], nextCursor: cursor, hasMore: false, nextPattaNumber: 1 }),
      getOperationStatuses: async () => ({ results: [{ operationId: 'submit-1', status: 'APPLIED',
        payloadHash: hash, serverRevision: 1, periodId: 'P' }] }),
      pushOperations: async () => { sends++; throw new Error('duplicate send'); }
    };
    const result = await executeReconnectProtocol(reopened, company, client);
    expect(result.reconciledCount).toBe(1);
    expect(sends).toBe(1);
    expect(loadPayrollValuationFromSqlite(reopened, company, 'P')).toMatchObject({
      workers: [{ gross: 105, syncStatus: 'UNKNOWN' }],
      acceptanceEvidence: { t: { operationId: 'submit-1', payloadHash: hash } }
    });
  });
  it('rolls back the receipt together with the outbox transition if local ACK fails', async () => {
    const { db, read, hash } = fixture();
    db.exec(`CREATE TRIGGER fail_ticket_ack BEFORE UPDATE OF status ON tickets
      WHEN NEW.status = 'CONFIRMED' BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END`);
    await expect(dispatchOutbox(db, company, { pushOperations: async () => ({ results: [{
      operationId: 'submit-1', status: 'APPLIED', payloadHash: hash, serverRevision: 1, periodId: 'P'
    }] }) })).rejects.toThrow('simulated disk failure');
    expect(db.prepare("SELECT status, accepted_payload_hash FROM local_outbox WHERE operation_id='submit-1'").get())
      .toEqual({ status: 'SENDING', accepted_payload_hash: null });
    expect(read().workers[0]).toMatchObject({ gross: 105, syncStatus: 'UNSYNCED' });
  });
  it('requires the latest accepted edit revision, not merely an accepted submit', async () => {
    const { db, read, hash } = fixture();
    const server = { pushOperations: async (ops: any[]) => ({ results: ops.map(op => ({
      operationId: op.operationId, status: 'APPLIED', payloadHash: op.payloadHash,
      serverRevision: op.operationId === 'submit-1' ? 1 : 2, periodId: 'P'
    })) }) };
    await dispatchOutbox(db, company, server);
    expect(read().acceptanceEvidence.t).toMatchObject({ payloadHash: hash, serverRevision: 1 });
    const json = canonicalStringify({ companyId: company, operationId: 'edit-2', ticketId: 't',
      entries: [{ entryId: 'entry_t_0_Sew_7', opName: 'Sew', workerId: 7 }] });
    insertOutboxOperation(db, { operation_id: 'edit-2', company_id: company, command_type: 'UpdateTicket',
      entity_type: 'ticket', entity_id: 't', base_revision: 1, causal_sequence: 1,
      payload_json: json, payload_hash: computePayloadHash(json) });
    expect(read().workers[0]).toMatchObject({ gross: 105, syncStatus: 'UNSYNCED' });
    expect(read().acceptanceEvidence.t).toBeNull();
    await dispatchOutbox(db, company, server);
    expect(read().acceptanceEvidence.t).toMatchObject({ operationId: 'edit-2', serverRevision: 2 });
    db.prepare("UPDATE ticket_entries SET qty=16 WHERE id='entry_t_0_Sew_7'").run();
    expect(read().acceptanceEvidence.t).toBeNull();
    expect(read().workers[0].gross).toBe(112);
  });
});
