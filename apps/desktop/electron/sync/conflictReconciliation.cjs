'use strict';

const { canonicalStringify, computePayloadHash } = require('../database/core/canonicalPayload.cjs');
const { updateOperationStatus } = require('../database/outbox/outboxManager.cjs');
const { applyTicketChange, applyModelChange } = require('./changeFeedApplier.cjs');
const { markFeedUnavailable } = require('./feedEvidence.cjs');
const { modelSnapshot, ticketSnapshot, differences } = require('../../../../packages/domain/syncConflictSemantics.cjs');

function errorOf(operation) {
  try { return JSON.parse(operation.last_error || operation.error_message || '{}'); } catch { return {}; }
}

function eligible(operation) {
  if (!operation || !['CONFLICT', 'DEAD_LETTER'].includes(operation.status)) return false;
  const error = errorOf(operation);
  return operation.command_type === 'UpsertModel' ? error.code === 'REVISION_CONFLICT'
    : operation.command_type === 'SubmitTicket' && (error.code === 'DUPLICATE_TICKET_ID'
      || (error.code === '23505' && String(error.message).includes('idx_tickets_party_patta')));
}

function resolvePayloadAliases(db, companyId, payload) {
  const model = db.prepare('SELECT canonical_model_id FROM model_id_aliases WHERE company_id=? AND legacy_model_id=?').get(companyId, payload.modelId);
  const party = payload.partyRecordId && db.prepare('SELECT canonical_party_id FROM party_id_aliases WHERE company_id=? AND legacy_party_id=?').get(companyId, payload.partyRecordId);
  return { ...payload, modelId: model?.canonical_model_id || payload.modelId,
    ...(payload.partyRecordId ? { partyRecordId: party?.canonical_party_id || payload.partyRecordId } : {}) };
}

function ticketPayload(db, companyId, ticket) {
  const entries = db.prepare('SELECT * FROM ticket_entries WHERE company_id=? AND ticket_id=?').all(companyId, ticket.id);
  return { modelId: ticket.model_id, periodId: ticket.period_id, partyRecordId: ticket.party_record_id,
    partyNumber: ticket.party_number, pattaNumber: ticket.patta_number, qty: ticket.qty,
    size: ticket.size, color: ticket.color, konveyer: ticket.konveyer,
    entries: entries.map(entry => ({ opName: entry.op_name, workerId: entry.worker_id, qty: entry.qty,
      rateSnapshot: entry.rate_snapshot, brak: entry.brak })) };
}

function hasUnresolvedRelatedIntent(db, companyId, operation) {
  return db.prepare(`SELECT 1 FROM local_outbox other WHERE other.company_id=? AND other.operation_id<>?
    AND other.status NOT IN ('SYNCED','SUPERSEDED')
    AND (other.depends_on_operation_id=? OR (other.entity_type=? AND other.entity_id=?)) LIMIT 1`)
    .get(companyId, operation.operation_id, operation.operation_id, operation.entity_type, operation.entity_id)
    || db.prepare('SELECT 1 FROM allocation_resolution_intents WHERE company_id=? AND original_operation_id=? LIMIT 1')
      .get(companyId, operation.operation_id);
}

