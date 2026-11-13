import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildFastifyServer } from '../app.cjs';
import { getServerPool, resetServerDatabase, closeServerPool } from '../infrastructure/db.cjs';
import { provisionDevice } from '../auth/deviceProvisioning.cjs';
import { provisionOperator } from '../auth/operatorAuth.cjs';
import { canonicalStringify, computePayloadHash } from '../modules/sync/canonicalPayload.cjs';
import { cancelAllocation, readAudit } from '../modules/sync/allocationResolution.cjs';
import { processSingleOperation } from '../modules/sync/handlers/operations.cjs';
import { hashSessionToken } from '../auth/operatorAuth.cjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const localDatabaseManager = require('../../desktop/electron/database/core/databaseManager.cjs');
const {
  insertOutboxOperation,
  queueAllocationCancellation,
  listPendingAllocationCancellations,
  acknowledgeAllocationCancellation,
  listAllocationReviewOperations
} = require('../../desktop/electron/database/outbox/outboxManager.cjs');

describe('live PostgreSQL trusted operator reconciliation authority', () => {
  const companyId = 'phase2-rbac-fixture';
  const deviceId = 'phase2-rbac-device';
  let pool: any;
  let app: any;
  let deviceToken: string;
  let adminToken: string;
  let accountantToken: string;

  beforeAll(async () => {
    pool = getServerPool();
    await resetServerDatabase();
    const device = await provisionDevice(pool, { deviceId, companyId });
    deviceToken = device.token;
    await provisionOperator(pool, { operatorId: 'phase2-admin', companyId, displayName: 'Phase 2 Admin', role: 'admin', password: 'phase2-test-password' });
    app = buildFastifyServer({ pool, allowTestTokens: false, businessMutationsEnabled: true });
    await app.ready();
    const login = await app.inject({
      method: 'POST', url: '/api/auth/operator/login',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { operatorId: 'phase2-admin', password: 'phase2-test-password' }
    });
    adminToken = JSON.parse(login.payload).session.token;
    await provisionOperator(pool, { operatorId: 'phase2-accountant', companyId, displayName: 'Phase 2 Accountant', role: 'accountant', password: 'phase2-test-password' });
    const accountantLogin = await app.inject({ method: 'POST', url: '/api/auth/operator/login',
      headers: { authorization: `Bearer ${deviceToken}` }, payload: { operatorId: 'phase2-accountant', password: 'phase2-test-password' } });
    accountantToken = JSON.parse(accountantLogin.payload).session.token;
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeServerPool();
  });

  beforeEach(async () => {
    // Audit rows are immutable by trigger; isolate each fixture with TRUNCATE.
    await pool.query(`TRUNCATE TABLE
      operations_dedup,
      allocation_review_candidates,
      allocation_resolution_audit,
      allocation_resolution_fences,
      change_log,
      migration_reconciliation_resolutions,
      production_adjustments,
      migration_reconciliation_candidates
      RESTART IDENTITY CASCADE`);
    await pool.query('DELETE FROM ticket_entries WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM tickets WHERE company_id=$1', [companyId]);
    await pool.query("DELETE FROM periods WHERE company_id=$1 AND id IN ('open-fixture','closed-fixture')", [companyId]);
    await pool.query(`INSERT INTO migration_reconciliation_candidates
      (candidate_id, company_id, model_id, worker_id, operation_name, legacy_qty, ticket_derived_qty, delta_qty, reason, source_snapshot_hash)
      VALUES ('phase2-candidate', $1, 'model-fixture', 1, 'Bichish', 10, 0, 10, 'fixture', repeat('a', 64))`, [companyId]);
    await pool.query(`INSERT INTO periods (id,company_id,start_date,end_date,is_closed)
      VALUES ('open-fixture',$1,'2026-01-01','2026-11-12',0)
      ON CONFLICT (company_id,id) DO UPDATE SET is_closed=0`, [companyId]);
  });

  function operation(operationId: string, decision: string, operatorId = 'phase2-admin') {
    const payload = {
      commandId: `cmd-${operationId}`, operationId, companyId, candidateId: 'phase2-candidate', decision,
      operatorId, operatorRole: 'admin', reason: 'fixture decision', effectiveDate: '2026-09-01'
    };
    return { operationId, companyId, commandType: 'ResolveMigrationReconciliationCandidate', entityType: 'reconciliation_candidate', entityId: 'phase2-candidate', payload, payloadHash: computePayloadHash(canonicalStringify(payload)) };
  }

  async function send(op: any, token = adminToken, device = deviceToken) {
    return app.inject({
      method: 'POST', url: '/api/sync/operations',
      headers: { authorization: `Bearer ${device}`, 'x-operator-token': token },
      payload: { operations: [op] }
    });
  }

  function cancellation(originalOperationId = 'alloc-cancel-1', resolutionOperationId = 'resolution-cancel-1', payload?: any) {
    payload ||= { operationId: originalOperationId, companyId, ticketId: 'ticket-1', qty: 12, periodId: 'open-fixture' };
    return { companyId, originalOperationId, originalPayloadHash: computePayloadHash(canonicalStringify(payload)),
      originalPayload: payload, commandType: 'SubmitTicket', resolutionOperationId, reason: 'Xato taqsimot' };
  }

  async function cancel(input: any, token = adminToken) {
    if (input?.companyId === companyId && input?.originalPayload?.companyId === companyId) {
      const payload = input.originalPayload;
      const canonical = canonicalStringify(payload);
      await pool.query(`INSERT INTO allocation_review_candidates
        (company_id,original_operation_id,command_type,entity_type,entity_id,original_payload_hash,original_payload_json,review_code,review_reason)
        VALUES($1,$2,$3,'ticket',$4,$5,$6::jsonb,'ALLOCATION_REVIEW_REQUIRED','fixture evidence')
        ON CONFLICT (company_id,original_operation_id) DO NOTHING`,
      [companyId, input.originalOperationId, input.commandType, payload.ticketId, computePayloadHash(canonical), canonical]);
    }
    return app.inject({ method: 'POST', url: '/api/sync/allocation-review/cancel',
      headers: { authorization: `Bearer ${deviceToken}`, 'x-operator-token': token }, payload: input });
  }

  it('accountant cancellation is atomic, audited, replayable and fences original operation replay', async () => {
    const request = cancellation();
    const first = await cancel(request, accountantToken);
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.payload)).toMatchObject({ status: 'CANCELLED', replay: false });
    const replay = await cancel(request, accountantToken);
    expect(JSON.parse(replay.payload)).toMatchObject({ status: 'CANCELLED', replay: true });
    const audit = await pool.query(`SELECT reviewer_id, action, previous_status, resulting_status, original_payload_hash
      FROM allocation_resolution_audit WHERE company_id=$1 AND original_operation_id=$2`, [companyId, request.originalOperationId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ reviewer_id: 'phase2-accountant', action: 'CANCEL', previous_status: 'CONFLICT', resulting_status: 'CANCELLED', original_payload_hash: request.originalPayloadHash });
    const op = { operationId: request.originalOperationId, companyId, commandType: request.commandType,
      entityType: 'ticket', entityId: 'ticket-1', payload: request.originalPayload, payloadHash: request.originalPayloadHash };
    const replayResult = await processSingleOperation(pool, { auth: { companyId, deviceId } }, op);
    expect(replayResult).toMatchObject({ status: 'REJECTED', error: { code: 'ALLOCATION_CANCELLED' } });
    expect(await pool.query('SELECT COUNT(*) FROM operations_dedup WHERE company_id=$1 AND operation_id=$2', [companyId, request.originalOperationId]).then((r: any) => Number(r.rows[0].count))).toBe(0);
  });

  it('allows an active admin cancellation and keeps identical operation IDs tenant-isolated', async () => {
    const operationId = 'same-id-two-companies';
    const request = cancellation(operationId, 'admin-cancel-resolution');
    const response = await cancel(request, adminToken);
    expect(JSON.parse(response.payload)).toMatchObject({ status: 'CANCELLED', replay: false });
    const otherCompanyAudit = await pool.query(`INSERT INTO allocation_resolution_audit
      (company_id,original_operation_id,original_payload_hash,resolution_operation_id,reviewer_id,action,
       previous_status,resulting_status,reason)
      VALUES('other-test-company',$1,repeat('c',64),'other-company-resolution','other-reviewer','CANCEL','CONFLICT','CANCELLED','isolated fixture')
      RETURNING original_operation_id`, [operationId]);
    expect(otherCompanyAudit.rows).toHaveLength(1);
    expect(await readAudit(pool, companyId, operationId)).toMatchObject([{ reviewerId: 'phase2-admin', action: 'CANCEL' }]);
    expect(await readAudit(pool, 'other-test-company', operationId)).toMatchObject([{ reviewerId: 'other-reviewer', action: 'CANCEL' }]);
  });

  it('persists immutable server review evidence from a real allocation-review rejection', async () => {
    const ticketId = '00000000-0000-4000-8000-000000000981';
    const operationId = 'server-recorded-allocation-review';
    await pool.query(`INSERT INTO models (id,company_id,name,operations_json,status)
      VALUES('review-model',$1,'Review fixture','[{"name":"Bichish","rate":1}]','ACTIVE')`, [companyId]);
    await pool.query(`INSERT INTO workers (id,company_id,name,status) VALUES(981,$1,'Review worker','ACTIVE')`, [companyId]);
    await pool.query(`INSERT INTO parties (id,company_id,party_number,physical_party_number,model_id,patta_count,
      patta_start_number,patta_end_number,ish_soni_per_patta,status)
      VALUES('review-party',$1,'review-77','review-77','review-model',1,1,1,10,'ACTIVE')`, [companyId]);
    const payload = { commandId: 'cmd-review-981', operationId, companyId, ticketId, modelId: 'review-model',
      partyNumber: 'review-77', partyRecordId: 'review-party', pattaNumber: 1, qty: 12,
      entries: [{ opName: 'Bichish', workerId: 981, qty: 12, rateSnapshot: 1 }],
      effectiveDate: '2026-11-11', periodId: 'open-fixture' };
    const envelope = { operationId, companyId, commandType: 'SubmitTicket', entityType: 'ticket', entityId: ticketId,
      payload, payloadHash: computePayloadHash(canonicalStringify(payload)) };
    const response = await app.inject({ method: 'POST', url: '/api/sync/operations',
      headers: { authorization: `Bearer ${deviceToken}`, 'x-operator-token': accountantToken }, payload: { operations: [envelope] } });
    const result = JSON.parse(response.payload).results[0];
    expect(result).toMatchObject({ status: 'CONFLICT', error: { code: 'ALLOCATION_REVIEW_REQUIRED' } });
    const recorded = await pool.query(`SELECT command_type,entity_type,entity_id,original_payload_hash,review_code
      FROM allocation_review_candidates WHERE company_id=$1 AND original_operation_id=$2`, [companyId, operationId]);
    expect(recorded.rows[0]).toMatchObject({ command_type: 'SubmitTicket', entity_type: 'ticket', entity_id: ticketId,
      original_payload_hash: envelope.payloadHash, review_code: 'ALLOCATION_REVIEW_REQUIRED' });
    const resolution = cancellation(operationId, 'server-recorded-resolution', payload);
    const cancelled = await cancel(resolution, accountantToken);
    expect(JSON.parse(cancelled.payload)).toMatchObject({ status: 'CANCELLED' });
    await expect(pool.query(`UPDATE allocation_review_candidates SET review_reason='rewritten'
      WHERE company_id=$1 AND original_operation_id=$2`, [companyId, operationId])).rejects.toThrow('ALLOCATION_REVIEW_CANDIDATE_IMMUTABLE');
  });

  it('serializes real PostgreSQL first-acceptance and cancellation races on separate pool connections', async () => {
    async function fixture(operationId: string) {
      const suffix = operationId.includes('cancel-first') ? 'cancel' : 'accept';
      const ticketId = suffix === 'cancel' ? '00000000-0000-4000-8000-000000000982' : '00000000-0000-4000-8000-000000000983';
      const modelId = `race-model-${suffix}`;
      const partyId = `race-party-${suffix}`;
      const partyNumber = `race-${suffix}-77`;
      const workerId = suffix === 'cancel' ? 982 : 983;
      await pool.query(`INSERT INTO models (id,company_id,name,operations_json,status)
        VALUES($1,$2,'Race fixture','[{"name":"Bichish","rate":1}]','ACTIVE')`, [modelId, companyId]);
      await pool.query('INSERT INTO workers (id,company_id,name,status) VALUES($1,$2,$3,\'ACTIVE\')', [workerId, companyId, 'Race worker']);
      await pool.query(`INSERT INTO parties (id,company_id,party_number,physical_party_number,model_id,patta_count,
        patta_start_number,patta_end_number,ish_soni_per_patta,status)
        VALUES($1,$2,$3,$3,$4,1,1,1,10,'ACTIVE')`, [partyId, companyId, partyNumber, modelId]);
      const payload = { commandId: `cmd-${operationId}`, operationId, companyId, ticketId, modelId,
        partyNumber, partyRecordId: partyId, pattaNumber: 1, qty: 10,
        entries: [{ opName: 'Bichish', workerId, qty: 10, rateSnapshot: 1 }],
        effectiveDate: '2026-11-11', periodId: 'open-fixture' };
      const op = { operationId, companyId, commandType: 'SubmitTicket', entityType: 'ticket', entityId: ticketId,
        payload, payloadHash: computePayloadHash(canonicalStringify(payload)) };
      await pool.query(`INSERT INTO allocation_review_candidates
        (company_id,original_operation_id,command_type,entity_type,entity_id,original_payload_hash,original_payload_json,review_code,review_reason)
        VALUES($1,$2,'SubmitTicket','ticket',$3,$4,$5::jsonb,'ALLOCATION_REVIEW_REQUIRED','concurrent fixture evidence')`,
      [companyId, operationId, ticketId, op.payloadHash, canonicalStringify(payload)]);
      return op;
    }
    const auth = { auth: { companyId, deviceId, operator: { operatorId: 'phase2-admin', companyId, deviceId, role: 'admin', isActive: true } } };

    const cancelFirstOp = await fixture('race-cancel-first');
    let cancelEntered!: () => void;
    let finishCancel!: () => void;
    const cancelHasWritten = new Promise<void>((resolve) => { cancelEntered = resolve; });
    const cancelGate = new Promise<void>((resolve) => { finishCancel = resolve; });
    const cancelFirst = cancelAllocation(pool, auth, cancellation(cancelFirstOp.operationId, 'race-cancel-first-resolution', cancelFirstOp.payload), {
      testHookBeforeCommit: async () => { cancelEntered(); await cancelGate; }
    });
    await cancelHasWritten;
    const replayWaiting = processSingleOperation(pool, { auth: { companyId, deviceId } }, cancelFirstOp);
    await new Promise<void>((resolve) => setImmediate(resolve));
    finishCancel();
    await cancelFirst;
    expect(await replayWaiting).toMatchObject({ status: 'REJECTED', error: { code: 'ALLOCATION_CANCELLED' } });
    expect(await pool.query('SELECT COUNT(*) FROM tickets WHERE company_id=$1 AND id=$2', [companyId, cancelFirstOp.entityId])
      .then((r: any) => Number(r.rows[0].count))).toBe(0);

    const acceptFirstOp = await fixture('race-accept-first');
    let acceptEntered!: () => void;
    let finishAccept!: () => void;
    const acceptHasWritten = new Promise<void>((resolve) => { acceptEntered = resolve; });
    const acceptGate = new Promise<void>((resolve) => { finishAccept = resolve; });
    const acceptance = processSingleOperation(pool, auth, acceptFirstOp, { testHookBeforeCommit: async () => { acceptEntered(); await acceptGate; } });
    await acceptHasWritten;
    const cancellationWaiting = cancelAllocation(pool, auth, cancellation(acceptFirstOp.operationId, 'race-accept-first-resolution', acceptFirstOp.payload));
    await new Promise<void>((resolve) => setImmediate(resolve));
    finishAccept();
    expect(await acceptance).toMatchObject({ status: 'APPLIED', isReplay: false });
    await expect(cancellationWaiting).rejects.toMatchObject({ code: 'ALLOCATION_ALREADY_ACCEPTED' });
    expect(await pool.query('SELECT COUNT(*) FROM tickets WHERE company_id=$1 AND id=$2', [companyId, acceptFirstOp.entityId])
      .then((r: any) => Number(r.rows[0].count))).toBe(1);
    expect(await pool.query('SELECT COUNT(*) FROM allocation_resolution_fences WHERE company_id=$1 AND original_operation_id=$2',
      [companyId, acceptFirstOp.operationId]).then((r: any) => Number(r.rows[0].count))).toBe(0);
  });

  it('recovers an ambiguous committed HTTP cancellation after SQLite restart with the same intent identity', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-pg-cancel-restart-'));
    const originalOperationId = 'ambiguous-http-cancel';
    const request = cancellation(originalOperationId, 'ambiguous-http-resolution');
    try {
      let db = localDatabaseManager.getCompanyDatabase(userData, companyId);
      const payloadJson = canonicalStringify(request.originalPayload);
      insertOutboxOperation(db, { operation_id: originalOperationId, company_id: companyId,
        command_type: request.commandType, entity_type: 'ticket', entity_id: request.originalPayload.ticketId,
        base_revision: 0, payload_json: payloadJson, payload_hash: request.originalPayloadHash,
        status: 'CONFLICT', last_error: 'ALLOCATION_REVIEW_REQUIRED' });
      const intent = queueAllocationCancellation(db, companyId, originalOperationId, request.reason);
      const serverRequest = { ...request, resolutionOperationId: intent.resolutionOperationId };

      // The server commits, but the client deliberately loses the response before
      // applying it locally. Restart must retain the same immutable intent.
      const first = await cancel(serverRequest, accountantToken);
      expect(JSON.parse(first.payload)).toMatchObject({ status: 'CANCELLED', replay: false });
      expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id=?').get(originalOperationId)).toEqual({ status: 'CONFLICT' });
      localDatabaseManager.closeAllCompanyDatabases();

      db = localDatabaseManager.getCompanyDatabase(userData, companyId);
      const [restored] = listPendingAllocationCancellations(db, companyId);
      expect(restored).toMatchObject({ resolution_operation_id: intent.resolutionOperationId,
        original_operation_id: originalOperationId, original_payload_hash: request.originalPayloadHash, status: 'PENDING' });
      const retry = await cancel(serverRequest, accountantToken);
      const receipt = JSON.parse(retry.payload);
      expect(receipt).toMatchObject({ status: 'CANCELLED', replay: true, resolutionOperationId: intent.resolutionOperationId });
      acknowledgeAllocationCancellation(db, companyId, intent.resolutionOperationId, receipt);
      expect(db.prepare('SELECT status,payload_hash,payload_json FROM local_outbox WHERE operation_id=?').get(originalOperationId))
        .toMatchObject({ status: 'SUPERSEDED', payload_hash: request.originalPayloadHash, payload_json: payloadJson });
      expect(listAllocationReviewOperations(db, companyId).find((row: any) => row.operation_id === originalOperationId)?.status)
        .toBe('SUPERSEDED');

      const originalReplay = await processSingleOperation(pool, { auth: { companyId, deviceId } }, {
        operationId: originalOperationId, companyId, commandType: request.commandType, entityType: 'ticket',
        entityId: request.originalPayload.ticketId, payload: request.originalPayload, payloadHash: request.originalPayloadHash
      });
      expect(originalReplay).toMatchObject({ status: 'REJECTED', error: { code: 'ALLOCATION_CANCELLED' } });
    } finally {
      localDatabaseManager.closeAllCompanyDatabases();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  it('rejects missing operator, cross-company request and cancellation of already accepted operation', async () => {
    const unauth = await app.inject({ method: 'POST', url: '/api/sync/allocation-review/cancel',
      headers: { authorization: `Bearer ${deviceToken}` }, payload: cancellation() });
    expect(unauth.statusCode).toBe(403);
    const cross = await cancel({ ...cancellation(), companyId: 'another-company' });
    expect(cross.statusCode).toBe(403);
    const request = cancellation('already-accepted');
    await pool.query(`INSERT INTO operations_dedup (company_id,operation_id,command_type,entity_type,entity_id,payload_hash,result_json,server_revision)
      VALUES($1,$2,'SubmitTicket','ticket','ticket-1',$3,'{}'::jsonb,1)`, [companyId, request.originalOperationId, request.originalPayloadHash]);
    const accepted = await cancel(request);
    expect(JSON.parse(accepted.payload).error.code).toBe('ALLOCATION_ALREADY_ACCEPTED');
    expect(await pool.query('SELECT COUNT(*) FROM allocation_resolution_fences WHERE company_id=$1', [companyId]).then((r: any) => Number(r.rows[0].count))).toBe(0);
  });

  it('binds reviewer to the session, ignores forged actor fields, and rejects hash or resolution identity reuse', async () => {
    const forged = { ...cancellation('forged-actor', 'forged-resolution'), actorId: 'owner-admin', reviewerId: 'owner-admin' };
    const first = await cancel(forged, accountantToken);
    expect(first.statusCode).toBe(200);
    const audit = await pool.query('SELECT reviewer_id FROM allocation_resolution_audit WHERE company_id=$1 AND original_operation_id=$2',
      [companyId, forged.originalOperationId]);
    expect(audit.rows[0].reviewer_id).toBe('phase2-accountant');

    const incorrectHash = cancellation('bad-hash', 'bad-hash-resolution');
    incorrectHash.originalPayloadHash = 'b'.repeat(64);
    expect(JSON.parse((await cancel(incorrectHash)).payload).error.code).toBe('ORIGINAL_PAYLOAD_HASH_MISMATCH');

    const reused = { ...forged, reason: 'A different resolution intent' };
    expect(JSON.parse((await cancel(reused, accountantToken)).payload).error.code).toBe('ALLOCATION_RESOLUTION_CONFLICT');
    const changedIdentity = { ...forged, resolutionOperationId: 'other-resolution' };
    expect(JSON.parse((await cancel(changedIdentity, accountantToken)).payload).error.code).toBe('ALLOCATION_RESOLUTION_CONFLICT');
    const reusedAcrossOriginals = cancellation('different-original', forged.resolutionOperationId);
    expect(JSON.parse((await cancel(reusedAcrossOriginals, accountantToken)).payload).error.code).toBe('ALLOCATION_RESOLUTION_CONFLICT');
  });

  it('rejects revoked device-bound operator sessions without writing resolution evidence', async () => {
    const request = cancellation('revoked-session', 'revoked-resolution');
    await pool.query('UPDATE operator_sessions SET revoked_at=NOW() WHERE token_hash=$1', [hashSessionToken(accountantToken)]);
    const response = await cancel(request, accountantToken);
    expect(response.statusCode).toBe(403);
    expect(await pool.query('SELECT COUNT(*) FROM allocation_resolution_fences WHERE company_id=$1 AND original_operation_id=$2',
      [companyId, request.originalOperationId]).then((r: any) => Number(r.rows[0].count))).toBe(0);
    // Restore the disposable fixture session so later tests use a fresh valid session.
    await pool.query('UPDATE operator_sessions SET revoked_at=NULL WHERE token_hash=$1', [hashSessionToken(accountantToken)]);
  });

  it('rolls back the fence when audit insertion itself fails', async () => {
    await pool.query(`CREATE OR REPLACE FUNCTION fail_allocation_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'INJECTED_AUDIT_FAILURE'; END $$`);
    await pool.query(`CREATE TRIGGER test_fail_allocation_audit BEFORE INSERT ON allocation_resolution_audit
      FOR EACH ROW EXECUTE FUNCTION fail_allocation_audit_insert()`);
    const request = cancellation('audit-failure', 'audit-failure-resolution');
    const response = await cancel(request);
    expect(response.statusCode).toBe(500);
    const counts = await pool.query(`SELECT
      (SELECT COUNT(*) FROM allocation_resolution_fences WHERE company_id=$1 AND original_operation_id=$2) AS fences,
      (SELECT COUNT(*) FROM allocation_resolution_audit WHERE company_id=$1 AND original_operation_id=$2) AS audits`,
    [companyId, request.originalOperationId]);
    expect(counts.rows[0]).toEqual({ fences: '0', audits: '0' });
    await pool.query('DROP TRIGGER test_fail_allocation_audit ON allocation_resolution_audit');
    await pool.query('DROP FUNCTION fail_allocation_audit_insert()');
  });

  it('keeps an exact accepted receipt idempotent and rejects cancellation after acceptance', async () => {
    const payload = { operationId: 'receipt-before-cancel', companyId, ticketId: '00000000-0000-4000-8000-000000000911', qty: 2, periodId: 'open-fixture' };
    const request = cancellation(payload.operationId, 'receipt-resolution', payload);
    await pool.query(`INSERT INTO operations_dedup
      (company_id,operation_id,command_type,entity_type,entity_id,payload_hash,result_json,server_revision)
      VALUES($1,$2,'SubmitTicket','ticket',$3,$4,'{"cursor":12}'::jsonb,1)`,
    [companyId, request.originalOperationId, payload.ticketId, request.originalPayloadHash]);
    expect(JSON.parse((await cancel(request)).payload).error.code).toBe('ALLOCATION_ALREADY_ACCEPTED');
    const op = { operationId: request.originalOperationId, companyId, commandType: 'SubmitTicket', entityType: 'ticket',
      entityId: payload.ticketId, payload, payloadHash: request.originalPayloadHash };
    expect(await processSingleOperation(pool, { auth: { companyId, deviceId } }, op)).toMatchObject({ status: 'APPLIED', isReplay: true });
    expect(await pool.query('SELECT COUNT(*) FROM allocation_resolution_fences WHERE company_id=$1 AND original_operation_id=$2',
      [companyId, request.originalOperationId]).then((r: any) => Number(r.rows[0].count))).toBe(0);
  });

  it('rolls back fence and audit together when a transaction fails', async () => {
    const request = cancellation('rollback-allocation', 'rollback-resolution');
    await pool.query(`INSERT INTO allocation_review_candidates
      (company_id,original_operation_id,command_type,entity_type,entity_id,original_payload_hash,original_payload_json,review_code,review_reason)
      VALUES($1,$2,$3,'ticket',$4,$5,$6::jsonb,'ALLOCATION_REVIEW_REQUIRED','fixture evidence')`,
    [companyId, request.originalOperationId, request.commandType, request.originalPayload.ticketId, request.originalPayloadHash,
      canonicalStringify(request.originalPayload)]);
    const auth = { auth: { companyId, deviceId, operator: { operatorId: 'phase2-admin', companyId, deviceId, role: 'admin', isActive: true } } };
    await expect(cancelAllocation(pool, auth, request, { testHookBeforeCommit: async () => { throw new Error('rollback fixture'); } })).rejects.toThrow('rollback fixture');
    const [fences, audits] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM allocation_resolution_fences WHERE company_id=$1', [companyId]),
      pool.query('SELECT COUNT(*) FROM allocation_resolution_audit WHERE company_id=$1', [companyId])
    ]);
    expect(Number(fences.rows[0].count)).toBe(0);
    expect(Number(audits.rows[0].count)).toBe(0);
  });

  it('serializes contradictory reviewers and rejects closed-period cancellation', async () => {
    const competing = cancellation('race-allocation', 'race-resolution-a');
    const second = { ...competing, resolutionOperationId: 'race-resolution-b', reason: 'Boshqa qaror' };
    const [a, b] = await Promise.all([cancel(competing), cancel(second, accountantToken)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await pool.query('SELECT COUNT(*) FROM allocation_resolution_audit WHERE company_id=$1 AND original_operation_id=$2',
      [companyId, competing.originalOperationId]).then((r: any) => Number(r.rows[0].count))).toBe(1);

    await pool.query(`INSERT INTO periods (id,company_id,start_date,end_date,is_closed)
      VALUES ('closed-fixture',$1,'2026-01-01','2026-12-31',1)`, [companyId]);
    const closed = cancellation('closed-allocation', 'closed-resolution', {
      operationId: 'closed-allocation', companyId, ticketId: 'ticket-closed', qty: 2, periodId: 'closed-fixture'
    });
    const response = await cancel(closed);
    expect(JSON.parse(response.payload).error.code).toBe('PERIOD_CLOSED');
    expect(await pool.query('SELECT COUNT(*) FROM allocation_resolution_fences WHERE company_id=$1 AND original_operation_id=$2',
      [companyId, closed.originalOperationId]).then((r: any) => Number(r.rows[0].count))).toBe(0);
  });

  it('two authorized clients resolving one candidate produce exactly one winner', async () => {
    const [confirm, reject] = await Promise.all([
      send(operation('phase2-confirm', 'CONFIRM_LEGACY_AS_ADJUSTMENT')),
      send(operation('phase2-reject', 'REJECT_LEGACY_DIFFERENCE'))
    ]);
    const results = [JSON.parse(confirm.payload).results[0], JSON.parse(reject.payload).results[0]];
    expect(results.filter((result) => result.status === 'APPLIED')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'REJECTED' || result.status === 'CONFLICT')).toHaveLength(1);
    const rows = await pool.query('SELECT status FROM migration_reconciliation_candidates WHERE company_id = $1 AND candidate_id = $2', [companyId, 'phase2-candidate']);
    const adjustments = await pool.query('SELECT COUNT(*) FROM production_adjustments WHERE company_id = $1', [companyId]);
    expect(['APPROVED', 'REJECTED']).toContain(rows.rows[0].status);
    expect(Number(adjustments.rows[0].count)).toBe(rows.rows[0].status === 'APPROVED' ? 1 : 0);
  });

  it('reconciliation mutation rolls back when failure is injected before commit', async () => {
    const { processSingleOperation } = require('../modules/sync/handlers/operations.cjs');
    const payload = operation('phase2-rollback', 'CONFIRM_LEGACY_AS_ADJUSTMENT');
    await expect(processSingleOperation(pool, { auth: { companyId, deviceId, operator: { operatorId: 'phase2-admin', companyId, deviceId, role: 'admin', isActive: true } } }, payload, { testHookBeforeCommit: async () => { throw new Error('fixture failure'); } })).rejects.toThrow('fixture failure');
    const resolution = await pool.query('SELECT COUNT(*) FROM migration_reconciliation_resolutions WHERE company_id = $1', [companyId]);
    const adjustment = await pool.query('SELECT COUNT(*) FROM production_adjustments WHERE company_id = $1', [companyId]);
    const log = await pool.query('SELECT COUNT(*) FROM change_log WHERE company_id = $1', [companyId]);
    expect(Number(resolution.rows[0].count)).toBe(0);
    expect(Number(adjustment.rows[0].count)).toBe(0);
    expect(Number(log.rows[0].count)).toBe(0);
  });
});
