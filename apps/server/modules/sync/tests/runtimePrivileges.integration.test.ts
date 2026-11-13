import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

const { getServerPool, resetServerDatabase, closeServerPool } = require('../../../infrastructure/db.cjs');
const { verifyFreshPostgres16TestEnvironment } = require('../../../../../scripts/verify/database/verify-pg16-test-env.cjs');
const { processSingleOperation } = require('../handlers/operations.cjs');
const { cancelAllocation } = require('../allocationResolution.cjs');
const { canonicalStringify, computePayloadHash } = require('../canonicalPayload.cjs');

const postgres = process.env.NOVDA_DISPOSABLE_PG === '1' && process.env.NOVDA_PG_URL && !process.env.DATABASE_URL
  ? describe : describe.skip;

postgres('sync with production runtime privileges', () => {
  const companyId = 'runtime-privileges-fixture';
  const role = `hisob_test_sync_runtime_${process.pid}`;
  const req = { auth: { companyId, deviceId: 'fixture-device', operator: {
    companyId, operatorId: 'fixture-reviewer', role: 'accountant', isActive: true
  } } };
  let admin: any;
  let runtime: Pool;

  beforeAll(async () => {
    await verifyFreshPostgres16TestEnvironment();
    admin = getServerPool();
    await resetServerDatabase();
    const grants = fs.readFileSync(path.resolve('apps/server/database/production_roles.sql'), 'utf8');
    await admin.query(grants.replaceAll('novda_app', role));
    runtime = new Pool({ connectionString: process.env.NOVDA_PG_URL, options: `-c role=${role}` });
    await admin.query(`INSERT INTO workers (id, company_id, name) VALUES (11, $1, 'Worker')`, [companyId]);
    await admin.query(`INSERT INTO periods (id, company_id, start_date, is_closed)
      VALUES ('open-fixture', $1, '2026-01-01', 0)`, [companyId]);
  });

  afterAll(async () => {
    if (runtime) await runtime.end();
    if (admin) {
      await admin.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
      await closeServerPool();
    }
  });

  it('accepts and replays worker changes without UPDATE rights on immutable allocation evidence', async () => {
    const privileges = await runtime.query(`SELECT
      has_table_privilege(current_user, 'allocation_resolution_fences', 'UPDATE') AS fence_update,
      has_table_privilege(current_user, 'allocation_review_candidates', 'UPDATE') AS evidence_update`);
    expect(privileges.rows[0]).toEqual({ fence_update: false, evidence_update: false });
    const current = await admin.query('SELECT server_revision FROM workers WHERE company_id=$1 AND id=11', [companyId]);
    const payload = { commandId: 'worker-command', operationId: 'worker-operation', companyId,
      workerId: 11, name: 'Updated worker', staj: 0, role: null, status: 'ACTIVE',
      balanceAdjustments: [{ adjustmentId: 'worker-avans', type: 'AVANS', amountDelta: 100, periodId: 'open-fixture' }] };
    const operation = { operationId: payload.operationId, companyId, commandType: 'UpsertWorker',
      entityType: 'worker', entityId: '11', baseRevision: Number(current.rows[0].server_revision),
      payload, payloadHash: computePayloadHash(canonicalStringify(payload)) };
    expect(await processSingleOperation(runtime, req, operation)).toMatchObject({ status: 'APPLIED', isReplay: false });
    expect(await processSingleOperation(runtime, req, operation)).toMatchObject({ status: 'APPLIED', isReplay: true });
    const adjustments = await admin.query('SELECT amount FROM worker_adjustments WHERE company_id=$1', [companyId]);
    expect(adjustments.rows).toEqual([{ amount: '100' }]);
  });

  it('cancels and replays allocation review while fencing the original command with read/insert-only evidence', async () => {
    const payload = { operationId: 'review-operation', companyId,
      ticketId: '00000000-0000-4000-8000-000000000811', qty: 10, periodId: 'open-fixture' };
    const canonical = canonicalStringify(payload);
    const hash = computePayloadHash(canonical);
    await admin.query(`INSERT INTO allocation_review_candidates
      (company_id, original_operation_id, command_type, entity_type, entity_id, original_payload_hash,
       original_payload_json, review_code, review_reason)
      VALUES ($1, $2, 'SubmitTicket', 'ticket', $3, $4, $5::jsonb, 'ALLOCATION_REVIEW_REQUIRED', 'fixture')`,
    [companyId, payload.operationId, payload.ticketId, hash, canonical]);
    const input = { companyId, originalOperationId: payload.operationId, originalPayloadHash: hash,
      originalPayload: payload, commandType: 'SubmitTicket', resolutionOperationId: 'resolution-operation', reason: 'Correction' };
    expect(await cancelAllocation(runtime, req, input)).toMatchObject({ status: 'CANCELLED', replay: false });
    expect(await cancelAllocation(runtime, req, input)).toMatchObject({ status: 'CANCELLED', replay: true });
    expect(await processSingleOperation(runtime, req, {
      operationId: payload.operationId, companyId, commandType: 'SubmitTicket', entityType: 'ticket',
      entityId: payload.ticketId, payload, payloadHash: hash
    })).toMatchObject({ status: 'REJECTED', error: { code: 'ALLOCATION_CANCELLED' } });
  });
});
