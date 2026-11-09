import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';

const workerHtml = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'bots', 'worker', 'webapp', 'index.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'admin-webapp', 'admin.js'), 'utf8');

describe('offline payroll consumers', () => {
  it.each([
    { rate: null, amount: null, status: 'INCOMPLETE', warning: true },
    { rate: 0, amount: 0, status: 'COMPLETE', warning: false },
    { rate: 5, amount: 20, status: 'COMPLETE', warning: false },
    { rate: 5, amount: 20, status: undefined, warning: true }
  ])('renders worker webapp $rate / $status without inventing an operation amount', ({ rate, amount, status, warning }) => {
    const elements = new Map<string, any>();
    const document = { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', classList: { add() {}, remove() {} } });
      return elements.get(id);
    } };
    const state = { calculations: { net: -2, gross: 10, pieceworkGross: 7, oklad: 3, magazin: 1, avans: 12, jarima: 0, staj: 0, pieces: 4,
       accountingStatus: status, unknownEntryCount: status === 'INCOMPLETE' ? 1 : 0, unresolvedAdjustmentCount: 0,
      modelsBreakdown: { m: { name: 'Model', earnings: 10, operations: [{ name: 'Op', qty: 4, rate, amount }] } } } };
    const hero = workerHtml.slice(workerHtml.indexOf('    function renderHero() {'), workerHtml.indexOf('    function renderOperations() {'));
    const ops = workerHtml.slice(workerHtml.indexOf('    function renderOperations() {'), workerHtml.indexOf('      // Fetch and render tickets that belong to this worker'));
    const context = { state, document, formatMoney: (n: number) => `${n} so'm`, formatNumber: String, escapeHtml: String };
    vm.runInNewContext(`${hero}\n${ops}\nrenderHero(); renderOperations();`, context);
    expect(elements.get('netPaySubtitle').textContent.includes('Hisob to‘liq emas')).toBe(warning);
    expect(elements.get('netPayAmount').textContent.includes('oraliq')).toBe(warning);
    expect(elements.get('modelsBreakdownList').innerHTML).toContain(rate == null ? 'Summa noma’lum' : `${amount} so'm`);
    if (rate === 0) expect(elements.get('modelsBreakdownList').innerHTML).toContain("0 so'm / dona");
  });

  it('renders admin warning for only incomplete workers and tolerates legacy DTOs', () => {
    const helpers = adminJs.slice(adminJs.indexOf('  function payrollIncomplete('), adminJs.indexOf('  function setOnlineStatus('));
    const context: any = {};
    vm.runInNewContext(`${helpers}\nthis.render = (workers) => [payrollWarning(workers), ...workers.map(w => payrollAmount(w, w.net))];`, context);
    expect(context.render([{ accountingStatus: 'INCOMPLETE', unknownEntryCount: 1, net: -2 }, { accountingStatus: 'COMPLETE', net: 0 }]))
       .toEqual(expect.arrayContaining([expect.stringContaining('1 ta ish narxi noma’lum'), '-2 (oraliq, tasdiqlanmagan)', '0']));
    expect(context.render([{ net: 0 }])).toEqual([expect.stringContaining('Hisob to‘liq emas'), '0 (oraliq, tasdiqlanmagan)']);
  });

  it.each([
    { status: 'INCOMPLETE', count: 1, expected: 'Hisob to‘liq emas' },
    { status: 'COMPLETE', count: 0, expected: '' },
    { status: undefined, count: 0, expected: 'Hisob to‘liq emas' }
  ])('renders actual admin payroll totals and scoped row labels for $status', async ({ status, count, expected }) => {
    const elements = new Map<string, any>();
    const byId = (id: string) => {
      if (id === 'payrollCardGrid') return null;
      if (!elements.has(id)) elements.set(id, { textContent: '', appendChild() {} });
      return elements.get(id);
    };
    const rows: string[][] = [];
    const workers = [{ workerId: 1, name: 'A', pieceworkGross: 7, oklad: 3, gross: 10, magazin: 1, net: -2, avans: 12, jarima: 0, staj: 0,
      pieces: 4, accountingStatus: status, unknownEntryCount: count },
    { workerId: 2, name: 'B', pieceworkGross: 0, oklad: 0, gross: 0, magazin: 0, net: 0, avans: 0, jarima: 0, staj: 0, pieces: 3, accountingStatus: 'COMPLETE', unknownEntryCount: 0 }];
    const helpers = adminJs.slice(adminJs.indexOf('  function payrollIncomplete('), adminJs.indexOf('  function setOnlineStatus('));
    const load = adminJs.slice(adminJs.indexOf('  async function loadPayroll(filters) {'), adminJs.indexOf('  function syncActivationControls()'));
    const context = { byId, state: { payrollSearchQuery: '' }, API: '/api/admin/webapp',
      request: async () => ({ payroll: { period: { name: 'September', startDate: '2026-09-01' }, accountingStatus: status || 'UNAVAILABLE', workers } }),
      withQuery: (url: string) => url, setText: (id: string, text: string) => { byId(id).textContent = text; },
      number: String, money: (value: number) => `${value} so'm`,
      tableMessage: () => ({ appendChild(row: any) { rows.push(row.cells); } }),
      node: () => ({ cells: [] }), cell: (row: any, value: string) => row.cells.push(value) };
    await vm.runInNewContext(`${helpers}\n${load}\nloadPayroll({companyId:'company-a'})`, context);
    expect(byId('payrollPeriod').textContent.includes('Hisob to‘liq emas')).toBe(Boolean(expected));
    expect(byId('payrollHeroTotal').textContent.includes('oraliq')).toBe(Boolean(expected));
    expect(rows[0][2].includes('oraliq')).toBe(Boolean(expected));
    expect(rows[0][4].includes('oraliq')).toBe(Boolean(expected));
    expect(rows[0][5].includes('oraliq')).toBe(Boolean(expected));
    expect(rows[0][9]).toContain('-2 so\'m');
    expect(rows[1][2]).toBe("0 so'm");
  });
});
