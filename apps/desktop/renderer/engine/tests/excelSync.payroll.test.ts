import { afterEach, describe, expect, it } from 'vitest';
import XLSX from 'xlsx-js-style';
import { createPayrollWorkbook, exportWorkbookToExcel } from '../excelSync';
import { ModelConfig, PayrollValuation, Worker } from '../../types/workbook';

declare const require: (id: string) => any;
declare const process: { pid: number };
const fs = require('fs');
const os = require('os');
const path = require('path');

const worker: Worker = { id: 7, name: 'Local worker', staj: 1, avans: 4, jarima: 3 };
const model: ModelConfig = {
  id: 'm', name: 'Local model', hisobSheetName: 'Hisob', title: '', party: '', color: '', size: '',
  pattaOpsOrder: [], operations: [{ id: 'sew', name: 'Sew', rate: 9 }],
  hisobQuantities: { 7: { Sew: 12 } }
};
let generatedFile = '';
afterEach(() => { if (generatedFile && fs.existsSync(generatedFile)) fs.unlinkSync(generatedFile); generatedFile = ''; });

function valuation(rate: number | null, amount: number | null, status: 'COMPLETE' | 'INCOMPLETE' = 'COMPLETE', closed = false): PayrollValuation {
  return {
    companyId: 'hisob_test_display', period: { periodId: 'P', name: 'P', startDate: '2026-09-01', endDate: null, isClosed: closed, restated: closed },
    accountingStatus: status,
    accountingReasons: status === 'COMPLETE' ? [] : ['UNKNOWN_HISTORICAL_RATE'],
    syncStatus: status === 'COMPLETE' ? 'CURRENT' : 'UNKNOWN',
    tariffs: [{ id: 'm', operations: [{ name: 'Sew', rate }] }],
    workers: [{ workerId: 7, workerName: worker.name, gross: amount ?? 0, net: (amount ?? 0) - 8,
      staj: 1, avans: 4, jarima: 3, accountingStatus: status, accountingReasons: status === 'COMPLETE' ? [] : ['UNKNOWN_HISTORICAL_RATE'],
      syncStatus: status === 'COMPLETE' ? 'CURRENT' : 'UNKNOWN',
      models_breakdown: { m: { id: 'm', name: model.name, earnings: amount ?? 0,
        operations: [{ name: 'Sew', rate, qty: 12, amount }] } } }]
  };
}