function applyEquivalentSnapshot(db, companyId, operation, payload, result) {
  const snapshot = result.snapshot;
  const revision = Number(result.entityRevision);
  if (!snapshot || !Number.isSafeInteger(revision) || revision < 1 || hasUnresolvedRelatedIntent(db, companyId, operation)) return false;
  if (operation.command_type === 'UpsertModel') {
    if (revision <= Number(operation.base_revision) || result.canonicalEntityId !== snapshot.modelId
      || differences(modelSnapshot(payload), modelSnapshot(snapshot)).length) return false;
    const current = db.prepare('SELECT * FROM models WHERE company_id=? AND id=?').get(companyId, snapshot.modelId);
    if (!current || Number(current.server_revision) > revision || current.status !== 'ACTIVE') return false;
    const local = modelSnapshot({ modelId: current.id, name: current.name, hisobSheetName: current.hisob_sheet_name,
      title: current.title, party: current.party, color: current.color, size: current.size,
      operations: JSON.parse(current.operations_json), pattaOpsOrder: JSON.parse(current.patta_ops_order_json || '[]') });
    if (differences(local, modelSnapshot(snapshot)).length) return false;
    applyModelChange(db, companyId, snapshot.modelId, 'UPDATE', snapshot, revision);
  } else {
    if (result.canonicalEntityId !== snapshot.ticketId || snapshot.status !== 'CONFIRMED' || snapshot.isClosed !== false
      || differences(ticketSnapshot(payload), ticketSnapshot(snapshot)).length) return false;
    const original = db.prepare('SELECT * FROM tickets WHERE company_id=? AND id=?').get(companyId, operation.entity_id);
    if (!original || original.status !== 'PENDING_SYNC' || Number(original.server_revision) !== 0
      || differences(ticketSnapshot(resolvePayloadAliases(db, companyId, ticketPayload(db, companyId, original))), ticketSnapshot(payload)).length) return false;
    if (db.prepare('SELECT 1 FROM production_adjustments WHERE company_id=? AND original_ticket_id=? LIMIT 1')
      .get(companyId, original.id)) return false;
    const canonical = db.prepare('SELECT * FROM tickets WHERE company_id=? AND id=?').get(companyId, snapshot.ticketId);
    if (canonical && canonical.id !== original.id && (canonical.status !== 'CONFIRMED'
      || Number(canonical.server_revision) > revision || differences(ticketSnapshot(ticketPayload(db, companyId, canonical)), ticketSnapshot(snapshot)).length)) return false;
    if (canonical && db.prepare(`SELECT 1 FROM local_outbox WHERE company_id=? AND entity_type='ticket' AND entity_id=?
      AND operation_id<>? AND status NOT IN ('SYNCED','SUPERSEDED') LIMIT 1`).get(companyId, canonical.id, operation.operation_id)) return false;
    if (snapshot.ticketId !== original.id) {
      // Preserve the duplicate's original rows and outbox as evidence, but
      // release its provisional uniqueness slot before installing the VPS fact.
      db.prepare("UPDATE tickets SET status='VOIDED' WHERE company_id=? AND id=? AND status='PENDING_SYNC'")
        .run(companyId, original.id);
    }
    applyTicketChange(db, companyId, snapshot.ticketId, canonical ? 'UPDATE' : 'INSERT', snapshot, revision);
  }
  // An inspection is not a contiguous feed page. The subsequent pull must
  // establish freshness; do not advance its cursor or manufacture a feed proof.
  markFeedUnavailable(db);
  updateOperationStatus(db, companyId, operation.operation_id, 'SUPERSEDED', JSON.stringify({
    code: 'SUPERSEDED_BY_EQUIVALENT_SERVER_FACT', canonicalEntityId: result.canonicalEntityId, serverRevision: revision
  }));
  return true;
}

async function reconcileEquivalentConflicts(db, companyId, syncClient, options = {}) {
  if (typeof syncClient?.inspectConflicts !== 'function') return 0;
  const rows = db.prepare(`SELECT * FROM local_outbox WHERE company_id=?
    AND command_type IN ('UpsertModel','SubmitTicket') AND status IN ('CONFLICT','DEAD_LETTER')
    ORDER BY rowid LIMIT 100`).all(companyId).filter(eligible);
  const candidates = [];
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json);
      if (payload.companyId !== companyId || payload.operationId !== row.operation_id
        || computePayloadHash(canonicalStringify(payload)) !== row.payload_hash || hasUnresolvedRelatedIntent(db, companyId, row)) continue;
      candidates.push({ row, descriptor: { operationId: row.operation_id, companyId, commandType: row.command_type,
        entityType: row.entity_type, entityId: row.entity_id, baseRevision: row.base_revision,
        payloadHash: row.payload_hash, payload } });
    } catch { /* Malformed evidence stays unresolved. */ }
  }
  let reconciled = 0;
  for (let offset = 0; offset < candidates.length; offset += 25) {
    const batch = candidates.slice(offset, offset + 25);
    const response = await syncClient.inspectConflicts(batch.map(item => item.descriptor));
    if (options.isContextCurrent && !options.isContextCurrent()) throw new Error('SYNC_CONTEXT_CHANGED');
    if (!Array.isArray(response?.results)) continue;
    const byId = new Map(batch.map(item => [item.row.operation_id, item]));
    for (const result of response.results) {
      const candidate = byId.get(result.operationId);
      if (!candidate || result.companyId !== companyId || result.payloadHash !== candidate.row.payload_hash) continue;
      const applied = db.transaction(() => {
        const current = db.prepare('SELECT * FROM local_outbox WHERE company_id=? AND operation_id=?').get(companyId, result.operationId);
        if (!eligible(current) || current.payload_hash !== result.payloadHash) return false;
        if (result.status === 'DIFFERENT') {
          const error = errorOf(current);
          const details = JSON.stringify({ ...error, details: { ...error.details,
            serverEntityId: result.canonicalEntityId, serverRevision: result.entityRevision,
            differingFields: result.differingFields, resolution: 'MANUAL_COMPARISON_REQUIRED' } });
          db.prepare('UPDATE local_outbox SET last_error=?, error_message=? WHERE company_id=? AND operation_id=?')
            .run(details, details, companyId, result.operationId);
          return false;
        }
        if (result.status !== 'EQUIVALENT') return false;
        return applyEquivalentSnapshot(db, companyId, current,
          resolvePayloadAliases(db, companyId, candidate.descriptor.payload), result);
      }).immediate();
      if (applied) reconciled++;
    }
  }
  return reconciled;
}

module.exports = { reconcileEquivalentConflicts };
