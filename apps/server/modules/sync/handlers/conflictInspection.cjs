'use strict';

const { canonicalStringify, computePayloadHash } = require('../canonicalPayload.cjs');
const { validateOperationEnvelope, validateCommandPayload } = require('../payloadValidation.cjs');
const { acquireCompanyChangeLock } = require('../changeFeedWatermark.cjs');
const { modelSnapshot, ticketSnapshot, differences } = require('../../../../../packages/domain/syncConflictSemantics.cjs');

async function inspectConflict(client, companyId, operation) {
  const envelope = validateOperationEnvelope(operation);
  if (envelope.companyId !== companyId) throw Object.assign(new Error('COMPANY_SCOPE_MISMATCH'), { code: 'COMPANY_SCOPE_MISMATCH' });
  if (!['UpsertModel', 'SubmitTicket'].includes(envelope.commandType)) return { status: 'NOT_ELIGIBLE' };
  if (computePayloadHash(canonicalStringify(envelope.payload)) !== envelope.payloadHash) {
    throw Object.assign(new Error('PAYLOAD_HASH_MISMATCH'), { code: 'PAYLOAD_HASH_MISMATCH' });
  }
  const payload = validateCommandPayload(envelope.commandType, envelope.payload,
    { companyId, operation: envelope, baseRevision: envelope.baseRevision });
  const accepted = await client.query(`SELECT 1 FROM operations_dedup WHERE company_id=$1 AND operation_id=$2`, [companyId, envelope.operationId]);
  if (accepted.rows.length) return { status: 'USE_ACCEPTANCE_RECEIPT' };
  const cancelled = await client.query(`SELECT 1 FROM allocation_resolution_fences WHERE company_id=$1 AND original_operation_id=$2`, [companyId, envelope.operationId]);
  if (cancelled.rows.length) return { status: 'NOT_ELIGIBLE' };
  const modelAlias = await client.query(`SELECT canonical_model_id FROM model_id_aliases WHERE company_id=$1 AND legacy_model_id=$2`, [companyId, payload.modelId]);
  payload.modelId = modelAlias.rows[0]?.canonical_model_id || payload.modelId;
  let snapshot;
  let entityRevision;
  let canonicalEntityId;
  let expected;
  let actual;
  if (envelope.commandType === 'UpsertModel') {
    const result = await client.query(`SELECT id, name, hisob_sheet_name, title, party, color, size,
      operations_json, patta_ops_order_json, server_revision FROM models
      WHERE company_id=$1 AND id=$2 AND status='ACTIVE'`, [companyId, payload.modelId]);
    const model = result.rows[0];
    if (!model) return { status: 'NOT_FOUND' };
    canonicalEntityId = model.id;
    entityRevision = Number(model.server_revision);
    snapshot = { modelId: model.id, name: model.name, hisobSheetName: model.hisob_sheet_name,
      title: model.title, party: model.party, color: model.color, size: model.size,
      operations: typeof model.operations_json === 'string' ? JSON.parse(model.operations_json) : model.operations_json,
      pattaOpsOrder: typeof model.patta_ops_order_json === 'string' ? JSON.parse(model.patta_ops_order_json) : model.patta_ops_order_json };
    expected = modelSnapshot(payload);
    actual = modelSnapshot(snapshot);
  } else {
    if (!payload.partyRecordId || !payload.periodId || payload.pattaNumber <= 0) return { status: 'NOT_ELIGIBLE' };
    const alias = await client.query(`SELECT canonical_party_id FROM party_id_aliases WHERE company_id=$1 AND legacy_party_id=$2`, [companyId, payload.partyRecordId]);
    payload.partyRecordId = alias.rows[0]?.canonical_party_id || payload.partyRecordId;
    const result = await client.query(`SELECT t.* FROM tickets t
      JOIN periods period ON period.company_id=t.company_id AND period.id=t.period_id AND period.is_closed=0
      WHERE t.company_id=$1 AND t.party_record_id=$2 AND t.patta_number=$3
        AND t.status='CONFIRMED' AND t.is_closed=0`, [companyId, payload.partyRecordId, payload.pattaNumber]);
    const ticket = result.rows[0];
    if (!ticket) return { status: 'NOT_FOUND' };
    const entries = await client.query(`SELECT id, op_name, worker_id, worker_name_snapshot, qty, rate_snapshot, brak
      FROM ticket_entries WHERE company_id=$1 AND ticket_id=$2 ORDER BY id`, [companyId, ticket.id]);
    canonicalEntityId = ticket.id;
    entityRevision = Number(ticket.server_revision);
    snapshot = { ticketId: ticket.id, modelId: ticket.model_id, periodId: ticket.period_id,
      partyRecordId: ticket.party_record_id, partyNumber: ticket.party_number, pattaNumber: ticket.patta_number,
      qty: Number(ticket.qty), size: ticket.size, color: ticket.color, konveyer: ticket.konveyer,
      submittedAt: ticket.submitted_at instanceof Date ? ticket.submitted_at.toISOString() : ticket.submitted_at,
      status: 'CONFIRMED', isClosed: false,
      entries: entries.rows.map(entry => ({ entryId: entry.id, opName: entry.op_name, workerId: entry.worker_id,
        workerNameSnapshot: entry.worker_name_snapshot, qty: Number(entry.qty),
        rateSnapshot: entry.rate_snapshot == null ? null : Number(entry.rate_snapshot), brak: entry.brak })) };
    expected = ticketSnapshot(payload);
    actual = ticketSnapshot(snapshot);
  }
  const differingFields = differences(expected, actual);
  return { status: differingFields.length ? 'DIFFERENT' : 'EQUIVALENT', canonicalEntityId, entityRevision,
    differingFields, ...(differingFields.length ? {} : { snapshot }) };
}

function createConflictInspectionHandler(pool) {
  return async (req, reply) => {
    const operations = req.body?.operations;
    if (!Array.isArray(operations) || !operations.length || operations.length > 25) {
      return reply.code(400).send({ success: false, error: { code: 'INVALID_CONFLICT_INSPECTION' } });
    }
    let client;
    let discardClient = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await acquireCompanyChangeLock(client, req.auth.companyId);
      const results = [];
      for (const operation of operations) {
        const result = await inspectConflict(client, req.auth.companyId, operation);
        results.push({ companyId: req.auth.companyId, operationId: operation.operationId, payloadHash: operation.payloadHash, ...result });
      }
      await client.query('COMMIT');
      return reply.header('Cache-Control', 'no-store').send({ success: true, results });
    } catch (error) {
      if (client) try { await client.query('ROLLBACK'); } catch { discardClient = true; }
      const known = error[Symbol.for('hisob.sync.applicationError')] === true
        || ['COMPANY_SCOPE_MISMATCH', 'PAYLOAD_HASH_MISMATCH'].includes(error.code);
      return reply.code(known ? 400 : 503).send({ success: false, error: { code: known ? error.code : 'CONFLICT_INSPECTION_UNAVAILABLE' } });
    } finally { if (client) client.release(discardClient ? new Error('Conflict inspection rollback failed') : undefined); }
  };
}

module.exports = { createConflictInspectionHandler, inspectConflict };
