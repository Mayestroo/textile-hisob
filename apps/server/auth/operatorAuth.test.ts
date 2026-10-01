import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const auth = require('./operatorAuth.cjs');

function poolFor(rows: any[]) {
  let index = 0;
  return {
    query: async (sql: string, params: any[]) => {
      if (sql.includes('SELECT operator_id')) return { rows: [rows[index++] || null].filter(Boolean) };
      if (sql.includes('INSERT INTO operator_sessions')) return { rows: [] };
      if (sql.includes('SELECT s.session_id')) return { rows: [rows[index++] || null].filter(Boolean) };
      return { rows: [] };
    }
  };
}

describe('trusted operator authentication primitives', () => {
  it('uses versioned salted scrypt hashes and constant-time verification', async () => {
    const encoded = await auth.hashPassword('correct horse battery staple');
    expect(encoded).toMatch(/^scrypt-v1\$N=16384,r=8,p=1\$/);
    expect(await auth.verifyPassword('correct horse battery staple', encoded)).toBe(true);
    expect(await auth.verifyPassword('wrong password', encoded)).toBe(false);
    expect(encoded).not.toContain('correct horse battery staple');
  });

  it('issues a random token and stores only its hash, scoped to operator/company/device', async () => {
    const passwordHash = await auth.hashPassword('correct horse battery staple');
    const queries: any[] = [];
    const pool = {
      query: async (sql: string, params: any[]) => {
        queries.push({ sql, params });
        if (sql.includes('SELECT operator_id')) return { rows: [{ operator_id: 'op-1', company_id: 'co-1', is_active: true, password_hash: passwordHash }] };
        return { rows: [] };
      }
    };
    const result = await auth.authenticateOperator(pool, { companyId: 'co-1', deviceId: 'dev-1' }, { operatorId: 'op-1', password: 'correct horse battery staple' });
    const insert = queries.find((q) => q.sql.includes('INSERT INTO operator_sessions'));
    expect(result.token).toHaveLength(64);
    expect(insert.params).toContain(auth.hashSessionToken(result.token));
    expect(insert.params).not.toContain(result.token);
    expect(insert.params).toContain('dev-1');
  });

  it('uses one dummy verification branch for unknown, inactive, revoked, and cross-company rows', async () => {
    const verificationHashes: string[] = [];
    const verifyPassword = async (_password: string, encoded: string) => {
      verificationHashes.push(encoded);
      return false;
    };
    for (const row of [
      null,
      { operator_id: 'op-1', company_id: 'other', is_active: true, password_hash: 'stored-hash-not-used' },
      { operator_id: 'op-1', company_id: 'co-1', is_active: false, password_hash: 'stored-hash-not-used' },
      { operator_id: 'op-1', company_id: 'co-1', is_active: true, revoked_at: new Date(), password_hash: 'stored-hash-not-used' }
    ]) {
      await expect(auth.authenticateOperator(
        poolFor(row ? [row] : [null]),
        { companyId: 'co-1', deviceId: 'dev-1' },
        { operatorId: 'op-1', password: 'rejected-path-input' },
        { verifyPassword }
      )).rejects.toMatchObject({ code: 'OPERATOR_AUTH_REJECTED', message: 'Invalid operator credentials' });
    }
    expect(verificationHashes).toHaveLength(4);
    expect(new Set(verificationHashes).size).toBe(1);
    expect(verificationHashes[0]).toMatch(/^scrypt-v1\$N=16384,r=8,p=1\$/);
    expect(verificationHashes[0]).not.toContain('stored-hash-not-used');
  });

  it('does not resolve a revoked, expired, device-mismatched, or inactive session', async () => {
    const base = { operator_id: 'op-1', company_id: 'co-1', device_id: 'dev-1', current_company_id: 'co-1', current_role: 'admin', is_active: true, expires_at: new Date(Date.now() + 60_000), revoked_at: null };
    for (const row of [
      { ...base, revoked_at: new Date() },
      { ...base, expires_at: new Date(Date.now() - 1) },
      { ...base, device_id: 'dev-2' },
      { ...base, is_active: false },
      { ...base, operator_revoked_at: new Date() }
    ]) {
      await expect(auth.resolveOperatorSession(poolFor([row]), 'raw-token', { companyId: 'co-1', deviceId: 'dev-1' })).resolves.toBeNull();
    }
  });

  it('hashes trimmed, case-preserved login-attempt dimensions before they reach PostgreSQL', async () => {
    const expected = crypto.createHash('sha256').update(['company-a', 'device-a', 'OPERATOR-A'].join(String.fromCharCode(0)), 'utf8').digest('hex');
    const key = auth.loginAttemptKey('company-a', 'device-a', 'OPERATOR-A');

    expect(key).toBe(expected);
    expect(auth.loginAttemptKey('company-a', 'device-a', ' OPERATOR-A ')).toBe(key);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain('OPERATOR-A');
  });

  it('keeps company, device, and operator attempt scopes isolated', () => {
    const base = auth.loginAttemptKey('company-a', 'device-a', 'operator-a');
    expect(auth.loginAttemptKey('company-b', 'device-a', 'operator-a')).not.toBe(base);
    expect(auth.loginAttemptKey('company-a', 'device-b', 'operator-a')).not.toBe(base);
    expect(auth.loginAttemptKey('company-a', 'device-a', 'operator-b')).not.toBe(base);
    expect(auth.loginAttemptKey('company-a', 'device-a', 'Alice')).not.toBe(auth.loginAttemptKey('company-a', 'device-a', 'alice'));
  });

  it('does not share the five-failure limit between case-distinct operator IDs', async () => {
    const counts = new Map<string, number>();
    const pool = {
      query: async (sql: string, params: any[] = []) => {
        if (!sql.includes('RETURNING failed_count')) return { rows: [] };
        const key = params[2];
        const count = (counts.get(key) || 0) + 1;
        counts.set(key, count);
        return { rows: [{ failed_count: count, window_expires_at: new Date(Date.now() + 900_000) }] };
      }
    };

    for (let attempt = 0; attempt < auth.LOGIN_ATTEMPT_LIMIT; attempt += 1) {
      await expect(auth.reserveLoginAttempt(pool, 'company-a', 'device-a', 'Alice')).resolves.toBe(false);
    }
    await expect(auth.reserveLoginAttempt(pool, 'company-a', 'device-a', 'Alice')).resolves.toBe(true);
    await expect(auth.reserveLoginAttempt(pool, 'company-a', 'device-a', 'alice')).resolves.toBe(false);
  });

  it('uses one atomic UPSERT for an attempt reservation and sends only the derived key', async () => {
    const queries: any[] = [];
    const pool = {
      query: async (sql: string, params: any[] = []) => {
        queries.push({ sql, params });
        return sql.includes('RETURNING failed_count') ? { rows: [{ failed_count: 1 }] } : { rows: [] };
      }
    };

    await expect(auth.reserveLoginAttempt(pool, 'company-a', 'device-a', 'OPERATOR-A')).resolves.toBe(false);

    const reservation = queries[0];
    expect(reservation.sql).toContain('INSERT INTO operator_login_attempts');
    expect(reservation.sql).toContain('ON CONFLICT (company_id, device_id, operator_key) DO UPDATE');
    expect(reservation.sql).toContain('failed_count = CASE');
    expect(reservation.sql).toContain('window_expires_at <= NOW()');
    expect(reservation.sql).toContain('RETURNING failed_count, window_expires_at');
    expect(reservation.params).toEqual([
      'company-a',
      'device-a',
      auth.loginAttemptKey('company-a', 'device-a', 'OPERATOR-A'),
      15 * 60
    ]);
    expect(reservation.params).not.toContain('OPERATOR-A');
    expect(queries[1].sql).toContain('DELETE FROM operator_login_attempts');
    expect(queries[1].sql).toContain('window_expires_at <= NOW()');
  });

  it('keeps the five-failure threshold and fifteen-minute window explicit', async () => {
    expect(auth.LOGIN_WINDOW_SECONDS).toBe(15 * 60);
    expect(auth.LOGIN_ATTEMPT_LIMIT).toBe(5);

    let failedCount = 0;
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('RETURNING failed_count')) return { rows: [{ failed_count: ++failedCount, window_expires_at: new Date(Date.now() + 900_000) }] };
        return { rows: [] };
      }
    };

    for (let attempt = 1; attempt <= auth.LOGIN_ATTEMPT_LIMIT; attempt += 1) {
      await expect(auth.reserveLoginAttempt(pool, 'company-a', 'device-a', 'operator-a')).resolves.toBe(false);
    }
    await expect(auth.reserveLoginAttempt(pool, 'company-a', 'device-a', 'operator-a')).resolves.toBe(true);
  });

  it('returns an unthrottled reservation when PostgreSQL resets an expired row', async () => {
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('RETURNING failed_count')) return { rows: [{ failed_count: 1, window_expires_at: new Date(Date.now() + 900_000) }] };
        return { rows: [] };
      }
    };

    await expect(auth.reserveLoginAttempt(pool, 'company-a', 'device-a', 'operator-a')).resolves.toBe(false);
  });

  it('clears only the exact company/device/operator scope after valid login', async () => {
    const passwordHash = await auth.hashPassword('correct horse battery staple');
    const queries: any[] = [];
    const pool = {
      query: async (sql: string, params: any[] = []) => {
        queries.push({ sql, params });
        if (sql.includes('RETURNING failed_count')) return { rows: [{ failed_count: 1, window_expires_at: new Date(Date.now() + 900_000) }] };
        if (sql.includes('SELECT operator_id')) return { rows: [{ operator_id: 'op-1', company_id: 'co-1', role: 'admin', is_active: true, revoked_at: null, password_hash: passwordHash }] };
        return { rows: [] };
      }
    };

    await auth.authenticateOperator(pool, { companyId: 'co-1', deviceId: 'dev-1' }, { operatorId: 'op-1', password: 'correct horse battery staple' });
    const clear = queries.find((query) => query.sql.includes('DELETE FROM operator_login_attempts WHERE company_id = $1 AND device_id = $2'));
    expect(clear.params).toEqual(['co-1', 'dev-1', auth.loginAttemptKey('co-1', 'dev-1', 'op-1')]);
    expect(clear.params).not.toContain('op-1');
  });

  it('keeps the limiter schema, migration, and runtime role replay-safe and least-privileged', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
    const migration = fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', 'deploy_operator_auth_rate_limit_migration.sql'), 'utf8');
    const roles = fs.readFileSync(path.join(__dirname, '..', 'database', 'production_roles.sql'), 'utf8');

    expect(schema).toContain('CREATE TABLE IF NOT EXISTS operator_login_attempts');
    expect(schema).toContain('CREATE INDEX IF NOT EXISTS idx_operator_login_attempts_expiry');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS operator_login_attempts');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS idx_operator_login_attempts_expiry');
    expect(roles).toContain('operator_login_attempts');
    expect(roles).toContain('NOCREATEROLE');
    expect(roles).toContain('NOSUPERUSER');
    expect(roles).toContain('ALTER ROLE novda_app');
    expect(roles).toContain('NOCREATEDB');
    expect(roles).toContain('NOREPLICATION');
    expect(roles).not.toMatch(/GRANT\s+(?:[^;\n]*\b)?(?:ALTER|DROP)\b/i);
  });
});
