import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildFastifyServer } from './app.cjs';
import { getServerPool, resetServerDatabase, closeServerPool } from './infrastructure/db.cjs';
import { canonicalStringify, computePayloadHash } from './modules/sync/canonicalPayload.cjs';

describe('Authoritative Server Concurrency & Safety (Step 4)', () => {
  let app: any;
  let pool: any;

  const COMPANY = 'company-concurrency-test';
  const EXACT_PARTY_TWO_COMPANY = 'comp_novda';
  const TOKEN = `novda-test-token:${COMPANY}:device-concurrent`;

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
  });

  async function seedParty(id: string, partyNumber: string, companyId = COMPANY) {
    await pool.query(
      `INSERT INTO models (id, company_id, name, operations_json)
       VALUES ('m_1', $1, 'Concurrency Model', '[{"name":"Bichish"},{"name":"Tikish"}]')
       ON CONFLICT (company_id, id) DO NOTHING`,
      [companyId]
    );
    await pool.query(
      `INSERT INTO workers (id, company_id, name)
       SELECT generate_series(1, 20), $1, 'Concurrency Worker'
       ON CONFLICT (company_id, id) DO NOTHING`,
      [companyId]
    );
    await pool.query(
      `INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status)
       VALUES ($1, $2, $3, $3, 'm_1', 'ACTIVE')`,
      [id, companyId, partyNumber]
    );
  }

  function partyOperation(operationId: string, commandType: 'CreateParty' | 'CloseParty', payload: any, companyId = COMPANY) {
    const normalizedPayload = commandType === 'CreateParty' && payload.pattaCount === undefined
      ? { ...payload, pattaCount: 1 }
      : payload;
    const canonical = canonicalStringify(normalizedPayload);
    return {
      operationId,
      companyId,
      commandType,
      entityType: 'party',
      entityId: normalizedPayload.partyRecordId,
      payloadHash: computePayloadHash(canonical),
      payload: normalizedPayload
    };
  }

  it('1. concurrent exact duplicate requests produce exactly ONE mutation and identical results', async () => {
    await seedParty('party-concurrent-1', '1');
    const payload = {
      commandId: 'cmd_concurrent_1',
      operationId: 'op_concurrent_dup_1',
      companyId: COMPANY,
      ticketId: '00000000-0000-4000-8000-000000000106',
      modelId: 'm_1',
      partyNumber: '1',
      partyRecordId: 'party-concurrent-1',
      effectiveDate: '2026-09-01',
      pattaNumber: 1,
      qty: 10,
      entries: [{ opName: 'Bichish', workerId: 1, qty: 10 }]
    };
    const pHash = computePayloadHash(canonicalStringify(payload));

    const opDescriptor = {
      operationId: 'op_concurrent_dup_1',
      companyId: COMPANY,
      commandType: 'SubmitTicket',
      entityType: 'ticket',
      entityId: '00000000-0000-4000-8000-000000000106',
      payloadHash: pHash,
      payload
    };

    // Fire 5 simultaneous duplicate requests
    const promises = Array.from({ length: 5 }).map(() =>
      app.inject({
        method: 'POST',
        url: '/api/sync/operations',
        headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
        payload: { operations: [opDescriptor] }
      })
    );

    const responses = await Promise.all(promises);

    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.results[0].status).toBe('APPLIED');
      expect(body.results[0].serverRevision).toBe(1);
    }

    // Exactly 1 ticket fact exists in PostgreSQL
    const ticketRes = await pool.query('SELECT COUNT(*) FROM tickets WHERE company_id = $1', [COMPANY]);
    expect(parseInt(ticketRes.rows[0].count, 10)).toBe(1);

    // Exactly 1 dedup row exists
    const dedupRes = await pool.query('SELECT COUNT(*) FROM operations_dedup WHERE company_id = $1', [COMPANY]);
    expect(parseInt(dedupRes.rows[0].count, 10)).toBe(1);

    // Exactly 1 change_log row exists
    const changeRes = await pool.query('SELECT COUNT(*) FROM change_log WHERE company_id = $1', [COMPANY]);
    expect(parseInt(changeRes.rows[0].count, 10)).toBe(1);
  });

  it('2. concurrent conflicting requests under same operationId produce one winner and IDEMPOTENCY_CONFLICT', async () => {
    const opId = 'op_concurrent_conflict_1';
    await seedParty('party-concurrent-a', '1');
    await seedParty('party-concurrent-b', '2');

    const payloadA = {
      commandId: 'cmd_a',
      operationId: opId,
      companyId: COMPANY,
      ticketId: '00000000-0000-4000-8000-000000000107',
      modelId: 'm_1',
      partyNumber: '1',
      partyRecordId: 'party-concurrent-a',
      effectiveDate: '2026-09-01',
      pattaNumber: 1,
      qty: 10,
      entries: [{ opName: 'Bichish', workerId: 1, qty: 10 }]
    };
    const hashA = computePayloadHash(canonicalStringify(payloadA));

    const payloadB = {
      commandId: 'cmd_b',
      operationId: opId,
      companyId: COMPANY,
      ticketId: '00000000-0000-4000-8000-000000000108',
      modelId: 'm_1',
      partyNumber: '2',
      partyRecordId: 'party-concurrent-b',
      effectiveDate: '2026-09-01',
      pattaNumber: 2,
      qty: 20,
      entries: [{ opName: 'Tikish', workerId: 2, qty: 20 }]
    };
    const hashB = computePayloadHash(canonicalStringify(payloadB));

    // Fire both simultaneously
    const reqA = app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [{ operationId: opId, companyId: COMPANY, commandType: 'SubmitTicket', entityType: 'ticket', entityId: payloadA.ticketId, payloadHash: hashA, payload: payloadA }] }
    });

    const reqB = app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [{ operationId: opId, companyId: COMPANY, commandType: 'SubmitTicket', entityType: 'ticket', entityId: payloadB.ticketId, payloadHash: hashB, payload: payloadB }] }
    });

    const [resA, resB] = await Promise.all([reqA, reqB]);

    const resultA = JSON.parse(resA.payload).results[0];
    const resultB = JSON.parse(resB.payload).results[0];

    const statuses = [resultA.status, resultB.status];
    expect(statuses).toContain('APPLIED');
    expect(statuses).toContain('CONFLICT');

    const conflictResult = resultA.status === 'CONFLICT' ? resultA : resultB;
    expect(conflictResult.error.code).toBe('IDEMPOTENCY_CONFLICT');

    // Exactly 1 ticket fact exists in PostgreSQL
    const ticketRes = await pool.query('SELECT COUNT(*) FROM tickets WHERE company_id = $1', [COMPANY]);
    expect(parseInt(ticketRes.rows[0].count, 10)).toBe(1);
  });

  it('3. concurrent lease requests allocate strictly non-overlapping integer sequence ranges', async () => {
    // 5 concurrent devices request a block of 20 numbers each
    const promises = Array.from({ length: 5 }).map((_, i) =>
      app.inject({
        method: 'POST',
        url: '/api/leases/party',
        headers: {
          authorization: `Bearer novda-test-token:${COMPANY}:device-${i + 1}`,
          'x-client-version': '2.0.0'
        },
        payload: { blockSize: 20 }
      })
    );

    const responses = await Promise.all(promises);

    const ranges: Array<{ start: number; end: number }> = [];
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      const lease = JSON.parse(res.payload).lease;
      ranges.push({ start: lease.rangeStart, end: lease.rangeEnd });
    }

    // Sort by start
    ranges.sort((a, b) => a.start - b.start);

    // Verify each block has size 20 and contiguous, non-overlapping boundaries:
    // [1, 20], [21, 40], [41, 60], [61, 80], [81, 100]
    expect(ranges.length).toBe(5);
    for (let i = 0; i < ranges.length; i++) {
      const expectedStart = i * 20 + 1;
      const expectedEnd = (i + 1) * 20;
      expect(ranges[i].start).toBe(expectedStart);
      expect(ranges[i].end).toBe(expectedEnd);
    }
  });

  it('4. two simultaneous CreateParty requests for same party number: exactly one APPLIED, one ACTIVE_PARTY_EXISTS', async () => {
    await pool.query(
      `INSERT INTO models (id, company_id, name, operations_json) 
       VALUES ('m_concurrent', $1, 'Model Concurrent', '[]') ON CONFLICT DO NOTHING`,
      [COMPANY]
    );

    const partyNum = '5';
    const payloadA = {
      partyRecordId: 'uuid-concurrent-p5-a',
      partyNumber: partyNum,
      modelId: 'm_concurrent',
      pattaCount: 1
    };
    const hashA = computePayloadHash(canonicalStringify(payloadA));

    const payloadB = {
      partyRecordId: 'uuid-concurrent-p5-b',
      partyNumber: partyNum,
      modelId: 'm_concurrent',
      pattaCount: 1
    };
    const hashB = computePayloadHash(canonicalStringify(payloadB));

    const reqA = app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [{ operationId: 'op_concurrent_p5_a', companyId: COMPANY, commandType: 'CreateParty', entityType: 'party', entityId: payloadA.partyRecordId, payloadHash: hashA, payload: payloadA }] }
    });

    const reqB = app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
      payload: { operations: [{ operationId: 'op_concurrent_p5_b', companyId: COMPANY, commandType: 'CreateParty', entityType: 'party', entityId: payloadB.partyRecordId, payloadHash: hashB, payload: payloadB }] }
    });

    const [resA, resB] = await Promise.all([reqA, reqB]);

    const resultA = JSON.parse(resA.payload).results[0];
    const resultB = JSON.parse(resB.payload).results[0];

    const statuses = [resultA.status, resultB.status];
    expect(statuses).toContain('APPLIED');
    expect(statuses).toContain('REJECTED');

    const rejectedResult = resultA.status === 'REJECTED' ? resultA : resultB;
    expect(rejectedResult.error.code).toBe('ACTIVE_PARTY_EXISTS');

    // Exactly 1 active party exists in PostgreSQL
    const dbRes = await pool.query('SELECT id, status FROM parties WHERE company_id = $1 AND party_number = $2', [COMPANY, partyNum]);
    expect(dbRes.rows.length).toBe(1);
    expect(dbRes.rows[0].status).toBe('ACTIVE');
  });

  it('5. two simultaneous third Party #2 creates are both rejected against the exact persisted pair', async () => {
    const token = `novda-test-token:${EXACT_PARTY_TWO_COMPANY}:device-concurrent`;
    await seedParty('rec_1788774889449_vrbkv', '2', EXACT_PARTY_TWO_COMPANY);
    await pool.query(
      `INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status)
       VALUES ('rec_1788930871307_cg1iv', $1, '2', '2', 'm_1', 'ACTIVE')`,
      [EXACT_PARTY_TWO_COMPANY]
    );

    const requests = [
      app.inject({
        method: 'POST', url: '/api/sync/operations',
        headers: { authorization: `Bearer ${token}`, 'x-client-version': '2.0.0' },
        payload: { operations: [partyOperation('op-third-p2-a', 'CreateParty', { partyRecordId: 'third-p2-a', partyNumber: '2', modelId: 'm_1' }, EXACT_PARTY_TWO_COMPANY)] }
      }),
      app.inject({
        method: 'POST', url: '/api/sync/operations',
        headers: { authorization: `Bearer ${token}`, 'x-client-version': '2.0.0' },
        payload: { operations: [partyOperation('op-third-p2-b', 'CreateParty', { partyRecordId: 'third-p2-b', partyNumber: '2', modelId: 'm_1' }, EXACT_PARTY_TWO_COMPANY)] }
      })
    ];

    const results = (await Promise.all(requests)).map((response) => JSON.parse(response.payload).results[0]);
    expect(results.every((result) => result.status === 'REJECTED' && result.error.code === 'ACTIVE_PARTY_EXISTS')).toBe(true);
    const rows = await pool.query(`SELECT id FROM parties WHERE company_id = $1 AND party_number = '2'`, [EXACT_PARTY_TWO_COMPANY]);
    expect(rows.rows.map((row: any) => row.id).sort()).toEqual([
      'rec_1788774889449_vrbkv',
      'rec_1788930871307_cg1iv'
    ].sort());
  });

  it('6. concurrent close/create requests serialize on the same company/number lock', async () => {
    await seedParty('party-close-create-5', '5');

    const [closeResponse, createResponse] = await Promise.all([
      app.inject({
        method: 'POST', url: '/api/sync/operations',
        headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
        payload: { operations: [partyOperation('op-close-create-close', 'CloseParty', { partyRecordId: 'party-close-create-5' })] }
      }),
      app.inject({
        method: 'POST', url: '/api/sync/operations',
        headers: { authorization: `Bearer ${TOKEN}`, 'x-client-version': '2.0.0' },
        payload: { operations: [partyOperation('op-close-create-new', 'CreateParty', { partyRecordId: 'party-close-create-5-new', partyNumber: '5', modelId: 'm_1' })] }
      })
    ]);

    const closeResult = JSON.parse(closeResponse.payload).results[0];
    const createResult = JSON.parse(createResponse.payload).results[0];
    expect(closeResult.status).toBe('APPLIED');
    expect(['APPLIED', 'REJECTED']).toContain(createResult.status);
    if (createResult.status === 'REJECTED') expect(createResult.error.code).toBe('ACTIVE_PARTY_EXISTS');

    const rows = await pool.query(`SELECT id, status FROM parties WHERE company_id = $1 AND party_number = '5' AND status != 'CLOSED'`, [COMPANY]);
    expect(rows.rows.length).toBe(createResult.status === 'APPLIED' ? 1 : 0);
  });

  it('7. both exact historical closes serialize before a normal Party #2 transition', async () => {
    const token = `novda-test-token:${EXACT_PARTY_TWO_COMPANY}:device-concurrent`;
    await seedParty('rec_1788774889449_vrbkv', '2', EXACT_PARTY_TWO_COMPANY);
    await pool.query(
      `INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status)
       VALUES ('rec_1788930871307_cg1iv', $1, '2', '2', 'm_1', 'ACTIVE')`,
      [EXACT_PARTY_TWO_COMPANY]
    );

    const closeResults = await Promise.all([
      app.inject({
        method: 'POST', url: '/api/sync/operations',
        headers: { authorization: `Bearer ${token}`, 'x-client-version': '2.0.0' },
        payload: { operations: [partyOperation('op-close-exact-a', 'CloseParty', { partyRecordId: 'rec_1788774889449_vrbkv' }, EXACT_PARTY_TWO_COMPANY)] }
      }),
      app.inject({
        method: 'POST', url: '/api/sync/operations',
        headers: { authorization: `Bearer ${token}`, 'x-client-version': '2.0.0' },
        payload: { operations: [partyOperation('op-close-exact-b', 'CloseParty', { partyRecordId: 'rec_1788930871307_cg1iv' }, EXACT_PARTY_TWO_COMPANY)] }
      })
    ]);
    expect(closeResults.every((response) => JSON.parse(response.payload).results[0].status === 'APPLIED')).toBe(true);

    const createResponse = await app.inject({
      method: 'POST', url: '/api/sync/operations',
      headers: { authorization: `Bearer ${token}`, 'x-client-version': '2.0.0' },
      payload: { operations: [partyOperation('op-create-after-exact-closes', 'CreateParty', { partyRecordId: 'normal-party-2-after-closes', partyNumber: '2', modelId: 'm_1' }, EXACT_PARTY_TWO_COMPANY)] }
    });
    expect(JSON.parse(createResponse.payload).results[0].status).toBe('APPLIED');

    const rows = await pool.query(`SELECT id, status FROM parties WHERE company_id = $1 AND party_number = '2' AND status != 'CLOSED'`, [EXACT_PARTY_TWO_COMPANY]);
    expect(rows.rows).toEqual([{ id: 'normal-party-2-after-closes', status: 'ACTIVE' }]);
  });
});
