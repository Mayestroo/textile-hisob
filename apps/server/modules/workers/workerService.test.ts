import { describe, expect, it, vi } from 'vitest';

const { claimWorkerBinding, getWorkerForEnrollment, getWorkerProfile, unbindWorkerTelegramBinding } = require('./workerService.cjs');

describe('worker binding credential enforcement', () => {
  it('falls back from a zero ticket rate snapshot to the current model rate for the profile and work breakdown', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM worker_telegram_bindings b')) {
          return { rows: [{ worker_id: 180, company_id: 'comp_novda', worker_name: 'Worker 180', status: 'ACTIVE', staj: 0 }] };
        }
        if (sql.includes('SELECT start_date, end_date, is_closed FROM periods')) {
          return { rows: [{ start_date: '2026-10-05', end_date: null, is_closed: false }] };
        }
        if (sql.includes('FROM ticket_entries e')) {
          expect(sql.match(/NULLIF\(e\.rate_snapshot, 0\)/g)).toHaveLength(2);
          return { rows: [{
            model_id: 'body-long', model_name: 'BODY-LONG', operation_name: 'POYCHA RASHMA',
            rate: '400', qty: '208', amount: '83200'
          }] };
        }
        if (sql.includes('FROM worker_adjustments')) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client) };

    await expect(getWorkerProfile(pool, {
      companyId: 'comp_novda', workerId: 180, telegramId: '8363499557'
    })).resolves.toMatchObject({
      gross: 83200,
      pieces: 208,
      models_breakdown: {
        'body-long': { operations: [{ rate: 400, qty: 208, amount: 83200 }] }
      }
    });
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('reports the server-wide PIN-disabled enrollment policy', async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{
        worker_id: 190,
        company_id: 'comp_novda',
        worker_name: 'Worker 190',
        status: 'ACTIVE',
        staj: 0,
        pin_configured: false
      }] }))
    };

    await expect(getWorkerForEnrollment(pool, 'comp_novda', 190, { pinRequired: false }))
      .resolves.toMatchObject({ worker_id: 190, pin_required: false, pin_configured: false });
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

  it('unbinds only the requested mapping for a company-scoped admin and writes an audit event', async () => {
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('SELECT binding.telegram_id')) {
          return { rows: [{ telegram_id: '8363499557', company_id: 'comp_novda', worker_id: 180, worker_name: 'Worker 180' }] };
        }
        if (sql.includes('DELETE FROM worker_telegram_bindings')) {
          expect(params).toEqual(['comp_novda', 180, '8363499557']);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
      }),
      release: vi.fn()
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [{ company_id: 'comp_novda' }] })),
      connect: vi.fn(async () => client)
    };

    await expect(unbindWorkerTelegramBinding(pool, {
      companyId: 'comp_novda', workerId: 180, telegramId: '8363499557', adminTelegramId: '274466315'
    })).resolves.toMatchObject({ companyId: 'comp_novda', workerId: 180, telegramId: '8363499557', unboundBy: '274466315' });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("'UNBOUND'"), ['comp_novda', 180, '8363499557', '274466315']);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('refuses to remove a different Telegram account bound to the worker', async () => {
    const client = {
      query: vi.fn(async (sql: string) => sql.includes('SELECT binding.telegram_id')
        ? { rows: [{ telegram_id: '9999999999', company_id: 'comp_novda', worker_id: 180, worker_name: 'Worker 180' }] }
        : { rows: [] }),
      release: vi.fn()
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [{ company_id: 'comp_novda' }] })),
      connect: vi.fn(async () => client)
    };

    await expect(unbindWorkerTelegramBinding(pool, {
      companyId: 'comp_novda', workerId: 180, telegramId: '8363499557', adminTelegramId: '274466315'
    })).rejects.toMatchObject({ code: 'WORKER_BINDING_MISMATCH', statusCode: 409 });
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM worker_telegram_bindings'), expect.anything());
    expect(client.release).toHaveBeenCalledOnce();
  });
});
