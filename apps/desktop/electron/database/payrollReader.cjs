'use strict';

const { reducePayroll } = require('../../../../packages/domain/payrollReducer.cjs');
const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');
const { readFeedEvidence, cursor } = require('../sync/feedEvidence.cjs');
const { getLocalCursor } = require('../sync/changeFeedApplier.cjs');

// A receipt identifies an accepted operation, not the current fact when a
// subsequent local edit changed its entries. Legacy SYNCED rows have no receipt.
function ticketAcceptanceEvidence(db, companyId, ticketId) {
  const ticket = db.prepare(`SELECT model_id, period_id, qty, status, server_revision, provenance FROM tickets
    WHERE company_id = ? AND id = ?`).get(companyId, ticketId);
  if (!ticket || ticket.status !== 'CONFIRMED') return null;
  if (ticket.provenance === 'REMOTE_SYNC' || ticket.provenance === 'REMOTE_BOOTSTRAP')
    return { source: 'SERVER_FACT' };
  if (ticket.provenance !== 'LOCAL_COMMAND') return null;
  const ops = db.prepare(`SELECT * FROM local_outbox WHERE company_id = ? AND entity_type = 'ticket'
    AND entity_id = ? AND command_type IN ('SubmitTicket', 'UpdateTicket', 'DeleteTicket')
    ORDER BY base_revision DESC, causal_sequence DESC, created_at DESC, operation_id DESC`).all(companyId, ticketId);
  const op = ops[0];
  if (!op || !['SubmitTicket', 'UpdateTicket'].includes(op.command_type)
    || op.status !== 'SYNCED' || op.accepted_payload_hash !== op.payload_hash
    || !Number.isSafeInteger(op.accepted_server_revision) || op.accepted_server_revision < 1
    || Number(ticket.server_revision) !== op.accepted_server_revision
    || computePayloadHash(op.payload_json) !== op.payload_hash) return null;
  let payload;
  try { payload = JSON.parse(op.payload_json); } catch { return null; }
  if (payload.ticketId !== ticketId || payload.companyId !== companyId || payload.operationId !== op.operation_id
    || !Array.isArray(payload.entries) || !payload.entries.length) return null;
  if (op.command_type === 'SubmitTicket' && (payload.modelId !== ticket.model_id
    || (payload.periodId || null) !== (ticket.period_id || null)
    || Number(payload.qty) !== Number(ticket.qty) || payload.qty == null)) return null;
  const entries = db.prepare(`SELECT id, op_name, worker_id, qty, rate_snapshot FROM ticket_entries
    WHERE company_id = ? AND ticket_id = ?`).all(companyId, ticketId);
  if (entries.length !== payload.entries.length) return null;
  const actual = new Map(entries.map((entry) => [entry.id, entry]));
  const matched = new Set();
  for (const [index, entry] of payload.entries.entries()) {
    let id = op.command_type === 'SubmitTicket'
      ? `entry_${ticketId}_${index}_${entry.opName}_${entry.workerId}` : entry.entryId;
    if (!id && op.command_type === 'UpdateTicket') {
      const existing = entries.filter(row => row.op_name === entry.opName && !matched.has(row.id));
      if (existing.length === 1) id = existing[0].id;
    }
    const row = actual.get(id);
    if (!row || matched.has(id) || row.op_name !== entry.opName || Number(row.worker_id) !== Number(entry.workerId)
      || Number(row.qty) !== Number(ticket.qty)
      || (op.command_type === 'SubmitTicket' &&
        (row.rate_snapshot ?? null) !== (entry.rateSnapshot ?? null))) return null;
    matched.add(id);
  }
  return { source: 'ACCEPTED_OPERATION', operationId: op.operation_id,
    payloadHash: op.accepted_payload_hash, serverRevision: op.accepted_server_revision };
}

