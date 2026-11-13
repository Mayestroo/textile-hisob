import { describe, expect, it } from 'vitest';
import { calculateMasterPayroll } from '../../../apps/desktop/renderer/engine/formulaEngine';
const { reducePayroll } = require('../payrollReducer.cjs');

describe('recurring STAJ deduction', () => {
  const workers = [{ worker_id: 7, worker_name: 'Worker', staj: 140000 }];

  it('deducts the full amount in every open period, including a new month with no earnings', () => {
    for (const id of ['november', 'december']) {
      const period = { id, is_closed: false };
      const empty = reducePayroll(period, workers, [], [], []).workers[0];
      expect(empty).toMatchObject({ staj: 140000, gross: 0, net: -140000, accountingStatus: 'COMPLETE' });
      const paid = reducePayroll(period, workers, [], [], [{ worker_id: 7, type: 'OKLAD', total: 500000 }]).workers[0];
      expect(paid).toMatchObject({ staj: 140000, gross: 500000, net: 360000 });
    }
    expect(workers[0].staj).toBe(140000);
  });

  it('freezes the recurring amount at close while the next period uses the current worker amount', () => {
    const current = [{ ...workers[0], staj: 200000 }];
    const basis = { stajDebtLedgerVersion: 1, closingArchive: {
      stajDeductionMode: 'RECURRING', models: [], workers: [{ id: 7, staj: 140000 }]
    } };
    expect(reducePayroll({ id: 'november', is_closed: true }, current, [], [], [], basis).workers[0])
      .toMatchObject({ staj: 140000, net: -140000 });
    expect(reducePayroll({ id: 'december', is_closed: false }, current, [], [], []).workers[0])
      .toMatchObject({ staj: 200000, net: -200000 });
  });

  it('retains previously closed ledger-only archive calculations', () => {
    const basis = { stajDebtLedgerVersion: 1, closingArchive: { models: [], workers: [{ id: 7, staj: 140000 }] } };
    const period = { id: 'old', is_closed: true };
    expect(reducePayroll(period, workers, [], [], [], basis).workers[0]).toMatchObject({ staj: 0, net: 0 });
    expect(reducePayroll(period, workers, [], [], [{ worker_id: 7, type: 'STAJ_DEBT', total: 10000 }], basis).workers[0])
      .toMatchObject({ staj: 10000, net: -10000 });
  });

  it('also deducts recurring STAJ in the legacy workbook calculation', () => {
    expect(calculateMasterPayroll([], [{ id: 7, name: 'Worker', staj: 140000, avans: 0, jarima: 0 }]))
      .toMatchObject({ totalStaj: 140000, totalSofFoyda: -140000, workers: [{ staj: 140000, sofFoyda: -140000 }] });
  });
});
