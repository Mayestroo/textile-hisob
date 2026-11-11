import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Execute the shipped loader, not a reimplementation of its concurrency policy.
const source = fs.readFileSync(path.resolve(__dirname, '../../../../webapps/admin/scripts/admin.js'), 'utf8');
const loader = source.slice(source.indexOf('  async function loadCompanyAdminData('), source.indexOf('  function renderCompanyHome('));
describe('admin asynchronous period ownership', () => {
  it('does not let a late old-period load overwrite the newer selected period', async () => {
    const reads: Array<(value: any) => void> = [];
    const rendered: string[] = [];
    const panel: any = { companyId: 'a', periodId: 'P' };
    const context = { companyPanel: panel, state: { sessionToken: 'token', sessionActorId: '123' }, API: '/api',
      payrollQuery: () => ({ periodId: panel.periodId }), withQuery: (_: string, query: any) => query.periodId,
      request: () => new Promise(resolve => reads.push(resolve)), loadCompanyCollection: async () => [],
      renderCompanyHome: (payroll: any) => rendered.push(payroll.period.periodId),
      renderCompanyWorkers() {}, renderCompanyParties() {}, renderCompanyModels() {}, coToast() {} };
    const load = vm.runInNewContext(`${loader}\nloadCompanyAdminData`, context);
    const old = load();
    panel.periodId = 'Q';
    const current = load();
    reads[1]({ payroll: { period: { periodId: 'Q' }, workers: [{ workerId: 1, net: 25 }] } });
    await current;
    reads[0]({ payroll: { period: { periodId: 'P' }, workers: [{ workerId: 1, net: 999 }] } });
    await old;
    expect(rendered).toEqual(['Q']);
    expect(panel.payroll[0].net).toBe(25);
  });
});
