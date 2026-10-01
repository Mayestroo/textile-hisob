import { describe, expect, it, vi } from 'vitest';

const { createAdminDashboardService } = require('./adminDashboard.cjs');

function serviceFor(query: ReturnType<typeof vi.fn>, overrides = {}) {
  return createAdminDashboardService({
    pool: { query },
    allowedAdminIds: new Set(['1526974123']),
    ...overrides
  });
}

describe(' admin dashboard PostgreSQL projections', () => {
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

  it('registers activation policy only against an existing business company scope', async () => {
    const policy = {
      company_id: 'comp_novda', company_name: 'comp_novda',
      allowed_roles: ['admin', 'type', 'print'], require_ticket_validation: true,
      is_active: true, updated_by_source: 'TELEGRAM_ADMIN'
    };
    const query = vi.fn().mockResolvedValue({ rows: [policy] });

    const result = await serviceFor(query).upsertCompany('1526974123', {
      companyId: 'comp_novda', companyName: 'comp_novda',
      allowedRoles: ['admin', 'type', 'print'], requireTicketValidation: true
    });

    expect(result).toEqual(policy);
    expect(query.mock.calls[0][0]).toContain('FROM company_batch_settings');
    expect(query.mock.calls[0][0]).toContain('updated_by_source');
    expect(query.mock.calls[0][1]).toEqual([
      'comp_novda', 'comp_novda', ['admin', 'type', 'print'], true, '1526974123'
    ]);
  });

  it('supports disabling a policy without turning it back on during an edit', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ company_id: 'comp_novda', is_active: false }] });
    await serviceFor(query).upsertCompany('1526974123', {
      companyId: 'comp_novda', companyName: 'Novda', allowedRoles: ['admin'],
      requireTicketValidation: false, isActive: false
    });
    expect(query.mock.calls[0][0]).toContain('is_active = EXCLUDED.is_active');
    expect(query.mock.calls[0][0]).toContain('require_ticket_validation = activation_companies.require_ticket_validation');
    expect(query.mock.calls[0][0]).toContain('SELECT $1::VARCHAR, $2, $3, TRUE');
    expect(query.mock.calls[0][1]).toEqual(['comp_novda', 'Novda', ['admin'], false, '1526974123']);
  });

  it('rejects an activation policy when the business scope does not exist', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(serviceFor(query).upsertCompany('1526974123', {
      companyId: 'company-does-not-exist', companyName: 'Unknown', allowedRoles: ['admin']
    })).rejects.toMatchObject({ code: 'CANONICAL_COMPANY_NOT_FOUND', statusCode: 404 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects roles outside the activation role registry', async () => {
    const query = vi.fn();

    await expect(serviceFor(query).upsertCompany('1526974123', {
      companyId: 'comp_novda', companyName: 'comp_novda', allowedRoles: ['owner']
    })).rejects.toMatchObject({ code: 'INVALID_ACTIVATION_ROLES', statusCode: 400 });
    expect(query).not.toHaveBeenCalled();
  });

  it('does not approve activation against an inactive company policy', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ request_id: '00000000-0000-4000-8000-000000000001', status: 'PENDING', machine_id: '1111-2222-3333-4444' }] })
      .mockResolvedValueOnce({ rows: [] });
    const signerClient = vi.fn();

    await expect(serviceFor(query, { signerClient }).approveActivation('1526974123', {
      requestId: '00000000-0000-4000-8000-000000000001', companyId: 'comp_novda', role: 'admin'
    })).rejects.toMatchObject({ code: 'ACTIVATION_ROLE_NOT_ALLOWED', statusCode: 403 });
    expect(signerClient).not.toHaveBeenCalled();
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

  it('returns worker data without PIN material and applies bounded filters', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      worker_id: 200, company_id: 'comp_novda', worker_name: 'Known Worker', status: 'ACTIVE',
      total_count: '1',
      staj: '0', role: 'worker', telegram_id: '12345678', username: 'worker', linked_at: '2026-09-24T00:00:00.000Z'
    }] });

    const result = await serviceFor(query).listWorkers({ companyId: 'comp_novda', search: 'Known', limit: 999, offset: -10 });

    expect(result.workers[0]).toEqual({
      workerId: 200, companyId: 'comp_novda', name: 'Known Worker', status: 'ACTIVE',
      staj: 0, role: 'worker', binding: { telegramId: '12345678', username: 'worker', linkedAt: '2026-09-24T00:00:00.000Z' }
    });
    expect(query.mock.calls[0][1]).toEqual(['comp_novda', '%Known%', 100, 0, false]);
    expect(query.mock.calls[0][0]).not.toContain('pin_hash');
  });

  it('calculates payroll from  ticket and adjustment facts and keeps an empty baseline empty', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'period-1', name: 'Current period', start_date: '2026-09-01', end_date: null, is_closed: 0 }] })
      .mockResolvedValueOnce({ rows: [{
        worker_id: 200, worker_name: 'Known Worker', status: 'ACTIVE', staj: '0',
        gross: '0', pieces: '0', avans: '0', jarima: '0'
      }] });

    const result = await serviceFor(query).getPayroll({ companyId: 'comp_novda' });

    expect(result.period).toMatchObject({ periodId: 'period-1', name: 'Current period' });
    expect(result.workers[0]).toMatchObject({ workerId: 200, gross: 0, avans: 0, jarima: 0, net: 0, pieces: 0 });
    expect(query.mock.calls[1][0]).toContain('ticket_entries');
    expect(query.mock.calls[1][0]).toContain('worker_adjustments');
  });

  it('rejects non-allowlisted company mutations before querying PostgreSQL', async () => {
    const query = vi.fn();

    await expect(serviceFor(query).upsertCompany('99887766', { companyId: 'comp_novda', companyName: 'Novda' }))
      .rejects.toMatchObject({ code: 'ADMIN_TELEGRAM_ID_NOT_AUTHORIZED', statusCode: 403 });
    expect(query).not.toHaveBeenCalled();
  });

  it('reads models, parties, ticket facts and balances from bounded canonical projections', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ company_id: 'comp_novda', id: 'm1', name: 'Model', operations_json: [{ name: 'Sew', rate: 2 }], available_sizes_json: ['S'], server_revision: 8 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'party-1', company_id: 'comp_novda', party_number: '2', model_id: 'm1', model_name: 'Model', status: 'ACTIVE', patta_count: 12, ish_soni: '4', server_revision: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ticket-1', company_id: 'comp_novda', model_id: 'm1', model_name: 'Model', party_record_id: 'party-1', party_number: '2', patta_number: 1, qty: '8', entry_qty: '8', status: 'CONFIRMED', submitted_at: '2026-09-24T00:00:00.000Z', worker_id: 200, worker_name: 'Worker', op_name: 'Sew' }] })
      .mockResolvedValueOnce({ rows: [{ worker_id: 200, name: 'Worker', type: 'AVANS', total: '2020000', fact_count: '4', opening_fact_count: '4' }] });
    const service = serviceFor(query);

    await expect(service.listModels({ companyId: 'comp_novda' })).resolves.toMatchObject({ models: [{ modelId: 'm1', serverRevision: 8 }] });
    await expect(service.listParties({ companyId: 'comp_novda' })).resolves.toMatchObject({ parties: [{ partyNumber: '2', pattaCount: 12 }] });
    await expect(service.listTickets({ companyId: 'comp_novda' })).resolves.toMatchObject({ tickets: [{ ticketId: 'ticket-1', workerId: 200 }] });
    await expect(service.getBalances({ companyId: 'comp_novda' })).resolves.toMatchObject({ facts: [{ total: 2020000, factCount: 4, openingFactCount: 4 }] });
    expect(query.mock.calls.slice(0, 3).every((call) => call[0].includes('LIMIT'))).toBe(true);
  });

  it('returns only safe operational health fields and fails when PostgreSQL is unavailable', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ checked_at: '2026-09-24T00:00:00.000Z', migration_level: '16', server_revision: '8' }] });
    await expect(serviceFor(query).getSystemHealth()).resolves.toEqual({
      api: 'available', database: 'available', checkedAt: '2026-09-24T00:00:00.000Z',
      migrationLevel: 16, serverRevision: 8, botStatus: 'not_exposed_by_api', backupStatus: 'not_exposed_by_api'
    });
    await expect(serviceFor(vi.fn().mockRejectedValue(new Error('db down'))).getSystemHealth()).rejects.toThrow('db down');
  });

  it('persists strict/free mode transactionally per company with actor audit and monotonic revision', async () => {
    const policies = new Map([
      ['comp_novda', { company_id: 'comp_novda', require_ticket_validation: true, policy_revision: 4 }],
      ['other_company', { company_id: 'other_company', require_ticket_validation: true, policy_revision: 7 }]
    ]);
    const auditEvents: any[] = [];
    const client = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        if (sql.includes('SELECT policy.company_id')) return { rows: policies.has(String(values[0])) ? [policies.get(String(values[0]))] : [] };
        if (sql.includes('UPDATE activation_companies')) {
          const row = policies.get(String(values[0]))!;
          row.require_ticket_validation = Boolean(values[1]); row.policy_revision += 1;
          return { rows: [{ policy_revision: row.policy_revision }] };
        }
        if (sql.includes('INSERT INTO activation_policy_events')) { auditEvents.push(values); return { rows: [] }; }
        return { rows: [] };
      }), release: vi.fn()
    };
    const query = vi.fn();
    const service = createAdminDashboardService({ pool: { query, connect: vi.fn().mockResolvedValue(client) }, allowedAdminIds: new Set(['1526974123']) });

    await expect(service.updateCompanyStrictMode('1526974123', { companyId: 'comp_novda', strictMode: false }))
      .resolves.toEqual({ companyId: 'comp_novda', strictMode: false, policyRevision: 5, synchronizedDevices: 0 });
    await expect(service.updateCompanyStrictMode('1526974123', { companyId: 'comp_novda', strictMode: true }))
      .resolves.toEqual({ companyId: 'comp_novda', strictMode: true, policyRevision: 6, synchronizedDevices: 0 });
    expect(policies.get('other_company')).toEqual({ company_id: 'other_company', require_ticket_validation: true, policy_revision: 7 });
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents.map((row) => row.slice(0, 2))).toEqual([['comp_novda', '1526974123'], ['comp_novda', '1526974123']]);
    expect(client.query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(2);
    await expect(service.updateCompanyStrictMode('99887766', { companyId: 'comp_novda', strictMode: false }))
      .rejects.toMatchObject({ code: 'ADMIN_TELEGRAM_ID_NOT_AUTHORIZED', statusCode: 403 });
    await expect(service.updateCompanyStrictMode('1526974123', { companyId: 'comp_novda', strictMode: 'false' }))
      .rejects.toMatchObject({ code: 'INVALID_STRICT_MODE', statusCode: 400 });
  });
});
