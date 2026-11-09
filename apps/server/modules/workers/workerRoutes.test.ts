import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const Fastify = require('fastify');
const { registerWorkerRoutes } = require('./workerRoutes.cjs');

it('serves the packaged worker Telegram WebApp from the repository-root asset path', async () => {
  const app = Fastify();
  registerWorkerRoutes(app, {
    pool: { query: async () => ({ rows: [] }) },
    workerApiToken: 'test-worker-token',
    workerAuthHmacSecret: 'test-worker-auth-secret'
  });

  try {
    const response = await app.inject({ method: 'GET', url: '/worker-app' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Telegram WebApp SDK');
    expect(response.body).toContain('/api/worker/profile');
    for (const name of ['IBMPlexSans[wdth,wght].ttf', 'Onest[wght].ttf']) {
      const font = await app.inject({ method: 'GET', url: `/worker-app-font/${encodeURIComponent(name)}` });
      expect(font.statusCode).toBe(200);
      expect(font.headers['content-type']).toContain('font/ttf');
      expect(font.rawPayload).toEqual(readFileSync(join(__dirname, '../../../bots/worker/webapp', name)));
      expect(font.rawPayload).toEqual(readFileSync(join(__dirname, '../../../desktop/renderer/assets/fonts', name)));
    }
    expect((await app.inject({ method: 'GET', url: '/worker-app-font/private.txt' })).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});

it('authenticates the bound worker and validates explicit closed period on the profile route', async () => {
  const calls: unknown[][] = [];
  const client = { query: async (sql: string, params: unknown[]) => {
    calls.push([sql, params]);
    if (sql.includes('FROM worker_telegram_bindings b')) return { rows: [{ worker_id: 7, company_id: 'tenant', worker_name: 'W', status: 'ACTIVE', staj: 0 }] };
    if (sql.includes('FROM periods')) return { rows: params[1] === 'P' ? [{ id: 'P', name: 'Closed', start_date: '2026-09-01', is_closed: true }] : [] };
    return { rows: [] };
  }, release() {} };
  const app = Fastify();
  registerWorkerRoutes(app, { pool: { connect: async () => client }, workerApiToken: 'fixture-token', workerAuthHmacSecret: 'fixture-hmac' });
  try {
    const url = '/api/worker/profile?companyId=tenant&workerId=7&telegramId=123&periodId=P';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const headers = { 'x-novda-worker-token': 'fixture-token' };
    const result = await app.inject({ method: 'GET', url, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json().profile).toMatchObject({ worker_id: 7, periodId: 'P', period: { isClosed: true }, gross: 0 });
    expect(calls.filter(([sql]) => String(sql).includes('FROM periods')).at(-1)?.[1]).toEqual(['tenant', 'P']);
    const invalid = await app.inject({ method: 'GET', url: `${url}&periodId=`, headers });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_PERIOD_ID');
    const other = await app.inject({ method: 'GET', url: url.replace('periodId=P', 'periodId=other'), headers });
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe('PERIOD_NOT_FOUND');
  } finally { await app.close(); }
});
