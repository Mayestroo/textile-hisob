'use strict';

const { canonicalStringify, computePayloadHash } = require('../database/core/canonicalPayload.cjs');
const { insertOutboxOperation, getOperation, updateOperationStatus } = require('../database/outbox/outboxManager.cjs');
const { isLegacyPattaBatch, capturedPattaRange } = require('../../../../packages/domain/legacyPattaBatch.cjs');

function parsePayload(row, companyId) {
  try {
    const payload = JSON.parse(row.payload_json);
    return payload.companyId === companyId && payload.operationId === row.operation_id
      && computePayloadHash(canonicalStringify(payload)) === row.payload_hash ? payload : null;
  } catch { return null; }
}

async function getReceipt(client, row) {
  const response = await client.getOperationStatuses([{ operationId: row.operation_id, payloadHash: row.payload_hash }]);
  return response?.results?.find(result => result.operationId === row.operation_id
    && result.status === 'APPLIED' && result.payloadHash === row.payload_hash
    && Number.isSafeInteger(Number(result.serverRevision)) && Number(result.serverRevision) > 0);
}

// Older clients could archive a party before its rejected issuance was accepted.
// The archive then succeeded with missingPartyRecordIds, and the late issuance
// resurrected a number which the owner had already released. Never merge the
// replacement with that old paper: the model or issued quantity can differ.
async function recoverDeferredPartyArchives(db, companyId, client) {
  if (typeof client?.getOperationStatuses !== 'function') return { queued: 0, retried: 0 };
  const failed = db.prepare(`SELECT * FROM local_outbox WHERE company_id = ?
    AND command_type = 'CompletePattaBatch' AND status IN ('CONFLICT','DEAD_LETTER')`).all(companyId);
  if (!failed.length) return { queued: 0, retried: 0 };
  const archives = db.prepare(`SELECT * FROM local_outbox WHERE company_id = ?
    AND command_type = 'ArchivePartyHistory' AND status = 'SYNCED' ORDER BY created_at DESC`).all(companyId);
  let queued = 0;
  let retried = 0;
  for (const row of failed) {
    let error;
    try { error = JSON.parse(row.last_error || row.error_message || '{}'); } catch { continue; }
    const payload = parsePayload(row, companyId);
    if (error?.code !== 'ACTIVE_PARTY_EXISTS' || !payload || !isLegacyPattaBatch(payload)
      || payload.batchId !== row.entity_id || !Array.isArray(payload.parties) || !payload.parties.length
      || payload.parties.some(party => !capturedPattaRange(party) || !party.printedAt)) continue;
    const key = `deferred_party_archive_v1:${row.operation_id}`;
    const stored = db.prepare('SELECT value FROM local_meta WHERE key = ?').get(key);
    if (stored) {
      let recovery;
      try { recovery = JSON.parse(stored.value); } catch { continue; }
      if (recovery.payloadHash !== row.payload_hash || recovery.retried
        || !Array.isArray(recovery.repairs) || !recovery.repairs.length) continue;
      let complete = true;
      for (const repair of recovery.repairs) {
        const operation = getOperation(db, companyId, repair.operationId);
        const party = db.prepare(`SELECT server_revision,is_archived,status FROM parties
          WHERE company_id = ? AND id = ?`).get(companyId, repair.partyId);
        if (!operation || operation.payload_hash !== repair.hash || !party || !party.is_archived || party.status !== 'CLOSED'
          || Number(party.server_revision) <= repair.revision || !await getReceipt(client, operation)) {
          complete = false;
          break;
        }
      }
      if (!complete || !recovery.repairs.length) continue;
      db.transaction(() => {
        updateOperationStatus(db, companyId, row.operation_id, 'PENDING', 'RETRY_AFTER_CONFIRMED_PARTY_ARCHIVE');
        db.prepare('UPDATE local_meta SET value = ?,updated_at = ? WHERE key = ?')
          .run(JSON.stringify({ ...recovery, retried: true }), new Date().toISOString(), key);
      }).immediate();
      retried++;
      continue;
    }

    const repairs = [];
    for (const party of payload.parties) {
      const blockers = db.prepare(`SELECT id,server_revision FROM parties WHERE company_id = ?
        AND party_number = ? AND id <> ? AND is_archived = 1 AND status = 'CLOSED' AND server_revision > 0`)
        .all(companyId, party.partyNumber, party.partyRecordId);
      for (const blocker of blockers) {
        const archive = archives.find(candidate => {
          const intent = parsePayload(candidate, companyId);
          return candidate.created_at < row.created_at && Array.isArray(intent?.partyRecordIds)
            && intent.partyRecordIds.includes(blocker.id);
        });
        // Local SYNCED alone is insufficient: require the original server receipt.
        if (!archive) continue;
        const issuance = db.prepare(`SELECT * FROM local_outbox WHERE company_id = ? AND status = 'SYNCED'
          AND ((command_type = 'CreateParty' AND entity_id = ?) OR (command_type = 'CompletePattaBatch'
            AND EXISTS (SELECT 1 FROM json_each(payload_json, '$.parties') item
              WHERE json_extract(item.value, '$.partyRecordId') = ?))) ORDER BY created_at LIMIT 1`)
          .get(companyId, blocker.id, blocker.id);
        if (!issuance || !parsePayload(issuance, companyId)) continue;
        const archiveReceipt = await getReceipt(client, archive);
        const issuanceReceipt = await getReceipt(client, issuance);
        // Prove the ordering defect from SERVER commit timestamps, not optimistic
        // local flags or the human-readable ACTIVE_PARTY_EXISTS message.
        const archivedAt = Date.parse(archiveReceipt?.committedAt);
        const issuedAt = Date.parse(issuanceReceipt?.committedAt);
        if (!Number.isFinite(archivedAt) || !Number.isFinite(issuedAt) || issuedAt <= archivedAt) continue;
        const operationId = `archive_repair_${computePayloadHash(canonicalStringify({
          companyId, archive: archive.operation_id, hash: archive.payload_hash, partyId: blocker.id
        })).slice(0, 48)}`;
        const repairPayload = { companyId, commandId: operationId, operationId, partyRecordIds: [blocker.id] };
        const json = canonicalStringify(repairPayload);
        repairs.push({ operationId, partyId: blocker.id, revision: Number(blocker.server_revision),
          originalArchive: archive.operation_id, json, hash: computePayloadHash(json) });
      }
    }
    if (!repairs.length) continue;
    db.transaction(() => {
      for (const repair of repairs) {
        if (getOperation(db, companyId, repair.operationId)) continue;
        insertOutboxOperation(db, { company_id: companyId, operation_id: repair.operationId,
          command_type: 'ArchivePartyHistory', entity_type: 'party_history', entity_id: companyId,
          base_revision: 0, payload_json: repair.json, payload_hash: repair.hash,
          depends_on_operation_id: repair.originalArchive, status: 'PENDING' });
        queued++;
      }
      db.prepare('INSERT INTO local_meta(key,value,updated_at) VALUES (?,?,?)')
        .run(key, JSON.stringify({ payloadHash: row.payload_hash, repairs, retried: false }), new Date().toISOString());
    }).immediate();
  }
  return { queued, retried };
}

module.exports = { recoverDeferredPartyArchives };
