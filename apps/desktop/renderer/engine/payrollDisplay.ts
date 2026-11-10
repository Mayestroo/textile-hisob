import { ModelConfig, PayrollValuation, Worker } from '../types/workbook';
import { calculateMasterPayroll, calculateModelTotals } from './formulaEngine';
import { formatMoney } from '../utils/formatters';

export function displayedMoney(value: number, ready: boolean, incomplete: boolean): string {
  return !ready ? 'Noma’lum' : `${incomplete ? '≈ ' : ''}${formatMoney(value)}`;
}
const validRate = (value: unknown): value is number | string =>
  (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));

// The read contract is the only money source in a company-bound workbook. The
// optimistic grid remains the editing/quantity source, never an extra wage fact.
export function payrollDisplay(models: ModelConfig[], workers: Worker[], valuationInput: PayrollValuation | null | undefined,
  companyId: string | undefined, periodId: string) {
  // Store hydration can briefly leave older or partially persisted state without a valuation.
  // Treat that as unavailable rather than crashing the renderer while reading companyId.
  const valuation: PayrollValuation = valuationInput || {
    companyId: '', period: null, workers: [], accountingStatus: 'UNAVAILABLE',
    accountingReasons: ['PAYROLL_VALUATION_UNAVAILABLE'], syncStatus: 'UNKNOWN',
  };
  const legacy = !companyId;
  const ready = legacy || (valuation.companyId === companyId && valuation.period?.periodId === periodId
    && valuation.accountingStatus !== 'UNAVAILABLE' && Array.isArray(valuation.workers));
  const unknown = new Set<string>();
  const cellAmounts: Record<string, number | null> = {};
  const cellQuantities: Record<string, number | null> = {};
  const key = (modelId: string, workerId: number, opName: string) => JSON.stringify([modelId, workerId, opName]);
  const workerValues = new Map(ready ? valuation.workers.map((w) => [Number(w.workerId), w]) : []);
  const displayModels = [...models];
  const listed = new Set(models.map((model) => model.id));
  if (ready) for (const valued of workerValues.values()) for (const [id, breakdown] of Object.entries(valued.models_breakdown || {})) {
    if (listed.has(id)) continue;
    listed.add(id);
    const historical = breakdown as { name: string; operations: Array<{ name: string; qty: number }> };
    const tariff = valuation.tariffs?.find((item) => String(item.id) === id);
    const quantities: ModelConfig['hisobQuantities'] = {};
    for (const item of workerValues.values()) {
      const own = item.models_breakdown?.[id];
      if (own) quantities[item.workerId] = Object.fromEntries(own.operations.map((op: { name: string; qty: number }) => [op.name, op.qty]));
    }
    displayModels.push({ id, name: historical.name || id, hisobSheetName: `${id}-hisob`,
      title: '', party: '', color: '', size: '', pattaOpsOrder: [],
      operations: (tariff?.operations || historical.operations).map((op, index) => ({ id: `${id}-${index}`, name: op.name,
        rate: 'rate' in op && validRate(op.rate) ? Number(op.rate) : null as unknown as number })),
      hisobQuantities: quantities });
  }
  const modelTotals = Object.fromEntries(displayModels.map((model) => [model.id, calculateModelTotals(model, workers)]));
  const masterReport = calculateMasterPayroll(displayModels, workers);
  const modelPrices: Record<string, number | null> = {};
  const operationRates: Record<string, Record<string, number | null>> = {};
  for (const model of displayModels) {
    const tariff = legacy ? model : valuation.tariffs?.find((item) => String(item.id) === String(model.id));
    const rates = tariff?.operations;
    operationRates[model.id] = Object.fromEntries(model.operations.map((op) => {
      const tariffRate = rates?.find((rate) => rate.name === op.name)?.rate;
      return [op.name, ready && validRate(tariffRate) ? Number(tariffRate) : null];
    }));
    modelPrices[model.id] = ready && Array.isArray(rates) && rates.every((op) => validRate(op.rate))
      ? rates.reduce((sum, op) => sum + Number(op.rate), 0) : null;
  }
  if (legacy) {
    for (const model of displayModels) for (const worker of workers) for (const op of model.operations) {
      const qty = Number(model.hisobQuantities?.[worker.id]?.[op.name] || 0);
      cellQuantities[key(model.id, worker.id, op.name)] = qty;
      cellAmounts[key(model.id, worker.id, op.name)] = qty * Number(op.rate || 0);
    }
    const workerMoneyReady = new Set(masterReport.workers.map((row) => row.workerId));
    return { modelTotals, masterReport, displayModels, ready: true, reportReady: true, workerMoneyReady,
      manualMoneyReady: new Set<number>(),
      legacy: true, unknown, key, cellAmounts, cellQuantities, modelPrices,
      operationRates, closed: false, incomplete: true, label: 'Eski ish daftari: hisob taxminiy' };
  }

  const modelAmounts: Record<string, number> = {};
  for (const model of displayModels) {
    const totals = modelTotals[model.id];
    totals.grandTotalAmount = 0;
    totals.grandTotalQuantity = 0;
    for (const op of model.operations) {
      totals.operations[op.name].totalAmount = 0;
      totals.operations[op.name].totalQuantity = 0;
    }
    for (const worker of workers) {
      const byModel = workerValues.get(worker.id)?.models_breakdown?.[model.id];
      totals.workerTotals[worker.id] ||= { workerId: worker.id, totalPieces: 0, totalEarnings: 0 };
      totals.workerTotals[worker.id].totalEarnings = ready ? Number(byModel?.earnings || 0) : 0;
      for (const op of model.operations) {
        const lines: Array<{ amount: number | null; qty: number }> = byModel?.operations?.filter((line: { name: string }) => line.name === op.name) || [];
        const cell = key(model.id, worker.id, op.name);
        if (!ready || !workerValues.has(worker.id)) {
          unknown.add(cell); cellAmounts[cell] = null; cellQuantities[cell] = null;
        } else {
          cellQuantities[cell] = lines.reduce((sum, line: { qty: number }) => sum + Number(line.qty || 0), 0);
          if (lines.some((line) => line.amount === null)) {
            unknown.add(cell); cellAmounts[cell] = null;
          } else {
            cellAmounts[cell] = lines.reduce((sum, line) => sum + Number(line.amount), 0);
            totals.operations[op.name].totalAmount += cellAmounts[cell];
          }
          totals.operations[op.name].totalQuantity += cellQuantities[cell] || 0;
          totals.grandTotalQuantity += cellQuantities[cell] || 0;
        }
      }
      totals.grandTotalAmount += totals.workerTotals[worker.id].totalEarnings;
    }
    modelAmounts[model.id] = totals.grandTotalAmount;
  }
  masterReport.modelTotals = modelAmounts;
  masterReport.totalUmumiy = 0;
  masterReport.totalPieceworkGross = 0;
  masterReport.totalOklad = 0;
  masterReport.totalMagazin = 0;
  masterReport.totalStaj = 0;
  masterReport.totalAvans = 0;
  masterReport.totalJarima = 0;
  masterReport.totalSofFoyda = 0;
  const workerMoneyReady = new Set<number>();
  const manualMoneyReady = new Set<number>();
  let reportReady = ready;
  for (const row of masterReport.workers) {
    const valued = workerValues.get(row.workerId);
    if (!ready || !valued) {
      reportReady = false;
      row.pieceworkGross = 0;
      row.oklad = 0;
      row.magazin = 0;
      row.umumiy = 0;
      row.staj = 0;
      row.avans = 0;
      row.jarima = 0;
      row.sofFoyda = 0;
      row.earningsByModel = Object.fromEntries(displayModels.map((model) => [model.id, 0]));
      continue;
    }
    workerMoneyReady.add(row.workerId);
    manualMoneyReady.add(row.workerId);
    row.earningsByModel = Object.fromEntries(displayModels.map((model) => [model.id,
      Number(valued.models_breakdown?.[model.id]?.earnings || 0)]));
    row.pieceworkGross = Number(valued.pieceworkGross ?? valued.gross ?? 0);
    row.oklad = Number(valued.oklad ?? 0);
    row.magazin = Number(valued.magazin ?? 0);
    row.umumiy = Number(valued.gross ?? (row.pieceworkGross + row.oklad));
    row.staj = Number(valued.staj ?? 0);
    row.avans = Number(valued.avans ?? 0);
    row.jarima = Number(valued.jarima ?? 0);
    row.sofFoyda = Number(valued.net ?? (row.umumiy - row.magazin - row.avans - row.staj - row.jarima));
    masterReport.totalUmumiy += row.umumiy;
    masterReport.totalPieceworkGross += row.pieceworkGross;
    masterReport.totalOklad += row.oklad;
    masterReport.totalMagazin += row.magazin;
    masterReport.totalStaj += row.staj;
    masterReport.totalAvans += row.avans;
    masterReport.totalJarima += row.jarima;
    masterReport.totalSofFoyda += row.sofFoyda;
  }
  const incomplete = !reportReady || valuation.accountingStatus !== 'COMPLETE' || valuation.syncStatus !== 'CURRENT';
  const missingRate = valuation.accountingReasons?.some((reason) =>
    ['UNKNOWN_HISTORICAL_RATE', 'UNKNOWN_CURRENT_RATE', 'CLOSED_TARIFF_UNAVAILABLE'].includes(reason));
  const label = !ready || !reportReady ? 'Ishchi yoki hisob ma’lumoti yuklanmagan — summa noma’lum' : missingRate
    ? 'Noma’lum tarif: ko‘rsatilgan summa faqat aniqlangan qism; yakuniy ish haqi emas' : incomplete
      ? 'Taxminiy hisob: sinxronlash / tarixiy ma’lumotlar to‘liq tasdiqlanmagan'
      : valuation.feedEvidence?.status === 'APPLIED_AS_OF'
        ? `Server holati (cursor ${valuation.feedEvidence.asOfCursor}) bo‘yicha` : '';
  return { modelTotals, masterReport, displayModels, ready, reportReady, workerMoneyReady, manualMoneyReady,
    legacy: false, unknown, key, cellAmounts, modelPrices,
    cellQuantities, operationRates, closed: ready && valuation.period?.isClosed === true, incomplete, label };
}