describe('payroll XLSX export uses shared valuation evidence', () => {
  it('writes the actual xlsx with archived 7 tariff, 84 gross, 76 net and provisional status', () => {
    const closed = valuation(7, 84, 'INCOMPLETE', true);
    createPayrollWorkbook([model], [worker], closed);
    generatedFile = path.join(os.tmpdir(), `hisob-payroll-export-${process.pid}.xlsx`);
    exportWorkbookToExcel([model], [worker], generatedFile, closed);
    const reopened = XLSX.readFile(generatedFile);
    const umumiy = XLSX.utils.sheet_to_json(reopened.Sheets.Umumiy, { header: 1, defval: '' }) as unknown[][];
    const hesab = XLSX.utils.sheet_to_json(reopened.Sheets.Hisob, { header: 1, defval: '' }) as unknown[][];
    expect(umumiy[0][0]).toContain('Noma’lum tarif');
    expect(umumiy[2].slice(0, 9)).toEqual([7, 'Local worker', 76, 1, 4, 3, 84, 0, 0]);
    expect(hesab[1][2]).toBe(7);
    expect(hesab[2][2]).toBe(84);
    expect(hesab[2][3]).toBe(12);
    expect(hesab[3][2]).toBe(84);
    expect(reopened.Sheets.Hisob.A1.c?.[0].t).toContain('yakuniy');
  });

  it('exports open at 9 as 108; missing rate is unknown (not zero); real zero remains zero', () => {
    const open = createPayrollWorkbook([model], [worker], valuation(9, 108));
    const openRows = XLSX.utils.sheet_to_json(open.Sheets.Hisob, { header: 1, defval: '' }) as unknown[][];
    expect(openRows[1][2]).toBe(9);
    expect(openRows[2][2]).toBe(108);

    const missing = createPayrollWorkbook([model], [worker], valuation(null, null, 'INCOMPLETE'));
    const missingRows = XLSX.utils.sheet_to_json(missing.Sheets.Hisob, { header: 1, defval: '' }) as unknown[][];
    expect(missingRows[1][2]).toBe('Noma’lum');
    expect(missingRows[2][2]).toBe('Noma’lum');
    expect(missingRows[3][2]).toBe('Noma’lum');

    const zero = createPayrollWorkbook([model], [worker], valuation(0, 0));
    const zeroRows = XLSX.utils.sheet_to_json(zero.Sheets.Hisob, { header: 1, defval: '' }) as unknown[][];
    expect(zeroRows[1][2]).toBe(0);
    expect(zeroRows[2][2]).toBe('');
    expect(zeroRows[3][2]).toBe(0);
  });

  it('keeps pending provisional and original-period adjustment value once from the shared reader result', () => {
    const pendingOnce = valuation(7, 105, 'INCOMPLETE');
    const workbook = createPayrollWorkbook([model], [worker], pendingOnce);
    const umumiy = XLSX.utils.sheet_to_json(workbook.Sheets.Umumiy, { header: 1, defval: '' }) as unknown[][];
    const hesab = XLSX.utils.sheet_to_json(workbook.Sheets.Hisob, { header: 1, defval: '' }) as unknown[][];
    expect(umumiy[2][6]).toBe(105);
    expect(hesab[2][2]).toBe(105);
    expect(hesab[3][2]).toBe(105);
    expect(umumiy[0][0]).toContain('Noma’lum tarif');
  });

  it('writes Oklad/Magazin and all totals from period valuation while model sheets remain piecework-only', () => {
    const money: PayrollValuation = {
      companyId: 'hisob_test_display',
      period: { periodId: 'P', name: 'P', startDate: '2026-09-01', endDate: null, isClosed: false, restated: false },
      accountingStatus: 'COMPLETE', accountingReasons: [], syncStatus: 'CURRENT',
      tariffs: [{ id: 'm', operations: [{ name: 'Sew', rate: 50000 }] }],
      workers: [{ workerId: 7, workerName: worker.name, pieceworkGross: 500000, oklad: 2000000, magazin: 100000,
        gross: 2500000, net: 2125000, staj: 25000, avans: 200000, jarima: 50000, pieces: 10,
        models_breakdown: { m: { id: 'm', name: model.name, earnings: 500000,
          operations: [{ name: 'Sew', qty: 10, rate: 50000, amount: 500000 }] } } }]
    };
    createPayrollWorkbook([model], [worker], money);
    generatedFile = path.join(os.tmpdir(), `hisob-payroll-money-${process.pid}.xlsx`);
    exportWorkbookToExcel([model], [worker], generatedFile, money);
    const reopened = XLSX.readFile(generatedFile);
    const umumiy = XLSX.utils.sheet_to_json(reopened.Sheets.Umumiy, { header: 1, defval: '' }) as unknown[][];
    const hisob = XLSX.utils.sheet_to_json(reopened.Sheets.Hisob, { header: 1, defval: '' }) as unknown[][];
    expect(umumiy[0].slice(0, 9)).toEqual([
      '№', 'Исм фамилия', 'Соф фойда', 'Стаж', 'Аванс', 'Jarima', 'Jami ish haqi (ish + Oklad)', 'Oklad', 'Magazin'
    ]);
    expect(umumiy[1].slice(0, 10)).toEqual([7, 'Local worker', 2125000, 25000, 200000, 50000, 2500000, 2000000, 100000, 500000]);
    expect(umumiy[2].slice(2, 9)).toEqual([2125000, 25000, 200000, 50000, 2500000, 2000000, 100000]);
    expect(hisob[2][2]).toBe(500000);
    expect(hisob[3][2]).toBe(500000);
  });

  it('exports unavailable payroll components as unknown rather than fresh worker attributes', () => {
    const unavailable: PayrollValuation = { companyId: 'hisob_test_display', period: null, workers: [],
      accountingStatus: 'UNAVAILABLE', accountingReasons: ['PAYROLL_VALUATION_UNAVAILABLE'], syncStatus: 'UNKNOWN' };
    const workbook = createPayrollWorkbook([model], [worker], unavailable);
    const umumiy = XLSX.utils.sheet_to_json(workbook.Sheets.Umumiy, { header: 1, defval: '' }) as unknown[][];
    expect(umumiy[2].slice(2, 9)).toEqual(Array(7).fill('Noma’lum'));
  });
});
