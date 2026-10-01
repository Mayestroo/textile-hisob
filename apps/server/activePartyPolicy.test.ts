import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { buildFastifyServer } from './app.cjs';
import { getServerPool, resetServerDatabase, closeServerPool } from './infrastructure/db.cjs';
import { canonicalStringify, computePayloadHash } from './modules/sync/canonicalPayload.cjs';

// @ts-ignore
const migrator = require('../desktop/electron/database/migrator.cjs');
// @ts-ignore
const databaseManager = require('../desktop/electron/database/databaseManager.cjs');

describe('Phase 2 â€” Active-Party Uniqueness Owner Exception Policy Tests (INV-05)', () => {
  let app: any;
  let pool: any;

  const COMPANY = 'comp_novda';
  const DEVICE = 'device-cutting-01';
  const TOKEN = `novda-test-token:${COMPANY}:${DEVICE}`;

  const GRANDFATHERED_A = 'rec_1788774889449_vrbkv';
  const GRANDFATHERED_B = 'rec_1788930871307_cg1iv';

  beforeAll(async () => {
    pool = getServerPool();
    await resetServerDatabase();
    app = buildFastifyServer({ pool, allowTestTokens: true });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeServerPool();
  });

  beforeEach(async () => {
    await resetServerDatabase();

    // Seed test models
    await pool.query(
      `INSERT INTO models (id, company_id, name, operations_json) 
       VALUES ($1, $2, 'BODY-T-SHRIT', '[]'), ($3, $2, 'Aleksandr-ÐŸÑ€Ð¸Ñ‚Ð°Ð»Ð¸Ð½Ð½Ð¸Ð¹', '[]')`,
      ['model-body-t', COMPANY, 'model-alex-prit']
    );
  });

  function makePartyOp(opId: string, commandType: 'CreateParty' | 'CloseParty', payload: any) {
    const normalizedPayload = commandType === 'CreateParty' && payload.pattaCount === undefined
      ? { ...payload, pattaCount: 1 }
      : payload;
    const canonical = canonicalStringify(normalizedPayload);
    const hash = computePayloadHash(canonical);
    return {
      operationId: opId,
      companyId: COMPANY,
      commandType,
      entityType: 'party',
      entityId: normalizedPayload.partyRecordId || normalizedPayload.id,
      payload: normalizedPayload,
      payloadHash: hash
    };
  }

  async function seedGrandfatheredPair() {
    // 1. Insert grandfather exception records
    await pool.query(
      `INSERT INTO legacy_party_collision_exceptions (
        exception_id, company_id, party_number, party_id, collision_group_id,
        approved_by, approved_at, reason, status
      ) VALUES 
        ('exc-p2-a', $1, '2', $2, 'col_group_comp_novda_party_2', 'OWNER_BUSINESS_DECISION', NOW(), 'Legacy exception', 'ACTIVE'),
        ('exc-p2-b', $1, '2', $3, 'col_group_comp_novda_party_2', 'OWNER_BUSINESS_DECISION', NOW(), 'Legacy exception', 'ACTIVE')`,
      [COMPANY, GRANDFATHERED_A, GRANDFATHERED_B]
    );

    // 2. Insert both parties as ACTIVE
    await pool.query(
      `INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status, is_closed)
       VALUES 
        ($1, $3, '2', '2', 'model-body-t', 'ACTIVE', 0),
        ($2, $3, '2', '2', 'model-alex-prit', 'ACTIVE', 0)`,
      [GRANDFATHERED_A, GRANDFATHERED_B, COMPANY]
    );
  }

  // ----------------------------------------------------------------
  // Test 1: grandfather Party #2 A ACTIVE + B ACTIVE => allowed
  // ----------------------------------------------------------------
  it('1. grandfather Party #2 A ACTIVE + B ACTIVE => allowed', async () => {
    await seedGrandfatheredPair();

    const res = await pool.query(
      `SELECT id, party_number, status, is_closed 
       FROM parties 
       WHERE company_id = $1 AND party_number = '2' AND status = 'ACTIVE' 
       ORDER BY id`,
      [COMPANY]
    );
    expect(res.rows.length).toBe(2);
    expect(res.rows.map((r: any) => r.id).sort()).toEqual([GRANDFATHERED_A, GRANDFATHERED_B].sort());
    expect(res.rows.every((r: any) => r.status === 'ACTIVE' && r.is_closed === 0)).toBe(true);
  });

  // ----------------------------------------------------------------
  // Test 2: A ACTIVE + B ACTIVE + new C #2 => rejected
  // ----------------------------------------------------------------
  it('2. A ACTIVE + B ACTIVE + new C #2 => rejected', async () => {
    await seedGrandfatheredPair();

    const opC = makePartyOp('op-new-c-attempt', 'CreateParty', {
      partyRecordId: 'uuid-party-2-c',
      partyNumber: '2',
      modelId: 'model-body-t'
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [opC] }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.results[0].status).toBe('REJECTED');
    expect(body.results[0].error.code).toBe('ACTIVE_PARTY_EXISTS');

    // DB-level trigger also rejects direct SQL bypass
    await expect(
      pool.query(
        `INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status)
         VALUES ('uuid-direct-bypass-c', $1, '2', '2', 'model-body-t', 'ACTIVE')`,
        [COMPANY]
      )
    ).rejects.toThrow(/ACTIVE_PARTY_EXISTS/);
  });

  // ----------------------------------------------------------------
  // Test 3: A CLOSED + B ACTIVE + new C #2 => rejected
  // ----------------------------------------------------------------
  it('3. A CLOSED + B ACTIVE + new C #2 => rejected', async () => {
    await seedGrandfatheredPair();

    // Close A via API
    const closeA = makePartyOp('op-close-a', 'CloseParty', {
      partyRecordId: GRANDFATHERED_A
    });
    const resClose = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [closeA] }
    });
    expect(JSON.parse(resClose.payload).results[0].status).toBe('APPLIED');

    // Attempt new C while B is still ACTIVE
    const opC = makePartyOp('op-c-when-b-active', 'CreateParty', {
      partyRecordId: 'uuid-party-2-c',
      partyNumber: '2',
      modelId: 'model-body-t'
    });
    const resC = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [opC] }
    });
    const bodyC = JSON.parse(resC.payload);
    expect(bodyC.results[0].status).toBe('REJECTED');
    expect(bodyC.results[0].error.code).toBe('ACTIVE_PARTY_EXISTS');
  });

  // ----------------------------------------------------------------
  // Test 4: A ACTIVE + B CLOSED + new C #2 => rejected
  // ----------------------------------------------------------------
  it('4. A ACTIVE + B CLOSED + new C #2 => rejected', async () => {
    await seedGrandfatheredPair();

    // Close B via API
    const closeB = makePartyOp('op-close-b', 'CloseParty', {
      partyRecordId: GRANDFATHERED_B
    });
    const resClose = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [closeB] }
    });
    expect(JSON.parse(resClose.payload).results[0].status).toBe('APPLIED');

    // Attempt new C while A is still ACTIVE
    const opC = makePartyOp('op-c-when-a-active', 'CreateParty', {
      partyRecordId: 'uuid-party-2-c',
      partyNumber: '2',
      modelId: 'model-body-t'
    });
    const resC = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [opC] }
    });
    const bodyC = JSON.parse(resC.payload);
    expect(bodyC.results[0].status).toBe('REJECTED');
    expect(bodyC.results[0].error.code).toBe('ACTIVE_PARTY_EXISTS');
  });

  // ----------------------------------------------------------------
  // Test 5: A CLOSED + B CLOSED + new C #2 => accepted
  // ----------------------------------------------------------------
  it('5. A CLOSED + B CLOSED + new C #2 => accepted', async () => {
    await seedGrandfatheredPair();

    // Close both A and B
    await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: {
        operations: [
          makePartyOp('op-close-a-both', 'CloseParty', { partyRecordId: GRANDFATHERED_A }),
          makePartyOp('op-close-b-both', 'CloseParty', { partyRecordId: GRANDFATHERED_B })
        ]
      }
    });

    // Both are closed -> exception group exhausted -> new C accepted
    const opC = makePartyOp('op-c-both-closed', 'CreateParty', {
      partyRecordId: 'uuid-party-2-c-accepted',
      partyNumber: '2',
      modelId: 'model-body-t'
    });
    const resC = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [opC] }
    });
    const bodyC = JSON.parse(resC.payload);
    expect(bodyC.results[0].status).toBe('APPLIED');
    expect(bodyC.results[0].serverRevision).toBe(1);

    const check = await pool.query(
      `SELECT id, status FROM parties WHERE company_id = $1 AND id = 'uuid-party-2-c-accepted'`,
      [COMPANY]
    );
    expect(check.rows[0].status).toBe('ACTIVE');

    const provenance = await pool.query(
      `SELECT party_id, status FROM legacy_party_collision_exceptions WHERE company_id = $1 ORDER BY party_id`,
      [COMPANY]
    );
    expect(provenance.rows.every((row: any) => row.status === 'ACTIVE')).toBe(true);
  });

  // ----------------------------------------------------------------
  // Test 6: new C #2 gets new canonical UUID
  // ----------------------------------------------------------------
  it('6. new C #2 gets new canonical UUID', async () => {
    await seedGrandfatheredPair();
    await pool.query(`UPDATE parties SET status = 'CLOSED', is_closed = 1 WHERE company_id = $1`, [COMPANY]);

    const newUuid = 'uuid-canonical-fresh-c';
    const opC = makePartyOp('op-fresh-uuid', 'CreateParty', {
      partyRecordId: newUuid,
      partyNumber: '2',
      modelId: 'model-body-t'
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [opC] }
    });
    expect(JSON.parse(res.payload).results[0].status).toBe('APPLIED');

    expect(newUuid).not.toBe(GRANDFATHERED_A);
    expect(newUuid).not.toBe(GRANDFATHERED_B);

    const rows = await pool.query(
      `SELECT id FROM parties WHERE company_id = $1 AND party_number = '2' ORDER BY id`,
      [COMPANY]
    );
    expect(rows.rows.length).toBe(3);
    const ids = rows.rows.map((r: any) => r.id);
    expect(ids).toContain(GRANDFATHERED_A);
    expect(ids).toContain(GRANDFATHERED_B);
    expect(ids).toContain(newUuid);
  });

  // ----------------------------------------------------------------
  // Test 7: closed A/B remain queryable historically
  // ----------------------------------------------------------------
  it('7. closed A/B remain queryable historically', async () => {
    await seedGrandfatheredPair();
    await pool.query(
      `UPDATE parties SET status = 'CLOSED', is_closed = 1, closed_at = NOW() WHERE company_id = $1`,
      [COMPANY]
    );

    const hist = await pool.query(
      `SELECT id, party_number, status, is_closed, closed_at 
       FROM parties 
       WHERE company_id = $1 AND party_number = '2' AND status = 'CLOSED' 
       ORDER BY id`,
      [COMPANY]
    );
    expect(hist.rows.length).toBe(2);
    expect(hist.rows[0].is_closed).toBe(1);
    expect(hist.rows[0].closed_at).not.toBeNull();
    expect(hist.rows[1].is_closed).toBe(1);
    expect(hist.rows[1].closed_at).not.toBeNull();
  });

  // ----------------------------------------------------------------
  // Test 8: Party #5 ACTIVE + new Party #5 => rejected
  // ----------------------------------------------------------------
  it('8. Party #5 ACTIVE + new Party #5 => rejected', async () => {
    const op1 = makePartyOp('op-p5-first', 'CreateParty', {
      partyRecordId: 'uuid-p5-first',
      partyNumber: '5',
      modelId: 'model-body-t'
    });
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [op1] }
    });
    expect(JSON.parse(res1.payload).results[0].status).toBe('APPLIED');

    const op2 = makePartyOp('op-p5-second', 'CreateParty', {
      partyRecordId: 'uuid-p5-second',
      partyNumber: '5',
      modelId: 'model-body-t'
    });
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [op2] }
    });
    const body2 = JSON.parse(res2.payload);
    expect(body2.results[0].status).toBe('REJECTED');
    expect(body2.results[0].error.code).toBe('ACTIVE_PARTY_EXISTS');
  });

  // ----------------------------------------------------------------
  // Test 9: Party #7 ACTIVE across another model => rejected
  // ----------------------------------------------------------------
  it('9. Party #7 ACTIVE across another model => rejected', async () => {
    const opA = makePartyOp('op-p7-model-a', 'CreateParty', {
      partyRecordId: 'uuid-p7-model-a',
      partyNumber: '7',
      modelId: 'model-body-t'
    });
    await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [opA] }
    });

    const opB = makePartyOp('op-p7-model-b', 'CreateParty', {
      partyRecordId: 'uuid-p7-model-b',
      partyNumber: '7',
      modelId: 'model-alex-prit' // different model
    });
    const resB = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [opB] }
    });
    const bodyB = JSON.parse(resB.payload);
    expect(bodyB.results[0].status).toBe('REJECTED');
    expect(bodyB.results[0].error.code).toBe('ACTIVE_PARTY_EXISTS');
  });

  // ----------------------------------------------------------------
  // Test 10: Party #9 ACTIVE across another period => rejected
  // ----------------------------------------------------------------
  it('10. Party #9 ACTIVE across another period => rejected', async () => {
    await pool.query(
      `INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status)
       VALUES ('uuid-p9-period-1', $1, '9', '9', 'model-body-t', 'ACTIVE')`,
      [COMPANY]
    );

    const opPeriod2 = makePartyOp('op-p9-period-2', 'CreateParty', {
      partyRecordId: 'uuid-p9-period-2',
      partyNumber: '9',
      modelId: 'model-body-t'
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [opPeriod2] }
    });
    const body = JSON.parse(res.payload);
    expect(body.results[0].status).toBe('REJECTED');
    expect(body.results[0].error.code).toBe('ACTIVE_PARTY_EXISTS');
  });

  it('10A. normal Party numbers remain company-scoped across models and devices', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [makePartyOp('op-p10-device-one', 'CreateParty', { partyRecordId: 'uuid-p10-device-one', partyNumber: '10', modelId: 'model-body-t' })] }
    });
    expect(JSON.parse(first.payload).results[0].status).toBe('APPLIED');

    const second = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer novda-test-token:${COMPANY}:device-two`, 'x-client-version': '2.0.0' },
      payload: { operations: [makePartyOp('op-p10-device-two', 'CreateParty', { partyRecordId: 'uuid-p10-device-two', partyNumber: '10', modelId: 'model-alex-prit' })] }
    });
    expect(JSON.parse(second.payload).results[0].status).toBe('REJECTED');
    expect(JSON.parse(second.payload).results[0].error.code).toBe('ACTIVE_PARTY_EXISTS');
  });

  // ----------------------------------------------------------------
  // Test 11: CLOSE_PENDING #2 still blocks reuse
  // ----------------------------------------------------------------
  it('11. CLOSE_PENDING #2 still blocks reuse', async () => {
    // Put party into CLOSE_PENDING
    await pool.query(
      `INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status)
       VALUES ('uuid-p2-pending', $1, '2', '2', 'model-body-t', 'CLOSE_PENDING')`,
      [COMPANY]
    );

    const opAttempt = makePartyOp('op-p2-attempt-while-pending', 'CreateParty', {
      partyRecordId: 'uuid-p2-attempt-pending',
      partyNumber: '2',
      modelId: 'model-body-t'
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [opAttempt] }
    });
    const body = JSON.parse(res.payload);
    expect(body.results[0].status).toBe('REJECTED');
    expect(body.results[0].error.code).toBe('ACTIVE_PARTY_EXISTS');
  });

  // ----------------------------------------------------------------
  // Test 12: exact authoritative CLOSED releases only that party's reservation
  // ----------------------------------------------------------------
  it('12. exact authoritative CLOSED releases only that party reservation', async () => {
    // Create Party 20 and Party 21
    await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: {
        operations: [
          makePartyOp('op-p20-init', 'CreateParty', { partyRecordId: 'uuid-p20', partyNumber: '20', modelId: 'model-body-t' }),
          makePartyOp('op-p21-init', 'CreateParty', { partyRecordId: 'uuid-p21', partyNumber: '21', modelId: 'model-body-t' })
        ]
      }
    });

    // Close only Party 20
    await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [makePartyOp('op-p20-close', 'CloseParty', { partyRecordId: 'uuid-p20' })] }
    });

    // Party 20 is reusable
    const res20 = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [makePartyOp('op-p20-new', 'CreateParty', { partyRecordId: 'uuid-p20-new', partyNumber: '20', modelId: 'model-body-t' })] }
    });
    expect(JSON.parse(res20.payload).results[0].status).toBe('APPLIED');

    // Party 21 is STILL BLOCKED
    const res21 = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [makePartyOp('op-p21-new', 'CreateParty', { partyRecordId: 'uuid-p21-new', partyNumber: '21', modelId: 'model-body-t' })] }
    });
    expect(JSON.parse(res21.payload).results[0].status).toBe('REJECTED');
    expect(JSON.parse(res21.payload).results[0].error.code).toBe('ACTIVE_PARTY_EXISTS');
  });

  // ----------------------------------------------------------------
  // Test 13: client cannot submit grandfather flag
  // ----------------------------------------------------------------
  it('13. client cannot submit grandfather flag to bypass uniqueness', async () => {
    // Create initial active Party 5
    await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: {
        operations: [makePartyOp('op-p5-base', 'CreateParty', { partyRecordId: 'uuid-p5-base', partyNumber: '5', modelId: 'model-body-t' })]
      }
    });

    // Client attempts to sneak in server-authoritative Party fields.
    const rogueOp = makePartyOp('op-rogue-grandfather', 'CreateParty', {
      partyRecordId: 'uuid-rogue-p5',
      partyNumber: '5',
      modelId: 'model-body-t',
      grandfathered: true,
      legacyException: true,
      exceptionGroupId: 'fake-group',
      approvedBy: 'fake-operator',
      status: 'ACTIVE'
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [rogueOp] }
    });
    const body = JSON.parse(res.payload);
    expect(body.results[0].status).toBe('REJECTED');
    expect(body.results[0].error.code).toBe('FORBIDDEN_AUTHORITY_FIELD');

    // Verify no row was inserted into legacy_party_collision_exceptions
    const check = await pool.query(
      `SELECT COUNT(*) as c FROM legacy_party_collision_exceptions WHERE company_id = $1 AND party_id = 'uuid-rogue-p5'`,
      [COMPANY]
    );
    expect(parseInt(check.rows[0].c, 10)).toBe(0);
  });

  // ----------------------------------------------------------------
  // Test 14: arbitrary third UUID cannot be added to exception group
  // ----------------------------------------------------------------
  it('14. arbitrary third UUID cannot be added to exception group', async () => {
    await seedGrandfatheredPair();

    // Trigger fails if an arbitrary 3rd party tries to claim grandfather status or exceed limit
    await expect(
      pool.query(
        `INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status)
         VALUES ('uuid-arbitrary-third', $1, '2', '2', 'model-body-t', 'ACTIVE')`,
        [COMPANY]
      )
    ).rejects.toThrow(/ACTIVE_PARTY_EXISTS/);
  });

  it('14A. fake exception rows and fake historical claims never grant Party #2 eligibility', async () => {
    await pool.query(
      `INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status)
       VALUES ('uuid-real-party-2', $1, '2', '2', 'model-body-t', 'ACTIVE')`,
      [COMPANY]
    );
    await pool.query(
      `INSERT INTO legacy_party_collision_exceptions (
         exception_id, company_id, party_number, party_id, collision_group_id,
         approved_by, approved_at, reason, status
       ) VALUES ('fake-provenance', $1, '2', 'uuid-fake-claimed-2', 'fake-group', 'fake-operator', NOW(), 'untrusted claim', 'ACTIVE')`,
      [COMPANY]
    );

    const result = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: {
        operations: [makePartyOp('op-fake-claimed-party-2', 'CreateParty', {
          partyRecordId: 'uuid-fake-claimed-2', partyNumber: '2', modelId: 'model-body-t'
        })]
      }
    });
    expect(JSON.parse(result.payload).results[0].error.code).toBe('ACTIVE_PARTY_EXISTS');

    await expect(
      pool.query(
        `INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status)
         VALUES ('uuid-fake-claimed-2-direct', $1, '2', '2', 'model-body-t', 'ACTIVE')`,
        [COMPANY]
      )
    ).rejects.toThrow(/ACTIVE_PARTY_EXISTS/);
  });

  it('14B. the approved exact Party #2 pair cannot be transferred to another company', async () => {
    const otherCompany = 'company_other';
    await pool.query(
      `INSERT INTO models (id, company_id, name, operations_json)
       VALUES ('model-other-a', $1, 'Other A', '[]'), ('model-other-b', $1, 'Other B', '[]')`,
      [otherCompany]
    );
    await pool.query(
      `INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status)
       VALUES ($1, $2, '2', '2', 'model-other-a', 'ACTIVE')`,
      [GRANDFATHERED_A, otherCompany]
    );

    await expect(pool.query(
      `INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status)
       VALUES ($1, $2, '2', '2', 'model-other-b', 'ACTIVE')`,
      [GRANDFATHERED_B, otherCompany]
    )).rejects.toThrow(/ACTIVE_PARTY_EXISTS/);
  });

  // ----------------------------------------------------------------
  // Test 15: another duplicated active number during migration => migration FAIL
  // ----------------------------------------------------------------
  it('15. another duplicated active number during migration => migration FAIL', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-fail-test-'));
    try {
      const novdaDir = path.join(tempDir, 'NovdaData');
      fs.mkdirSync(novdaDir, { recursive: true });
      const jsonPath = path.join(novdaDir, `hisob_database_comp_fail.json`);
      const payload = {
        companyId: 'comp_fail',
        models: [{ id: 'm1', name: 'Model 1' }],
        workers: [],
        submittedTickets: [],
        printedPartyHistory: [
          // Duplicate Party #12 active
          { id: 'rec_p12_a', partyNumber: '12', modelId: 'm1', isClosed: false },
          { id: 'rec_p12_b', partyNumber: '12', modelId: 'm1', isClosed: false }
        ]
      };
      fs.writeFileSync(jsonPath, JSON.stringify(payload));

      const res = migrator.migrateLegacyData(tempDir, 'comp_fail', { explicitSourcePath: jsonPath });
      expect(res.migrationReady).toBe(false);
      expect(res.counts.quarantine).toBe(2);

      const db = databaseManager.getCompanyDatabase(tempDir, 'comp_fail');
      try {
        const quar = db.prepare(`SELECT * FROM migration_quarantine_parties WHERE original_party_number = '12'`).all();
        expect(quar.length).toBe(2);
        expect(quar[0].resolution_status).toBe('PENDING_REVIEW');
        expect(quar[1].resolution_status).toBe('PENDING_REVIEW');
      } finally {
        databaseManager.closeCompanyDatabase('comp_fail');
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ----------------------------------------------------------------
  // Test 16: existing exact Party #2 pair migration => PASS
  // ----------------------------------------------------------------
  it('16. existing exact Party #2 pair migration => PASS', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-pass-test-'));
    try {
      const novdaDir = path.join(tempDir, 'NovdaData');
      fs.mkdirSync(novdaDir, { recursive: true });
      const compTarget = 'comp_novda';
      const jsonPath = path.join(novdaDir, `hisob_database_${compTarget}.json`);
      const payload = {
        companyId: compTarget,
        models: [{ id: 'm1', name: 'Model 1' }],
        workers: [],
        submittedTickets: [],
        printedPartyHistory: [
          { id: GRANDFATHERED_A, partyNumber: '2', modelId: 'm1', isClosed: false, closedAt: null },
          { id: GRANDFATHERED_B, partyNumber: '2', modelId: 'm1', isClosed: false, closedAt: null }
        ]
      };
      fs.writeFileSync(jsonPath, JSON.stringify(payload));

      const partyResolutions = [GRANDFATHERED_A, GRANDFATHERED_B].map((partyId) => ({
        partyId,
        decision: 'GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED',
        operatorId: 'OWNER_BUSINESS_DECISION',
        decidedAt: '2026-10-01T00:00:00.000Z',
        reason: 'Owner-approved exact existing comp_novda Party #2 pair'
      }));
      const res = migrator.migrateLegacyData(tempDir, compTarget, { explicitSourcePath: jsonPath, partyResolutions });
      expect(res.counts.quarantine).toBe(0); // Zero unresolved quarantine!
      expect(res.counts.parties).toBe(2);
      expect(res.migrationReady).toBe(true);

      const db = databaseManager.getCompanyDatabase(tempDir, compTarget);
      try {
        // Both exist in parties table as ACTIVE
        const parties = db.prepare(`SELECT * FROM parties WHERE party_number = '2' ORDER BY id`).all();
        expect(parties.length).toBe(2);
        expect(parties[0].status).toBe('ACTIVE');
        expect(parties[0].is_closed).toBe(0);
        expect(parties[0].closed_at).toBeNull();
        expect(parties[1].status).toBe('ACTIVE');
        expect(parties[1].is_closed).toBe(0);
        expect(parties[1].closed_at).toBeNull();

        // Both recorded in legacy_party_collision_exceptions
        const excs = db.prepare(`SELECT * FROM legacy_party_collision_exceptions WHERE company_id = ?`).all(compTarget);
        expect(excs.length).toBe(2);
        expect(excs.map((e: any) => e.party_id).sort()).toEqual([GRANDFATHERED_A, GRANDFATHERED_B].sort());

        // Both recorded in migration_party_resolutions
        const audits = db.prepare(`SELECT * FROM migration_party_resolutions WHERE company_id = ?`).all(compTarget);
        expect(audits.length).toBe(2);
        expect(audits[0].decision).toBe('GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED');

        // Quarantine entries marked as RESOLVED
        const quarRows = db.prepare(`SELECT * FROM migration_quarantine_parties WHERE company_id = ?`).all(compTarget);
        expect(quarRows.length).toBe(2);
        expect(quarRows.every((q: any) => q.resolution_status === 'RESOLVED')).toBe(true);
      } finally {
        databaseManager.closeCompanyDatabase(compTarget);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ----------------------------------------------------------------
  // Test 17: replay/idempotency unchanged
  // ----------------------------------------------------------------
  it('17. replay/idempotency unchanged', async () => {
    const op = makePartyOp('op-replay-test-p50', 'CreateParty', {
      partyRecordId: 'uuid-p50-replay',
      partyNumber: '50',
      modelId: 'model-body-t'
    });

    const res1 = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [op] }
    });
    const body1 = JSON.parse(res1.payload);
    expect(body1.results[0].status).toBe('APPLIED');
    expect(body1.results[0].isReplay).toBe(false);

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [op] }
    });
    const body2 = JSON.parse(res2.payload);
    expect(body2.results[0].status).toBe('APPLIED');
    expect(body2.results[0].isReplay).toBe(true);
    expect(body2.results[0].serverRevision).toBe(body1.results[0].serverRevision);
  });

  // ----------------------------------------------------------------
  // Test 18: historical tickets remain tied to partyRecordId
  // ----------------------------------------------------------------
  it('18. historical tickets remain tied to partyRecordId', async () => {
    await seedGrandfatheredPair();

    await pool.query(
      `INSERT INTO tickets (id, company_id, model_id, party_number, party_record_id, patta_number, qty, submitted_at)
       VALUES 
         ('00000000-0000-4000-8000-000000000601', $1, 'model-body-t', '2', $2, 1, 50, NOW() - INTERVAL '2 days'),
         ('00000000-0000-4000-8000-000000000602', $1, 'model-alex-prit', '2', $3, 2, 75, NOW() - INTERVAL '1 day')`,
      [COMPANY, GRANDFATHERED_A, GRANDFATHERED_B]
    );

    const ticketsA = await pool.query(
      `SELECT id, qty FROM tickets WHERE company_id = $1 AND party_record_id = $2`,
      [COMPANY, GRANDFATHERED_A]
    );
    expect(ticketsA.rows.length).toBe(1);
    expect(ticketsA.rows[0].id).toBe('00000000-0000-4000-8000-000000000601');
    expect(ticketsA.rows[0].qty).toBe('50');

    const ticketsB = await pool.query(
      `SELECT id, qty FROM tickets WHERE company_id = $1 AND party_record_id = $2`,
      [COMPANY, GRANDFATHERED_B]
    );
    expect(ticketsB.rows.length).toBe(1);
    expect(ticketsB.rows[0].id).toBe('00000000-0000-4000-8000-000000000602');
    expect(ticketsB.rows[0].qty).toBe('75');
  });
});
