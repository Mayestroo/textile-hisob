import { describe, expect, it } from 'vitest';

const Fastify = require('fastify');
const { createOperationsHandler, processSingleOperation } = require('./handlers/operations.cjs');
const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');

const companyId = 'failure_fixture';
const ticketId = '00000000-0000-4000-8000-000000000404';
const req = { auth: { companyId, deviceId: 'fixture-device' } };
function operation(id: string, overrides: any = {}) {
  const payload = { commandId: `cmd_${id}`, operationId: id, companyId, ticketId };
  return { operationId: id, companyId, commandType: 'DeleteTicket', entityType: 'ticket', entityId: ticketId,
    payload, payloadHash: computePayloadHash(canonicalStringify(payload)), ...overrides };
}
function fault(code?: string) {
  return Object.assign(new Error('private database diagnostics'), code ? { code } : {});
}
function wire(id: string, commandType: string, entityType: string, entityId: string, payload: any, baseRevision?: number) {
  return { operationId: id, companyId, commandType, entityType, entityId, payload, baseRevision,
    payloadHash: computePayloadHash(canonicalStringify(payload)) };
}

// Query double models transactional staging; it is NOT a PostgreSQL durability proof.
function fixture(failure?: (sql: string, id: string | undefined) => Error | undefined) {
  const dedup = new Map<string, any>();
  const changes: string[] = [];
  const releases: any[] = [];
  const queries: string[] = [];
  let mutationCount = 0;
  const pool = {
    connect: async () => {
      let staged: { id?: string; row?: any; changed?: boolean } = {};
      let id: string | undefined;
      return {
        release: (error?: Error) => releases.push(error),
        query: async (sql: string, params: any[] = []) => {
          queries.push(sql.trim());
          if (sql === 'BEGIN') staged = {};
          if (sql.includes('SELECT company_id, operation_id, command_type')) id = params[1];
          const error = failure?.(sql, id);
          if (error) throw error;
          if (sql === 'ROLLBACK') { staged = {}; return { rows: [] }; }
          if (sql === 'COMMIT') {
            if (staged.changed) { changes.push(id!); mutationCount++; }
            if (staged.row) dedup.set(staged.id!, staged.row);
            return { rows: [] };
          }
          if (sql.includes('FROM operations_dedup') && sql.includes('FOR UPDATE')) return { rows: dedup.has(id!) ? [dedup.get(id!)] : [] };
          if (sql.includes('FROM tickets') && sql.includes('FOR UPDATE')) return { rows: [{ id: ticketId, status: 'CONFIRMED', is_closed: 0 }] };
          if (sql.includes('UPDATE tickets SET status')) return { rows: [{ server_revision: 2 }] };
          if (sql.includes('INSERT INTO change_log')) { staged.changed = true; return { rows: [{ change_id: changes.length + 1 }] }; }
          if (sql.includes('INSERT INTO operations_dedup')) {
            staged.id = params[1];
            staged.row = { payload_hash: params[5], command_type: params[2], entity_type: params[3], entity_id: params[4],
              server_revision: params[7], result_json: params[6], accepted_at: params[8] };
          }
          return { rows: [] };
        }
      };
    }
  };
  return { pool, dedup, changes, releases, queries, get mutationCount() { return mutationCount; } };
}
async function inject(pool: any, operations: any[]) {
  const app = Fastify();
  app.decorateRequest('auth', null);
  app.addHook('preHandler', async (request: any) => { request.auth = req.auth; });
  app.post('/api/sync/operations', createOperationsHandler(pool));
  try { return await app.inject({ method: 'POST', url: '/api/sync/operations', payload: { operations } }); }
  finally { await app.close(); }
}

