import { describe, expect, it, vi } from 'vitest';

const { claimWorkerBinding, getWorkerForEnrollment } = require('./workerService.cjs');

describe('worker binding credential enforcement', () => {
  it('reports the server-wide PIN-disabled enrollment policy', async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{
        worker_id: 190,
        company_id: 'comp_novda',
        worker_name: 'Worker 190',
        status: 'ACTIVE',
        staj: 0,
        pin_required: false
      }] }))
    };

    await expect(getWorkerForEnrollment(pool, 'comp_novda', 190, { pinRequired: false }))
      .resolves.toMatchObject({ worker_id: 190, pin_required: false });
  });

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

  it('permits Telegram binding without a PIN only when the explicit server policy disables it', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('SELECT telegram_id, company_id, worker_id FROM worker_telegram_bindings WHERE telegram_id')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT w.id, w.company_id, w.name, w.status, credential.pin_salt')) {
          return {
            rows: [{ id: 190, company_id: 'comp_novda', name: 'Worker 190', status: 'ACTIVE', pin_salt: null, pin_hash: null }]
          };
        }
        if (sql.includes('SELECT telegram_id FROM worker_telegram_bindings WHERE company_id')) return { rows: [] };
        if (sql.includes('INSERT INTO worker_telegram_bindings')) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client) };

    await expect(claimWorkerBinding(pool, {
      companyId: 'comp_novda', workerId: 190, telegramId: '123456789', username: 'claimant'
    }, { pinRequired: false })).resolves.toMatchObject({ worker_id: 190, company_id: 'comp_novda' });

    expect(statements.some((sql) => sql.includes('INSERT INTO worker_telegram_bindings'))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
