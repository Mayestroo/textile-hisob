import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fastify from 'fastify';

const { claimWorkerBinding, hashWorkerPin } = require('./workerService.cjs');
const { registerWorkerRoutes } = require('./workerRoutes.cjs');
const input = { companyId: 'company-a', workerId: 27, telegramId: '123456789', username: 'fixture', pin: '1234' };
const expectedBinding = { company_id: 'company-a', worker_id: 27, telegram_id: '123456789', username: 'fixture', worker_name: 'Fixture <Worker>' };

// Stateful query-contract double, NOT PostgreSQL. Unexpected SQL fails closed.
function fixture() {
  const credential = hashWorkerPin('1234', Buffer.alloc(16, 7));
  const state = { binding: null as null | Record<string, unknown>, status: 'ACTIVE', companyActive: true, inserts: 0 };
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(q)) return { rows: [] };
      if (q === 'SELECT pg_advisory_xact_lock(hashtext($1))') {
        expect(params).toHaveLength(1);
        expect(String(params[0])).toMatch(/^novda:worker-(binding|telegram):/);
        return { rows: [] };
      }
      if (/^SELECT telegram_id, company_id, worker_id(?:, username)? FROM worker_telegram_bindings WHERE telegram_id = \$1 FOR UPDATE$/.test(q)) {
        const b = state.binding;
        if (!b || b.telegram_id !== params[0]) return { rows: [] };
        // Model the actual SELECT projection rather than returning extra fields.
        return { rows: [{ telegram_id: b.telegram_id, company_id: b.company_id, worker_id: b.worker_id,
          ...(q.includes(', username') ? { username: b.username } : {}) }] };
      }
      if (q.startsWith('SELECT w.id, w.company_id, w.name, w.status, credential.pin_salt')) {
        expect(q).toContain('company.is_active = TRUE');
        expect(q).toContain('WHERE w.company_id = $1 AND w.id = $2 FOR UPDATE OF w');
        expect(params).toEqual([input.companyId, input.workerId]);
        return { rows: state.companyActive ? [{ id: 27, company_id: 'company-a', name: expectedBinding.worker_name,
          status: state.status, pin_salt: credential.salt, pin_hash: credential.hash }] : [] };
      }
      if (q === 'SELECT telegram_id FROM worker_telegram_bindings WHERE company_id = $1 AND worker_id = $2 FOR UPDATE') {
        expect(params).toEqual([input.companyId, input.workerId]);
        return { rows: state.binding ? [{ telegram_id: state.binding.telegram_id }] : [] };
      }
      if (q.startsWith('INSERT INTO worker_telegram_bindings (telegram_id, company_id, worker_id, username)')) {
        expect(params).toEqual([input.telegramId, input.companyId, input.workerId, input.username]);
        if (state.binding) throw new Error('Fixture duplicate binding');
        state.binding = { telegram_id: params[0], company_id: params[1], worker_id: params[2], username: params[3] };
        state.inserts++;
        return { rows: [] };
      }
      if (q === 'DELETE FROM worker_binding_limits WHERE telegram_id = $1 AND company_id = $2') {
        expect(params).toEqual([input.telegramId, input.companyId]);
        return { rows: [] };
      }
      throw new Error(`Unexpected fixture query: ${q}`);
    })
  };
  return { state, client, pool: { connect: vi.fn(async () => client) } };
}

async function routeResponses() {
  const data = fixture();
  const app = fastify();
  registerWorkerRoutes(app, { pool: data.pool, env: {}, workerApiToken: 'fixture-service-token', workerAuthHmacSecret: 'fixture-hmac' });
  try {
    const request = { method: 'POST' as const, url: '/api/worker/bindings', headers: { 'x-novda-worker-token': 'fixture-service-token' } };
    const unauthorized = await app.inject({ method: 'POST', url: request.url, payload: input });
    expect(unauthorized.statusCode).toBe(401);
    expect(data.pool.connect).not.toHaveBeenCalled();
    const fresh = await app.inject({ ...request, payload: input });
    // Simulate a lost first response: repeat the same claim with no PIN.
    const retry = await app.inject({ ...request, payload: { ...input, pin: undefined, username: 'changed-on-retry' } });
    expect([fresh.statusCode, retry.statusCode]).toEqual([201, 201]);
    expect(data.state.inserts).toBe(1);
    expect(data.client.release).toHaveBeenCalledTimes(2);
    return [fresh.json(), retry.json()];
  } finally { await app.close(); }
}

describe('binding success/retry contract (real handlers, simulated queries/transport)', () => {
  it('returns the same complete public binding DTO on first claim and retry', async () => {
    const responses = await routeResponses();
    expect(responses).toEqual([
      { success: true, binding: expectedBinding }, { success: true, binding: expectedBinding }
    ]);
  });

  it('feeds both actual HTTP response bodies through Python finish_registration and profile rendering', async () => {
    const responses = await routeResponses();
    const root = path.resolve(__dirname, '../../../..');
    const python = spawnSync(process.env.PYTHON || 'python', ['-B', 'apps/bots/worker/test_worker_privacy.py', '--binding-contract'], {
      cwd: root, encoding: 'utf8', input: JSON.stringify(responses),
      env: { ...process.env, WORKER_WEBAPP_URL: '', NOVDA_WORKER_API_URL: '' }
    });
    expect(python.error).toBeUndefined();
    expect(python.status, python.stderr).toBe(0);
    expect(python.stdout).toContain('fresh and retry DTOs consumed by finish_registration');
  });

  it.each(['company', 'worker'])('rejects a conflicting %s retry without mutating the original binding', async (kind) => {
    const { pool, state, client } = fixture();
    await claimWorkerBinding(pool, input);
    const before = { ...state.binding };
    await expect(claimWorkerBinding(pool, { ...input, ...(kind === 'company' ? { companyId: 'company-b' } : { workerId: 28 }) }))
      .rejects.toMatchObject({ code: 'TELEGRAM_ACCOUNT_ALREADY_BOUND', statusCode: 409 });
    expect(state.binding).toEqual(before);
    expect(state.inserts).toBe(1);
    expect(client.release).toHaveBeenCalledTimes(2);
  });

  it('does not let another Telegram identity claim the already bound worker', async () => {
    const { pool, state } = fixture();
    await claimWorkerBinding(pool, input);
    await expect(claimWorkerBinding(pool, { ...input, telegramId: '987654321' }))
      .rejects.toMatchObject({ code: 'WORKER_ALREADY_BOUND', statusCode: 409 });
    expect(state.inserts).toBe(1);
  });

  it.each(['worker', 'company'])('does not return success for a retry after %s deactivation', async (kind) => {
    const { pool, state } = fixture();
    await claimWorkerBinding(pool, input);
    if (kind === 'worker') state.status = 'INACTIVE';
    else state.companyActive = false;
    await expect(claimWorkerBinding(pool, input)).rejects.toMatchObject({ code: 'WORKER_NOT_FOUND', statusCode: 404 });
    expect(state.inserts).toBe(1);
  });
});
