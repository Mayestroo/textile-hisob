import { describe, expect, it, vi } from 'vitest';

const { claimWorkerBinding } = require('./workerService.cjs');

describe('worker binding credential enforcement', () => {
  it('refuses to bind a worker without a configured PIN credential', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT telegram_id, company_id, worker_id FROM worker_telegram_bindings WHERE telegram_id')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT w.id, w.company_id, w.name, w.status, credential.pin_salt')) {
          return {
            rows: [{ id: 27, company_id: 'company-a', name: 'Worker 27', status: 'ACTIVE', pin_salt: null, pin_hash: null }]
          };
        }
        return { rows: [] };
      }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client) };

    await expect(claimWorkerBinding(pool, {
      companyId: 'company-a', workerId: 27, telegramId: '123456789', username: 'claimant'
    })).rejects.toMatchObject({ code: 'WORKER_ENROLLMENT_NOT_CONFIGURED', statusCode: 409 });

    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO worker_telegram_bindings'), expect.anything());
    expect(client.release).toHaveBeenCalledOnce();
  });
});