function adjustmentAcceptanceEvidence(db, companyId, adjustmentId) {
  const row = db.prepare(`SELECT adjustment_id, company_id, model_id, worker_id, op_name,
    delta_qty, status, server_revision, provenance, original_adjustment_id
    FROM production_adjustments WHERE company_id = ? AND adjustment_id = ?`).get(companyId, adjustmentId);
  if (!row) return null;
  if (row.provenance === 'REMOTE_SYNC' || row.provenance === 'REMOTE_BOOTSTRAP') return { source: 'SERVER_FACT' };
  const op = db.prepare(`SELECT * FROM local_outbox WHERE company_id = ? AND entity_id = ?
    AND command_type IN ('RecordProductionAdjustment', 'ReverseProductionAdjustment')
    ORDER BY causal_sequence DESC, created_at DESC, operation_id DESC LIMIT 1`).get(companyId, adjustmentId);
  if (!op || op.status !== 'SYNCED' || op.accepted_payload_hash !== op.payload_hash
    || !Number.isSafeInteger(op.accepted_server_revision) || op.accepted_server_revision < 1
    || Number(row.server_revision) !== op.accepted_server_revision
    || computePayloadHash(op.payload_json) !== op.payload_hash) return null;
  let payload;
  try { payload = JSON.parse(op.payload_json); } catch { return null; }
  if (payload.companyId !== companyId || payload.operationId !== op.operation_id
    || (payload.adjustmentId || payload.reversalAdjustmentId) !== adjustmentId) return null;
  if (op.command_type === 'RecordProductionAdjustment' &&
    (payload.modelId !== row.model_id || Number(payload.workerId) !== Number(row.worker_id)
      || payload.opName !== row.op_name || Number(payload.deltaQty) !== Number(row.delta_qty))) return null;
  if (op.command_type === 'ReverseProductionAdjustment' &&
    payload.originalAdjustmentId !== row.original_adjustment_id) return null;
  return { source: 'ACCEPTED_OPERATION', operationId: op.operation_id,
    payloadHash: op.accepted_payload_hash, serverRevision: op.accepted_server_revision };
}

