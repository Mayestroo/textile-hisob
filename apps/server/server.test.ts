import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { buildFastifyServer } from './app.cjs';
import { getServerPool, initServerDatabase, resetServerDatabase, closeServerPool } from './infrastructure/db.cjs';
import { canonicalStringify, computePayloadHash } from './modules/sync/canonicalPayload.cjs';
const { hashToken } = require('./auth/auth.cjs');
const { verifyFreshPostgres16TestEnvironment } = require('../../scripts/verify/verify-pg16-test-env.cjs');
const { startServer } = require('./serve.cjs');
const { canonicalActivationPayload } = require('./modules/activation/licenseActivation.cjs');
const { hashWorkerPin } = require('./modules/workers/workerService.cjs');
const { signableWorkerRequest } = require('./modules/workers/workerRoutes.cjs');

const activationSigner = crypto.generateKeyPairSync('ed25519');
const activationPublicKey = activationSigner.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const activationPrivateKey = activationSigner.privateKey;

function signActivation(payload: Record<string, unknown>) {
  return {
    payload,
    signature: crypto.sign(null, Buffer.from(canonicalActivationPayload(payload)), activationPrivateKey).toString('base64')
  };
}

describe('Server startup and package boundaries', () => {
  it('uses the authoritative entrypoint for server commands', () => {
    const packageJson = require('../../package.json');

    expect(packageJson.scripts.server).toBe('node apps/server/serve.cjs');
  });

  it('initializes the database before listening', async () => {
    const events: string[] = [];
    const pool = { query: async () => ({ rows: [] }) };
    const app = {
      listen: async () => {
        events.push('listen');
        return 'http://127.0.0.1:3474';
      }
    };

    const result = await startServer({
      env: { NODE_ENV: 'test', NOVDA_PG_URL: 'postgresql://test@localhost/test' },
      host: '127.0.0.1',
      port: 3474,
      createPool: () => {
        events.push('pool');
        return pool;
      },
      buildServer: (options: { pool: unknown }) => {
        events.push('build');
        expect(options.pool).toBe(pool);
        return app;
      },
      initializeDatabase: async (options: { pool: unknown; databaseUrl: string }) => {
        events.push('init');
        expect(options.pool).toBe(pool);
        expect(options.databaseUrl).toBe('postgresql://test@localhost/test');
      }
    });

    expect(events).toEqual(['pool', 'build', 'init', 'listen']);
    expect(result.address).toBe('http://127.0.0.1:3474');
  });

  it('rejects startup when database initialization fails before listening', async () => {
    const events: string[] = [];
    const pool = { query: async () => ({ rows: [] }) };
    const app = {
      listen: async () => {
        events.push('listen');
        return 'http://127.0.0.1:3474';
      }
    };

    await expect(startServer({
      env: { NODE_ENV: 'test', NOVDA_PG_URL: 'postgresql://test@localhost/test' },
      createPool: () => {
        events.push('pool');
        return pool;
      },
      buildServer: () => {
        events.push('build');
        return app;
      },
      initializeDatabase: async () => {
        events.push('init');
        throw new Error('DATABASE_INIT_FAILED');
      }
    })).rejects.toThrow('DATABASE_INIT_FAILED');

    expect(events).toEqual(['pool', 'build', 'init']);
  });

  it('verifies a pre-migrated production schema read-only before listening', async () => {
    const queries: string[] = [];
    const events: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }
    };
    const app = {
      listen: async () => {
        events.push('listen');
        return 'http://127.0.0.1:3474';
      }
    };

    await expect(startServer({
      env: { NODE_ENV: 'production', DATABASE_URL: 'postgresql://novda_app@db/novda_prod' },
      createPool: () => pool,
      buildServer: () => app
    })).rejects.toMatchObject({ code: 'POSTGRES_RELEASE_INTEGRITY_FAILED' });

    expect(queries.some((sql) => sql.includes('FROM schema_migrations'))).toBe(true);
    expect(queries.some((sql) => /CREATE\s+TABLE/i.test(sql))).toBe(false);
    expect(events).not.toContain('listen');
  });

  it('revalidates the requested DSN before reusing the server pool', async () => {
    const testDsn = 'postgresql://test@localhost/test';
    const productionDsn = 'postgresql://prod@db/novda';
    getServerPool({ env: { NODE_ENV: 'test', NOVDA_PG_URL: testDsn } });

    try {
      expect(() => getServerPool({ env: { NODE_ENV: 'production' } })).toThrowError(
        expect.objectContaining({ code: 'DATABASE_URL_REQUIRED' })
      );
      expect(() => getServerPool({ databaseUrl: productionDsn })).toThrowError(
        expect.objectContaining({ code: 'DATABASE_POOL_CONFIGURATION_MISMATCH' })
      );
    } finally {
      await closeServerPool();
    }
  });

  it('fails direct startup before creating a pool when both DSN variables are absent', () => {
    const env = { ...process.env, NODE_ENV: 'production' };
    delete env.DATABASE_URL;
    delete env.NOVDA_PG_URL;

    const result = spawnSync(process.execPath, [path.join(__dirname, 'serve.cjs')], {
      env,
      encoding: 'utf8'
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout || ''}${result.stderr || ''}`).toContain('DATABASE_URL_REQUIRED');
  });

  it('rejects request bodies above the active 64 KiB Fastify limit', async () => {
    const app = buildFastifyServer({
      pool: { query: async () => ({ rows: [] }) } as any,
      allowTestTokens: true
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sync/operations',
        headers: {
          authorization: 'Bearer novda-test-token:company-body-limit:device-body-limit',
          'x-client-version': '2.0.0'
        },
        payload: {
          operations: [{
            operationId: 'operation-body-limit',
            companyId: 'company-body-limit',
            commandType: 'SubmitTicket',
            entityType: 'ticket',
            entityId: '00000000-0000-4000-8000-000000000599',
            payloadHash: 'a'.repeat(64),
            payload: { blob: 'x'.repeat(70 * 1024) }
          }]
        }
      });
      expect(res.statusCode).toBe(413);
    } finally {
      await app.close();
    }
  });

  it('keeps business mutation routes behind the production kill switch', async () => {
    let poolConnections = 0;
    const app = buildFastifyServer({
      pool: {
        query: async () => ({ rows: [] }),
        connect: async () => { poolConnections += 1; throw new Error('Mutation handler must not run'); }
      } as any,
      allowTestTokens: true,
      businessMutationsEnabled: false
    });
    await app.ready();
    try {
      const headers = {
        authorization: 'Bearer novda-test-token:company-kill-switch:device-kill-switch',
        'x-client-version': '2.0.0'
      };
      const operations = await app.inject({
        method: 'POST', url: '/api/sync/operations', headers, payload: { operations: [] }
      });
      const worker = await app.inject({
        method: 'POST', url: '/api/workers', headers,
        payload: { operationId: crypto.randomUUID(), name: 'Must not be created' }
      });
      const lease = await app.inject({
        method: 'POST', url: '/api/leases/party', headers, payload: { blockSize: 1 }
      });
      const activationHealth = await app.inject({ method: 'GET', url: '/api/health' });
      const genericHealth = await app.inject({ method: 'GET', url: '/health' });

      for (const response of [operations, worker, lease]) {
        expect(response.statusCode).toBe(503);
        expect(response.json().error.code).toBe('BUSINESS_MUTATIONS_DISABLED');
      }
      expect(activationHealth.statusCode).toBe(200);
      expect(genericHealth.statusCode).toBe(200);
      expect(poolConnections).toBe(0);
    } finally {
      await app.close();
    }
  });
});

const describePostgresIntegration = process.env.NOVDA_DISPOSABLE_PG === '1'
  && Boolean(process.env.NOVDA_PG_URL)
  && !process.env.DATABASE_URL
  ? describe
  : describe.skip;

describePostgresIntegration('Authoritative Server Sync & PostgreSQL Integration (Step 4)', () => {
  let app: any;
  let pool: any;

  const COMPANY_A = 'company-test-alpha';
  const COMPANY_B = 'company-test-beta';
  const DEVICE_A = 'device-alpha-1';
  const DEVICE_B = 'device-beta-1';
  const TOKEN_A = `novda-test-token:${COMPANY_A}:${DEVICE_A}`;
  const TOKEN_B = `novda-test-token:${COMPANY_B}:${DEVICE_B}`;

  beforeAll(async () => {
    if (process.env.NOVDA_DISPOSABLE_PG !== '1' || !process.env.NOVDA_PG_URL || process.env.DATABASE_URL) {
      throw new Error('DISPOSABLE_POSTGRES_REQUIRED: use only NOVDA_PG_URL with NOVDA_DISPOSABLE_PG=1');
    }
    await verifyFreshPostgres16TestEnvironment(process.env.NOVDA_PG_URL);
    pool = getServerPool();
    await resetServerDatabase();
    app = buildFastifyServer({
      pool,
      allowTestTokens: true,
      adminApiToken: 'activation-admin-service-test-token',
      allowedAdminIds: new Set(['12345678']),
      licensePublicKey: activationPublicKey,
      workerApiToken: 'worker-service-test-token',
      workerAuthHmacSecret: 'worker-web-test-hmac-secret'
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeServerPool();
  });

  beforeEach(async () => {
    await resetServerDatabase();
    await pool.query(`
      INSERT INTO models (id, company_id, name, operations_json)
      VALUES
        ('m_1', $1, 'Fixture Model', '[{"name":"Bichish"},{"name":"Tikish"},{"name":"Dazmol"}]'),
        ('m_alpha', $1, 'Alpha Model', '[{"name":"Bichish"},{"name":"Tikish"},{"name":"Dazmol"}]')
      ON CONFLICT (company_id, id) DO NOTHING`, [COMPANY_A]);
    await pool.query(`
      INSERT INTO models (id, company_id, name, operations_json)
      VALUES ('m_1', $1, 'Fixture Model', '[{"name":"Bichish"},{"name":"Tikish"},{"name":"Dazmol"}]')
      ON CONFLICT (company_id, id) DO NOTHING`, [COMPANY_B]);
    await pool.query(`
      INSERT INTO workers (id, company_id, name)
      SELECT generate_series(1, 20), $1, 'Fixture Worker'
      ON CONFLICT (company_id, id) DO NOTHING`, [COMPANY_A]);
    await pool.query(`
      INSERT INTO workers (id, company_id, name)
      SELECT generate_series(1, 20), $1, 'Fixture Worker'
      ON CONFLICT (company_id, id) DO NOTHING`, [COMPANY_B]);
  });

  async function seedParty(companyId: string, id: string, partyNumber: string, modelId = 'm_1') {
    await pool.query(
      `INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status)
       VALUES ($1, $2, $3, $3, $4, 'ACTIVE')`,
      [id, companyId, partyNumber, modelId]
    );
  }

  async function applyActivationMigration() {
    const migrationSql = fs.readFileSync(path.join(__dirname, 'database', 'migrations', 'deploy_activation_migration.sql'), 'utf8');
    await pool.query(migrationSql);
  }

  async function createActivationRequest(machineId = 'A588-F0E4-DE9A-59A2') {
    const requestId = crypto.randomUUID();
    const requestToken = crypto.randomBytes(32).toString('hex');
    const response = await app.inject({
      method: 'POST',
      url: '/api/activation/requests',
      payload: { requestId, requestToken, machineId, context: { appVersion: '1.7.7', platform: 'win32' } }
    });
    expect(response.statusCode).toBe(201);
    return { requestId, requestToken, machineId };
  }

  async function createActivationCompany(companyId = 'company-activation-test') {
    await pool.query(`INSERT INTO company_batch_settings (company_id)
      VALUES ($1) ON CONFLICT (company_id) DO NOTHING`, [companyId]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/activation/companies',
      headers: { 'x-novda-admin-token': 'activation-admin-service-test-token' },
      payload: { adminTelegramId: '12345678', companyId, companyName: 'Activation Test Company' }
    });
    expect(response.statusCode).toBe(201);
    return JSON.parse(response.payload).company;
  }

  // ----------------------------------------------------------------
  // 1-4: Authentication, Version Fencing, and Tenant Isolation
  // ----------------------------------------------------------------
  it('1. rejects unauthenticated requests with 401 AUTH_REQUIRED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      payload: { operations: [] }
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('AUTH_REQUIRED');
  });

  it('2. rejects requests with client version below  fence with 426 CLIENT_VERSION_TOO_OLD', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'x-client-version': '1.7.4'
      },
      payload: { operations: [] }
    });
    expect(res.statusCode).toBe(426);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('CLIENT_VERSION_TOO_OLD');
  });

  it('3. accepts authenticated requests with valid version and token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sync/changes',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'x-client-version': '2.0.0'
      }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.items).toEqual([]);
  });

  it('4. fails closed with 403 COMPANY_SCOPE_MISMATCH on cross-company token claim', async () => {
    const payload = {
      commandId: 'cmd_1',
      operationId: 'op_cross_comp_1',
      companyId: COMPANY_B, // Mismatched! Token is for COMPANY_A
      ticketId: 't_cross_1',
      modelId: 'm_1',
      partyNumber: '1',
      pattaNumber: 1,
      qty: 10,
      entries: [{ opName: 'Bichish', workerId: 1, qty: 10 }]
    };
    const pJson = canonicalStringify(payload);
    const pHash = computePayloadHash(pJson);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: {
        authorization: `Bearer ${TOKEN_A}`, // Authenticated as COMPANY_A
        'x-client-version': '2.0.0'
      },
      payload: {
        operations: [
          {
            operationId: 'op_cross_comp_1',
            companyId: COMPANY_B,
            commandType: 'SubmitTicket',
            entityType: 'ticket',
            entityId: 't_cross_1',
            payloadHash: pHash,
            payload
          }
        ]
      }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.results[0].status).toBe('REJECTED');
    expect(body.results[0].error.code).toBe('COMPANY_SCOPE_MISMATCH');
  });

  // ----------------------------------------------------------------
  // 5-6: Server Payload Fingerprint Recomputation & Validation
  // ----------------------------------------------------------------
  it('5. rejects operation when supplied payload_hash does not match server computed hash', async () => {
    const payload = {
      commandId: 'cmd_2',
      operationId: 'op_bad_hash',
      companyId: COMPANY_A,
      ticketId: 't_bad_hash',
      modelId: 'm_1',
      partyNumber: '1',
      pattaNumber: 1,
      qty: 15,
      entries: [{ opName: 'Tikish', workerId: 2, qty: 15 }]
    };
    const wrongHash = '0000000000000000000000000000000000000000000000000000000000000000';

    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'x-client-version': '2.0.0'
      },
      payload: {
        operations: [
          {
            operationId: 'op_bad_hash',
            companyId: COMPANY_A,
            commandType: 'SubmitTicket',
            entityType: 'ticket',
            entityId: 't_bad_hash',
            payloadHash: wrongHash,
            payload
          }
        ]
      }
    });

    const body = JSON.parse(res.payload);
    expect(body.results[0].status).toBe('REJECTED');
    expect(body.results[0].error.code).toBe('PAYLOAD_HASH_MISMATCH');
  });

  // ----------------------------------------------------------------
  // 7-9: First Commit, Replay Idempotency, and Idempotency Conflict
  // ----------------------------------------------------------------
  it('6. first operation commits, and exact replay returns prior result without duplicate mutation', async () => {
    await seedParty(COMPANY_A, 'party-ticket-100', '5', 'm_alpha');
    const payload = {
      commandId: 'cmd_ticket_100',
      operationId: 'op_ticket_100',
      companyId: COMPANY_A,
      ticketId: '00000000-0000-4000-8000-000000000100',
      modelId: 'm_alpha',
      partyNumber: '5',
      partyRecordId: 'party-ticket-100',
      effectiveDate: '2026-09-01',
      pattaNumber: 1,
      qty: 25,
      entries: [{ opName: 'Dazmol', workerId: 3, qty: 25 }]
    };
    const pJson = canonicalStringify(payload);
    const pHash = computePayloadHash(pJson);

    const opDescriptor = {
      operationId: 'op_ticket_100',
      companyId: COMPANY_A,
      commandType: 'SubmitTicket',
      entityType: 'ticket',
      entityId: '00000000-0000-4000-8000-000000000100',
      payloadHash: pHash,
      payload
    };

    // First submission
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-client-version': '2.0.0' },
      payload: { operations: [opDescriptor] }
    });
    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.payload);
    expect(body1.results[0].status).toBe('APPLIED');
    expect(body1.results[0].isReplay).toBe(false);
    expect(body1.results[0].serverRevision).toBe(1);
    const cursor1 = body1.results[0].cursor;

    // Verify exactly 1 ticket in PostgreSQL
    const ticketCount1 = await pool.query('SELECT COUNT(*) FROM tickets WHERE company_id = $1', [COMPANY_A]);
    expect(parseInt(ticketCount1.rows[0].count, 10)).toBe(1);

    // Verify exactly 1 change log entry
    const clCount1 = await pool.query('SELECT COUNT(*) FROM change_log WHERE company_id = $1', [COMPANY_A]);
    expect(parseInt(clCount1.rows[0].count, 10)).toBe(1);

    // Replay with identical payload and operationId
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-client-version': '2.0.0' },
      payload: { operations: [opDescriptor] }
    });
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.payload);
    expect(body2.results[0].status).toBe('APPLIED');
    expect(body2.results[0].isReplay).toBe(true);
    expect(body2.results[0].serverRevision).toBe(1);
    expect(body2.results[0].cursor).toBe(cursor1);

    // Still exactly 1 ticket and 1 change log entry (zero duplicate mutations)
    const ticketCount2 = await pool.query('SELECT COUNT(*) FROM tickets WHERE company_id = $1', [COMPANY_A]);
    expect(parseInt(ticketCount2.rows[0].count, 10)).toBe(1);

    const clCount2 = await pool.query('SELECT COUNT(*) FROM change_log WHERE company_id = $1', [COMPANY_A]);
    expect(parseInt(clCount2.rows[0].count, 10)).toBe(1);
  });

  it('7. rejects second request with same operationId but different payload with IDEMPOTENCY_CONFLICT', async () => {
    await seedParty(COMPANY_A, 'party-ticket-101', '1');
    const payloadA = {
      commandId: 'cmd_101',
      operationId: 'op_conflict_101',
      companyId: COMPANY_A,
      ticketId: '00000000-0000-4000-8000-000000000101',
      modelId: 'm_1',
      partyNumber: '1',
      partyRecordId: 'party-ticket-101',
      effectiveDate: '2026-09-01',
      pattaNumber: 1,
      qty: 20,
      entries: [{ opName: 'Tikish', workerId: 1, qty: 20 }]
    };
    const hashA = computePayloadHash(canonicalStringify(payloadA));

    // First submission
    await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-client-version': '2.0.0' },
      payload: {
        operations: [
          {
            operationId: 'op_conflict_101',
            companyId: COMPANY_A,
            commandType: 'SubmitTicket',
            entityType: 'ticket',
            entityId: '00000000-0000-4000-8000-000000000101',
            payloadHash: hashA,
            payload: payloadA
          }
        ]
      }
    });

    // Second submission with modified payload (e.g. qty: 30) but same operationId
    const payloadB = { ...payloadA, qty: 30 };
    const hashB = computePayloadHash(canonicalStringify(payloadB));

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-client-version': '2.0.0' },
      payload: {
        operations: [
          {
            operationId: 'op_conflict_101',
            companyId: COMPANY_A,
            commandType: 'SubmitTicket',
            entityType: 'ticket',
            entityId: '00000000-0000-4000-8000-000000000101',
            payloadHash: hashB,
            payload: payloadB
          }
        ]
      }
    });

    const body2 = JSON.parse(res2.payload);
    expect(body2.results[0].status).toBe('CONFLICT');
    expect(body2.results[0].error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  // ----------------------------------------------------------------
  // 8: Transaction Atomicity & Failure Rollback
  // ----------------------------------------------------------------
  it('8. verifies atomicity of mutation + dedup + change log in ONE PostgreSQL transaction', async () => {
    const payload = {
      commandId: 'cmd_adj_1',
      operationId: 'op_adj_1',
      companyId: COMPANY_A,
      adjustmentId: 'adj_1',
      modelId: 'm_1',
      workerId: 10,
      opName: 'Tikish',
      deltaQty: 5,
      reason: 'Quality bonus'
      , effectiveDate: '2026-09-01'
    };
    const pHash = computePayloadHash(canonicalStringify(payload));

    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-client-version': '2.0.0' },
      payload: {
        operations: [
          {
            operationId: 'op_adj_1',
            companyId: COMPANY_A,
            commandType: 'RecordProductionAdjustment',
            entityType: 'production_adjustment',
            entityId: 'adj_1',
            payloadHash: pHash,
            payload
          }
        ]
      }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.results[0].status).toBe('APPLIED');

    // Verify all 3 rows committed together
    const fact = await pool.query('SELECT * FROM production_adjustments WHERE adjustment_id = $1', ['adj_1']);
    const dedup = await pool.query('SELECT * FROM operations_dedup WHERE operation_id = $1', ['op_adj_1']);
    const change = await pool.query('SELECT * FROM change_log WHERE operation_id = $1', ['op_adj_1']);

    expect(fact.rows.length).toBe(1);
    expect(dedup.rows.length).toBe(1);
    expect(change.rows.length).toBe(1);
    expect(fact.rows[0].server_revision).toBe(1);
  });

  it('9. injected failure before commit rolls back all mutations completely (0 fact, 0 dedup, 0 changelog)', async () => {
    const { processSingleOperation } = require('./modules/sync/handlers/operations.cjs');
    await seedParty(COMPANY_A, 'party-ticket-fail', '9');
    const payload = {
      commandId: 'cmd_fail_1',
      operationId: 'op_fail_1',
      companyId: COMPANY_A,
      ticketId: '00000000-0000-4000-8000-000000000102',
      modelId: 'm_1',
      partyNumber: '9',
      partyRecordId: 'party-ticket-fail',
      effectiveDate: '2026-09-01',
      pattaNumber: 1,
      qty: 10,
      entries: [{ opName: 'Bichish', workerId: 1, qty: 10 }]
    };
    const pHash = computePayloadHash(canonicalStringify(payload));

    const mockReq = {
      auth: { companyId: COMPANY_A, deviceId: DEVICE_A }
    };

    const opDescriptor = {
      operationId: 'op_fail_1',
      companyId: COMPANY_A,
      commandType: 'SubmitTicket',
      entityType: 'ticket',
      entityId: '00000000-0000-4000-8000-000000000102',
      payloadHash: pHash,
      payload
    };

    // Process with an injected error right before COMMIT
    const result = await processSingleOperation(pool, mockReq, opDescriptor, {
      testHookBeforeCommit: async () => {
        throw new Error('INJECTED_DATABASE_DISK_CRASH');
      }
    });

    expect(result.status).toBe('REJECTED');
    expect(result.error.message).toContain('INJECTED_DATABASE_DISK_CRASH');

    // Verify rollback: 0 ticket rows, 0 dedup rows, 0 change log rows
    const ticketCheck = await pool.query('SELECT * FROM tickets WHERE id = $1', ['00000000-0000-4000-8000-000000000102']);
    const dedupCheck = await pool.query('SELECT * FROM operations_dedup WHERE operation_id = $1', ['op_fail_1']);
    const changeCheck = await pool.query('SELECT * FROM change_log WHERE operation_id = $1', ['op_fail_1']);

    expect(ticketCheck.rows.length).toBe(0);
    expect(dedupCheck.rows.length).toBe(0);
    expect(changeCheck.rows.length).toBe(0);
  });

  // ----------------------------------------------------------------
  // 10: CAS & Revision Control
  // ----------------------------------------------------------------
  it('10. verifies monotonic CAS on ReverseProductionAdjustment: accepts on baseRevision match, rejects on mismatch', async () => {
    // 1. Record initial adjustment
    const adjPayload = {
      commandId: 'cmd_adj_cas',
      operationId: 'op_adj_cas',
      companyId: COMPANY_A,
      adjustmentId: 'adj_cas_1',
      modelId: 'm_1',
      workerId: 1,
      opName: 'Tikish',
      deltaQty: 10,
      reason: 'Initial bonus'
      , effectiveDate: '2026-09-01'
    };
    await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-client-version': '2.0.0' },
      payload: {
        operations: [
          {
            operationId: 'op_adj_cas',
            companyId: COMPANY_A,
            commandType: 'RecordProductionAdjustment',
            entityType: 'production_adjustment',
            entityId: 'adj_cas_1',
            payloadHash: computePayloadHash(canonicalStringify(adjPayload)),
            payload: adjPayload
          }
        ]
      }
    });

    // Current revision on server is 1.
    // Try reversing with wrong baseRevision = 99 -> must reject with REVISION_CONFLICT
    const wrongRevPayload = {
      commandId: 'cmd_rev_wrong',
      operationId: 'op_rev_wrong',
      companyId: COMPANY_A,
      reversalId: 'rev_1',
      originalAdjustmentId: 'adj_cas_1',
      baseRevision: 99,
      reason: 'Reversal'
      , effectiveDate: '2026-09-01'
    };
    const resWrong = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-client-version': '2.0.0' },
      payload: {
        operations: [
          {
            operationId: 'op_rev_wrong',
            companyId: COMPANY_A,
            commandType: 'ReverseProductionAdjustment',
            entityType: 'production_adjustment',
            entityId: 'rev_1',
            payloadHash: computePayloadHash(canonicalStringify(wrongRevPayload)),
            payload: wrongRevPayload
          }
        ]
      }
    });
    const bodyWrong = JSON.parse(resWrong.payload);
    expect(bodyWrong.results[0].status).toBe('CONFLICT');
    expect(bodyWrong.results[0].error.code).toBe('REVISION_CONFLICT');

    // Now reverse with correct baseRevision = 1 -> must succeed and advance revision to 2
    const correctRevPayload = {
      commandId: 'cmd_rev_ok',
      operationId: 'op_rev_ok',
      companyId: COMPANY_A,
      reversalId: 'rev_ok_1',
      originalAdjustmentId: 'adj_cas_1',
      baseRevision: 1,
      reason: 'Reversal'
      , effectiveDate: '2026-09-01'
    };
    const resOk = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-client-version': '2.0.0' },
      payload: {
        operations: [
          {
            operationId: 'op_rev_ok',
            companyId: COMPANY_A,
            commandType: 'ReverseProductionAdjustment',
            entityType: 'production_adjustment',
            entityId: 'rev_ok_1',
            payloadHash: computePayloadHash(canonicalStringify(correctRevPayload)),
            payload: correctRevPayload
          }
        ]
      }
    });
    const bodyOk = JSON.parse(resOk.payload);
    expect(bodyOk.results[0].status).toBe('APPLIED');
    expect(bodyOk.results[0].serverRevision).toBe(2);

    const origCheck = await pool.query('SELECT status, server_revision FROM production_adjustments WHERE adjustment_id = $1', ['adj_cas_1']);
    expect(origCheck.rows[0].status).toBe('REVERSED');
    expect(origCheck.rows[0].server_revision).toBe(2);
  });

  // ----------------------------------------------------------------
  // 11-13: Change Feed, Cursor Monotonicity, and Multi-Tenant Gaps
  // ----------------------------------------------------------------
  it('11. multi-company interleaved changes do not skip tenant changes', async () => {
    await seedParty(COMPANY_A, 'party-a-1', '1');
    await seedParty(COMPANY_B, 'party-b-1', '1');
    // Submit for Company A (change 1)
    const pA1 = {
      commandId: 'cmd_a1',
      operationId: 'op_a1',
      companyId: COMPANY_A,
      ticketId: '00000000-0000-4000-8000-000000000103',
      modelId: 'm_1',
      partyNumber: '1',
      partyRecordId: 'party-a-1',
      effectiveDate: '2026-09-01',
      pattaNumber: 1,
      qty: 10,
      entries: [{ opName: 'Bichish', workerId: 1, qty: 10 }]
    };
    await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-client-version': '2.0.0' },
      payload: { operations: [{ operationId: 'op_a1', companyId: COMPANY_A, commandType: 'SubmitTicket', entityType: 'ticket', entityId: pA1.ticketId, payloadHash: computePayloadHash(canonicalStringify(pA1)), payload: pA1 }] }
    });

    // Submit for Company B (change 2 - interleaves global BIGSERIAL)
    const pB1 = {
      commandId: 'cmd_b1',
      operationId: 'op_b1',
      companyId: COMPANY_B,
      ticketId: '00000000-0000-4000-8000-000000000104',
      modelId: 'm_1',
      partyNumber: '1',
      partyRecordId: 'party-b-1',
      effectiveDate: '2026-09-01',
      pattaNumber: 1,
      qty: 20,
      entries: [{ opName: 'Bichish', workerId: 1, qty: 20 }]
    };
    await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN_B}`, 'x-client-version': '2.0.0' },
      payload: { operations: [{ operationId: 'op_b1', companyId: COMPANY_B, commandType: 'SubmitTicket', entityType: 'ticket', entityId: pB1.ticketId, payloadHash: computePayloadHash(canonicalStringify(pB1)), payload: pB1 }] }
    });

    // Submit for Company A (change 3)
    const pA2 = {
      commandId: 'cmd_a2',
      operationId: 'op_a2',
      companyId: COMPANY_A,
      ticketId: '00000000-0000-4000-8000-000000000105',
      modelId: 'm_1',
      partyNumber: '1',
      partyRecordId: 'party-a-1',
      effectiveDate: '2026-09-01',
      pattaNumber: 2,
      qty: 15,
      entries: [{ opName: 'Tikish', workerId: 2, qty: 15 }]
    };
    await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-client-version': '2.0.0' },
      payload: { operations: [{ operationId: 'op_a2', companyId: COMPANY_A, commandType: 'SubmitTicket', entityType: 'ticket', entityId: pA2.ticketId, payloadHash: computePayloadHash(canonicalStringify(pA2)), payload: pA2 }] }
    });

    // Pull changes for Company A from cursor 0
    const pullA = await app.inject({
      method: 'GET',
      url: '/api/sync/changes?cursor=0',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-client-version': '2.0.0' }
    });
    const bodyA = JSON.parse(pullA.payload);
    expect(bodyA.items.length).toBe(2);
    expect(bodyA.items[0].entityId).toBe('00000000-0000-4000-8000-000000000103');
    expect(bodyA.items[1].entityId).toBe('00000000-0000-4000-8000-000000000105');
    expect(bodyA.items.every((i: any) => i.companyId === COMPANY_A)).toBe(true);

    // Pull changes for Company B from cursor 0
    const pullB = await app.inject({
      method: 'GET',
      url: '/api/sync/changes?cursor=0',
      headers: { authorization: `Bearer ${TOKEN_B}`, 'x-client-version': '2.0.0' }
    });
    const bodyB = JSON.parse(pullB.payload);
    expect(bodyB.items.length).toBe(1);
    expect(bodyB.items[0].entityId).toBe('00000000-0000-4000-8000-000000000104');
    expect(bodyB.items[0].companyId).toBe(COMPANY_B);
  });

  // ----------------------------------------------------------------
  // 14-17: Party Sequence Leases
  // ----------------------------------------------------------------
  it('14. party lease allocates non-overlapping ranges using server clock', async () => {
    // Acquire lease 1 (block of 50)
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/leases/party',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-client-version': '2.0.0' },
      payload: { blockSize: 50 }
    });
    expect(res1.statusCode).toBe(200);
    const lease1 = JSON.parse(res1.payload).lease;
    expect(lease1.rangeStart).toBe(1);
    expect(lease1.rangeEnd).toBe(50);
    expect(lease1.status).toBe('ACTIVE');
    expect(new Date(lease1.issuedAtServer).getTime()).toBeGreaterThan(0);

    // Acquire lease 2 (block of 50)
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/leases/party',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-client-version': '2.0.0' },
      payload: { blockSize: 50 }
    });
    expect(res2.statusCode).toBe(200);
    const lease2 = JSON.parse(res2.payload).lease;
    expect(lease2.rangeStart).toBe(51);
    expect(lease2.rangeEnd).toBe(100);
  });

  it('15. lease revocation retires remainder; revoked range is NEVER recycled to another lease', async () => {
    // Acquire lease (1 to 50)
    const resAcq = await app.inject({
      method: 'POST',
      url: '/api/leases/party',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-client-version': '2.0.0' },
      payload: { blockSize: 50 }
    });
    const leaseId = JSON.parse(resAcq.payload).lease.leaseId;

    // Revoke lease
    const resRev = await app.inject({
      method: 'POST',
      url: '/api/leases/party/revoke',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-client-version': '2.0.0' },
      payload: { leaseId }
    });
    expect(resRev.statusCode).toBe(200);
    expect(JSON.parse(resRev.payload).status).toBe('REVOKED');

    // Acquire next lease: must start at 51, NOT recycle 1..50!
    const resNext = await app.inject({
      method: 'POST',
      url: '/api/leases/party',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-client-version': '2.0.0' },
      payload: { blockSize: 50 }
    });
    const nextLease = JSON.parse(resNext.payload).lease;
    expect(nextLease.rangeStart).toBe(51);
    expect(nextLease.rangeEnd).toBe(100);
  });

  // ----------------------------------------------------------------
  // 16-23: Test Token Gating, Production Security & Device Auth Regressions
  // ----------------------------------------------------------------
  describe('Authentication Gate & Real Device Credentials (Correction Pass)', () => {
    let defaultApp: any;
    let explicitDisabledApp: any;

    beforeAll(async () => {
      // Default server (allowTestTokens defaults to false)
      defaultApp = buildFastifyServer({ pool, businessMutationsEnabled: true });
      await defaultApp.ready();

      // Explicit allowTestTokens: false
      explicitDisabledApp = buildFastifyServer({ pool, allowTestTokens: false });
      await explicitDisabledApp.ready();
    });

    afterAll(async () => {
      if (defaultApp) await defaultApp.close();
      if (explicitDisabledApp) await explicitDisabledApp.close();
    });

    it('16. default server rejects novda-test-token with 401 AUTH_REQUIRED', async () => {
      const res = await defaultApp.inject({
        method: 'GET',
        url: '/api/sync/changes',
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'x-client-version': '2.0.0'
        }
      });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('AUTH_REQUIRED');
    });

    it('17. explicit allowTestTokens=false rejects novda-test-token with 401 AUTH_REQUIRED', async () => {
      const res = await explicitDisabledApp.inject({
        method: 'GET',
        url: '/api/sync/changes',
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'x-client-version': '2.0.0'
        }
      });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('AUTH_REQUIRED');
    });

    it('18. explicit allowTestTokens=true accepts valid test token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sync/changes',
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'x-client-version': '2.0.0'
        }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
    });

    it('19. malformed test token rejected even when allowTestTokens=true', async () => {
      // Missing parts
      const res1 = await app.inject({
        method: 'GET',
        url: '/api/sync/changes',
        headers: {
          authorization: 'Bearer novda-test-token:only-one-part',
          'x-client-version': '2.0.0'
        }
      });
      expect(res1.statusCode).toBe(401);
      expect(JSON.parse(res1.payload).error.code).toBe('AUTH_REQUIRED');

      // Empty parts
      const res2 = await app.inject({
        method: 'GET',
        url: '/api/sync/changes',
        headers: {
          authorization: 'Bearer novda-test-token::',
          'x-client-version': '2.0.0'
        }
      });
      expect(res2.statusCode).toBe(401);
      expect(JSON.parse(res2.payload).error.code).toBe('AUTH_REQUIRED');
    });

    it('20. production-style/default server cannot claim arbitrary company through test token', async () => {
      const arbitraryCompanyToken = 'novda-test-token:compromised-tenant:evil-device';
      const res = await defaultApp.inject({
        method: 'POST',
        url: '/api/sync/operations',
        headers: {
          authorization: `Bearer ${arbitraryCompanyToken}`,
          'x-client-version': '2.0.0'
        },
        payload: { operations: [] }
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload).error.code).toBe('AUTH_REQUIRED');
    });

    it('21. valid server_devices credential works on default server (allowTestTokens=false)', async () => {
      const realToken = 'secret-production-workstation-token-999';
      const tokenHash = hashToken(realToken);
      const realDeviceId = 'workstation-registered-1';
      const realCompanyId = 'company-production-real';

      await pool.query(
        `INSERT INTO server_devices (device_id, company_id, token_hash, client_version, is_revoked, registered_at)
         VALUES ($1, $2, $3, '2.0.0', false, NOW())
         ON CONFLICT (device_id) DO UPDATE SET token_hash = $3, is_revoked = false`,
        [realDeviceId, realCompanyId, tokenHash]
      );

      const res = await defaultApp.inject({
        method: 'GET',
        url: '/api/sync/changes',
        headers: {
          authorization: `Bearer ${realToken}`,
          'x-client-version': '2.0.0'
        }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
    });

    it('22. revoked real device is rejected with 403 DEVICE_REVOKED', async () => {
      const revokedToken = 'secret-revoked-token-888';
      const tokenHash = hashToken(revokedToken);
      const revokedDeviceId = 'workstation-revoked-1';
      const realCompanyId = 'company-production-real';

      await pool.query(
        `INSERT INTO server_devices (device_id, company_id, token_hash, client_version, is_revoked, registered_at)
         VALUES ($1, $2, $3, '2.0.0', true, NOW())
         ON CONFLICT (device_id) DO UPDATE SET token_hash = $3, is_revoked = true`,
        [revokedDeviceId, realCompanyId, tokenHash]
      );

      const res = await defaultApp.inject({
        method: 'GET',
        url: '/api/sync/changes',
        headers: {
          authorization: `Bearer ${revokedToken}`,
          'x-client-version': '2.0.0'
        }
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('DEVICE_REVOKED');
    });

    it('23. company scope mismatch on real device rejected with 403 COMPANY_SCOPE_MISMATCH', async () => {
      const validToken = 'secret-prod-token-scope-check';
      const tokenHash = hashToken(validToken);
      const deviceId = 'workstation-scope-1';
      const companyId = 'company-tenant-alpha';

      await pool.query(
        `INSERT INTO server_devices (device_id, company_id, token_hash, client_version, is_revoked, registered_at)
         VALUES ($1, $2, $3, '2.0.0', false, NOW())
         ON CONFLICT (device_id) DO UPDATE SET token_hash = $3, is_revoked = false`,
        [deviceId, companyId, tokenHash]
      );

      // Attempt operation with payload claiming company-tenant-bravo
      const payload = {
        commandId: 'cmd_scope_1',
        operationId: 'op_scope_1',
        companyId: 'company-tenant-bravo', // Mismatch!
        ticketId: 't_scope_1',
        modelId: 'm_1',
        partyNumber: '1',
        pattaNumber: 1,
        qty: 5,
        entries: [{ opName: 'Bichish', workerId: 1, qty: 5 }]
      };
      const pJson = canonicalStringify(payload);
      const pHash = computePayloadHash(pJson);

      const res = await defaultApp.inject({
        method: 'POST',
        url: '/api/sync/operations',
        headers: {
          authorization: `Bearer ${validToken}`,
          'x-client-version': '2.0.0'
        },
        payload: {
          operations: [
            {
              operationId: 'op_scope_1',
              companyId: 'company-tenant-bravo',
              commandType: 'SubmitTicket',
              entityType: 'ticket',
              entityId: 't_scope_1',
              payloadHash: pHash,
              payload
            }
          ]
        }
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.results[0].status).toBe('REJECTED');
      expect(body.results[0].error.code).toBe('COMPANY_SCOPE_MISMATCH');
    });

    it('persists idempotent pending activation requests and protects status reads with the request secret', async () => {
      await applyActivationMigration();
      const requestId = crypto.randomUUID();
      const requestToken = crypto.randomBytes(32).toString('hex');
      const payload = {
        requestId,
        requestToken,
        machineId: 'A588-F0E4-DE9A-59A2',
        context: { appVersion: '1.7.7', platform: 'win32' }
      };

      const created = await app.inject({ method: 'POST', url: '/api/activation/requests', payload });
      expect(created.statusCode).toBe(201);
      expect(JSON.parse(created.payload).request).toMatchObject({ requestId, status: 'PENDING', replay: false });

      const replay = await app.inject({ method: 'POST', url: '/api/activation/requests', payload });
      expect(replay.statusCode).toBe(200);
      expect(JSON.parse(replay.payload).request).toMatchObject({ requestId, status: 'PENDING', replay: true });

      const unauthorized = await app.inject({ method: 'GET', url: `/api/activation/requests/${requestId}` });
      expect(unauthorized.statusCode).toBe(404);
      const status = await app.inject({
        method: 'GET',
        url: `/api/activation/requests/${requestId}`,
        headers: {
          'x-activation-request-token': requestToken,
          'x-machine-id': payload.machineId
        }
      });
      expect(status.statusCode).toBe(200);
      expect(JSON.parse(status.payload).request).toMatchObject({ requestId, status: 'PENDING', activation: null });

      const stored = await pool.query('SELECT request_token_hash, status FROM activation_requests WHERE request_id = $1', [requestId]);
      expect(stored.rows[0].request_token_hash).not.toBe(requestToken);
      expect(stored.rows[0].status).toBe('PENDING');
    });

    it('requires authorized admin approval, persists the verified signature, and supports rejection and signed revocation', async () => {
      await applyActivationMigration();
      const company = await createActivationCompany();
      const request = await createActivationRequest();
      const denied = await app.inject({
        method: 'GET',
        url: '/api/admin/activation/requests',
        headers: { 'x-novda-admin-token': 'wrong-token' }
      });
      expect(denied.statusCode).toBe(401);

      const now = new Date();
      const activePayload = {
        activationId: crypto.randomUUID(),
        companyId: company.company_id,
        companyName: company.company_name,
        expiresAt: null,
        issuedAt: now.toISOString(),
        machineId: request.machineId,
        requireTicketValidation: company.require_ticket_validation,
        role: 'admin',
        schema: 'novda-license-v1',
        status: 'active'
      };
      const approved = await app.inject({
        method: 'POST',
        url: `/api/admin/activation/requests/${request.requestId}/approve`,
        headers: { 'x-novda-admin-token': 'activation-admin-service-test-token' },
        payload: {
          adminTelegramId: '12345678',
          companyId: company.company_id,
          role: 'admin',
          signedActivation: signActivation(activePayload)
        }
      });
      expect(approved.statusCode).toBe(200);
      expect(JSON.parse(approved.payload).request).toMatchObject({ status: 'APPROVED', company_id: company.company_id, role: 'admin' });

      const provisioned = await pool.query(
        'SELECT device_id, company_id, token_hash, is_revoked FROM server_devices WHERE device_id = $1',
        [request.machineId]
      );
      expect(provisioned.rows).toEqual([{
        device_id: request.machineId,
        company_id: company.company_id,
        token_hash: hashToken(request.requestToken),
        is_revoked: false
      }]);

      const deviceAuthenticated = await app.inject({
        method: 'GET',
        url: '/api/sync/changes?cursor=0&limit=1',
        headers: { authorization: `Bearer ${request.requestToken}`, 'x-client-version': '2.0.0' }
      });
      expect(deviceAuthenticated.statusCode).toBe(200);

      const wrongMachine = await app.inject({
        method: 'GET',
        url: `/api/activation/requests/${request.requestId}`,
        headers: { 'x-activation-request-token': request.requestToken, 'x-machine-id': '1111-2222-3333-4444' }
      });
      expect(wrongMachine.statusCode).toBe(404);
      const clientResult = await app.inject({
        method: 'GET',
        url: `/api/activation/requests/${request.requestId}`,
        headers: { 'x-activation-request-token': request.requestToken, 'x-machine-id': request.machineId }
      });
      expect(JSON.parse(clientResult.payload).request).toMatchObject({
        status: 'APPROVED',
        activation: { payload: activePayload, signature: expect.any(String) }
      });

      const nextRequest = await createActivationRequest('B588-F0E4-DE9A-59A2');
      const rejected = await app.inject({
        method: 'POST',
        url: `/api/admin/activation/requests/${nextRequest.requestId}/reject`,
        headers: { 'x-novda-admin-token': 'activation-admin-service-test-token' },
        payload: { adminTelegramId: '12345678', reason: 'Device not recognized' }
      });
      expect(rejected.statusCode).toBe(200);
      expect(JSON.parse(rejected.payload).request).toMatchObject({ status: 'REJECTED', rejection_reason: 'Device not recognized' });

      const revokedPayload = {
        ...activePayload,
        issuedAt: new Date(now.getTime() + 2000).toISOString(),
        status: 'revoked'
      };
      const revoked = await app.inject({
        method: 'POST',
        url: `/api/admin/activation/requests/${request.requestId}/revoke`,
        headers: { 'x-novda-admin-token': 'activation-admin-service-test-token' },
        payload: { adminTelegramId: '12345678', signedActivation: signActivation(revokedPayload) }
      });
      expect(revoked.statusCode).toBe(200);
      expect(JSON.parse(revoked.payload).request).toMatchObject({ status: 'REVOKED', activation: { payload: revokedPayload } });

      const revokedDevice = await pool.query(
        'SELECT is_revoked FROM server_devices WHERE device_id = $1 AND company_id = $2',
        [request.machineId, company.company_id]
      );
      expect(revokedDevice.rows[0].is_revoked).toBe(true);
      const rejectedDevice = await app.inject({
        method: 'GET',
        url: '/api/sync/changes?cursor=0&limit=1',
        headers: { authorization: `Bearer ${request.requestToken}`, 'x-client-version': '2.0.0' }
      });
      expect(rejectedDevice.statusCode).toBe(403);
      expect(JSON.parse(rejectedDevice.payload).error.code).toBe('DEVICE_REVOKED');

      const eventCount = await pool.query('SELECT event_type FROM activation_events WHERE request_id = $1 ORDER BY event_id', [request.requestId]);
      expect(eventCount.rows.map((row: any) => row.event_type)).toEqual(['APPROVED', 'REVOKED']);
    });

    it('rejects client-forged bindings, disallowed roles, unauthorized admins, and excess request creation', async () => {
      await applyActivationMigration();
      const company = await createActivationCompany();
      const request = await createActivationRequest();
      const forged = signActivation({
        activationId: crypto.randomUUID(), companyId: company.company_id, companyName: company.company_name,
        expiresAt: null, issuedAt: new Date().toISOString(), machineId: '9999-2222-3333-4444',
        requireTicketValidation: true, role: 'admin', schema: 'novda-license-v1', status: 'active'
      });
      const forgedApproval = await app.inject({
        method: 'POST',
        url: `/api/admin/activation/requests/${request.requestId}/approve`,
        headers: { 'x-novda-admin-token': 'activation-admin-service-test-token' },
        payload: { adminTelegramId: '12345678', companyId: company.company_id, role: 'admin', signedActivation: forged }
      });
      expect(forgedApproval.statusCode).toBe(400);
      expect(JSON.parse(forgedApproval.payload).error.code).toBe('ACTIVATION_SIGNATURE_OR_BINDING_INVALID');

      const disallowedRole = await app.inject({
        method: 'POST',
        url: `/api/admin/activation/requests/${request.requestId}/approve`,
        headers: { 'x-novda-admin-token': 'activation-admin-service-test-token' },
        payload: {
          adminTelegramId: '12345678', companyId: company.company_id, role: 'owner',
          signedActivation: signActivation({})
        }
      });
      expect(disallowedRole.statusCode).toBe(400);

      const unauthorizedAdmin = await app.inject({
        method: 'POST',
        url: `/api/admin/activation/requests/${request.requestId}/reject`,
        headers: { 'x-novda-admin-token': 'activation-admin-service-test-token' },
        payload: { adminTelegramId: '87654321', reason: 'not authorized' }
      });
      expect(unauthorizedAdmin.statusCode).toBe(403);

      const requestIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      for (const requestId of requestIds) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/activation/requests',
          payload: { requestId, requestToken: crypto.randomBytes(32).toString('hex'), machineId: request.machineId }
        });
        expect(response.statusCode).toBe(201);
      }
      const rateLimited = await app.inject({
        method: 'POST',
        url: '/api/activation/requests',
        payload: { requestId: crypto.randomUUID(), requestToken: crypto.randomBytes(32).toString('hex'), machineId: request.machineId }
      });
      expect(rateLimited.statusCode).toBe(429);
    });

    it('binds workers through , enforces their PIN, and exposes only their own PostgreSQL payroll', async () => {
      await applyActivationMigration();
      await createActivationCompany(COMPANY_A);
      const pin = hashWorkerPin('0482');
      await pool.query(
        `INSERT INTO worker_credentials (company_id, worker_id, pin_salt, pin_hash) VALUES ($1, 1, $2, $3)`,
        [COMPANY_A, pin.salt, pin.hash]
      );
      await pool.query(
        `UPDATE models SET operations_json = $2::jsonb WHERE company_id = $1 AND id = 'm_1'`,
        [COMPANY_A, JSON.stringify([{ name: 'Tikish', rate: 3 }])]
      );
      const startDate = new Date().toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO periods (id, company_id, start_date, is_closed) VALUES ('period-worker-test', $1, $2, 0)`,
        [COMPANY_A, startDate]
      );
      await seedParty(COMPANY_A, 'worker-party-1', '9');
      const ticketId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO tickets (id, company_id, model_id, party_number, party_record_id, patta_number,
          qty, status, is_closed, submitted_at)
         VALUES ($1, $2, 'm_1', '9', 'worker-party-1', 1, 4, 'CONFIRMED', 0, NOW())`,
        [ticketId, COMPANY_A]
      );
      await pool.query(
        `INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id, qty)
         VALUES ($1, $2, $3, 'Tikish', 1, 4)`,
        [`${ticketId}_entry_1`, ticketId, COMPANY_A]
      );
      await pool.query(
        `INSERT INTO worker_adjustments (id, company_id, worker_id, type, amount, source_id, provenance)
         VALUES ('worker-avans', $1, 1, 'AVANS', 5, 'avans-1', 'OPENING'),
                ('worker-jarima', $1, 1, 'JARIMA', 2, 'jarima-1', 'OPENING')`,
        [COMPANY_A]
      );
      await pool.query('UPDATE workers SET staj = 3 WHERE company_id = $1 AND id = 1', [COMPANY_A]);

      const headers = { 'x-novda-worker-token': 'worker-service-test-token' };
      const enrollment = await app.inject({
        method: 'GET', url: '/api/worker/enrollment?companyId=company-test-alpha&workerId=1', headers
      });
      expect(JSON.parse(enrollment.payload).worker).toMatchObject({ worker_id: 1, pin_required: true });
      expect(JSON.stringify(JSON.parse(enrollment.payload))).not.toContain('pin_hash');

      const wrongPin = await app.inject({
        method: 'POST', url: '/api/worker/bindings', headers,
        payload: { telegramId: '123456789', companyId: COMPANY_A, workerId: 1, pin: '0000' }
      });
      expect(wrongPin.statusCode).toBe(401);
      expect(JSON.parse(wrongPin.payload).error.code).toBe('WORKER_PIN_INVALID');

      const bound = await app.inject({
        method: 'POST', url: '/api/worker/bindings', headers,
        payload: { telegramId: '123456789', companyId: COMPANY_A, workerId: 1, pin: '0482', username: 'worker_test' }
      });
      expect(bound.statusCode).toBe(201);
      expect(JSON.parse(bound.payload).binding).toMatchObject({ worker_id: 1, company_id: COMPANY_A, telegram_id: '123456789' });

      const profile = await app.inject({
        method: 'GET',
        url: `/api/worker/profile?companyId=${COMPANY_A}&workerId=1&telegramId=123456789`,
        headers
      });
      expect(profile.statusCode).toBe(200);
      expect(JSON.parse(profile.payload).profile).toMatchObject({
        worker_id: 1,
        company_id: COMPANY_A,
        gross: 12,
        avans: 5,
        jarima: 2,
        staj: 3,
        net: 2,
        pieces: 4
      });

      const expiresAt = Math.floor(Date.now() / 1000) + 600;
      const hmacParams = { companyId: COMPANY_A, workerId: '1', telegramId: '123456789', expiresAt };
      const webToken = crypto.createHmac('sha256', 'worker-web-test-hmac-secret')
        .update(signableWorkerRequest(hmacParams), 'utf8').digest('hex');
      const webProfile = await app.inject({
        method: 'GET',
        url: `/api/worker/profile?companyId=${COMPANY_A}&workerId=1&telegramId=123456789&expiresAt=${expiresAt}`,
        headers: { 'x-worker-auth-token': webToken }
      });
      expect(webProfile.statusCode).toBe(200);
      const crossCompany = await app.inject({
        method: 'GET',
        url: `/api/worker/profile?companyId=${COMPANY_B}&workerId=1&telegramId=123456789&expiresAt=${expiresAt}`,
        headers: { 'x-worker-auth-token': webToken }
      });
      expect(crossCompany.statusCode).toBe(401);

      const tickets = await app.inject({
        method: 'GET',
        url: `/api/worker/tickets?companyId=${COMPANY_A}&workerId=1&telegramId=123456789&limit=10`,
        headers
      });
      expect(JSON.parse(tickets.payload).tickets).toHaveLength(1);
      expect(JSON.parse(tickets.payload).tickets[0]).toMatchObject({ ticket_id: ticketId, my_operations: 'Tikish' });
    });
  });
});
