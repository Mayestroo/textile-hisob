import { describe, expect, it, vi } from 'vitest';

const { createAdminDashboardService } = require('../../admin/adminDashboard.cjs');
const { getWorkerProfile } = require('../workerService.cjs');
const { reducePayroll } = require('../payrollValuation.cjs');
const { canonicalStringify, computePayloadHash } = require('../../sync/canonicalPayload.cjs');

const period = { id: 'P', name: 'September', start_date: '2026-09-01', end_date: '2026-09-30', is_closed: true };
const worker = { worker_id: 7, company_id: 'tenant', worker_name: 'Worker', status: 'ACTIVE', staj: '1' };
const entry = (qty: string, rate: string | null, periodId = 'P', op = 'Old operation') =>
  ({ worker_id: 7, model_id: 'deleted-model', model_name: null, op_name: op, period_id: periodId, qty, rate });
const adjustment = (qty: string, rate: string | null, status = 'APPROVED', extras = {}) => ({
  adjustment_id: 'a', original_adjustment_id: null, provenance: null,
  worker_id: 7, model_id: 'deleted-model', model_name: null, op_name: 'Old operation',
  qty, rate, status, attribution_status: rate === null ? 'UNRESOLVED' : 'RESOLVED', original_period_id: 'P',
  ...extras
});

function fixture(entries: object[], adjustments: object[] = [], selected: typeof period | null = period,
  currentRate = 7, closingRate: number | null = 7, archiveOverride?: object) {
  const archive = { period: { id: selected?.id, companyId: 'tenant' },
    models: [{ id: 'deleted-model', operations: [{ name: 'Old operation', rate: closingRate }] }] };
  const archiveRow = archiveOverride || { archive_json: archive, sha256: computePayloadHash(canonicalStringify(archive)) };
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM worker_telegram_bindings b')) return { rows: [worker] };
    if (sql.includes('FROM periods')) {
      expect(params[0]).toBe('tenant');
      return { rows: selected && (params[1] === null || params[1] === selected.id) ? [selected] : [] };
    }
    if (sql.includes('FROM workers WHERE')) return { rows: [worker] };
    if (sql.includes('FROM ticket_entries e')) {
      expect(sql).toContain('e.company_id = $1');
      expect(sql).toContain("t.status = 'CONFIRMED'");
      expect(sql).not.toContain('submitted_at');
      return { rows: entries };
    }
    if (sql.includes('FROM production_adjustments a')) {
      expect(sql).toContain('original.company_id = a.company_id');
      expect(sql).toContain('a.company_id = $1');
      expect(sql).not.toContain('created_at');
      return { rows: adjustments };
    }
    if (sql.includes('FROM worker_adjustments')) return { rows: [
      { worker_id: 7, type: 'AVANS', total: '4' }, { worker_id: 7, type: 'JARIMA', total: '3' }
    ] };
    if (sql.includes('FROM staj_debt_events')) return { rows: [] };
    if (sql.includes('FROM models WHERE')) return { rows: [{ id: 'deleted-model', operations: [{ name: 'Old operation', rate: currentRate }] }] };
    if (sql.includes('FROM period_archives')) return { rows: closingRate === null ? [] : [archiveRow] };
    throw new Error(`Unexpected query ${sql}`);
  });
  const client = { query, release: vi.fn() };
  const admin = createAdminDashboardService({ pool: { query } });
  return { admin, client, query, profile: () => getWorkerProfile({ connect: async () => client },
    { companyId: 'tenant', workerId: 7, telegramId: '123', periodId: 'P' }) };
}