describe('sync operation failure classification (Fastify injection + query doubles)', () => {
  it.each(['40001', '40P01', '55P03', '57014', '08006', '57P01', '53300', '23505', '23503', 'ECONNRESET', undefined])(
    'does not terminally reject execution fault %s', async (code) => {
      const db = fixture((sql) => sql.includes('SELECT pg_advisory_xact_lock') ? fault(code) : undefined);
      const response = await inject(db.pool, [operation('fault')]);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ success: false, error: { code: 'SYNC_RETRY_REQUIRED',
        message: 'Sync could not be confirmed; retry the same operations' } });
      expect(db.queries).toContain('ROLLBACK');
      expect(db.releases).toHaveLength(1);
      expect(db.releases[0]).toBeInstanceOf(Error);
    }
  );

  it.each(['BEGIN', 'INSERT INTO change_log', 'INSERT INTO operations_dedup', 'COMMIT', 'ROLLBACK'])(
    '%s fault cannot produce an APPLIED acknowledgement', async (stage) => {
      const db = fixture((sql) => sql.includes(stage) && (stage !== 'ROLLBACK' || sql === 'ROLLBACK') ? fault() :
        stage === 'ROLLBACK' && sql.includes('INSERT INTO change_log') ? fault('40P01') : undefined);
      const response = await inject(db.pool, [operation('stage')]);
      expect(response.statusCode).toBe(503);
      expect(db.releases).toHaveLength(1);
      expect(db.releases[0]).toBeInstanceOf(Error);
    }
  );

  it('pool acquisition failure returns sanitized 503 without a client', async () => {
    const response = await inject({ connect: async () => { throw fault('ECONNRESET'); } }, [operation('acquire')]);
    expect(response.statusCode).toBe(503);
    expect(response.payload).not.toContain('private database diagnostics');
  });

  it('known envelope, tenant, workbook and semantic/revision decisions retain outcome schema', async () => {
    const db = fixture();
    const invalid = await inject(db.pool, [operation('invalid', { payloadHash: '0'.repeat(64) })]);
    expect(invalid.json().results[0]).toMatchObject({ status: 'REJECTED', error: { code: 'PAYLOAD_HASH_MISMATCH' } });
    const tenant = await inject(db.pool, [operation('tenant', { companyId: 'other' })]);
    expect(tenant.json().results[0]).toMatchObject({ status: 'REJECTED', error: { code: 'COMPANY_SCOPE_MISMATCH' } });
    const applied = await inject(db.pool, [operation('replay')]);
    expect(applied.json().results[0]).toMatchObject({ status: 'APPLIED', isReplay: false });
    expect((await inject(db.pool, [operation('replay')])).json().results[0]).toMatchObject({ status: 'APPLIED', isReplay: true });
    expect(db.mutationCount).toBe(1);
    db.dedup.get('replay').entity_id = 'different';
    expect((await inject(db.pool, [operation('replay')])).json().results[0])
      .toMatchObject({ status: 'CONFLICT', error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(db.releases.every((value) => value === undefined)).toBe(true);
  });

  it('workbook revision conflict and operator reauthentication remain known outcomes', async () => {
    const db = fixture();
    const model = wire('model_revision', 'UpsertModel', 'model', 'model-1', {
      commandId: 'cmd_model_revision', operationId: 'model_revision', companyId, modelId: 'model-1',
      name: 'Fixture', operations: []
    }, 1);
    expect((await inject(db.pool, [model])).json().results[0])
      .toMatchObject({ status: 'CONFLICT', error: { code: 'REVISION_CONFLICT' } });
    const reconciliation = wire('operator', 'ResolveMigrationReconciliationCandidate', 'reconciliation_candidate', 'candidate-1', {
      commandId: 'cmd_operator', operationId: 'operator', companyId, candidateId: 'candidate-1',
      decision: 'DEFER_REVIEW', reason: 'Review later'
    });
    expect((await inject(db.pool, [reconciliation])).json().results[0])
      .toMatchObject({ status: 'REJECTED', error: { code: 'RECONCILIATION_RBAC_BLOCKED' } });
  });

  it('mixed batch stops after B and retries exact A/B/C with A replayed', async () => {
    let failB = true;
    const db = fixture((sql, id) => failB && id === 'B' && sql.includes('INSERT INTO change_log') ? fault('40P01') : undefined);
    const ops = ['A', 'B', 'C'].map(operation);
    expect((await inject(db.pool, ops)).statusCode).toBe(503);
    expect(db.changes).toEqual(['A']);
    failB = false;
    const response = await inject(db.pool, ops);
    expect(response.json().results.map((result: any) => result.isReplay)).toEqual([true, false, false]);
    expect(db.changes).toEqual(['A', 'B', 'C']);
  });

  it.each([false, true])('ambiguous COMMIT success=%s replays the same identity once', async (committed) => {
    let fail = true;
    const db = fixture();
    const wrapped = { connect: async () => {
      const client = await db.pool.connect();
      const query = client.query;
      client.query = async (sql: string, params?: any[]) => {
        if (sql === 'COMMIT' && fail) {
          if (committed) await query(sql, params);
          throw fault('ECONNRESET');
        }
        return query(sql, params);
      };
      return client;
    } };
    expect((await inject(wrapped, [operation('ambiguous')])).statusCode).toBe(503);
    fail = false;
    const response = await inject(wrapped, [operation('ambiguous')]);
    expect(response.json().results[0]).toMatchObject({ status: 'APPLIED', isReplay: committed });
    expect(db.mutationCount).toBe(1);
    expect(db.dedup.size).toBe(1);
    expect(db.releases[0]).toBeInstanceOf(Error);
  });

  it('COMMIT failure on dedup replay remains retryable', async () => {
    let fail = false;
    const db = fixture((sql) => fail && sql === 'COMMIT' ? fault('40001') : undefined);
    await inject(db.pool, [operation('replay_commit')]);
    fail = true;
    expect((await inject(db.pool, [operation('replay_commit')])).statusCode).toBe(503);
    expect(db.mutationCount).toBe(1);
  });
});
