'use strict';

const { updateOperationStatus, getOperation } = require('../database/outboxManager.cjs');
const { rebuildCompanyProjections } = require('../database/projectionReader.cjs');
const { applyWorkerChange } = require('./changeFeedApplier.cjs');

/**
 * Checks whether an operation's causal dependency is fully satisfied.
 *
 * Rules:
 * - If depends_on_operation_id is null/empty => satisfied.
 * - If depends_on_operation_id is present => predecessor MUST exist in local_outbox with status = 'SYNCED'.
 * - Any other status (PENDING, SENDING, CONFLICT, DEAD_LETTER) => blocked.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @param {object} op
 * @returns {boolean}
 */
function isDependencySatisfied(db, companyId, op) {
  const depId = op.depends_on_operation_id;
  if (!depId || String(depId).trim() === '') {
    return true;
  }

  const parent = getOperation(db, companyId, String(depId).trim());
  if (!parent) {
    return false;
  }

  return parent.status === 'SYNCED';
}

function restoreTicketEntries(db, companyId, op) {
  if (!op.local_archive_json) return false;
  let archive;
  try { archive = JSON.parse(op.local_archive_json); } catch { return false; }
  if (!Array.isArray(archive?.entries)) return false;
  db.prepare('DELETE FROM ticket_entries WHERE company_id = ? AND ticket_id = ?').run(companyId, op.entity_id);
  const insertEntry = db.prepare(`INSERT INTO ticket_entries (
    id, ticket_id, company_id, op_name, worker_id, worker_name_snapshot,
    rate_snapshot, brak, qty, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const entry of archive.entries) {
    insertEntry.run(entry.id, op.entity_id, companyId, entry.op_name, entry.worker_id,
      entry.worker_name_snapshot, entry.rate_snapshot, entry.brak, entry.qty, entry.created_at);
  }
  return true;
}

function isRevisionConflict(errorValue) {
  if (typeof errorValue !== 'string' || !errorValue) return false;
  try {
    return JSON.parse(errorValue)?.code === 'REVISION_CONFLICT';
  } catch {
    return false;
  }
}

function supersedeOlderBatchSettingsConflicts(db, companyId, acceptedOperation) {
  const acceptedPayload = JSON.parse(acceptedOperation.payload_json);
  if (!Array.isArray(acceptedPayload.availableSizes) || !Array.isArray(acceptedPayload.configs)) return 0;

  const conflicts = db.prepare(`
    SELECT operation_id, base_revision, last_error, error_message
    FROM local_outbox
    WHERE company_id = ? AND entity_id = ? AND command_type = 'UpdateBatchSettings' AND status = 'CONFLICT'
      AND operation_id <> ?
    ORDER BY causal_sequence ASC, created_at ASC
  `).all(companyId, acceptedOperation.entity_id, acceptedOperation.operation_id);

  let superseded = 0;
  for (const conflict of conflicts) {
    if (Number(conflict.base_revision) >= Number(acceptedOperation.base_revision)) continue;
    if (!isRevisionConflict(conflict.last_error) && !isRevisionConflict(conflict.error_message)) continue;
    updateOperationStatus(db, companyId, conflict.operation_id, 'SUPERSEDED', 'SUPERSEDED_BY_NEWER_BATCH_SETTINGS');
    superseded++;
  }
  return superseded;
}

/**
 * Dispatches eligible local outbox operations to the authoritative server.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @param {import('./syncClient.cjs').SyncClient} syncClient
 * @param {object} [options={}]
 * @param {string} [options.baseUserDataPath]
 * @param {number} [options.batchSize=25]
 * @returns {Promise<object>} DispatchResult
 */
async function dispatchOutbox(db, companyId, syncClient, options = {}) {
  const batchSize = options.batchSize || 25;

  // 1. Fetch pending operations ordered by causal sequence and creation time
  const pendingRows = db.prepare(`
    SELECT * FROM local_outbox
    WHERE company_id = ? AND status = 'PENDING'
    ORDER BY causal_sequence ASC, created_at ASC
    LIMIT ?
  `).all(companyId, batchSize);

  if (pendingRows.length === 0) {
    return { attempted: 0, synced: 0, conflict: 0, deadLetter: 0, transientErrors: 0 };
  }

  // 2. Filter eligible operations preserving causal order
  const eligible = [];
  const blockedOpIds = new Set();

  for (const op of pendingRows) {
    if (op.depends_on_operation_id && blockedOpIds.has(op.depends_on_operation_id)) {
      blockedOpIds.add(op.operation_id);
      continue;
    }

    if (!isDependencySatisfied(db, companyId, op)) {
      blockedOpIds.add(op.operation_id);
      continue;
    }

    eligible.push(op);
  }

  if (eligible.length === 0) {
    return { attempted: 0, synced: 0, conflict: 0, deadLetter: 0, transientErrors: 0, blockedCount: pendingRows.length };
  }

  // 3. Transition eligible operations: PENDING -> SENDING
  for (const op of eligible) {
    updateOperationStatus(db, companyId, op.operation_id, 'SENDING');
  }

  // 4. Build wire payload
  const wireOperations = eligible.map((op) => ({
    operationId: op.operation_id,
    companyId: op.company_id,
    commandType: op.command_type,
    entityType: op.entity_type,
    entityId: op.entity_id,
    baseRevision: op.base_revision,
    payloadHash: op.payload_hash,
    payload: JSON.parse(op.payload_json)
  }));

  let serverResponse;
  try {
    serverResponse = await syncClient.pushOperations(wireOperations);
  } catch (netErr) {
    // Transient network failure or timeout: revert SENDING -> PENDING for retry
    for (const op of eligible) {
      try {
        updateOperationStatus(
          db,
          companyId,
          op.operation_id,
          'PENDING',
          netErr.message || 'Transient network failure'
        );
      } catch (e) {
        // ignore
      }
    }
    return {
      attempted: eligible.length,
      synced: 0,
      conflict: 0,
      deadLetter: 0,
      transientErrors: eligible.length,
      error: netErr.message
    };
  }

  const resultsMap = new Map();
  if (Array.isArray(serverResponse?.results)) {
    for (const r of serverResponse.results) {
      resultsMap.set(r.operationId, r);
    }
  }

  // Hook for testing crash between server commit and local ACK application
  if (typeof options.testHooks?.afterServerResponse === 'function') {
    await options.testHooks.afterServerResponse(serverResponse);
  }

  let synced = 0;
  let conflict = 0;
  let deadLetter = 0;
  let operatorReauthRequired = 0;
  let factsUpdated = 0;

  // 5. Process each operation response transactionally
  for (const op of eligible) {
    const res = resultsMap.get(op.operation_id);
    if (!res) {
      // Missing response for specific op in batch: revert to PENDING
      updateOperationStatus(db, companyId, op.operation_id, 'PENDING', 'Missing result from server');
      continue;
    }

    if (res.status === 'APPLIED') {
      // Transactionally update outbox to SYNCED and fact to CONFIRMED
      db.transaction(() => {
        updateOperationStatus(db, companyId, op.operation_id, 'SYNCED');

        if (op.command_type === 'SubmitTicket') {
          db.prepare(`
            UPDATE tickets
            SET status = 'CONFIRMED', period_id = COALESCE(?, period_id), server_revision = MAX(server_revision, ?)
            WHERE company_id = ? AND id = ?
          `).run(res.periodId || null, res.serverRevision || 0, companyId, op.entity_id);
          factsUpdated++;
        } else if (op.command_type === 'DeleteTicket') {
          db.prepare(`UPDATE tickets SET status = 'VOIDED', server_revision = ? WHERE company_id = ? AND id = ?`)
            .run(res.serverRevision || 0, companyId, op.entity_id);
          factsUpdated++;
        } else if (op.command_type === 'UpdateTicket') {
          db.prepare(`UPDATE tickets SET server_revision = MAX(server_revision, ?)
            WHERE company_id = ? AND id = ?`).run(res.serverRevision || 0, companyId, op.entity_id);
          factsUpdated++;
        } else if (op.command_type === 'UpsertModel' || op.command_type === 'DeactivateModel') {
          const status = op.command_type === 'DeactivateModel' ? 'INACTIVE' : 'ACTIVE';
          const modelAlias = db.prepare(`SELECT canonical_model_id FROM model_id_aliases
            WHERE company_id = ? AND legacy_model_id = ?`).get(companyId, op.entity_id);
          const modelId = modelAlias?.canonical_model_id || op.entity_id;
          db.prepare(`UPDATE models SET status = ?, server_revision = ?, updated_at = ? WHERE company_id = ? AND id = ?`)
            .run(status, res.serverRevision, res.committedAt || new Date().toISOString(), companyId, modelId);
          if (op.command_type === 'UpsertModel') {
            db.prepare(`UPDATE local_outbox SET status = 'SUPERSEDED', error_message = NULL, last_error = NULL,
              updated_at = ? WHERE company_id = ? AND command_type = 'UpsertModel' AND status = 'DEAD_LETTER'
              AND entity_id IN (
                SELECT legacy_model_id FROM model_id_aliases
                WHERE company_id = ? AND canonical_model_id = ?
              )`).run(new Date().toISOString(), companyId, companyId, modelId);
          }
          factsUpdated++;
        } else if (op.command_type === 'UpsertWorker' || op.command_type === 'DeactivateWorker') {
          const status = op.command_type === 'DeactivateWorker' ? 'INACTIVE' : 'ACTIVE';
          db.prepare(`UPDATE workers SET status = ?, server_revision = ?, updated_at = ? WHERE company_id = ? AND id = ?`)
            .run(status, res.serverRevision, res.committedAt || new Date().toISOString(), companyId, Number(op.entity_id));
          factsUpdated++;
        } else if (op.command_type === 'CreateWorker') {
          const payload = JSON.parse(op.payload_json);
          const workerId = Number(res.entityId);
          if (!Number.isSafeInteger(workerId) || workerId <= 0 || Number(res.worker?.id) !== workerId) {
            throw new Error('SERVER_WORKER_ID_INVALID');
          }
          applyWorkerChange(db, companyId, String(workerId), 'INSERT', {
            ...res.worker,
            balanceAdjustments: res.worker.balanceAdjustments || payload.balanceAdjustments || [],
            updatedAt: res.committedAt || new Date().toISOString()
          }, res.serverRevision || 1);
          factsUpdated++;
        } else if (op.command_type === 'CreatePeriod' || op.command_type === 'UpdatePeriod' || op.command_type === 'ClosePeriod') {
          const payload = JSON.parse(op.payload_json);
          const isClosed = op.command_type === 'ClosePeriod' ? 1 : 0;
          const closedAt = op.command_type === 'ClosePeriod' ? (res.committedAt || new Date().toISOString()) : null;
          db.prepare(`UPDATE periods SET server_revision = ?, is_closed = ?, closed_at = COALESCE(?, closed_at),
            status = ?, updated_at = COALESCE(?, updated_at) WHERE company_id = ? AND id = ?`)
            .run(res.serverRevision, isClosed, closedAt, isClosed ? 'CLOSED' : 'OPEN', res.committedAt || null, companyId, op.entity_id);
          if (op.command_type === 'ClosePeriod' && payload.nextPeriod?.id) {
            db.prepare(`UPDATE periods SET server_revision = MAX(server_revision, 1), status = 'OPEN' WHERE company_id = ? AND id = ?`)
              .run(companyId, payload.nextPeriod.id);
          }
          factsUpdated++;
        } else if (op.command_type === 'CreateParty' || op.command_type === 'UpdateParty' || op.command_type === 'CloseParty') {
          const payload = JSON.parse(op.payload_json);
          const status = op.command_type === 'CloseParty' ? 'CLOSED' : 'ACTIVE';
          const requestedPartyId = payload.partyRecordId || op.entity_id;
          const partyAlias = db.prepare(`SELECT canonical_party_id FROM party_id_aliases
            WHERE company_id = ? AND legacy_party_id = ?`).get(companyId, requestedPartyId);
          const partyId = partyAlias?.canonical_party_id || requestedPartyId;
          db.prepare(`UPDATE parties SET server_revision = ?, status = ?, is_closed = ?,
            closed_at = COALESCE(?, closed_at), updated_at = COALESCE(?, updated_at)
            WHERE company_id = ? AND id = ?`)
            .run(res.serverRevision, status, status === 'CLOSED' ? 1 : 0,
              status === 'CLOSED' ? (res.committedAt || new Date().toISOString()) : null,
              res.committedAt || null, companyId, partyId);
          factsUpdated++;
        } else if (op.command_type === 'UpdateBatchSettings') {
          db.prepare(`UPDATE company_batch_settings SET server_revision = ?, updated_at = ? WHERE company_id = ?`)
            .run(res.serverRevision, res.committedAt || new Date().toISOString(), companyId);
          supersedeOlderBatchSettingsConflicts(db, companyId, op);
          factsUpdated++;
        } else if (op.command_type === 'CompletePattaBatch' || op.command_type === 'CompletePartySeries') {
          factsUpdated++;
        } else if (op.command_type === 'ReverseProductionAdjustment') {
          const payload = JSON.parse(op.payload_json);
          if (payload.originalAdjustmentId) {
            db.prepare(`
              UPDATE production_adjustments
              SET status = 'REVERSED'
              WHERE company_id = ? AND adjustment_id = ?
            `).run(companyId, payload.originalAdjustmentId);
          }
          factsUpdated++;
        }
      })();
      synced++;
    } else if (res.status === 'CONFLICT') {
      const errJson = JSON.stringify(res.error || { code: 'CONFLICT' });
      updateOperationStatus(db, companyId, op.operation_id, 'CONFLICT', errJson);
      if (op.command_type === 'DeleteTicket') {
        db.prepare(`UPDATE tickets SET status = 'CONFIRMED' WHERE company_id = ? AND id = ? AND status = 'PENDING_DELETE'`)
          .run(companyId, op.entity_id);
        factsUpdated++;
      } else if (op.command_type === 'UpdateTicket' && restoreTicketEntries(db, companyId, op)) {
        factsUpdated++;
      }
      conflict++;
    } else {
      const errorCode = res.error?.code;
      if (errorCode === 'RECONCILIATION_RBAC_BLOCKED' || errorCode === 'OPERATOR_AUTH_REQUIRED' || errorCode === 'OPERATOR_INTENT_MISMATCH') {
        updateOperationStatus(db, companyId, op.operation_id, 'PENDING', JSON.stringify({ code: 'OPERATOR_REAUTH_REQUIRED', cause: errorCode }));
        operatorReauthRequired++;
        continue;
      }
      // REJECTED / permanent failure -> DEAD_LETTER
      const errJson = JSON.stringify(res.error || { code: 'REJECTED' });
      updateOperationStatus(db, companyId, op.operation_id, 'DEAD_LETTER', errJson);
      if (op.command_type === 'DeleteTicket') {
        db.prepare(`UPDATE tickets SET status = 'CONFIRMED' WHERE company_id = ? AND id = ? AND status = 'PENDING_DELETE'`)
          .run(companyId, op.entity_id);
        factsUpdated++;
      } else if (op.command_type === 'UpdateTicket' && restoreTicketEntries(db, companyId, op)) {
        factsUpdated++;
      }
      deadLetter++;
    }
  }

  // 6. Post-sync projection recalculation
  if (factsUpdated > 0 && options.baseUserDataPath) {
    try {
      rebuildCompanyProjections(options.baseUserDataPath, companyId);
    } catch (projErr) {
      console.warn('[OutboxDispatcher] Projection rebuild warning:', projErr.message);
    }
  }

  return {
    attempted: eligible.length,
    synced,
    conflict,
    deadLetter,
    transientErrors: 0
    ,operatorReauthRequired
  };
}

module.exports = {
  isDependencySatisfied,
  dispatchOutbox,
  restoreTicketEntries,
  supersedeOlderBatchSettingsConflicts
};
