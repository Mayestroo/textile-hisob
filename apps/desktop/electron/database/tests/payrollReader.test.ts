import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { payrollDisplay } from '../../../renderer/engine/payrollDisplay';
import { createPayrollWorkbook } from '../../../renderer/engine/excelSync';

const manager = require('../core/databaseManager.cjs');
const { loadPayrollValuationFromSqlite } = require('../readers/payrollReader.cjs');
const { readPeriodPayrollProjection } = require('../readers/workbookPayrollRead.cjs');
const { executeWorkbookCommand } = require('../commands/workbookCommandPipeline.cjs');
const { executeRecordAdjustmentCommand } = require('../commands/commandPipeline.cjs');
const { executeSubmitTicketCommand } = require('../commands/commandPipeline.cjs');
const { reducePayroll } = require('../../../../server/modules/workers/payrollValuation.cjs');
const { canonicalStringify, computePayloadHash } = require('../core/canonicalPayload.cjs');
const tenant = 'payroll-tenant';
const now = '2026-09-15T00:00:00Z';

describe('desktop SQLite saved-rate reader and shared server reducer', () => {
  let directory: string;
  let db: any;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-payroll-read-'));
    db = manager.getCompanyDatabase(directory, tenant);
    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES ('m', ?, 'Historical', '[{"name":"Sew","rate":7}]', ?, ?)`).run(tenant, now, now);
    db.prepare(`INSERT INTO workers (id, company_id, name, staj, created_at, updated_at)
      VALUES (7, ?, 'Worker', 1, ?, ?)`).run(tenant, now, now);
    for (const [id, closed] of [['P', 0], ['Q', 0]]) db.prepare(`INSERT INTO periods
      (id, company_id, name, start_date, is_closed, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, tenant, id, id === 'P' ? '2026-09-01' : '2026-10-01', closed, now);
    for (const [id, rate] of [['P', 7], ['Q', 9]]) db.prepare(`INSERT INTO period_archives
      (company_id, period_id, archive_json, sha256, archived_at) VALUES (?, ?, ?, ?, ?)`)
      .run(tenant, id, JSON.stringify({ models: [{ id: 'm', operations: [{ name: 'Sew', rate }] }] }), 'a'.repeat(64), now);
    db.prepare(`INSERT INTO worker_adjustments (id, company_id, worker_id, period_id, type, amount, provenance, created_at)
      VALUES ('av', ?, 7, 'P', 'AVANS', 4, 'REMOTE_SYNC', ?),
      ('ja', ?, 7, 'P', 'JARIMA', 3, 'REMOTE_SYNC', ?)`).run(tenant, now, tenant, now);
  });
  afterEach(() => { manager.closeAllCompanyDatabases(); fs.rmSync(directory, { recursive: true, force: true }); });
  function ticket(id: string, qty: number, rate: number | null, period: string | null = 'P', provenance = 'REMOTE_SYNC') {
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, period_id, party_number, patta_number,
      qty, status, submitted_at, created_at, provenance) VALUES (?, ?, 'm', ?, '1', 1, ?, 'CONFIRMED', ?, ?, ?)`)
      .run(id, tenant, period, qty, now, now, provenance);
    db.prepare(`INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id, rate_snapshot, qty, created_at)
      VALUES (?, ?, ?, 'Sew', 7, ?, ?, ?)`).run(`${id}-entry`, id, tenant, rate, qty, now);
  }
  function adjustment(id: string, qty: number, rate: number | null = 5, period: string | null = 'P',
    status = 'APPROVED', original: string | null = null, provenance = 'REMOTE_SYNC') {
    db.prepare(`INSERT INTO production_adjustments (adjustment_id, company_id, model_id, worker_id, op_name,
      delta_qty, reason, status, provenance, created_at, created_by, original_adjustment_id,
      original_period_id, original_rate_snapshot, attribution_status)
      VALUES (?, ?, 'm', 7, 'Sew', ?, 'test', ?, ?, ?, 'remote', ?, ?, ?, ?)`)
      .run(id, tenant, qty, status, provenance, now, original, period, rate,
        rate === null ? 'UNRESOLVED' : 'RESOLVED');
  }
  function outbox(id: string, type: string, entity: string, status: string, payload: object = {}, entityType = 'fact') {
    const json = canonicalStringify(payload);
    db.prepare(`INSERT INTO local_outbox (operation_id, company_id, command_type, entity_type, entity_id,
      payload_json, payload_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenant, type, entityType, entity, json, computePayloadHash(json), status, now, now);
  }
  function closeWithProductionArchive(rate: number, archivePeriod = 'P', archiveCompany = tenant, nextPeriodId = 'after-p') {
    const archive = {
      period: { id: archivePeriod, companyId: archiveCompany, name: 'P', startDate: '2026-09-01' },
      models: [{ id: 'm', operations: [{ name: 'Sew', rate }] }],
      workers: [{ id: 7, name: 'Worker', staj: 1 }],
      submittedTickets: []
    };
    return executeWorkbookCommand(directory, tenant, {
      commandType: 'ClosePeriod', commandId: 'close-p', operationId: 'close-p', companyId: tenant,
      entityId: 'P', payload: { periodId: 'P', endDate: '2026-09-30',
        nextPeriod: { id: nextPeriodId, name: 'Next', startDate: '2026-10-01' } }, localArchive: archive
    });
  }
  const read = (p: string | null = 'P') => loadPayrollValuationFromSqlite(db, tenant, p);
  it('rejects a valid digest with foreign top-level company rather than borrowing its tariff', () => {
    ticket('foreign-archive', 12, 5);
    db.prepare("UPDATE periods SET is_closed=1 WHERE id='P'").run();
    const foreign = { companyId: 'other', period: { id: 'P', companyId: tenant },
      models: [{ id: 'm', operations: [{ name: 'Sew', rate: 999 }] }] };
    db.prepare("UPDATE period_archives SET archive_json=?,sha256=? WHERE company_id=? AND period_id='P'")
      .run(canonicalStringify(foreign), computePayloadHash(canonicalStringify(foreign)), tenant);
    expect(read().workers[0]).toMatchObject({ gross: 0, unknownQuantity: 12,
      accountingReasons: expect.arrayContaining(['CLOSED_TARIFF_UNAVAILABLE']) });
  });
  it('does not let an unverified period-read archive replace the persisted closing tariff', () => {
    ticket('closed', 12, 5);
    db.prepare("UPDATE periods SET is_closed=1 WHERE id='P'").run();
    const persisted = { period: { id: 'P', companyId: tenant },
      models: [{ id: 'm', operations: [{ name: 'Sew', rate: 7 }] }],
      workers: [{ id: 7, name: 'Worker', staj: 3 }] };
    db.prepare('UPDATE period_archives SET archive_json=?, sha256=? WHERE company_id=? AND period_id=?')
      .run(JSON.stringify(persisted), computePayloadHash(canonicalStringify(persisted)), tenant, 'P');
    expect(readPeriodPayrollProjection(db, tenant, 'P', { ...persisted, models: [
      { id: 'm', operations: [{ name: 'Sew', rate: 99 }] }] }).workers[0].gross).toBe(84);
    expect(readPeriodPayrollProjection(db, tenant, 'P', { ...persisted,
      workers: [{ id: 7, name: 'Worker', staj: 99 }] }).workers[0].net).toBe(76);
    expect(readPeriodPayrollProjection(db, tenant, 'P', persisted).workers[0]).toMatchObject({ gross: 84, net: 74 });
  });
  function parity(p = 'P') {
    const period = db.prepare('SELECT id, name, start_date, end_date, is_closed FROM periods WHERE company_id = ? AND id = ?').get(tenant, p);
    const workers = [{ worker_id: 7, worker_name: 'Worker', staj: 1 }];
    const facts = db.prepare(`SELECT e.worker_id, t.model_id, m.name AS model_name, e.op_name, e.qty,
      e.rate_snapshot AS rate, t.period_id FROM ticket_entries e JOIN tickets t ON t.id=e.ticket_id AND t.company_id=e.company_id
      LEFT JOIN models m ON m.id=t.model_id AND m.company_id=t.company_id
      WHERE e.company_id=? AND t.status='CONFIRMED' AND (t.period_id=? OR t.period_id IS NULL)`).all(tenant, p);
    const a = db.prepare(`SELECT a.worker_id, a.model_id, m.name AS model_name, a.op_name,
      a.delta_qty AS qty, a.original_rate_snapshot AS rate, a.original_period_id, a.status, a.attribution_status,
      a.original_adjustment_id, a.provenance, o.status AS original_status, o.worker_id AS original_worker_id,
      o.model_id AS original_model_id, o.op_name AS original_op_name, o.original_period_id AS original_period,
      o.original_rate_snapshot AS original_rate, o.delta_qty AS original_qty, o.attribution_status AS original_attribution
      FROM production_adjustments a LEFT JOIN production_adjustments o ON o.adjustment_id=a.original_adjustment_id
      AND o.company_id=a.company_id LEFT JOIN models m ON m.id=a.model_id AND m.company_id=a.company_id
      WHERE a.company_id=? AND (a.original_period_id=? OR a.original_period_id IS NULL)`).all(tenant, p);
    const deductions = p === 'P' ? [{ worker_id: 7, type: 'AVANS', total: 4 }, { worker_id: 7, type: 'JARIMA', total: 3 }] : [];
    const actual = read(p).workers[0];
    const archive = JSON.parse(db.prepare('SELECT archive_json FROM period_archives WHERE company_id=? AND period_id=?').get(tenant, p).archive_json);
    const models = db.prepare('SELECT id, operations_json AS operations FROM models WHERE company_id=?').all(tenant)
      .map((model: any) => ({ ...model, operations: JSON.parse(model.operations) }));
    const server = reducePayroll(period, workers, facts, a, deductions,
      period.is_closed ? { closingArchive: archive } : { currentModels: models }).workers[0];
    expect(actual).toMatchObject({ gross: server.gross, pieces: server.pieces, net: server.net,
      rawQuantity: server.rawQuantity, unknownEntryCount: server.unknownEntryCount,
      unknownQuantity: server.unknownQuantity });
    const operations = (value: any) => Object.values(value.models_breakdown).flatMap((model: any) => model.operations)
      .sort((a: any, b: any) => String(a.rate).localeCompare(String(b.rate)));
    expect(operations(actual)).toEqual(operations(server));
    return actual;
  }
  it('values P at frozen 5, Q independently at 9; reversal and closed baseline', () => {
    ticket('p', 10, 5); ticket('q', 2, 9, 'Q'); adjustment('add', 2);
    expect(parity()).toMatchObject({ gross: 84, pieces: 12, net: 76, syncStatus: 'UNKNOWN', accountingStatus: 'INCOMPLETE' });
    expect(parity('Q')).toMatchObject({ gross: 14, pieces: 2 });
    adjustment('rev', -2, 5, 'P', 'APPROVED', 'add');
    expect(parity()).toMatchObject({ gross: 70, net: 62 });
    db.prepare("UPDATE production_adjustments SET status='REVERSED' WHERE adjustment_id='add'").run();
    expect(parity().gross).toBe(70);
    db.prepare("UPDATE production_adjustments SET status='REVERSED' WHERE adjustment_id='rev'").run();
    expect(parity().gross).toBe(70);
    db.prepare("UPDATE periods SET is_closed=1 WHERE id='P'").run();
    expect(read().accountingReasons).toContain('HISTORICAL_BASELINE_UNVERIFIED');
  });
  it('reads period-posted Oklad and Magazin without mixing them into piecework or losing deductions', () => {
    db.prepare("UPDATE workers SET staj=25000 WHERE company_id=? AND id=7").run(tenant);
    db.prepare("UPDATE models SET operations_json='[{\"name\":\"Sew\",\"rate\":50000}]' WHERE company_id=? AND id='m'").run(tenant);
    db.prepare("DELETE FROM worker_adjustments WHERE company_id=? AND period_id='P'").run(tenant);
    ticket('manual-payroll', 10, 50000);
    db.prepare(`INSERT INTO worker_adjustments (id, company_id, worker_id, period_id, type, amount, provenance, status, created_at)
      VALUES ('oklad-P', ?, 7, 'P', 'OKLAD', 2000000, 'REMOTE_SYNC', 'POSTED', ?),
        ('magazin-P', ?, 7, 'P', 'MAGAZIN', 100000, 'REMOTE_SYNC', 'POSTED', ?),
        ('avans-P', ?, 7, 'P', 'AVANS', 200000, 'REMOTE_SYNC', 'POSTED', ?),
        ('jarima-P', ?, 7, 'P', 'JARIMA', 50000, 'REMOTE_SYNC', 'POSTED', ?),
        ('oklad-Q', ?, 7, 'Q', 'OKLAD', 9000000, 'REMOTE_SYNC', 'POSTED', ?),
        ('magazin-pending', ?, 7, 'P', 'MAGAZIN', 700000, 'REMOTE_SYNC', 'PENDING', ?)
    `).run(tenant, now, tenant, now, tenant, now, tenant, now, tenant, now, tenant, now);
    expect(read('P').workers[0]).toMatchObject({
      pieceworkGross: 500000, oklad: 2000000, magazin: 100000, avans: 200000,
      jarima: 50000, staj: 25000, gross: 2500000, net: 2125000, pieces: 10
    });
    expect(read('Q').workers[0]).toMatchObject({ pieceworkGross: 0, oklad: 9000000, magazin: 0, gross: 9000000 });
    expect(read('P').workers[0].models_breakdown.m.operations[0]).toMatchObject({ qty: 10, amount: 500000 });
  });
  it('keeps pending local worker balances provisional, excludes conflicts, and never trusts ACK without feed proof', () => {
    db.prepare("UPDATE workers SET staj=25000 WHERE company_id=? AND id=7").run(tenant);
    db.prepare("UPDATE models SET operations_json='[{\"name\":\"Sew\",\"rate\":50000}]' WHERE company_id=? AND id='m'").run(tenant);
    db.prepare("DELETE FROM worker_adjustments WHERE company_id=? AND period_id='P'").run(tenant);
    ticket('worker-command-payroll', 10, 50000);
    db.prepare(`INSERT INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,provenance,status,created_at)
      VALUES ('remote-avans',?,7,'P','AVANS',200000,'REMOTE_SYNC','POSTED',?),
        ('remote-jarima',?,7,'P','JARIMA',50000,'REMOTE_SYNC','POSTED',?),
        ('local-oklad',?,7,'P','OKLAD',2000000,'WORKBOOK_COMMAND','POSTED',?),
        ('local-magazin',?,7,'P','MAGAZIN',100000,'WORKBOOK_COMMAND','POSTED',?)`)
      .run(tenant, now, tenant, now, tenant, now, tenant, now);
    const payload = { workerId: 7, balanceAdjustments: [
      { adjustmentId: 'local-oklad', type: 'OKLAD', amountDelta: 2000000, periodId: 'P' },
      { adjustmentId: 'local-magazin', type: 'MAGAZIN', amountDelta: 100000, periodId: 'P' }
    ] };
    outbox('worker-money-op', 'UpsertWorker', '7', 'PENDING', payload, 'worker');
    expect(read('P').workers[0]).toMatchObject({ gross: 2500000, net: 2125000,
      syncStatus: 'UNSYNCED', accountingStatus: 'INCOMPLETE' });

    db.prepare("UPDATE local_outbox SET status='CONFLICT' WHERE operation_id='worker-money-op'").run();
    expect(read('P').workers[0]).toMatchObject({ pieceworkGross: 500000, gross: 500000, net: 225000,
      syncStatus: 'UNKNOWN', accountingStatus: 'INCOMPLETE',
      accountingReasons: expect.arrayContaining(['WORKER_ADJUSTMENT_CONFLICT']) });

    db.prepare(`UPDATE local_outbox SET status='SYNCED', accepted_payload_hash=payload_hash, accepted_server_revision=2
      WHERE operation_id='worker-money-op'`).run();
    db.prepare('UPDATE workers SET server_revision=2 WHERE company_id=? AND id=7').run(tenant);
    expect(read('P').workers[0]).toMatchObject({ gross: 2500000, net: 2125000,
      syncStatus: 'UNKNOWN', accountingStatus: 'INCOMPLETE',
      accountingReasons: expect.arrayContaining(['SYNC_FRESHNESS_UNVERIFIED']) });
  });
  it('independent buckets, floor, zero/null, unresolved and adjustment-only', () => {
    ticket('a', 10, 5); ticket('b', 4, 9); adjustment('minus', -3);
    expect(parity()).toMatchObject({ gross: 77, pieces: 11, net: 69 });
    db.prepare("UPDATE production_adjustments SET delta_qty=-12 WHERE adjustment_id='minus'").run();
    expect(parity()).toMatchObject({ gross: 14, pieces: 2, rawQuantity: 2 });
    db.prepare("DELETE FROM production_adjustments WHERE adjustment_id='minus'").run();
    db.prepare("DELETE FROM ticket_entries").run(); db.prepare("DELETE FROM tickets").run();
    adjustment('only', 12); expect(parity()).toMatchObject({ gross: 84, pieces: 12 });
    ticket('zero', 1, 0); ticket('unknown', 2, null); ticket('legacy', 8, 5, null);
    adjustment('unresolved', 2, null); adjustment('pending', 4, 5, 'P', 'PENDING_REVIEW');
    expect(parity()).toMatchObject({ gross: 105, pieces: 15, unknownEntryCount: 0,
      unknownQuantity: 0, unresolvedAdjustmentCount: 1,
      accountingReasons: expect.arrayContaining(['UNKNOWN_ORIGINAL_PERIOD']) });
  });
  it('keeps local-origin money visible across ACK and inverse retry without doubling it', () => {
    ticket('local', 10, 5, 'P', 'LOCAL_COMMAND'); adjustment('original', 2);
    expect(read().workers[0]).toMatchObject({ gross: 84, syncStatus: 'UNKNOWN', accountingReasons: expect.arrayContaining(['SYNC_FRESHNESS_UNVERIFIED']) });
    outbox('submit', 'SubmitTicket', 'local', 'PENDING');
    expect(read().workers[0]).toMatchObject({ gross: 84, syncStatus: 'UNSYNCED' });
    db.prepare("UPDATE local_outbox SET status='SYNCED' WHERE operation_id='submit'").run();
    expect(read().workers[0]).toMatchObject({ gross: 84, syncStatus: 'UNKNOWN' });
    adjustment('inverse', -2, 5, 'P', 'APPROVED', 'original', 'REVERSAL');
    outbox('reverse', 'ReverseProductionAdjustment', 'inverse', 'PENDING', { originalAdjustmentId: 'original' });
    expect(read().workers[0]).toMatchObject({ gross: 70, syncStatus: 'UNSYNCED' });
    db.prepare("UPDATE local_outbox SET status='SYNCED' WHERE operation_id='reverse'").run();
    expect(read().workers[0]).toMatchObject({ gross: 70, syncStatus: 'UNKNOWN' });
    db.prepare("UPDATE production_adjustments SET provenance='REMOTE_SYNC' WHERE adjustment_id='inverse'").run();
    expect(read().workers[0].gross).toBe(70);
  });
  it('shows pending offline money provisionally and retains accepted local adjustments/edits', () => {
    ticket('pending', 10, 5, 'P', 'LOCAL_COMMAND');
    db.prepare("UPDATE tickets SET status='PENDING_SYNC' WHERE id='pending'").run();
    expect(read().workers[0]).toMatchObject({ gross: 70, syncStatus: 'UNSYNCED',
      accountingReasons: expect.arrayContaining(['LOCAL_MUTATION_PENDING']) });
    db.prepare("UPDATE tickets SET status='CONFIRMED' WHERE id='pending'").run();
    outbox('accepted', 'SubmitTicket', 'pending', 'SYNCED');
    adjustment('local-adj', 2, 5, 'P', 'APPROVED', null, 'MANUAL_CORRECTION');
    outbox('accepted-adj', 'RecordProductionAdjustment', 'local-adj', 'SYNCED');
    expect(read().workers[0]).toMatchObject({ gross: 84, syncStatus: 'UNKNOWN',
      accountingReasons: expect.arrayContaining(['SYNC_FRESHNESS_UNVERIFIED']) });
    db.prepare("UPDATE production_adjustments SET provenance='REMOTE_SYNC' WHERE adjustment_id='local-adj'").run();
    expect(read().workers[0].gross).toBe(84);
    outbox('edit', 'UpdateTicket', 'pending', 'SYNCED');
    expect(read().workers[0]).toMatchObject({ gross: 84, syncStatus: 'UNKNOWN',
      accountingReasons: expect.arrayContaining(['SYNC_FRESHNESS_UNVERIFIED']) });
  });
  it('retains adjustment-only history and flags missing reversal without inventing its value', () => {
    adjustment('only', 12);
    expect(parity()).toMatchObject({ gross: 84, pieces: 12 });
    adjustment('bad-reversal', -11, 5, 'P', 'APPROVED', 'only');
    expect(parity()).toMatchObject({ gross: 84, unresolvedAdjustmentCount: 1,
      accountingReasons: expect.arrayContaining(['MISSING_OR_INCONSISTENT_REVERSAL']) });
  });
  it('scopes all queries to tenant and explicit period; absent period is unavailable', () => {
    ticket('p', 10, 5);
    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES ('foreign-m', 'other', 'Foreign', '[]', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO workers (id, company_id, name, created_at, updated_at)
      VALUES (8, 'other', 'Foreign', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, created_at)
      VALUES ('foreign-P', 'other', 'Foreign', '2026-09-01', ?)`).run(now);
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, period_id, party_number, patta_number,
      qty, status, submitted_at, created_at, provenance)
      VALUES ('foreign-ticket', 'other', 'foreign-m', 'foreign-P', '1', 1, 100,
      'CONFIRMED', ?, ?, 'REMOTE_BOOTSTRAP')`).run(now, now);
    db.prepare(`INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id,
      rate_snapshot, qty, created_at) VALUES ('foreign-entry', 'foreign-ticket', 'other', 'Sew', 8, 100, 100, ?)`)
      .run(now);
    expect(read('P').workers).toHaveLength(1);
    expect(read('P').workers[0].gross).toBe(70);
    expect(read('Q').workers[0].gross).toBe(0);
    expect(read(null)).toMatchObject({ companyId: tenant, period: null, accountingStatus: 'UNAVAILABLE', syncStatus: 'UNKNOWN' });
    expect(() => read('other')).toThrow('PERIOD_NOT_FOUND');
    expect(loadPayrollValuationFromSqlite(db, 'other', null)).toMatchObject({
      workers: [{ workerId: 8, gross: 0 }], period: null, accountingStatus: 'UNAVAILABLE'
    });
    expect(() => loadPayrollValuationFromSqlite(db, 'other', 'P')).toThrow('PERIOD_NOT_FOUND');
    expect(readPeriodPayrollProjection(db, tenant, 'not-a-period', {})).toMatchObject({
      companyId: tenant, period: null, accountingStatus: 'UNAVAILABLE', syncStatus: 'UNKNOWN'
    });
    expect(readPeriodPayrollProjection(db, 'other', 'P', {})).toMatchObject({
      companyId: 'other', period: null, accountingStatus: 'UNAVAILABLE', syncStatus: 'UNKNOWN'
    });
  });

  it('values a selected closed archive period from closing tariff and original-period +/- ledger corrections', () => {
    ticket('closed', 13, 3, 'Q');
    adjustment('q-plus', 2, 9, 'Q');
    adjustment('q-minus', -3, 9, 'Q');
    db.prepare("UPDATE periods SET is_closed=1 WHERE company_id=? AND id='Q'").run(tenant);
    db.prepare('UPDATE models SET operations_json=? WHERE company_id=? AND id=?')
      .run(JSON.stringify([{ name: 'Sew', rate: 9 }]), tenant, 'm');
    db.prepare('UPDATE period_archives SET archive_json=?, sha256=? WHERE company_id=? AND period_id=?')
      .run(JSON.stringify({ models: [{ id: 'm', operations: [{ name: 'Sew', rate: 7 }] }] }), 'b'.repeat(64), tenant, 'Q');
    db.prepare("INSERT INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,provenance,created_at) VALUES ('q-av',?,7,'Q','AVANS',4,'REMOTE_SYNC',?),('q-ja',?,7,'Q','JARIMA',3,'REMOTE_SYNC',?)")
      .run(tenant, now, tenant, now);
    db.prepare("UPDATE workers SET status='INACTIVE' WHERE company_id=? AND id=7").run(tenant);

    const archiveWorkers = [{ id: 7, name: 'Archived worker', staj: 1, avans: 4, jarima: 3 }];
    const archived = loadPayrollValuationFromSqlite(db, tenant, 'Q', {
      closingArchive: { models: [{ id: 'm', operations: [{ name: 'Sew', rate: 7 }] }] }, workers: archiveWorkers
    });
    expect(archived.period).toMatchObject({ periodId: 'Q', isClosed: true });
    expect(archived.tariffs?.[0].operations[0]).toEqual({ name: 'Sew', rate: 7 });
    expect(archived.workers[0]).toMatchObject({ workerId: 7, name: 'Archived worker', gross: 84, net: 76, pieces: 12 });

    db.prepare("DELETE FROM period_archives WHERE company_id=? AND period_id='Q'").run(tenant);
    const missingArchive = loadPayrollValuationFromSqlite(db, tenant, 'Q', { workers: archiveWorkers });
    expect(missingArchive.workers[0]).toMatchObject({ gross: 0, unknownEntryCount: 1 });
    expect(missingArchive.accountingReasons).toContain('CLOSED_TARIFF_UNAVAILABLE');

    db.prepare(`INSERT INTO period_archives(company_id,period_id,archive_json,sha256,archived_at)
      VALUES (?,'Q',?,?,?)`).run(tenant, JSON.stringify({ models: [{ id: 'm', operations: [{ name: 'Sew', rate: 0 }] }] }), 'c'.repeat(64), now);
    const zeroArchive = loadPayrollValuationFromSqlite(db, tenant, 'Q', {
      closingArchive: { models: [{ id: 'm', operations: [{ name: 'Sew', rate: 0 }] }] }, workers: archiveWorkers
    });
    expect(zeroArchive.workers[0]).toMatchObject({ gross: 0, unknownEntryCount: 0, pieces: 12 });
  });

  it('reads a production ClosePeriod archive through workbook payroll at close rate, not current or saved rate', () => {
    ticket('production-close', 10, 5);
    db.prepare('UPDATE models SET operations_json=? WHERE company_id=? AND id=?')
      .run(JSON.stringify([{ name: 'Sew', rate: 9 }]), tenant, 'm');
    expect(closeWithProductionArchive(7).committed).toBe(true);
    const stored = db.prepare('SELECT archive_json, sha256 FROM period_archives WHERE company_id=? AND period_id=?').get(tenant, 'P');
    expect(JSON.parse(stored.archive_json)).toMatchObject({ period: { id: 'P', companyId: tenant }, models: [{ id: 'm', operations: [{ name: 'Sew', rate: 7 }] }] });
    const result = readPeriodPayrollProjection(db, tenant, 'P');
    expect(result).toMatchObject({ companyId: tenant, period: { periodId: 'P', isClosed: true }, tariffs: [{ id: 'm', operations: [{ name: 'Sew', rate: 7 }] }] });
    expect(result.workers[0]).toMatchObject({ gross: 70, pieces: 10, net: 62,
      accountingStatus: 'INCOMPLETE', accountingReasons: expect.arrayContaining(['HISTORICAL_BASELINE_UNVERIFIED']) });

    db.prepare('UPDATE period_archives SET archive_json=? WHERE company_id=? AND period_id=?')
      .run('{malformed', tenant, 'P');
    expect(readPeriodPayrollProjection(db, tenant, 'P').workers[0]).toMatchObject({ gross: 0,
      unknownEntryCount: 1, unknownQuantity: 10, accountingReasons: expect.arrayContaining(['CLOSED_TARIFF_UNAVAILABLE', 'UNKNOWN_HISTORICAL_RATE']) });

    const conflicting = { period: { id: 'Q', companyId: tenant }, models: [{ id: 'm', operations: [{ name: 'Sew', rate: 7 }] }] };
    db.prepare('UPDATE period_archives SET archive_json=?, sha256=? WHERE company_id=? AND period_id=?')
      .run(JSON.stringify(conflicting), computePayloadHash(canonicalStringify(conflicting)), tenant, 'P');
    expect(readPeriodPayrollProjection(db, tenant, 'P').workers[0]).toMatchObject({ gross: 0,
      unknownEntryCount: 1, unknownQuantity: 10, accountingReasons: expect.arrayContaining(['CLOSED_TARIFF_UNAVAILABLE']) });
  });

  it('keeps valid explicit-zero close rate distinct from missing evidence and isolates archive company/period', () => {
    ticket('zero-close', 10, 5);
    expect(closeWithProductionArchive(0).committed).toBe(true);
    const zero = readPeriodPayrollProjection(db, tenant, 'P');
    expect(zero.workers[0]).toMatchObject({ gross: 0, pieces: 10, unknownEntryCount: 0, unknownQuantity: 0,
      accountingStatus: 'INCOMPLETE', accountingReasons: expect.arrayContaining(['HISTORICAL_BASELINE_UNVERIFIED']) });
    expect(zero.accountingReasons).not.toContain('CLOSED_TARIFF_UNAVAILABLE');

    db.prepare('DELETE FROM period_archives WHERE company_id=? AND period_id=?').run(tenant, 'P');
    db.prepare(`INSERT INTO period_archives(company_id,period_id,archive_json,sha256,archived_at) VALUES ('other','P',?,?,?)`)
      .run(JSON.stringify({ period: { id: 'P', companyId: 'other' }, models: [{ id: 'm', operations: [{ name: 'Sew', rate: 99 }] }] }), 'f'.repeat(64), now);
    const missing = readPeriodPayrollProjection(db, tenant, 'P');
    expect(missing.workers[0]).toMatchObject({ gross: 0, pieces: 10, unknownEntryCount: 1,
      accountingReasons: expect.arrayContaining(['CLOSED_TARIFF_UNAVAILABLE', 'UNKNOWN_HISTORICAL_RATE']) });
  });

  it('posts later +/- corrections to original P, values closed P at 7/open Q at 9, and isolates unresolved work', () => {
    ticket('p-source', 10, 5, 'P');
    ticket('q-source', 4, 5, 'Q');
    db.prepare('UPDATE models SET operations_json=? WHERE company_id=? AND id=?')
      .run(JSON.stringify([{ name: 'Sew', rate: 9 }]), tenant, 'm');
    expect(closeWithProductionArchive(7, 'P', tenant, 'after-p').committed).toBe(true);

    const post = (id: string, qty: number, sourceId?: string) => executeRecordAdjustmentCommand(directory, tenant, {
      commandId: `cmd-${id}`, operationId: `op-${id}`, adjustmentId: id, companyId: tenant,
      modelId: 'm', workerId: 7, opName: 'Sew', deltaQty: qty, reason: 'synthetic correction', createdBy: 'fixture',
      effectiveDate: '2026-10-10', createdAt: '2026-10-10T12:00:00Z',
      ...(sourceId ? { originalTicketId: sourceId, originalEntryId: `${sourceId}-entry` } : {})
    });
    expect(post('p-plus', 2, 'p-source')).toMatchObject({ committed: true });
    expect(post('p-minus', -3, 'p-source')).toMatchObject({ committed: true });
    expect(post('q-plus', 2, 'q-source')).toMatchObject({ committed: true });
    expect(db.prepare(`SELECT adjustment_id, original_period_id, original_rate_snapshot, attribution_status
      FROM production_adjustments WHERE company_id=? ORDER BY adjustment_id`).all(tenant)).toEqual([
      { adjustment_id: 'p-minus', original_period_id: 'P', original_rate_snapshot: 5, attribution_status: 'RESOLVED' },
      { adjustment_id: 'p-plus', original_period_id: 'P', original_rate_snapshot: 5, attribution_status: 'RESOLVED' },
      { adjustment_id: 'q-plus', original_period_id: 'Q', original_rate_snapshot: 5, attribution_status: 'RESOLVED' }
    ]);

    const closed = readPeriodPayrollProjection(db, tenant, 'P');
    expect(closed.workers[0]).toMatchObject({ gross: 63, pieces: 9, net: 55,
      accountingStatus: 'INCOMPLETE', accountingReasons: expect.arrayContaining(['HISTORICAL_BASELINE_UNVERIFIED', 'LOCAL_MUTATION_PENDING']) });
    expect(closed.workers[0].accountingReasons).not.toContain('UNKNOWN_ORIGINAL_PERIOD');
    const view = payrollDisplay([{ id: 'm', name: 'M', operations: [{ id: 'sew', name: 'Sew', rate: 9 }], hisobQuantities: {} }] as any,
      [{ id: 7, name: 'Worker', avans: 4, jarima: 3, staj: 1 }] as any, closed as any, tenant, 'P');
    expect(view.cellAmounts[JSON.stringify(['m', 7, 'Sew'])]).toBe(63);
    expect(view.masterReport.workers[0]).toMatchObject({ umumiy: 63, sofFoyda: 55 });

    expect(post('unattributed', 50)).toMatchObject({ committed: true });
    expect(db.prepare(`SELECT original_period_id, original_rate_snapshot, attribution_status
      FROM production_adjustments WHERE company_id=? AND adjustment_id='unattributed'`).get(tenant))
      .toEqual({ original_period_id: null, original_rate_snapshot: null, attribution_status: 'UNRESOLVED' });
    const open = readPeriodPayrollProjection(db, tenant, 'Q');
    expect(open.workers[0]).toMatchObject({ gross: 54, pieces: 6, rawQuantity: 6,
      accountingReasons: expect.arrayContaining(['UNKNOWN_ORIGINAL_PERIOD']) });
    expect(open.workers[0].unresolvedAdjustmentCount).toBe(1);
  });

  it('carries incomplete party through ClosePeriod, enters Q once, survives restart/replay and exports exact month money', () => {
    db.prepare("DELETE FROM period_archives WHERE company_id=? AND period_id='Q'").run(tenant);
    db.prepare("DELETE FROM periods WHERE company_id=? AND id='Q'").run(tenant);
    db.prepare('UPDATE models SET operations_json=? WHERE company_id=? AND id=?')
      .run(JSON.stringify([{ name: 'Sew', rate: 9 }]), tenant, 'm');
    db.prepare(`INSERT INTO parties(id,company_id,party_number,physical_party_number,model_id,patta_count,
      sizes_json,archived_patta_numbers_json,created_at,updated_at)
      VALUES ('carry-party',?,'1','1','m',2,'{"M":2}','[]',?,?)`).run(tenant, now, now);
    ticket('old-period-ticket', 2, 5, 'P');
    db.prepare("UPDATE tickets SET party_record_id='carry-party' WHERE id='old-period-ticket'").run();

    expect(closeWithProductionArchive(7, 'P', tenant, 'Q').committed).toBe(true);
    expect(db.prepare("SELECT status,is_closed,archived_patta_numbers_json FROM parties WHERE id='carry-party'").get())
      .toEqual({ status: 'ACTIVE', is_closed: 0, archived_patta_numbers_json: '[1]' });
    expect(db.prepare("SELECT period_id,is_closed,status FROM tickets WHERE id='old-period-ticket'").get())
      .toEqual({ period_id: 'P', is_closed: 1, status: 'CONFIRMED' });

    const entryCommand = { commandId: 'carry-entry', operationId: 'carry-entry', companyId: tenant,
      ticketId: '00000000-0000-4000-8000-000000000777', modelId: 'm', partyNumber: '1', partyRecordId: 'carry-party',
      periodId: 'Q', pattaNumber: 2, qty: 3, effectiveDate: '2026-10-12', submittedAt: '2026-10-12T12:00:00Z',
      entries: [{ workerId: 7, opName: 'Sew', rateSnapshot: 5 }] };
    expect(executeSubmitTicketCommand(directory, tenant, entryCommand)).toMatchObject({ committed: true, status: 'PENDING_SYNC' });
    expect(executeSubmitTicketCommand(directory, tenant, entryCommand)).toMatchObject({ committed: true, isReplay: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE id=?").get(entryCommand.ticketId).n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ticket_entries WHERE ticket_id=?").get(entryCommand.ticketId).n).toBe(1);
    expect(db.prepare("SELECT period_id,status,is_closed FROM tickets WHERE id=?").get(entryCommand.ticketId))
      .toEqual({ period_id: 'Q', status: 'PENDING_SYNC', is_closed: 0 });
    expect(executeRecordAdjustmentCommand(directory, tenant, {
      commandId: 'late-original-correction', operationId: 'late-original-correction',
      adjustmentId: 'late-p-correction', companyId: tenant, modelId: 'm', workerId: 7, opName: 'Sew',
      deltaQty: 1, reason: 'late synthetic source correction', createdBy: 'fixture',
      originalTicketId: 'old-period-ticket', originalEntryId: 'old-period-ticket-entry',
      effectiveDate: '2026-10-12', createdAt: '2026-10-12T13:00:00Z'
    })).toMatchObject({ committed: true });
    expect(db.prepare("SELECT original_period_id,original_rate_snapshot,attribution_status FROM production_adjustments WHERE adjustment_id='late-p-correction'").get())
      .toEqual({ original_period_id: 'P', original_rate_snapshot: 5, attribution_status: 'RESOLVED' });

    manager.closeAllCompanyDatabases();
    db = manager.getCompanyDatabase(directory, tenant);
    const closed = readPeriodPayrollProjection(db, tenant, 'P');
    const openProjection = require('../readers/workbookPayrollRead.cjs').readWorkbookPayrollProjection(db, tenant);
    expect(closed.workers[0]).toMatchObject({ gross: 21, pieces: 3, net: 13 }); // (2 original + 1 correction) × frozen 7; deductions/staj 8.
    expect(openProjection.currentPeriod.id).toBe('Q');
    expect(openProjection.payrollValuation.workers[0]).toMatchObject({ gross: 27, pieces: 3, net: 26,
      accountingReasons: expect.arrayContaining(['LOCAL_MUTATION_PENDING']) });
    const workbook = createPayrollWorkbook(openProjection.models, openProjection.workers, openProjection.payrollValuation);
    const rows = require('xlsx-js-style').utils.sheet_to_json(workbook.Sheets.Umumiy, { header: 1, defval: '' });
    expect(rows[2].slice(0, 7)).toEqual([7, 'Worker', 26, 1, '', '', 27]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE id=?').get(entryCommand.ticketId).n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_entries WHERE ticket_id=?').get(entryCommand.ticketId).n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM production_adjustments WHERE adjustment_id='late-p-correction'").get().n).toBe(1);

    const closedBeforeMissingArchive = readPeriodPayrollProjection(db, tenant, 'P');
    expect(closedBeforeMissingArchive.workers[0].gross).toBe(21); // (2 + 1) × frozen 7; captured 5/current 9 ignored.
    db.prepare("DELETE FROM period_archives WHERE company_id=? AND period_id='P'").run(tenant);
    expect(readPeriodPayrollProjection(db, tenant, 'P').workers[0]).toMatchObject({ gross: 0,
      unknownEntryCount: 1, unknownQuantity: 2, accountingReasons: expect.arrayContaining(['CLOSED_TARIFF_UNAVAILABLE']) });
    expect(db.prepare("SELECT period_id FROM tickets WHERE id='old-period-ticket'").get().period_id).toBe('P');
  });
});
