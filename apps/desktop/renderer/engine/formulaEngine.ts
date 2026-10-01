import { Worker, ModelConfig } from '../types/workbook';

export interface WorkerModelTotal {
  workerId: number;
  totalEarnings: number;
  totalPieces: number;
}

export interface OperationTotal {
  opName: string;
  rate: number;
  totalQuantity: number;
  totalAmount: number;
}

export interface ModelTotals {
  modelId: string;
  operations: Record<string, OperationTotal>;
  workerTotals: Record<number, WorkerModelTotal>;
  grandTotalQuantity: number;
  grandTotalAmount: number;
}

export interface WorkerPayrollSummary {
  workerId: number;
  workerName: string;
  earningsByModel: Record<string, number>;
  umumiy: number; // Gross Total (= sum of all -hisob sheets)
  staj: number;   // Staj allowance
  avans: number;  // Avans
  jarima: number; // Jarima
  sofFoyda: number; // Sof foyda (= umumiy - avans - staj - jarima)
}

export interface MasterPayrollReport {
  workers: WorkerPayrollSummary[];
  totalUmumiy: number;
  totalStaj: number;
  totalAvans: number;
  totalJarima: number;
  totalSofFoyda: number;
  modelTotals: Record<string, number>; // modelId -> grand total earnings
}

/**
 * Calculates totals for a single model (its -hisob sheet)
 */
export function calculateModelTotals(model: ModelConfig, workers: Worker[]): ModelTotals {
  const operationsTotalMap: Record<string, OperationTotal> = {};
  const workerTotalsMap: Record<number, WorkerModelTotal> = {};

  if (!model) {
    return {
      modelId: '',
      operations: operationsTotalMap,
      workerTotals: workerTotalsMap,
      grandTotalQuantity: 0,
      grandTotalAmount: 0
    };
  }

  const operations = Array.isArray(model.operations) ? model.operations : [];
  const safeWorkers = Array.isArray(workers) ? workers : [];
  const hisobQuantities = model.hisobQuantities && typeof model.hisobQuantities === 'object' ? model.hisobQuantities : {};

  const safeNumber = (val: any): number => {
    const num = typeof val === 'number' ? val : Number(val);
    return Number.isFinite(num) ? Math.max(0, num) : 0;
  };

  // Initialize operations map
  for (const op of operations) {
    const safeRate = safeNumber(op.rate);
    operationsTotalMap[op.name] = {
      opName: op.name,
      rate: safeRate,
      totalQuantity: 0,
      totalAmount: 0
    };
  }

  let grandTotalQuantity = 0;
  let grandTotalAmount = 0;

  // Pre-build operation rate map for O(1) lookups
  const opRateMap: Record<string, number> = {};
  for (const op of operations) {
    opRateMap[op.name] = safeNumber(op.rate);
  }

  for (const worker of safeWorkers) {
    if (!worker || worker.id === undefined) continue;
    const workerQtyMap = (hisobQuantities as any)[worker.id];
    if (!workerQtyMap || typeof workerQtyMap !== 'object' || Object.keys(workerQtyMap).length === 0) {
      workerTotalsMap[worker.id] = {
        workerId: worker.id,
        totalEarnings: 0,
        totalPieces: 0
      };
      continue;
    }

    let workerEarnings = 0;
    let workerPieces = 0;

    for (const [opName, qty] of Object.entries(workerQtyMap)) {
      const rawQty = typeof qty === 'number' ? qty : Number(qty);
      const numQty = Number.isFinite(rawQty) ? Math.max(0, rawQty) : 0;
      if (numQty > 0) {
        const rate = opRateMap[opName] || 0;
        const lineAmount = numQty * rate;
        workerEarnings += lineAmount;
        workerPieces += numQty;

        if (operationsTotalMap[opName]) {
          operationsTotalMap[opName].totalQuantity += numQty;
          operationsTotalMap[opName].totalAmount += lineAmount;
        }
      }
    }

    workerTotalsMap[worker.id] = {
      workerId: worker.id,
      totalEarnings: workerEarnings,
      totalPieces: workerPieces
    };

    grandTotalAmount += workerEarnings;
    grandTotalQuantity += workerPieces;
  }

  return {
    modelId: model.id,
    operations: operationsTotalMap,
    workerTotals: workerTotalsMap,
    grandTotalQuantity,
    grandTotalAmount
  };
}

/**
 * Calculates master summary for 'Umumiy' sheet: Sof foyda = Umumiy - Avans - Staj - Jarima
 */
export function calculateMasterPayroll(models: ModelConfig[], workers: Worker[]): MasterPayrollReport {
  const safeModels = Array.isArray(models) ? models : [];
  const safeWorkers = Array.isArray(workers) ? workers : [];

  // Pre-calculate all model totals
  const modelTotalsCache: Record<string, ModelTotals> = {};
  const modelGrandTotals: Record<string, number> = {};

  for (const model of safeModels) {
    if (!model || !model.id) continue;
    const totals = calculateModelTotals(model, safeWorkers);
    modelTotalsCache[model.id] = totals;
    modelGrandTotals[model.id] = totals.grandTotalAmount;
  }

  const workerSummaries: WorkerPayrollSummary[] = [];
  let totalUmumiy = 0;
  let totalStaj = 0;
  let totalAvans = 0;
  let totalJarima = 0;
  let totalSofFoyda = 0;

  for (const worker of safeWorkers) {
    if (!worker || worker.id === undefined) continue;
    let workerUmumiy = 0;
    const earningsByModel: Record<string, number> = {};

    for (const model of safeModels) {
      if (!model || !model.id) continue;
      const workerModelTot = modelTotalsCache[model.id]?.workerTotals[worker.id];
      const earnings = workerModelTot ? workerModelTot.totalEarnings : 0;
      earningsByModel[model.id] = earnings;
      workerUmumiy += earnings;
    }

    const safeNumber = (val: any): number => {
      const num = typeof val === 'number' ? val : Number(val);
      return Number.isFinite(num) ? Math.max(0, num) : 0;
    };

    const staj = safeNumber(worker.staj);
    const avans = safeNumber(worker.avans);
    const jarima = safeNumber(worker.jarima);
    const sofFoyda = workerUmumiy - avans - staj - jarima;

    workerSummaries.push({
      workerId: worker.id,
      workerName: worker.name || `Ishchi #${worker.id}`,
      earningsByModel,
      umumiy: workerUmumiy,
      staj,
      avans,
      jarima,
      sofFoyda
    });

    totalUmumiy += workerUmumiy;
    totalStaj += staj;
    totalAvans += avans;
    totalJarima += jarima;
    totalSofFoyda += sofFoyda;
  }

  return {
    workers: workerSummaries,
    totalUmumiy,
    totalStaj,
    totalAvans,
    totalJarima,
    totalSofFoyda,
    modelTotals: modelGrandTotals
  };
}

export { formatMoney, formatNumber } from '../utils/formatters';