describe('shared payroll service/query contract', () => {
  it('does not price server closed payroll from a corrupted or foreign archive; retains genuine zero', async () => {
    const valid = { period: { id: 'P', companyId: 'tenant' },
      models: [{ id: 'deleted-model', operations: [{ name: 'Old operation', rate: 7 }] }] };
    const digest = computePayloadHash(canonicalStringify(valid));
    for (const archiveRow of [
      { archive_json: { ...valid, models: [{ id: 'deleted-model', operations: [{ name: 'Old operation', rate: 99 }] }] }, sha256: digest },
      { archive_json: { ...valid, period: { id: 'Q', companyId: 'tenant' } }, sha256: digest },
      { archive_json: { ...valid, period: { id: 'P', companyId: 'other' } }, sha256: digest }
    ]) {
      const result = await fixture([entry('12', '5')], [], period, 9, 7, archiveRow).admin.getPayroll({ companyId: 'tenant', periodId: 'P' });
      expect(result.workers[0]).toMatchObject({ gross: 0, unknownQuantity: 12,
        accountingReasons: expect.arrayContaining(['CLOSED_TARIFF_UNAVAILABLE']) });
    }
    const zero = { ...valid, models: [{ id: 'deleted-model', operations: [{ name: 'Old operation', rate: 0 }] }] };
    expect((await fixture([entry('12', '5')], [], period, 9, 0,
      { archive_json: zero, sha256: computePayloadHash(canonicalStringify(zero)) }).admin.getPayroll({ companyId: 'tenant', periodId: 'P' })).workers[0])
      .toMatchObject({ gross: 0, unknownQuantity: 0, pieces: 12 });
  });
  it('keeps a closed period incomplete even when no workers are active', () => {
    expect(reducePayroll(period, [], [], [], [])).toMatchObject({
      workers: [], accountingStatus: 'INCOMPLETE', accountingReasons: ['HISTORICAL_BASELINE_UNVERIFIED']
    });
    expect(reducePayroll({ ...period, is_closed: false }, [], [], [], [])).toMatchObject({
      workers: [], accountingStatus: 'COMPLETE', accountingReasons: []
    });
  });
  it('rejects a correctly hashed archive whose top-level company conflicts with its nested period', async () => {
    const foreign = { companyId: 'other', period: { id: 'P', companyId: 'tenant' },
      models: [{ id: 'deleted-model', operations: [{ name: 'Old operation', rate: 999 }] }] };
    const row = { archive_json: foreign, sha256: computePayloadHash(canonicalStringify(foreign)) };
    expect((await fixture([entry('12', '5')], [], period, 7, 7, row).admin.getPayroll({ companyId: 'tenant', periodId: 'P' })).workers[0])
      .toMatchObject({ gross: 0, unknownQuantity: 12, accountingReasons: expect.arrayContaining(['CLOSED_TARIFF_UNAVAILABLE']) });
  });
  it('uses frozen close tariff for closed P and current operation tariff for open work', async () => {
    const f = fixture([entry('10', '5')], [adjustment('2', '5')]);
    const admin = await f.admin.getPayroll({ companyId: 'tenant', periodId: 'P' });
    const profile = await f.profile();
    expect(profile.period_name).toContain('qayta hisoblangan');
    for (const result of [admin.workers[0], profile]) {
      expect(result).toMatchObject({ gross: 84, pieces: 12, net: 76, accountingStatus: 'INCOMPLETE',
        accountingReasons: expect.arrayContaining(['HISTORICAL_BASELINE_UNVERIFIED']) });
      expect(result.models_breakdown['deleted-model'].operations).toMatchObject([{ rate: 7, qty: 12, amount: 84 }]);
    }
    expect(admin.period).toMatchObject({ periodId: 'P', isClosed: true, restated: true });
    const q = fixture([entry('1', '9', 'Q')], [], { ...period, id: 'Q', name: 'October', is_closed: false }, 9);
    expect((await q.admin.getPayroll({ companyId: 'tenant', periodId: 'Q' })).workers[0]).toMatchObject({ gross: 9, pieces: 1 });
    expect(f.query.mock.calls.filter(([sql]) => sql.includes('FROM ticket_entries e')).map(([, params]) => params))
      .toEqual([['tenant', 'P', null], ['tenant', 'P', 7]]);
  });

  it('uses captured closed tariff despite later current rate, prices corrections in original period, and flags missing close evidence', async () => {
    const closed = fixture([entry('10', '5')], [adjustment('2', '5')], period, 9, 7);
    expect((await closed.admin.getPayroll({ companyId: 'tenant', periodId: 'P' })).workers[0]).toMatchObject({ gross: 84, pieces: 12 });
    const correction = fixture([entry('10', '5')], [adjustment('2', '5')], period, 9, 7);
    expect((await correction.admin.getPayroll({ companyId: 'tenant', periodId: 'P' })).workers[0].gross).toBe(84);
    const unknown = fixture([entry('10', '5')], [], period, 9, null);
    expect((await unknown.admin.getPayroll({ companyId: 'tenant', periodId: 'P' })).workers[0]).toMatchObject({ gross: 0,
      accountingReasons: expect.arrayContaining(['CLOSED_TARIFF_UNAVAILABLE']) });
  });

  it('queries only period-posted Oklad and Magazin while preserving legacy null-period deductions', async () => {
    const f = fixture([entry('10', '5')], [], period, 9, 7);
    const result = await f.profile();
    const query = f.query.mock.calls.find(([sql]) => sql.includes('FROM worker_adjustments'));
    expect(query[0]).toContain("ELSE COALESCE(SUM(amount) FILTER (WHERE period_id = $2 AND status = 'POSTED'), 0)");
    expect(query[0]).toContain("status = 'POSTED'");
    expect(query[0]).toContain("type IN ('AVANS', 'JARIMA') AND period_id IS NULL");
  });

  it('keeps manual Oklad known while unknown piecework tariff remains incomplete', () => {
    const result = reducePayroll({ ...period, is_closed: false }, [worker], [entry('10', null)], [], [
      { worker_id: 7, type: 'OKLAD', total: 2000000 }, { worker_id: 7, type: 'MAGAZIN', total: 100000 }
    ], { currentModels: [{ id: 'deleted-model', operations: [{ name: 'Old operation', rate: null }] }] }).workers[0];
    expect(result).toMatchObject({ pieceworkGross: 0, oklad: 2000000, magazin: 100000,
      gross: 2000000, net: 1899999, unknownEntryCount: 1, accountingStatus: 'INCOMPLETE' });
    expect(result.models_breakdown['deleted-model'].operations[0].amount).toBeNull();
  });

  it('reprices captured-5 open work at current tariff 7', async () => {
    const active = fixture([entry('10', '5')], [], { ...period, is_closed: false }, 7);
    expect((await active.admin.getPayroll({ companyId: 'tenant', periodId: 'P' })).workers[0])
      .toMatchObject({ gross: 70, pieces: 10 });
  });

  it('does not value blank or malformed operation rates as zero, but accepts explicit zero and resolved corrections without captured rate', () => {
    for (const is_closed of [false, true]) {
      for (const missingRate of [null, '', '  ', undefined, []]) {
        const result = reducePayroll({ ...period, is_closed }, [worker], [entry('10', '5')], [], [],
          is_closed ? { closingArchive: { models: [{ id: 'deleted-model', operations: [{ name: 'Old operation', rate: missingRate }] }] } }
            : { currentModels: [{ id: 'deleted-model', operations: [{ name: 'Old operation', rate: missingRate }] }] });
        expect(result.workers[0]).toMatchObject({ gross: 0, unknownEntryCount: 1, unknownQuantity: 10 });
        expect(result.workers[0].models_breakdown['deleted-model'].operations[0].amount).toBeNull();
      }
      const basis = is_closed ? { closingArchive: { models: [{ id: 'deleted-model', operations: [{ name: 'Old operation', rate: 0 }] }] } }
        : { currentModels: [{ id: 'deleted-model', operations: [{ name: 'Old operation', rate: 0 }] }] };
      const zero = reducePayroll({ ...period, is_closed }, [worker], [entry('10', '5')], [], [], basis);
      expect(zero.workers[0]).toMatchObject({ gross: 0, unknownEntryCount: 0 });
      const corrected = reducePayroll({ ...period, is_closed }, [worker], [], [adjustment('2', null, 'APPROVED', { attribution_status: 'RESOLVED' })], [],
        is_closed ? { closingArchive: { models: [{ id: 'deleted-model', operations: [{ name: 'Old operation', rate: 7 }] }] } }
          : { currentModels: [{ id: 'deleted-model', operations: [{ name: 'Old operation', rate: 7 }] }] });
      expect(corrected.workers[0]).toMatchObject({ gross: 14, unresolvedAdjustmentCount: 0 });
    }
  });

  it('carries unentered work into next period and prices it at the next active tariff', async () => {
    const next = fixture([entry('12', '5', 'Q')], [], { ...period, id: 'Q', name: 'October', is_closed: false }, 7);
    expect((await next.admin.getPayroll({ companyId: 'tenant', periodId: 'Q' })).workers[0]).toMatchObject({ gross: 84, pieces: 12 });
  });

  it('separates rate buckets, preserves audit overdraw, and retains adjustment-only historical operations', async () => {
    const f = fixture([entry('10', '5'), entry('4', '9')], [adjustment('-3', '5')]);
    const row = (await f.admin.getPayroll({ companyId: 'tenant', periodId: 'P' })).workers[0];
    expect(row).toMatchObject({ gross: 77, pieces: 11, net: 69 });
    expect(row.models_breakdown['deleted-model'].operations).toMatchObject([
      { rate: 7, qty: 11, amount: 77 }
    ]);
    const only = fixture([], [adjustment('12', '5')]);
    expect((await only.profile()).models_breakdown['deleted-model'].operations[0]).toMatchObject({ qty: 12, amount: 84 });
    const overdraw = fixture([entry('10', '5')], [adjustment('-12', '5')]);
    expect(await overdraw.profile()).toMatchObject({ gross: 0, pieces: 0, rawQuantity: -2, net: -8 });
    const mixedOverdraw = fixture([entry('10', '5'), entry('4', '9')], [adjustment('-12', '5')]);
    expect(await mixedOverdraw.profile()).toMatchObject({ gross: 14, pieces: 2, accountingStatus: 'INCOMPLETE' });
  });

  it('keeps zero distinct from null, flags legacy unknown periods, excludes pending and invalid reversal facts', async () => {
    const f = fixture([entry('1', '0'), entry('2', null), entry('8', '5', null)], [
      adjustment('4', '5', 'PENDING'), adjustment('2', null),
      adjustment('-2', '5', 'APPROVED', { adjustment_id: 'inverse', original_adjustment_id: 'missing' })
    ]);
    const row = (await f.admin.getPayroll({ companyId: 'tenant', periodId: 'P' })).workers[0];
    expect(row).toMatchObject({ gross: 21, pieces: 3, unknownEntryCount: 0, unknownQuantity: 0,
      unresolvedAdjustmentCount: 2, accountingStatus: 'INCOMPLETE' });
    expect(row.accountingReasons).toEqual(expect.arrayContaining([
      'UNKNOWN_ORIGINAL_PERIOD', 'UNRESOLVED_ATTRIBUTION', 'MISSING_OR_INCONSISTENT_REVERSAL'
    ]));
    expect(row.models_breakdown['deleted-model'].operations).toEqual([
      expect.objectContaining({ rate: 7, amount: 21 })
    ]);
    expect(reducePayroll({ ...period, is_closed: false }, [worker], [entry('1', '9')], [], [], {
      currentModels: [{ id: 'deleted-model', operations: [{ name: 'Old operation', rate: 0 }] }]
    }).workers[0]).toMatchObject({ gross: 0, unknownEntryCount: 0 });
  });

  it('honors all reversal compatibility forms, validates explicit tenant periods, and returns unavailable without open period', async () => {
    const original = adjustment('2', '5');
    const inverse = adjustment('-2', '5', 'APPROVED', {
      adjustment_id: 'inverse', original_adjustment_id: 'a', provenance: 'REVERSAL', original_status: 'APPROVED',
      original_worker_id: 7, original_model_id: 'deleted-model', original_op_name: 'Old operation',
      original_period: 'P', original_rate: '5', original_qty: '2', original_attribution: 'RESOLVED'
    });
    const run = async (rows: object[]) => (await fixture([entry('10', '5')], rows).profile()).gross;
    expect(await run([original, inverse])).toBe(70);
    expect(await run([{ ...original, status: 'REVERSED' }, { ...inverse, original_status: 'REVERSED' }])).toBe(70);
    expect(await run([{ ...original, status: 'REVERSED' }, { ...inverse, status: 'REVERSED' }])).toBe(70);
    const empty = fixture([], [], null);
    expect(await empty.admin.getPayroll({ companyId: 'tenant' })).toMatchObject({ period: null, accountingStatus: 'UNAVAILABLE', workers: [{ accountingStatus: 'UNAVAILABLE', gross: 0 }] });
    expect(empty.query.mock.calls.some(([sql]) => sql.includes('FROM ticket_entries'))).toBe(false);
    await expect(empty.profile()).rejects.toMatchObject({ code: 'PERIOD_NOT_FOUND', statusCode: 404 });
    await expect(empty.admin.getPayroll({ companyId: 'tenant', periodId: 'other-tenant' })).rejects.toMatchObject({ code: 'PERIOD_NOT_FOUND' });
    await expect(empty.profile()).rejects.toMatchObject({ code: 'PERIOD_NOT_FOUND' });
    await expect(empty.admin.getPayroll({ companyId: 'tenant', periodId: '' })).rejects.toMatchObject({ code: 'INVALID_PERIOD_ID' });
  });
});
