import { describe, expect, it, vi } from 'vitest';

const { claimWorkerBinding, getWorkerForEnrollment, getWorkerProfile, unbindWorkerTelegramBinding } = require('./workerService.cjs');

describe('worker binding credential enforcement', () => {
  it('keeps captured zero distinct from unknown and marks only scoped confirmed work incomplete', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM worker_telegram_bindings b')) {
          return { rows: [{ worker_id: 180, company_id: 'comp_novda', worker_name: 'Worker 180', status: 'ACTIVE', staj: 0 }] };
        }
        if (sql.includes('FROM periods')) {
          return { rows: [{ id: 'october', start_date: '2026-10-05', end_date: null, is_closed: false }] };
        }
        if (sql.includes('FROM ticket_entries e')) {
          expect(sql).toContain('e.rate_snapshot::TEXT AS rate');
          expect(sql).toContain("t.status = 'CONFIRMED'");
          expect(sql).toContain('e.company_id = $1');
          expect(sql).toContain('t.period_id = $2');
          expect(sql).toContain('t.period_id IS NULL');
          expect(sql).not.toContain('rates.rate');
          return { rows: [
            { worker_id: 180, period_id: 'october', model_id: 'body-long', model_name: 'BODY-LONG', op_name: 'Known', rate: '5', qty: '2' },
            { worker_id: 180, period_id: 'october', model_id: 'body-long', model_name: 'BODY-LONG', op_name: 'Zero', rate: '0', qty: '3' },
            { worker_id: 180, period_id: 'october', model_id: 'body-long', model_name: 'BODY-LONG', op_name: 'Unknown', rate: null, qty: '4' }
          ] };
        }
        if (sql.includes('FROM worker_adjustments')) {
          expect(sql).toContain('period_id = $2');
          return { rows: [{ worker_id: 180, type: 'AVANS', total: '12' }] };
        }
        if (sql.includes('FROM models')) {
          return { rows: [{ id: 'body-long', operations: [
            { name: 'Known', rate: 5 }, { name: 'Zero', rate: 0 }
          ] }] };
        }
        return { rows: [] };
      }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client) };

    await expect(getWorkerProfile(pool, {
      companyId: 'comp_novda', workerId: 180, telegramId: '8363499557'
    })).resolves.toMatchObject({
      gross: 10, net: -2, pieces: 9, unknownEntryCount: 1, unknownQuantity: 4,
      accountingStatus: 'INCOMPLETE', accountingReasons: ['UNKNOWN_HISTORICAL_RATE'],
      models_breakdown: {
        'body-long': { earnings: 10, operations: [{ rate: 5, amount: 10 }, { rate: 0, amount: 0 }, { rate: null, amount: null }] }
      }
    });
    expect(client.query.mock.calls.filter(([sql]) => sql.includes('FROM ticket_entries e') || sql.includes('FROM worker_adjustments')).map(([, params]) => params))
      .toEqual([['comp_novda', 'october', 180], ['comp_novda', 'october', '2026-10-05', 180, null]]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([{ rate: '0', amount: '0' }, { rate: '5', amount: '20' }])('treats known rate $rate as complete', async ({ rate, amount }) => {
    const client = { query: vi.fn(async (sql: string) => ({ rows: sql.includes('FROM worker_telegram_bindings b')
      ? [{ worker_id: 180, company_id: 'comp_novda', worker_name: 'Worker', status: 'ACTIVE' }]
      : sql.includes('FROM periods') ? [{ id: 'p', start_date: '2026-10-05', is_closed: false }]
      : sql.includes('FROM ticket_entries e') ? [{ worker_id: 180, period_id: 'p', model_id: 'm', model_name: 'M', op_name: 'Op', rate: '5', qty: '4' }]
      : sql.includes('FROM models') ? [{ id: 'm', operations: [{ name: 'Op', rate: Number(rate) }] }] : [] })), release: vi.fn() };
    const result = await getWorkerProfile({ connect: async () => client }, { companyId: 'comp_novda', workerId: 180, telegramId: '123' });
    expect(result).toMatchObject({ gross: Number(amount), accountingStatus: 'COMPLETE', accountingReasons: [], unknownEntryCount: 0, unknownQuantity: 0 });
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
        if (sql.includes('SELECT telegram_id, company_id, worker_id, username FROM worker_telegram_bindings WHERE telegram_id')) {
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
        if (sql.includes('SELECT telegram_id, company_id, worker_id, username FROM worker_telegram_bindings WHERE telegram_id')) {
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
