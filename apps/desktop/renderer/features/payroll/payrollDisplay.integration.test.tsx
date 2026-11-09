import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useWorkbookStore } from '../../store/workbookStore';
import { hydrateWorkbookProjection } from '../../store/businessMutations';
import { payrollDisplay } from '../../engine/payrollDisplay';
import { exportWorkbookToExcel } from '../../engine/excelSync';
declare const require: (id: string) => any;
declare const process: { env: Record<string, string | undefined>; pid: number };

const root = 'D:/hisob-new/.opencode/deep-audit/output/local-test-db';
const company = 'hisob_test_display';
const manager = require('../../../electron/database/databaseManager.cjs');
const { readWorkbookPayrollProjection } = require('../../../electron/database/workbookPayrollRead.cjs');
const { loadPayrollValuationFromSqlite } = require('../../../electron/database/payrollReader.cjs');
const { loadPayroll } = require('../../../../server/modules/workers/payrollValuation.cjs');
const { canonicalStringify, computePayloadHash } = require('../../../electron/database/canonicalPayload.cjs');
const fs = require('fs');
const path = require('path');
const os = require('os');
let db: any;

describe('local SQLite db-read -> hydrated store -> rendered Hisob/Umumiy money', () => {
  beforeAll(() => {
    db = manager.getCompanyDatabase(root, company);
    db.exec('BEGIN');
    const stamp = '2026-09-15T12:00:00Z';
    db.prepare(`INSERT INTO models(id,company_id,name,operations_json,created_at,updated_at)
      VALUES ('m',?,'Local model','[{"id":"sew","name":"Sew","rate":7}]',?,?)`).run(company, stamp, stamp);
    db.prepare(`INSERT INTO workers(id,company_id,name,staj,created_at,updated_at)
      VALUES (7,?,'Local worker',1,?,?)`).run(company, stamp, stamp);
    for (const [period, start, closed] of [['P', '2026-09-01', 0], ['Q', '2026-08-01', 1]] as const) {
      db.prepare(`INSERT INTO periods(id,company_id,name,start_date,is_closed,created_at)
        VALUES (?,?,?,?,?,?)`).run(period, company, period, start, closed, stamp);
    }
    const closedArchive = { models: [{ id: 'm', operations: [{ name: 'Sew', rate: 7 }] }] };
    db.prepare(`INSERT INTO period_archives(company_id,period_id,archive_json,sha256,archived_at)
      VALUES (?,?,?,?,?)`).run(company, 'Q', JSON.stringify(closedArchive), computePayloadHash(canonicalStringify(closedArchive)), stamp);
    for (const [id, period, qty, captured, status, provenance] of [
      ['entered', 'P', 10, 5, 'CONFIRMED', 'LOCAL_COMMAND'],
      ['old', 'Q', 4, 5, 'CONFIRMED', 'REMOTE_SYNC']
    ] as const) {
      db.prepare(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,patta_number,
        qty,status,submitted_at,created_at,provenance) VALUES (?,?,'m',?,'1',1,?,?,?, ?,?)`)
        .run(id, company, period, qty, status, stamp, stamp, provenance);
      db.prepare(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,qty,rate_snapshot,created_at)
        VALUES (?,?,?,'Sew',7,?,?,?)`).run(`${id}-e`, id, company, qty, captured, stamp);
    }
    for (const [id, period, qty] of [['plus', 'P', 2], ['closed-plus', 'Q', 2]] as const) {
      db.prepare(`INSERT INTO production_adjustments(adjustment_id,company_id,model_id,worker_id,op_name,
        delta_qty,reason,status,provenance,created_at,created_by,original_period_id,attribution_status)
        VALUES (?,?,'m',7,'Sew',?,'fixture','APPROVED','MANUAL_CORRECTION',?,'test',?,'RESOLVED')`)
        .run(id, company, qty, stamp, period);
    }
    for (const [id, type, amount] of [['av', 'AVANS', 4], ['ja', 'JARIMA', 3]] as const) {
      db.prepare(`INSERT INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,provenance,created_at)
        VALUES (?,?,7,'P',?,?,'REMOTE_SYNC',?)`).run(id, company, type, amount, stamp);
    }
  });
  afterAll(() => { if (db?.open) db.exec('ROLLBACK'); manager.closeAllCompanyDatabases(); });

  function renderCurrent() {
    const read = readWorkbookPayrollProjection(db, company);
    const hydrated = hydrateWorkbookProjection(read, company);
    useWorkbookStore.setState({ ...hydrated, licenseStatus: { isActivated: true, machineId: 'test-device', companyId: company } });
    const display = payrollDisplay(hydrated.models, hydrated.workers, hydrated.payrollValuation, company, hydrated.currentPeriod.id);
    return { read, hydrated, display };
  }

  it('reprices captured 5 at active 7, applies +2 in original P and renders 84 gross / 76 net', () => {
    const { read, hydrated, display } = renderCurrent();
    expect(read.payrollValuation.workers[0]).toMatchObject({ gross: 84, net: 76, pieces: 12 });
    expect(hydrated.models[0].hisobQuantities[7].Sew).toBe(12);
    expect(display.cellAmounts[JSON.stringify(['m', 7, 'Sew'])]).toBe(84);
    expect(display.masterReport.workers[0]).toMatchObject({ umumiy: 84, sofFoyda: 76 });
    expect(display.incomplete).toBe(true);
  });

  it('writes an actual XLSX from the same local SQLite read and preserves matching effective money/status', () => {
    const { read, hydrated } = renderCurrent();
    const output = path.join(os.tmpdir(), `hisob-sqlite-payroll-${process.pid}.xlsx`);
    try {
      exportWorkbookToExcel(read.models, read.workers, output, read.payrollValuation);
      const XLSX = require('xlsx-js-style');
      const generated = XLSX.readFile(output);
      const umumiy = XLSX.utils.sheet_to_json(generated.Sheets.Umumiy, { header: 1, defval: '' });
      const hesabSheetName = generated.SheetNames.find((name: string) => name.toLowerCase().includes('hisob'));
      const hesabSheet = generated.Sheets[hesabSheetName];
      const hisob = XLSX.utils.sheet_to_json(hesabSheet, { header: 1, defval: '' });
      expect(umumiy[0][0]).toContain('Taxminiy');
      expect(umumiy[2].slice(0, 7)).toEqual([7, 'Local worker', 76, 1, 4, 3, 84]);
      expect(hisob[1][2]).toBe(7);
      expect(hisob[2][2]).toBe(84);
      expect(hisob[2][3]).toBe(12);
      expect(hisob[3][2]).toBe(84);
      expect(hesabSheet.A1.c?.[0].t).toContain('Taxminiy');
      expect(hydrated.currentPeriod.id).toBe('P');
    } finally {
      if (fs.existsSync(output)) fs.unlinkSync(output);
    }
  });

  it('shows offline pending once, then retains accepted LOCAL provenance after lost ACK/retry', () => {
    const stamp = '2026-09-15T12:00:00Z';
    db.prepare(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,patta_number,
      qty,status,submitted_at,created_at,provenance) VALUES ('offline',?,'m','P','1',2,3,'PENDING_SYNC',?,?,'LOCAL_COMMAND')`)
      .run(company, stamp, stamp);
    db.prepare(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,qty,rate_snapshot,created_at)
      VALUES ('offline-e','offline',?,'Sew',7,3,5,?)`).run(company, stamp);
    expect(renderCurrent().read.payrollValuation.workers[0].gross).toBe(105);
    db.prepare("UPDATE tickets SET status='CONFIRMED' WHERE id='offline'").run();
    expect(renderCurrent().read.payrollValuation.workers[0].gross).toBe(105);
    expect(renderCurrent().display.masterReport.totalUmumiy).toBe(105);
  });

  it('freezes closed Q at 7 despite current 9, handles -1 correction, genuine 0 and missing tariff', () => {
    db.prepare(`UPDATE models SET operations_json='[{"id":"sew","name":"Sew","rate":9}]' WHERE id='m'`).run();
    db.prepare(`INSERT INTO production_adjustments(adjustment_id,company_id,model_id,worker_id,op_name,
      delta_qty,reason,status,provenance,created_at,created_by,original_period_id,attribution_status)
      VALUES ('closed-minus',?,'m',7,'Sew',-1,'fixture','APPROVED','REMOTE_SYNC','2026-09-15','test','Q','RESOLVED')`).run(company);
    expect(loadPayrollValuationFromSqlite(db, company, 'Q').workers[0].gross).toBe(35); // (4 + 2 - 1) * closing 7
    expect(renderCurrent().read.payrollValuation.workers[0].gross).toBe(135); // P 15 * new 9
    db.prepare(`UPDATE models SET operations_json='[{"id":"sew","name":"Sew","rate":0}]' WHERE id='m'`).run();
    expect(renderCurrent().read.payrollValuation.workers[0]).toMatchObject({ gross: 0, unknownEntryCount: 0 });
    db.prepare(`UPDATE models SET operations_json='[{"id":"sew","name":"Sew","rate":null}]' WHERE id='m'`).run();
    const missing = renderCurrent();
    expect(missing.read.payrollValuation.workers[0].accountingReasons).toContain('UNKNOWN_HISTORICAL_RATE');
    expect(missing.display.cellAmounts[JSON.stringify(['m', 7, 'Sew'])]).toBeNull();
    expect(missing.display.modelPrices.m).toBeNull();
    expect(loadPayrollValuationFromSqlite(db, company, 'Q').workers[0].gross).toBe(35);
  });

  it('rejects wrong company/period valuation rather than displaying a stale wage', () => {
    const { read, hydrated } = renderCurrent();
    const stale = payrollDisplay(hydrated.models, hydrated.workers, read.payrollValuation, 'other-company', 'P');
    expect(stale.ready).toBe(false);
    expect(stale.cellAmounts[JSON.stringify(['m', 7, 'Sew'])]).toBeNull();
    expect(payrollDisplay(hydrated.models, hydrated.workers, read.payrollValuation, company, 'Q').ready).toBe(false);
  });
});

