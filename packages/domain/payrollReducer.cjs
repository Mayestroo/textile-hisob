'use strict';

// Pure reducer shared by server queries and the packaged desktop read contract.
const numeric = (value) => Number(value || 0);
const finiteRate = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));
const dateOnly = (value) => value == null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

function operationRates(models) {
  const rates = new Map();
  for (const model of models || []) for (const operation of model.operations || []) {
    const rate = operation && operation.name != null && finiteRate(operation.rate) ? Number(operation.rate) : null;
    if (operation && operation.name != null) rates.set(JSON.stringify([String(model.id), String(operation.name)]), rate);
  }
  return rates;
}

function reducePayroll(period, workers, facts, adjustments, deductions, tariffBasis = {}) {
  const currentRates = operationRates(tariffBasis.currentModels);
  const archivedModels = tariffBasis.closingArchive && tariffBasis.closingArchive.models;
  const closingRates = operationRates(archivedModels);
  const closingArchiveAvailable = Array.isArray(archivedModels);
  const ratesForPeriod = period && Boolean(period.is_closed) ? closingRates : currentRates;
  const ledgerOnlyArchive = Boolean(period?.is_closed) && tariffBasis.stajDebtLedgerVersion === 1
    && tariffBasis.closingArchive?.stajDeductionMode !== 'RECURRING';
  const archivedWorkers = new Map((tariffBasis.closingArchive?.workers || []).map((w) => [Number(w.id), w]));
  const byWorker = new Map(workers.map((w) => [Number(w.worker_id), {
    workerId: Number(w.worker_id), name: w.worker_name,
    // STAJ is a recurring deduction, retained on the worker across period rollover.
    // Closed snapshots retain the amount and calculation policy captured at close.
    staj: ledgerOnlyArchive ? 0 : Math.max(0, numeric(period?.is_closed
      ? (archivedWorkers.get(Number(w.worker_id))?.staj ?? w.staj) : w.staj)),
    legacyStaj: Math.max(0, numeric(w.staj)),
    avans: 0, jarima: 0, oklad: 0, magazin: 0,
    pieceworkGross: 0, gross: 0, net: 0, pieces: 0, rawQuantity: 0,
    unknownEntryCount: 0, unknownQuantity: 0, unresolvedAdjustmentCount: 0,
    accountingReasons: [], models_breakdown: {}, buckets: new Map()
  }]));
  const reason = (w, code) => { if (!w.accountingReasons.includes(code)) w.accountingReasons.push(code); };
  const bucket = (w, row, rate) => {
    const modelId = String(row.model_id);
    const key = JSON.stringify([modelId, row.op_name, rate]);
    if (!w.buckets.has(key)) w.buckets.set(key, { modelId, modelName: row.model_name || modelId,
      name: row.op_name, rate, raw: 0, unknown: 0 });
    return w.buckets.get(key);
  };
  for (const row of facts) {
    const w = byWorker.get(Number(row.worker_id));
    if (!w) continue;
    if (row.period_id == null) { reason(w, 'UNKNOWN_ORIGINAL_PERIOD'); continue; }
    const rateKey = JSON.stringify([String(row.model_id), String(row.op_name)]);
    const rate = ratesForPeriod.has(rateKey) ? ratesForPeriod.get(rateKey) : null;
    if (period && Boolean(period.is_closed) && !closingArchiveAvailable) reason(w, 'CLOSED_TARIFF_UNAVAILABLE');
    const b = bucket(w, row, rate);
    b.raw += numeric(row.qty);
    if (rate === null) { b.unknown += 1; w.unknownEntryCount += 1; w.unknownQuantity += numeric(row.qty); reason(w, 'UNKNOWN_HISTORICAL_RATE'); }
  }
  for (const row of adjustments) {
    const w = byWorker.get(Number(row.worker_id));
    if (!w || row.status !== 'APPROVED') continue;
    const inverse = Boolean(row.original_adjustment_id || row.provenance === 'REVERSAL');
    if (inverse) {
      if (!row.original_adjustment_id || !row.original_status ||
        !['APPROVED', 'REVERSED'].includes(row.original_status) ||
        Number(row.original_worker_id) !== Number(row.worker_id) || row.original_model_id !== row.model_id ||
        row.original_op_name !== row.op_name || numeric(row.original_qty) !== -numeric(row.qty) ||
        row.original_period !== row.original_period_id || row.original_rate !== row.rate ||
        row.original_attribution !== row.attribution_status) {
        w.unresolvedAdjustmentCount += 1; reason(w, 'MISSING_OR_INCONSISTENT_REVERSAL'); continue;
      }
      if (row.original_status === 'REVERSED') continue;
    }
    if (row.attribution_status !== 'RESOLVED' || row.original_period_id == null) {
      w.unresolvedAdjustmentCount += 1;
      reason(w, row.original_period_id == null ? 'UNKNOWN_ORIGINAL_PERIOD' : 'UNRESOLVED_ATTRIBUTION');
      continue;
    }
    if (row.original_period_id !== period.id) continue;
    const rateKey = JSON.stringify([String(row.model_id), String(row.op_name)]);
    const rate = ratesForPeriod.has(rateKey) ? ratesForPeriod.get(rateKey) : null;
    if (period && Boolean(period.is_closed) && !closingArchiveAvailable) reason(w, 'CLOSED_TARIFF_UNAVAILABLE');
    if (rate === null) {
      w.unresolvedAdjustmentCount += 1;
      reason(w, period && Boolean(period.is_closed) ? 'CLOSED_TARIFF_UNAVAILABLE' : 'UNKNOWN_CURRENT_RATE');
      continue;
    }
    bucket(w, row, rate).raw += numeric(row.qty);
  }
  for (const row of deductions) {
    const w = byWorker.get(Number(row.worker_id));
    if (w && row.type === 'AVANS') w.avans = Math.max(0, numeric(row.total));
    if (w && row.type === 'JARIMA') w.jarima = Math.max(0, numeric(row.total));
    if (w && row.type === 'OKLAD') w.oklad = numeric(row.total);
    if (w && row.type === 'MAGAZIN') w.magazin = numeric(row.total);
    if (w && ledgerOnlyArchive && row.type === 'STAJ_DEBT') w.staj = Math.max(0, numeric(row.total));
  }
  for (const w of byWorker.values()) {
    if (ledgerOnlyArchive && w.legacyStaj > 0) reason(w, 'LEGACY_STAJ_REQUIRES_RECONCILIATION');
    if (period && Boolean(period.is_closed)) reason(w, 'HISTORICAL_BASELINE_UNVERIFIED');
    const byOperation = new Map();
    for (const b of w.buckets.values()) {
      const key = JSON.stringify([b.modelId, b.name]);
      if (!byOperation.has(key)) byOperation.set(key, []);
      byOperation.get(key).push(b);
    }
    for (const rates of byOperation.values()) {
      if (rates.length > 1 && rates.some((b) => b.raw < 0) && rates.some((b) => b.raw > 0)) reason(w, 'AMBIGUOUS_RATE_ALLOCATION');
    }
    for (const b of w.buckets.values()) {
      const payable = Math.max(0, b.raw);
      const amount = b.rate === null ? null : payable * b.rate;
      const model = w.models_breakdown[b.modelId] ||= { id: b.modelId, name: b.modelName, earnings: 0, pieces: 0, operations: [] };
      model.operations.push({ name: b.name, rate: b.rate, qty: payable, amount, rawQty: b.raw });
      model.earnings += amount || 0; model.pieces += payable;
      w.pieceworkGross += amount || 0; w.pieces += payable; w.rawQuantity += b.raw;
    }
    w.gross = w.pieceworkGross + w.oklad;
    w.net = w.gross - w.magazin - w.avans - w.jarima - w.staj;
    w.accountingStatus = !period ? 'UNAVAILABLE' : w.accountingReasons.length ? 'INCOMPLETE' : 'COMPLETE';
    w.syncStatus = 'CURRENT';
    w.earningsLabel = 'RESOLVED_SUBTOTAL';
    delete w.buckets;
  }
  const accountingReasons = [...new Set([...byWorker.values()].flatMap((w) => w.accountingReasons))];
  if (period && Boolean(period.is_closed) && !accountingReasons.includes('HISTORICAL_BASELINE_UNVERIFIED')) {
    accountingReasons.push('HISTORICAL_BASELINE_UNVERIFIED');
  }
  return { period: period ? { periodId: period.id, name: period.name, startDate: dateOnly(period.start_date),
    endDate: dateOnly(period.end_date), isClosed: Boolean(period.is_closed), restated: Boolean(period.is_closed) } : null,
  accountingStatus: !period ? 'UNAVAILABLE' : accountingReasons.length ? 'INCOMPLETE' : 'COMPLETE',
  accountingReasons,
  syncStatus: 'CURRENT', workers: [...byWorker.values()] };
}

module.exports = { reducePayroll };
