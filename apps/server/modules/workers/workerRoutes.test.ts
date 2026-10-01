import { expect, it } from 'vitest';

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
  } finally {
    await app.close();
  }
});
