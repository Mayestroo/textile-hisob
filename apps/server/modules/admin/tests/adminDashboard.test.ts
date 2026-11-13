import { describe, expect, it, vi } from 'vitest';

const { createAdminDashboardService, getTashkentDateString } = require('../adminDashboard.cjs');

function serviceFor(query: ReturnType<typeof vi.fn>, overrides = {}) {
  return createAdminDashboardService({
    pool: { query },
    ...overrides
  });
}

describe(' admin dashboard PostgreSQL projections', () => {
  it.each([null, undefined, '', '  ', false, true, [], {}].map(rate => ({ rate })))('rejects unknown or non-price values instead of coercing $rate to zero', async ({ rate }) => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ company_id: 'comp_novda' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'm', status: 'ACTIVE', operations_json: [{ name: 'Sew', rate: null }] }] });
    await expect(serviceFor(query).updateModelRates('274466315', {
      companyId: 'comp_novda', modelId: 'm', baseRevision: 0, operations: [{ name: 'Sew', rate }]
    })).rejects.toMatchObject({ code: 'INVALID_MODEL_OPERATIONS', statusCode: 400 });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('returns overview counts from one PostgreSQL projection', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      company_count: '1', worker_count: '201', model_count: '18', party_count: '42',
      device_count: '0', pending_activation_count: '0', active_activation_count: '0', worker_binding_count: '102'
    }] });

    const result = await serviceFor(query).overview();

    expect(result).toEqual({ companies: 1, workers: 201, models: 18, parties: 42, devices: 0, pendingActivations: 0, activeActivations: 0, workerBindings: 102, recentSyncAt: null });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('activation_requests');
  });

  it('lists company IDs and PostgreSQL activation policy without Firebase names', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      company_id: 'comp_novda', company_name: null, is_active: null,
      allowed_roles: null, require_ticket_validation: null,
      business_scope_exists: true,
      worker_count: '201', model_count: '18', party_count: '42'
    }] });

    const result = await serviceFor(query).listCompanies();

    expect(result[0]).toMatchObject({
      companyId: 'comp_novda', companyName: 'comp_novda',
      activationConfigured: false, businessScopeExists: true,
      workerCount: 201, modelCount: 18, partyCount: 42
    });
    expect(query.mock.calls[0][0]).toContain('activation_companies');
    expect(query.mock.calls[0][0]).toContain('company_batch_settings');
  });

  it('returns registered devices and activation requests without request credentials', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ device_id: 'device-a', company_id: 'comp_novda', client_version: '2.0.0', is_revoked: false, registered_at: '2026-09-24T00:00:00.000Z' }] })
      .mockResolvedValueOnce({ rows: [{ request_id: 'request-a', machine_id: '1111-2222-3333-4444', status: 'PENDING', requested_at: '2026-09-24T00:00:00.000Z' }] });

    const result = await serviceFor(query).listDevices();

    expect(result.registered[0]).toMatchObject({ deviceId: 'device-a', companyId: 'comp_novda', revoked: false });
    expect(result.activationRequests[0]).toMatchObject({ requestId: 'request-a', machineId: '1111-2222-3333-4444', status: 'PENDING' });
    expect(query.mock.calls.join(' ')).not.toContain('request_token_hash');
  });

  it('checks company grants before reading a worker for an edit request', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ company_id: 'comp_novda' }] });

    await expect(serviceFor(query).updateWorker('274466315', {
      companyId: 'other_company', workerId: 180, baseRevision: 0, name: 'Ali'
    })).rejects.toMatchObject({ code: 'ADMIN_COMPANY_SCOPE_REQUIRED', statusCode: 403 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('activation_company_admins');
  });

  it('returns worker data without PIN material and applies bounded filters', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      worker_id: 200, company_id: 'comp_novda', worker_name: 'Known Worker', status: 'ACTIVE',
      total_count: '1',
      staj: '0', role: 'worker', telegram_id: '12345678', username: 'worker', linked_at: '2026-09-24T00:00:00.000Z'
    }] });

    const result = await serviceFor(query).listWorkers({ companyId: 'comp_novda', search: 'Known', limit: 999, offset: -10 });

    expect(result.workers[0]).toEqual({
      workerId: 200, companyId: 'comp_novda', name: 'Known Worker', status: 'ACTIVE',
      staj: 0, role: 'worker', serverRevision: 0,
      binding: { telegramId: '12345678', username: 'worker', linkedAt: '2026-09-24T00:00:00.000Z' }
    });
    expect(query.mock.calls[0][1]).toEqual(['comp_novda', '%Known%', 100, 0, false]);
    expect(query.mock.calls[0][0]).not.toContain('pin_hash');
  });

  it('calculates payroll from  ticket and adjustment facts and keeps an empty baseline empty', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'period-1', name: 'Current period', start_date: new Date('2026-09-01T00:00:00.000Z'), end_date: null, is_closed: 0 }] })
      .mockResolvedValueOnce({ rows: [{
        worker_id: 200, worker_name: 'Known Worker', status: 'ACTIVE', staj: '0'
      }] }).mockResolvedValue({ rows: [] });

    const result = await serviceFor(query).getPayroll({ companyId: 'comp_novda' });

    expect(result.period).toMatchObject({ periodId: 'period-1', name: 'Current period' });
    expect(result.workers[0]).toMatchObject({ workerId: 200, gross: 0, avans: 0, jarima: 0, net: 0, pieces: 0, accountingStatus: 'COMPLETE', unknownEntryCount: 0 });
    expect(query.mock.calls[2][0]).toContain('ticket_entries');
    expect(query.mock.calls[3][0]).toContain('production_adjustments');
    expect(query.mock.calls[4][0]).toContain('worker_adjustments');
    expect(query.mock.calls[4][0]).toContain("status = 'POSTED'");
    expect(query.mock.calls[4][1]).toEqual(['comp_novda', 'period-1', '2026-09-01', null, null]);
  });

  it('scopes closed-period earnings by explicit period without date-inferred money', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'period-closed', name: 'September', start_date: new Date('2026-09-01T00:00:00.000Z'), end_date: new Date('2026-09-30T00:00:00.000Z'), is_closed: 1 }] })
      .mockResolvedValueOnce({ rows: [{ worker_id: 200, worker_name: 'Known Worker', status: 'ACTIVE', staj: '0' }] })
      .mockResolvedValue({ rows: [] });

    const result = await serviceFor(query).getPayroll({ companyId: 'comp_novda', periodId: 'period-closed' });

    expect(result.period).toMatchObject({ isClosed: true, restated: true });
    expect(query.mock.calls[0][1]).toEqual(['comp_novda', 'period-closed']);
    expect(query.mock.calls[2][0]).toContain("t.status = 'CONFIRMED'");
    expect(query.mock.calls[2][0]).not.toContain('submitted_at');
    expect(query.mock.calls[3][0]).toContain('original.original_period_id = $2');
    expect(query.mock.calls[3][0]).not.toContain('created_at');
  });

  it('reports worker-specific unknown counts alongside resolved subtotals and legacy DTO fields', async () => {
    const archive = { period: { id: 'period-closed', companyId: 'company-a' }, models: [{ id: 'm', operations: [
      { name: 'Known', rate: 5 }, { name: 'Unknown', rate: null }, { name: 'Zero', rate: 0 }
    ] }] };
    const { canonicalStringify, computePayloadHash } = require('../../sync/canonicalPayload.cjs');
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'period-closed', name: 'September', start_date: '2026-09-01', end_date: '2026-09-30', is_closed: 1 }] })
      .mockResolvedValueOnce({ rows: [
        { worker_id: 1, worker_name: 'Mixed', staj: '0' },
        { worker_id: 2, worker_name: 'Known zero', staj: '0' }
      ] })
      .mockResolvedValueOnce({ rows: [
        { worker_id: 1, period_id: 'period-closed', model_id: 'm', model_name: 'M', op_name: 'Known', rate: '5', qty: '2' },
        { worker_id: 1, period_id: 'period-closed', model_id: 'm', model_name: 'M', op_name: 'Unknown', rate: null, qty: '4' },
        { worker_id: 2, period_id: 'period-closed', model_id: 'm', model_name: 'M', op_name: 'Zero', rate: '0', qty: '3' }
      ] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ worker_id: 1, type: 'AVANS', total: '12' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ archive_json: archive, sha256: computePayloadHash(canonicalStringify(archive)) }] });
    const result = await serviceFor(query).getPayroll({ companyId: 'company-a', periodId: 'period-closed' });
    expect(result.workers).toMatchObject([
      { gross: 10, net: -2, unknownEntryCount: 1, unknownQuantity: 4, accountingStatus: 'INCOMPLETE', accountingReasons: expect.arrayContaining(['UNKNOWN_HISTORICAL_RATE']) },
      { gross: 0, net: 0, unknownEntryCount: 0, accountingStatus: 'INCOMPLETE', accountingReasons: ['HISTORICAL_BASELINE_UNVERIFIED'] }
    ]);
    expect(query.mock.calls[2][1]).toEqual(['company-a', 'period-closed', null]);
  });

  it('reads models, parties, ticket facts and balances from bounded canonical projections', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ company_id: 'comp_novda', id: 'm1', name: 'Model', operations_json: [{ name: 'Sew', rate: 2 }], available_sizes_json: ['S'], model_server_revision: 11, settings_server_revision: 8 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'party-1', company_id: 'comp_novda', party_number: '2', model_id: 'm1', model_name: 'Model', status: 'ACTIVE', patta_count: 12, ish_soni: '4', server_revision: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ticket-1', company_id: 'comp_novda', model_id: 'm1', model_name: 'Model', party_record_id: 'party-1', party_number: '2', patta_number: 1, qty: '8', entry_qty: '8', status: 'CONFIRMED', submitted_at: '2026-09-24T00:00:00.000Z', worker_id: 200, worker_name: 'Worker', op_name: 'Sew' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'period-current', name: 'October 2026', start_date: '2026-10-01', end_date: null, is_closed: 0 }] })
      .mockResolvedValueOnce({ rows: [{ worker_id: 200, name: 'Worker', type: 'AVANS', total: '2020000', fact_count: '4', opening_fact_count: '0' }] });
    const service = serviceFor(query);

    await expect(service.listModels({ companyId: 'comp_novda' })).resolves.toMatchObject({ models: [{ modelId: 'm1', modelRevision: 11, serverRevision: 8 }] });
    await expect(service.listParties({ companyId: 'comp_novda' })).resolves.toMatchObject({ parties: [{ partyNumber: '2', pattaCount: 12 }] });
    await expect(service.listTickets({ companyId: 'comp_novda' })).resolves.toMatchObject({ tickets: [{ ticketId: 'ticket-1', workerId: 200 }] });
    await expect(service.getBalances({ companyId: 'comp_novda', periodId: 'period-current' })).resolves.toMatchObject({
      period: { periodId: 'period-current', name: 'October 2026', isClosed: false },
      facts: [{ total: 2020000, factCount: 4, openingFactCount: 0 }]
    });
    expect(query.mock.calls.slice(0, 3).every((call) => call[0].includes('LIMIT'))).toBe(true);
    expect(query.mock.calls[4][0]).toContain('a.period_id = $2');
    expect(query.mock.calls[4][1]).toEqual(['comp_novda', 'period-current', '2026-10-01', null]);
  });

  it('generates daily production report with Tashkent date and model breakdowns', async () => {
    const query = vi.fn()
      // 1. cut query
      .mockResolvedValueOnce({
        rows: [
          { company_id: 'comp_novda', company_name: 'Novda Textile', model_id: 'm1', model_name: 'DZ-008-1', ticket_count: 5, qty: '800' },
          { company_id: 'comp_novda', company_name: 'Novda Textile', model_id: 'm2', model_name: 'Брайс-Турси', ticket_count: 2, qty: '200' }
        ]
      })
      // 2. entry query
      .mockResolvedValueOnce({
        rows: [
          { company_id: 'comp_novda', company_name: 'Novda Textile', model_id: 'm1', model_name: 'DZ-008-1', entry_count: 12, qty: '500' }
        ]
      })
      // 3. admins query
      .mockResolvedValueOnce({
        rows: [
          { company_id: 'comp_novda', telegram_id: '274466315' }
        ]
      })
      // 4. companies query
      .mockResolvedValueOnce({
        rows: [
          { company_id: 'comp_novda', company_name: 'Novda Textile' }
        ]
      });

    const service = serviceFor(query);
    const result = await service.dailyProductionReport({ companyId: 'comp_novda', date: '2026-11-10' });

    expect(result.date).toBe('2026-11-10');
    expect(result.companyId).toBe('comp_novda');
    expect(result.report).toBeDefined();
    expect(result.report.companyName).toBe('Novda Textile');
    expect(result.report.adminTelegramIds).toEqual(['274466315']);
    
    // Bichilgan son: total 1000 dona (7 ta patta)
    expect(result.report.cutProduction.totalQty).toBe(1000);
    expect(result.report.cutProduction.totalTickets).toBe(7);
    expect(result.report.cutProduction.byModel).toEqual([
      { modelId: 'm1', modelName: 'DZ-008-1', qty: 800, ticketCount: 5 },
      { modelId: 'm2', modelName: 'Брайс-Турси', qty: 200, ticketCount: 2 }
    ]);

    // Kiritilgan son: total 500 dona (12 ta operatsiya)
    expect(result.report.enteredProduction.totalQty).toBe(500);
    expect(result.report.enteredProduction.totalEntries).toBe(12);
    expect(result.report.enteredProduction.byModel).toEqual([
      { modelId: 'm1', modelName: 'DZ-008-1', qty: 500, entryCount: 12 }
    ]);

    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[0][1]).toEqual(['comp_novda', '2026-11-10']);
  });

  it('computes Tashkent date string helper properly', () => {
    // 2026-11-09T20:00:00Z is 2026-11-10 01:00:00 in Tashkent (UTC+5)
    const dt = new Date('2026-11-09T20:00:00.000Z');
    expect(getTashkentDateString(dt)).toBe('2026-11-10');
  });
});
