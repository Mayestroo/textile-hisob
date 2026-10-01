import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const auth = require('./operatorAuth.cjs');

const disposableUrl = process.env.NOVDA_DISPOSABLE_PG === '1' ? process.env.NOVDA_PG_URL : undefined;
const describeDisposablePostgres = disposableUrl ? describe : describe.skip;

describeDisposablePostgres('NOT RUN without NOVDA_DISPOSABLE_PG=1 and NOVDA_PG_URL: persistent operator limiter', () => {
  const schemaName = `novda_operator_auth_${process.pid}_${Date.now().toString(36)}`;
  const quotedSchemaName = `"${schemaName}"`;
  let poolA: Pool | null = null;
  let poolB: Pool | null = null;
  let schemaCreated = false;

  function createPool() {
    return new Pool({
      connectionString: disposableUrl,
      options: `-c search_path=${schemaName},public`,
      max: 8
    });
  }

  async function runSqlFile(pool: Pool, filename: string) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', filename), 'utf8'));
  }

  beforeAll(async () => {
    if (process.env.NOVDA_DISPOSABLE_PG !== '1' || !disposableUrl) {
      throw new Error('DISPOSABLE_POSTGRES_REQUIRED: NOVDA_DISPOSABLE_PG=1 and NOVDA_PG_URL are required');
    }
    if (process.env.DATABASE_URL) {
      throw new Error('DISPOSABLE_POSTGRES_REQUIRED: DATABASE_URL must be unset');
    }

    poolA = createPool();
    const preflight = await poolA.query('SELECT current_database() AS database, current_setting(\'server_version_num\') AS server_version_num');
    if (!String(preflight.rows[0].server_version_num).startsWith('16')) {
      throw new Error('POSTGRESQL_16_REQUIRED: disposable operator-auth integration requires PostgreSQL 16');
    }
    if (!/(test|regression|disposable)/i.test(String(preflight.rows[0].database))) {
      throw new Error('DISPOSABLE_DATABASE_REQUIRED: database name must identify a test, regression, or disposable database');
    }

    await poolA.query(`CREATE SCHEMA ${quotedSchemaName}`);
    schemaCreated = true;
    const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
    await poolA.query(schemaSql);
    await poolA.query(schemaSql);
    await runSqlFile(poolA, 'deploy_operator_auth_migration.sql');
    await runSqlFile(poolA, 'deploy_operator_auth_migration.sql');
    await runSqlFile(poolA, 'deploy_operator_auth_rate_limit_migration.sql');
    await runSqlFile(poolA, 'deploy_operator_auth_rate_limit_migration.sql');

    const constraints = await poolA.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'operator_login_attempts'::regclass
        AND conname IN ('operator_login_attempts_failed_count_check', 'operator_login_attempts_operator_key_check')
      ORDER BY conname
    `);
    expect(constraints.rows.map((row: any) => row.conname)).toEqual([
      'operator_login_attempts_failed_count_check',
      'operator_login_attempts_operator_key_check'
    ]);

    poolB = createPool();
    await poolB.query('SELECT 1');
  });

  beforeEach(async () => {
    await poolA!.query('DELETE FROM operator_sessions');
    await poolA!.query('DELETE FROM operator_login_attempts');
    await poolA!.query('DELETE FROM server_operators');
    await poolA!.query('DELETE FROM server_devices');
  });

  afterAll(async () => {
    try {
      const cleanupPool = poolB || poolA;
      if (schemaCreated && cleanupPool) await cleanupPool.query(`DROP SCHEMA ${quotedSchemaName} CASCADE`);
    } finally {
      if (poolA) await poolA.end();
      if (poolB) await poolB.end();
    }
  });

  it('persists reservations across an independent pool after the first pool closes', async () => {
    await expect(auth.reserveLoginAttempt(poolA, 'company-a', 'device-a', 'operator-a')).resolves.toBe(false);
    await poolA!.end();

    poolA = createPool();
    const persisted = await poolA.query(
      'SELECT failed_count FROM operator_login_attempts WHERE company_id = $1 AND device_id = $2 AND operator_key = $3',
      ['company-a', 'device-a', auth.loginAttemptKey('company-a', 'device-a', 'operator-a')]
    );
    expect(Number(persisted.rows[0].failed_count)).toBe(1);
    await expect(auth.reserveLoginAttempt(poolA, 'company-a', 'device-a', 'operator-a')).resolves.toBe(false);
    const incremented = await poolA.query(
      'SELECT failed_count FROM operator_login_attempts WHERE company_id = $1 AND device_id = $2 AND operator_key = $3',
      ['company-a', 'device-a', auth.loginAttemptKey('company-a', 'device-a', 'operator-a')]
    );
    expect(Number(incremented.rows[0].failed_count)).toBe(2);
  });

  it('serializes concurrent reservations with no lost increment and throttles the sixth failure', async () => {
    const reservations = await Promise.all(
      Array.from({ length: auth.LOGIN_ATTEMPT_LIMIT }, (_, index) => auth.reserveLoginAttempt(
        index % 2 === 0 ? poolA : poolB,
        'company-concurrent',
        'device-concurrent',
        'operator-concurrent'
      ))
    );
    expect(reservations).toEqual([false, false, false, false, false]);

    const row = await poolA!.query(
      'SELECT failed_count FROM operator_login_attempts WHERE company_id = $1 AND device_id = $2',
      ['company-concurrent', 'device-concurrent']
    );
    expect(Number(row.rows[0].failed_count)).toBe(auth.LOGIN_ATTEMPT_LIMIT);
    await expect(auth.reserveLoginAttempt(poolB, 'company-concurrent', 'device-concurrent', 'operator-concurrent')).resolves.toBe(true);
  });

  it('does not share the limiter between case-distinct operator IDs', async () => {
    for (let attempt = 0; attempt < auth.LOGIN_ATTEMPT_LIMIT; attempt += 1) {
      await expect(auth.reserveLoginAttempt(poolA, 'company-case', 'device-case', 'Alice')).resolves.toBe(false);
    }
    await expect(auth.reserveLoginAttempt(poolA, 'company-case', 'device-case', 'alice')).resolves.toBe(false);
    await expect(auth.reserveLoginAttempt(poolA, 'company-case', 'device-case', 'Alice')).resolves.toBe(true);
  });

  it('counts an unknown operator without storing the raw operator identity', async () => {
    await expect(auth.authenticateOperator(
      poolA,
      { companyId: 'company-unknown', deviceId: 'device-unknown' },
      { operatorId: 'unknown-operator', password: 'correct horse battery staple' }
    )).rejects.toMatchObject({ code: 'OPERATOR_AUTH_REJECTED' });

    const row = await poolA!.query(
      'SELECT operator_key, failed_count FROM operator_login_attempts WHERE company_id = $1 AND device_id = $2',
      ['company-unknown', 'device-unknown']
    );
    expect(Number(row.rows[0].failed_count)).toBe(1);
    expect(row.rows[0].operator_key).not.toContain('unknown-operator');
  });

  it('resets an expired window to one attempt and keeps expiry bounded', async () => {
    const key = auth.loginAttemptKey('company-expiry', 'device-expiry', 'operator-expiry');
    await poolA!.query(`
      INSERT INTO operator_login_attempts (company_id, device_id, operator_key, failed_count, window_expires_at)
      VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 second')
    `, ['company-expiry', 'device-expiry', key, auth.LOGIN_ATTEMPT_LIMIT]);

    await expect(auth.reserveLoginAttempt(poolA, 'company-expiry', 'device-expiry', 'operator-expiry')).resolves.toBe(false);
    const row = await poolA!.query(
      'SELECT failed_count, window_expires_at FROM operator_login_attempts WHERE company_id = $1 AND device_id = $2 AND operator_key = $3',
      ['company-expiry', 'device-expiry', key]
    );
    expect(Number(row.rows[0].failed_count)).toBe(1);
    const expiryMs = new Date(row.rows[0].window_expires_at).getTime();
    expect(expiryMs).toBeGreaterThan(Date.now());
    expect(expiryMs).toBeLessThanOrEqual(Date.now() + auth.LOGIN_WINDOW_SECONDS * 1000 + 1000);
  });

  it('clears only the successful active-company scope and rejects revoked, inactive, and cross-company operators', async () => {
    const companyId = 'company-auth';
    const deviceId = 'device-auth';
    await poolA!.query(
      `INSERT INTO server_devices (device_id, company_id, token_hash, client_version)
       VALUES ($1, $2, repeat('a', 64), '2.0.0')`,
      [deviceId, companyId]
    );
    await auth.provisionOperator(poolA, {
      operatorId: 'active-operator',
      companyId,
      displayName: 'Active Operator',
      role: 'admin',
      password: 'correct horse battery staple'
    });
    await auth.provisionOperator(poolA, {
      operatorId: 'revoked-operator',
      companyId,
      displayName: 'Revoked Operator',
      role: 'admin',
      password: 'correct horse battery staple'
    });
    await auth.provisionOperator(poolA, {
      operatorId: 'inactive-operator',
      companyId,
      displayName: 'Inactive Operator',
      role: 'admin',
      password: 'correct horse battery staple'
    });
    await auth.provisionOperator(poolA, {
      operatorId: 'cross-company-operator',
      companyId: 'other-company',
      displayName: 'Cross Company Operator',
      role: 'admin',
      password: 'correct horse battery staple'
    });
    await poolA!.query(`UPDATE server_operators SET revoked_at = NOW() WHERE operator_id = 'revoked-operator'`);
    await poolA!.query(`UPDATE server_operators SET is_active = FALSE WHERE operator_id = 'inactive-operator'`);

    for (const operatorId of ['revoked-operator', 'inactive-operator', 'cross-company-operator']) {
      await expect(auth.authenticateOperator(
        poolA,
        { companyId, deviceId },
        { operatorId, password: 'correct horse battery staple' }
      )).rejects.toMatchObject({ code: 'OPERATOR_AUTH_REJECTED' });
    }

    await auth.reserveLoginAttempt(poolA, companyId, deviceId, 'active-operator');
    await auth.reserveLoginAttempt(poolA, companyId, 'other-device', 'active-operator');
    await auth.reserveLoginAttempt(poolA, 'other-company', deviceId, 'active-operator');
    await auth.reserveLoginAttempt(poolA, companyId, deviceId, 'other-operator');

    const login = await auth.authenticateOperator(
      poolA,
      { companyId, deviceId },
      { operatorId: 'active-operator', password: 'correct horse battery staple' }
    );
    expect(login.companyId).toBe(companyId);

    const attempts = await poolA!.query(
      'SELECT company_id, device_id, operator_key, failed_count, window_expires_at, updated_at FROM operator_login_attempts ORDER BY company_id, device_id, operator_key'
    );
    // Only the successful active-company/device/operator scope is cleared.
    // The three rejected operators and the three other scoped reservations remain.
    expect(attempts.rows).toHaveLength(6);
    expect(attempts.rows.every((row: any) => /^[a-f0-9]{64}$/.test(row.operator_key))).toBe(true);
    const serialized = JSON.stringify(attempts.rows);
    expect(serialized).not.toContain('active-operator');
    expect(serialized).not.toContain('correct horse battery staple');
    expect(serialized).not.toContain(login.token);
  });
});