// Additive, explicit-period read only. The locally entered subtotal is provisional until sync is verified.
function loadPayrollValuationFromSqlite(db, companyId, periodId, options = {}) {
  if (typeof companyId !== 'string' || !companyId.trim()) throw new Error('COMPANY_ID_REQUIRED');
  if (periodId != null && (typeof periodId !== 'string' || !periodId.trim())) throw new Error('INVALID_PERIOD_ID');
  const period = periodId == null ? null : db.prepare(`SELECT id, name, start_date, end_date, is_closed, server_revision FROM periods
    WHERE company_id = ? AND id = ?`).get(companyId, periodId);
  if (periodId != null && !period) throw new Error('PERIOD_NOT_FOUND');
  const workers = Array.isArray(options.workers)
    ? options.workers.map((worker) => ({ worker_id: Number(worker.id), worker_name: worker.name, staj: worker.staj }))
    : db.prepare(`SELECT id AS worker_id, name AS worker_name, staj FROM workers
      WHERE company_id = ? AND status = 'ACTIVE' ORDER BY id`).all(companyId);
  if (!period) {
    const unavailable = reducePayroll(null, workers, [], [], []);
    for (const worker of unavailable.workers) worker.syncStatus = 'UNKNOWN';
    return { companyId, ...unavailable, syncStatus: 'UNKNOWN' };
  }
  const feedEvidence = readFeedEvidence(db, companyId, periodId, period.server_revision, getLocalCursor(db));
  const feedVerified = feedEvidence?.verified === true;

  const facts = db.prepare(`SELECT e.id AS entry_id, t.id AS ticket_id, e.worker_id, t.model_id,
    m.name AS model_name, e.op_name, e.qty, e.rate_snapshot AS rate, t.period_id,
    t.provenance, t.status
    FROM ticket_entries e JOIN tickets t ON t.company_id = e.company_id AND t.id = e.ticket_id
    LEFT JOIN models m ON m.company_id = t.company_id AND m.id = t.model_id
    WHERE e.company_id = ? AND t.company_id = ? AND t.status IN ('CONFIRMED', 'PENDING_SYNC')
      AND (t.period_id = ? OR t.period_id IS NULL) ORDER BY t.id, e.id`)
    .all(companyId, companyId, periodId);
  const acceptanceEvidence = Object.fromEntries([...new Set(facts.map(row => row.ticket_id))]
    .map(id => [id, ticketAcceptanceEvidence(db, companyId, id)]));
  const pendingTickets = db.prepare(`SELECT DISTINCT t.id AS ticket_id, e.worker_id FROM tickets t
    JOIN ticket_entries e ON e.company_id = t.company_id AND e.ticket_id = t.id
    WHERE t.company_id = ? AND t.status IN ('PENDING_SYNC', 'PENDING_DELETE', 'CONFLICT')
      AND (t.period_id = ? OR t.period_id IS NULL)`).all(companyId, periodId);
  const adjustments = db.prepare(`SELECT a.adjustment_id, a.original_adjustment_id, a.provenance,
    a.worker_id, a.model_id, m.name AS model_name, a.op_name, a.delta_qty AS qty,
    a.status, a.attribution_status, a.original_period_id, a.original_rate_snapshot AS rate,
    original.status AS original_status, original.worker_id AS original_worker_id,
    original.model_id AS original_model_id, original.op_name AS original_op_name,
    original.original_period_id AS original_period, original.original_rate_snapshot AS original_rate,
    original.delta_qty AS original_qty, original.attribution_status AS original_attribution,
    original.provenance AS original_provenance
    FROM production_adjustments a
    LEFT JOIN production_adjustments original ON original.company_id = a.company_id
      AND original.adjustment_id = a.original_adjustment_id
    LEFT JOIN models m ON m.company_id = a.company_id AND m.id = a.model_id
    WHERE a.company_id = ? AND (a.original_period_id = ? OR a.original_period_id IS NULL
      OR original.original_period_id = ?) ORDER BY a.adjustment_id`)
    .all(companyId, periodId, periodId);
  const adjustmentEvidence = Object.fromEntries(adjustments.map(row =>
    [row.adjustment_id, adjustmentAcceptanceEvidence(db, companyId, row.adjustment_id)]));
  const workerBalanceFacts = db.prepare(`SELECT id, worker_id, type, amount, period_id, provenance, status
    FROM worker_adjustments WHERE company_id = ? AND period_id = ? AND status = 'POSTED'
      AND type IN ('AVANS', 'JARIMA', 'OKLAD', 'MAGAZIN') ORDER BY id`).all(companyId, periodId);
  const adjustmentById = new Map(workerBalanceFacts.map((fact) => [fact.id, fact]));
  const workerAdjustmentOps = db.prepare(`SELECT entity_id, status, payload_json, payload_hash,
      accepted_payload_hash, accepted_server_revision, accepted_change_id, operation_id
    FROM local_outbox WHERE company_id = ? AND entity_type = 'worker' AND command_type = 'UpsertWorker'
    ORDER BY created_at, operation_id`).all(companyId);
  const conflictedBalanceIds = new Set();
  const workerRevisions = new Map(db.prepare('SELECT id, server_revision FROM workers WHERE company_id = ?').all(companyId)
    .map((row) => [Number(row.id), Number(row.server_revision || 0)]));
  const deductions = db.prepare(`SELECT worker_id, type, SUM(amount) AS total FROM worker_adjustments
    WHERE company_id = ? AND period_id = ? AND status = 'POSTED'
      AND type IN ('AVANS', 'JARIMA', 'OKLAD', 'MAGAZIN')
    GROUP BY worker_id, type`).all(companyId, periodId);
  const outbox = db.prepare(`SELECT command_type, entity_id, status, payload_json FROM local_outbox
    WHERE company_id = ? AND command_type IN ('SubmitTicket', 'UpdateTicket', 'DeleteTicket',
      'RecordProductionAdjustment', 'ReverseProductionAdjustment')`).all(companyId);
  const pendingContext = db.prepare(`SELECT 1 FROM local_outbox WHERE company_id = ?
    AND status NOT IN ('SYNCED', 'SUPERSEDED') AND (
      (entity_type = 'period' AND entity_id = ? AND command_type IN ('CreatePeriod', 'UpdatePeriod', 'ClosePeriod'))
      OR (entity_type = 'model' AND command_type = 'UpsertModel')
    ) LIMIT 1`).get(companyId, periodId);
  const mutations = new Map();
  for (const op of outbox) {
    const ids = [String(op.entity_id)];
    if (op.command_type === 'ReverseProductionAdjustment') {
      try {
        const original = JSON.parse(op.payload_json).originalAdjustmentId;
        if (original) ids.push(String(original));
      } catch { /* malformed proof is never authoritative */ }
    }
    for (const id of ids) {
      if (!mutations.has(id)) mutations.set(id, []);
      mutations.get(id).push(op);
    }
  }
  const pending = (id) => (mutations.get(String(id)) || []).some((op) => op.status !== 'SYNCED' && op.status !== 'SUPERSEDED');
  const issues = new Map();
  let unsynced = false;
  let unknown = false;
  function uncertain(workerId, code, isPending, adjustment = false) {
    const id = Number(workerId);
    if (!issues.has(id)) issues.set(id, { reasons: new Set(), adjustments: 0 });
    issues.get(id).reasons.add(code);
    if (adjustment) issues.get(id).adjustments++;
    if (isPending) unsynced = true;
    else unknown = true;
  }
  for (const op of workerAdjustmentOps) {
    let payload;
    try { payload = JSON.parse(op.payload_json); } catch { payload = null; }
    if (!payload || !Array.isArray(payload.balanceAdjustments)) continue;
    for (const adjustment of payload.balanceAdjustments) {
      if (!adjustment || adjustment.periodId !== periodId) continue;
      const fact = adjustmentById.get(adjustment.adjustmentId);
      const matches = fact && Number(op.entity_id) === Number(fact.worker_id)
        && adjustment.type === fact.type && Number(adjustment.amountDelta) === Number(fact.amount)
        && adjustment.periodId === fact.period_id;
      if (!matches) {
        uncertain(Number(payload.workerId || op.entity_id), 'LOCAL_ACCEPTANCE_UNVERIFIED', false);
        continue;
      }
      if (['CONFLICT', 'DEAD_LETTER', 'SUPERSEDED'].includes(op.status)) {
        conflictedBalanceIds.add(fact.id);
        uncertain(fact.worker_id, 'WORKER_ADJUSTMENT_CONFLICT', false);
      } else if (op.status !== 'SYNCED') {
        uncertain(fact.worker_id, 'LOCAL_MUTATION_PENDING', true);
      } else {
        const acceptedCursor = cursor(op.accepted_change_id);
        const appliedCursor = cursor(getLocalCursor(db));
        const receiptValid = op.accepted_payload_hash === op.payload_hash
          && computePayloadHash(op.payload_json) === op.payload_hash
          && Number.isSafeInteger(op.accepted_server_revision) && op.accepted_server_revision > 0
          && (workerRevisions.get(Number(fact.worker_id)) || 0) >= op.accepted_server_revision
          && acceptedCursor !== null && appliedCursor !== null && acceptedCursor <= appliedCursor && feedVerified;
        if (!receiptValid) uncertain(fact.worker_id, 'LOCAL_ACCEPTANCE_UNVERIFIED', false);
      }
    }
  }
  const acceptedDeductions = deductions.map((row) => {
    const conflictAmount = workerBalanceFacts.filter((fact) => conflictedBalanceIds.has(fact.id)
      && Number(fact.worker_id) === Number(row.worker_id) && fact.type === row.type)
      .reduce((sum, fact) => sum + Number(fact.amount), 0);
    return conflictAmount ? { ...row, total: Number(row.total) - conflictAmount } : row;
  });
  for (const row of pendingTickets) {
    uncertain(row.worker_id, 'LOCAL_MUTATION_PENDING', true);
  }
  if (pendingContext) for (const worker of workers) uncertain(worker.worker_id, 'LOCAL_CONTEXT_PENDING', true);
  for (const row of facts) {
    const isPending = pending(row.ticket_id);
    if (row.status === 'PENDING_SYNC' || isPending) uncertain(row.worker_id, 'LOCAL_MUTATION_PENDING', true);
    else if (row.provenance === 'LOCAL_COMMAND' && !acceptanceEvidence[row.ticket_id])
      uncertain(row.worker_id, 'LOCAL_ACCEPTANCE_UNVERIFIED', false);
  }
  for (const row of adjustments) {
    const isPending = pending(row.adjustment_id) || (row.original_adjustment_id && pending(row.original_adjustment_id));
    if (isPending) {
      uncertain(row.worker_id, 'LOCAL_MUTATION_PENDING', true);
    } else if (row.provenance !== 'REMOTE_SYNC' && row.provenance !== 'REMOTE_BOOTSTRAP'
      && !adjustmentEvidence[row.adjustment_id]) {
      uncertain(row.worker_id, 'LOCAL_ACCEPTANCE_UNVERIFIED', false, true);
    }
  }
  const currentModels = period.is_closed ? [] : db.prepare(`SELECT id, operations_json AS operations FROM models WHERE company_id = ?`)
    .all(companyId).map((model) => ({ ...model, operations: (() => { try { return JSON.parse(model.operations || '[]'); } catch { return []; } })() }));
  const archivedRow = period.is_closed ? db.prepare(`SELECT archive_json, sha256 FROM period_archives WHERE company_id = ? AND period_id = ?`)
    .get(companyId, periodId) : null;
  let closingArchive = null;
  if (archivedRow) {
    try {
      const parsed = typeof archivedRow.archive_json === 'string' ? JSON.parse(archivedRow.archive_json) : archivedRow.archive_json;
      const digestMatches = typeof archivedRow.archive_json === 'string'
        && computePayloadHash(canonicalStringify(parsed)) === archivedRow.sha256;
      const identity = parsed?.period;
      const identityMatches = !identity || (identity.id === periodId
        && (identity.companyId == null || identity.companyId === companyId));
      if (digestMatches && identityMatches && Array.isArray(parsed?.models)) closingArchive = parsed;
    } catch { closingArchive = null; }
  }
  if (options.closingArchive && typeof options.closingArchive === 'object') closingArchive = options.closingArchive;
  // One row per immutable entry/adjustment. Do not add the optimistic aggregate again.
  // LOCAL provenance survives server ACK/feed: it describes origin, not eligibility.
  const result = reducePayroll(period, workers, facts, adjustments, acceptedDeductions, { currentModels, closingArchive });
  // A coherent snapshot plus fully applied terminal feed page proves only an
  // as-of server head, never instantaneous global freshness.
  if (!feedVerified) result.accountingReasons.push('SYNC_FRESHNESS_UNVERIFIED');
  for (const w of result.workers) {
    const issue = issues.get(w.workerId);
    if (issue) {
      w.accountingReasons.push(...[...issue.reasons].filter((reason) => !w.accountingReasons.includes(reason)));
      w.unresolvedAdjustmentCount += issue.adjustments;
    }
    if (!feedVerified) w.accountingReasons.push('SYNC_FRESHNESS_UNVERIFIED');
    w.accountingStatus = w.accountingReasons.length ? 'INCOMPLETE' : 'COMPLETE';
    w.syncStatus = issue && [...issue.reasons].some(reason =>
      reason === 'LOCAL_MUTATION_PENDING' || reason === 'LOCAL_CONTEXT_PENDING')
      ? 'UNSYNCED' : issue ? 'UNKNOWN' : feedVerified ? 'CURRENT' : 'UNKNOWN';
  }
  result.accountingReasons = [...new Set([...result.accountingReasons, ...[...issues.values()].flatMap((issue) => [...issue.reasons])])];
  result.accountingStatus = result.accountingReasons.length ? 'INCOMPLETE' : 'COMPLETE';
  result.syncStatus = unsynced ? 'UNSYNCED' : unknown ? 'UNKNOWN' : feedVerified ? 'CURRENT' : 'UNKNOWN';
  return { companyId, ...result, feedEvidence: feedEvidence ? { asOfCursor: feedEvidence.asOfCursor,
    status: feedVerified ? 'APPLIED_AS_OF' : 'STALE_AS_OF' } : null, acceptanceEvidence, adjustmentEvidence,
    tariffs: period.is_closed ? closingArchive?.models ?? null : currentModels };
}

module.exports = { loadPayrollValuationFromSqlite, ticketAcceptanceEvidence, adjustmentAcceptanceEvidence };