describe.runIf(Boolean(process.env.NOVDA_LOCAL_TEST_PG_URL))('own loopback PostgreSQL server reader parity', () => {
  it('executes real server SQL for the same open/closed tariff facts', async () => {
    require('../../../../../.opencode/deep-audit/output/local-test-db/assert-local-pg.cjs');
    const { Client } = require('pg');
    const client = new Client({ connectionString: process.env.NOVDA_LOCAL_TEST_PG_URL, connectionTimeoutMillis: 4000 });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE periods(id varchar, company_id varchar, name varchar, start_date date, end_date date, is_closed integer);
        CREATE TEMP TABLE workers(id integer, company_id varchar, name varchar, staj integer, status varchar);
        CREATE TEMP TABLE models(id varchar, company_id varchar, name varchar, operations_json jsonb);
        CREATE TEMP TABLE tickets(id varchar, company_id varchar, model_id varchar, period_id varchar, status varchar);
        CREATE TEMP TABLE ticket_entries(ticket_id varchar, company_id varchar, worker_id integer, op_name varchar, qty integer, rate_snapshot numeric);
        CREATE TEMP TABLE production_adjustments(adjustment_id varchar,original_adjustment_id varchar,provenance varchar,company_id varchar,worker_id integer,model_id varchar,op_name varchar,delta_qty integer,status varchar,attribution_status varchar,original_period_id varchar,original_rate_snapshot numeric);
        CREATE TEMP TABLE worker_adjustments(worker_id integer,company_id varchar,period_id varchar,type varchar,amount integer,created_at timestamp);
        CREATE TEMP TABLE period_archives(company_id varchar,period_id varchar,archive_json jsonb);`);
      await client.query(`INSERT INTO periods VALUES ('P','hisob_test_display','P','2026-09-01',NULL,0),('Q','hisob_test_display','Q','2026-08-01',NULL,1);
        INSERT INTO workers VALUES (7,'hisob_test_display','Local worker',1,'ACTIVE');
        INSERT INTO models VALUES ('m','hisob_test_display','Local model','[{"name":"Sew","rate":7}]');
        INSERT INTO tickets VALUES ('entered','hisob_test_display','m','P','CONFIRMED'),('old','hisob_test_display','m','Q','CONFIRMED');
        INSERT INTO ticket_entries VALUES ('entered','hisob_test_display',7,'Sew',10,5),('old','hisob_test_display',7,'Sew',4,5);
        INSERT INTO production_adjustments(adjustment_id,company_id,worker_id,model_id,op_name,delta_qty,status,attribution_status,original_period_id)
          VALUES ('plus','hisob_test_display',7,'m','Sew',2,'APPROVED','RESOLVED','P'),('closed-plus','hisob_test_display',7,'m','Sew',2,'APPROVED','RESOLVED','Q');
        INSERT INTO worker_adjustments VALUES (7,'hisob_test_display','P','AVANS',4,'2026-09-15'),(7,'hisob_test_display','P','JARIMA',3,'2026-09-15');
        INSERT INTO period_archives VALUES ('hisob_test_display','Q','{"models":[{"id":"m","operations":[{"name":"Sew","rate":7}]}]}');`);
      const open = (await loadPayroll(client, company, 'P')).workers[0];
      const closed = (await loadPayroll(client, company, 'Q')).workers[0];
      expect([open.gross, open.net, closed.gross]).toEqual([84, 76, 42]);
      expect(open.accountingStatus).toBe('COMPLETE');
      expect(closed.accountingStatus).toBe('INCOMPLETE');
      await client.query(`UPDATE models SET operations_json='[{"name":"Sew","rate":9}]'`);
      expect((await loadPayroll(client, company, 'P')).workers[0].gross).toBe(108);
      expect((await loadPayroll(client, company, 'Q')).workers[0].gross).toBe(42);
    } finally { await client.query('ROLLBACK'); await client.end(); }
  });
});
