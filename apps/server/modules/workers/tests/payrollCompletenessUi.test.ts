import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';

const workerHtml = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'webapps', 'worker', 'scripts', 'worker.js'), 'utf8');
const adminJs = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'webapps', 'admin', 'scripts', 'admin.js'), 'utf8');

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
  ])('renders actual company admin payroll totals for $status', ({ status, count, expected }) => {
    const elements = new Map<string, any>();
    const byId = (id: string) => {
      if (id === 'companyPattaDone' || id === 'companyWorkDone') return null;
      if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false });
      return elements.get(id);
    };
    const workers = [{ workerId: 1, name: 'A', pieceworkGross: 7, oklad: 3, gross: 10, magazin: 1, net: -2, avans: 12, jarima: 0, staj: 0,
      pieces: 4, accountingStatus: status, unknownEntryCount: count },
    { workerId: 2, name: 'B', pieceworkGross: 0, oklad: 0, gross: 0, magazin: 0, net: 0, avans: 0, jarima: 0, staj: 0, pieces: 3, accountingStatus: 'COMPLETE', unknownEntryCount: 0 }];
    const helpers = adminJs.slice(adminJs.indexOf('  function payrollIncomplete('), adminJs.indexOf('  function setOnlineStatus('));
    const render = adminJs.slice(adminJs.indexOf('  function renderCompanyHome(payroll) {'), adminJs.indexOf('  function renderCompanyWorkers()'));
    const context = { byId, companyPanel: { payroll: workers, workers, models: [], parties: [], tickets: [] },
      selectedPeriod: () => null, getCompanyModelsSummary: () => ({ totalPieces: 0 }),
      setText: (id: string, text: string) => { byId(id).textContent = text; }, number: String, coMoney: String };
    vm.runInNewContext(`${helpers}\n${render}\nrenderCompanyHome({accountingStatus:${JSON.stringify(status || 'UNAVAILABLE')},period:{name:'September'}})`, context);
    expect(byId('companyWorkerCount').textContent.includes('Hisob to‘liq emas')).toBe(Boolean(expected));
    expect(byId('companyNet').textContent.includes('oraliq')).toBe(Boolean(expected));
    expect(byId('companyGross').textContent.includes('oraliq')).toBe(Boolean(expected));
    expect(byId('companyNet').textContent).toContain('-2');
  });
});
