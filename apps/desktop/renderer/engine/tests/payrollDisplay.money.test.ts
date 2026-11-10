import { describe, expect, it } from 'vitest';
import { payrollDisplay } from '../payrollDisplay';
import { ModelConfig, PayrollValuation, Worker } from '../../types/workbook';

const model: ModelConfig = { id: 'm', name: 'Model', hisobSheetName: 'Model-hisob', title: '', party: '',
  color: '', size: '', pattaOpsOrder: [], operations: [{ id: 'sew', name: 'Sew', rate: 999 }],
  hisobQuantities: { 7: { Sew: 500 } } };
const worker: Worker = { id: 7, name: 'Worker', staj: 900, avans: 900, jarima: 900, oklad: 900, magazin: 900 };
const valuation: PayrollValuation = {
  companyId: 'hisob_test_company',
  period: { periodId: 'P', name: 'P', startDate: '2026-09-01', endDate: null, isClosed: false, restated: false },
  accountingStatus: 'COMPLETE', accountingReasons: [], syncStatus: 'CURRENT',
  tariffs: [{ id: 'm', operations: [{ name: 'Sew', rate: 50000 }] }],
  workers: [{ workerId: 7, name: 'Worker', pieceworkGross: 500000, oklad: 2000000, magazin: 100000,
    gross: 2500000, staj: 25000, avans: 200000, jarima: 50000, net: 2125000, pieces: 10,
    models_breakdown: { m: { id: 'm', name: 'Model', earnings: 500000,
      operations: [{ name: 'Sew', rate: 50000, qty: 10, amount: 500000 }] } } }]
};

describe('payroll display takes all company-bound worker money from selected-period valuation', () => {
  it('treats an absent valuation as unavailable instead of crashing', () => {
    const display = payrollDisplay([model], [worker], undefined, 'hisob_test_company', 'P');
    expect(display.ready).toBe(false);
    expect(display.reportReady).toBe(false);
    expect(display.unknown.has(display.key('m', 7, 'Sew'))).toBe(true);
  });

  it('uses gross/net and manual components from valuation, while model earnings remain piecework', () => {
    const display = payrollDisplay([model], [worker], valuation, 'hisob_test_company', 'P');
    expect(display.masterReport.workers[0]).toMatchObject({
      pieceworkGross: 500000, oklad: 2000000, magazin: 100000,
      umumiy: 2500000, avans: 200000, jarima: 50000, staj: 25000, sofFoyda: 2125000
    });
    expect(display.masterReport.modelTotals.m).toBe(500000);
    expect(display.masterReport.totalStaj).toBe(25000);
    expect(display.masterReport.totalAvans).toBe(200000);
    expect(display.masterReport.totalJarima).toBe(50000);
    expect(display.masterReport.totalSofFoyda).toBe(2125000);
    expect(display.reportReady).toBe(true);
    expect(display.workerMoneyReady.has(7)).toBe(true);
  });

  it('does not fill a missing valuation worker from fresh worker attributes', () => {
    const missing = { ...valuation, workers: [] };
    const display = payrollDisplay([model], [worker], missing, 'hisob_test_company', 'P');
    expect(display.reportReady).toBe(false);
    expect(display.workerMoneyReady.has(7)).toBe(false);
    expect(display.masterReport.workers[0]).toMatchObject({
      pieceworkGross: 0, oklad: 0, magazin: 0, umumiy: 0, avans: 0, jarima: 0, staj: 0, sofFoyda: 0
    });
    expect(display.unknown.has(display.key('m', 7, 'Sew'))).toBe(true);
  });

  it('keeps known manual money provisional when the operation tariff is unknown, but accepts a genuine zero tariff', () => {
    const unknownValuation: PayrollValuation = {
      ...valuation, accountingStatus: 'INCOMPLETE', accountingReasons: ['UNKNOWN_HISTORICAL_RATE'],
      tariffs: [{ id: 'm', operations: [{ name: 'Sew', rate: null }] }],
      workers: [{ ...valuation.workers[0], models_breakdown: { m: {
        id: 'm', name: 'Model', earnings: 0, operations: [{ name: 'Sew', rate: null, qty: 10, amount: null }]
      } } }]
    };
    const incomplete = payrollDisplay([model], [worker], unknownValuation, 'hisob_test_company', 'P');
    expect(incomplete.incomplete).toBe(true);
    expect(incomplete.label).toContain('Noma’lum tarif');
    expect(incomplete.cellAmounts[incomplete.key('m', 7, 'Sew')]).toBeNull();
    expect(incomplete.masterReport.workers[0].oklad).toBe(2000000);
    const zero = payrollDisplay([model], [worker], {
      ...valuation, tariffs: [{ id: 'm', operations: [{ name: 'Sew', rate: 0 }] }],
      workers: [{ ...valuation.workers[0], pieceworkGross: 0, gross: 2000000, net: 1625000,
        models_breakdown: { m: { id: 'm', name: 'Model', earnings: 0,
          operations: [{ name: 'Sew', rate: 0, qty: 10, amount: 0 }] } } }]
    }, 'hisob_test_company', 'P');
    expect(zero.cellAmounts[zero.key('m', 7, 'Sew')]).toBe(0);
    expect(zero.unknown.size).toBe(0);
    expect(zero.masterReport.workers[0]).toMatchObject({ pieceworkGross: 0, oklad: 2000000,
      umumiy: 2000000, sofFoyda: 1625000 });
  });
});
