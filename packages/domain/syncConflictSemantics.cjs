'use strict';

function rate(value) {
  if (value == null) return null;
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === ''
    || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error('INVALID_RATE');
  return Number(value);
}

function modelSnapshot(model) {
  try {
    if (!model?.modelId || !model.name || !Array.isArray(model.operations)
      || (model.operationRenames || []).length) return null;
    const operations = model.operations.map(op => {
      if (!op?.name) throw new Error('INVALID_OPERATION');
      return { id: op.id || null, name: op.name, rate: rate(op.rate) };
    });
    return { modelId: model.modelId, name: model.name,
      hisobSheetName: model.hisobSheetName || `${model.name}-hisob`, title: model.title || `Model- ${model.name}`,
      party: model.party || '', color: model.color || '', size: model.size || '', operations,
      pattaOpsOrder: model.pattaOpsOrder || operations.map(op => op.name) };
  } catch { return null; }
}

function ticketSnapshot(ticket) {
  try {
    if (!ticket?.modelId || !ticket.periodId || !ticket.partyRecordId || !ticket.partyNumber
      || !Number.isSafeInteger(Number(ticket.pattaNumber)) || Number(ticket.pattaNumber) <= 0
      || !Number.isSafeInteger(Number(ticket.qty)) || Number(ticket.qty) <= 0
      || !Array.isArray(ticket.entries) || !ticket.entries.length) return null;
    const totals = new Map();
    const identities = new Set();
    const entries = ticket.entries.map(entry => {
      const qty = Number(entry.qty ?? ticket.qty);
      const workerId = Number(entry.workerId);
      const identity = JSON.stringify([entry.opName, workerId]);
      if (!entry.opName || !Number.isSafeInteger(workerId) || workerId <= 0
        || !Number.isSafeInteger(qty) || qty <= 0 || identities.has(identity)) throw new Error('INVALID_ALLOCATION');
      identities.add(identity);
      const total = (totals.get(entry.opName) || 0) + qty;
      if (total > Number(ticket.qty)) throw new Error('OVERALLOCATION');
      totals.set(entry.opName, total);
      return { opName: entry.opName, workerId, qty, rateSnapshot: rate(entry.rateSnapshot), brak: entry.brak || null };
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    // IDs/timestamps identify the attempts, not another unit of printed work.
    // Preserve the existing authoritative ticket's identity and submission date.
    return { modelId: ticket.modelId, periodId: ticket.periodId, partyRecordId: ticket.partyRecordId,
      partyNumber: ticket.partyNumber, pattaNumber: Number(ticket.pattaNumber), qty: Number(ticket.qty),
      size: ticket.size || '', color: ticket.color || '', konveyer: ticket.konveyer || '', entries };
  } catch { return null; }
}

function differences(left, right) {
  if (!left || !right) return ['unverifiable'];
  return Object.keys(left).filter(key => JSON.stringify(left[key]) !== JSON.stringify(right[key]));
}

module.exports = { modelSnapshot, ticketSnapshot, differences };
