'use strict';

const { updateOperationStatus, getOperation, acknowledgeOutboxOperation } = require('../database/outbox/outboxManager.cjs');
const { rebuildCompanyProjections } = require('../database/readers/projectionReader.cjs');
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

function hasNewerServerTicketRevision(db, companyId, op) {
  const ticket = db.prepare('SELECT server_revision FROM tickets WHERE company_id = ? AND id = ?')
    .get(companyId, op.entity_id);
  return Number(ticket?.server_revision || 0) > Number(op.base_revision || 0);
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
  // Match the server operations endpoint's maximum; invalid limits use default.
  const batchSize = Number.isSafeInteger(options.batchSize) && options.batchSize > 0
    ? Math.min(options.batchSize, 100) : 25;

  // Filter BEFORE LIMIT: a blocked prefix must not starve independent work.
  // Only persisted SYNCED parents qualify, never another member of this request.
  // The indexed, tenant-scoped parent lookup is non-recursive; at most batchSize
  // payloads enter JS/memory/the network, regardless of the blocked queue size.
  const candidates = db.prepare(`
    SELECT op.* FROM local_outbox op
    WHERE op.company_id = ? AND op.status = 'PENDING'
      AND (op.depends_on_operation_id IS NULL OR TRIM(op.depends_on_operation_id) = ''
        OR EXISTS (
          SELECT 1 FROM local_outbox parent
          WHERE parent.company_id = op.company_id
            AND parent.operation_id = TRIM(op.depends_on_operation_id)
            AND parent.status = 'SYNCED'
        ))
    ORDER BY op.causal_sequence ASC, op.rowid ASC
    LIMIT ?
  `).all(companyId, batchSize);
  const lifecycleSupported = db.prepare("SELECT value FROM local_meta WHERE key = 'patta_lifecycle_v1'").get()?.value === '1';
  const firstUnresolvedBatch = db.prepare(`SELECT operation_id FROM local_outbox
    WHERE company_id = ? AND status IN ('PENDING', 'SENDING')
      AND command_type IN ('UpdateBatchSettings', 'CompletePattaBatch')
    ORDER BY rowid ASC LIMIT 1`).get(companyId);
  // A print's immutable CAS base may include queued settings updates. Never send
  // two company batch mutations in one concurrent push request.
  let batchMutationSeen = false;
  const eligible = candidates.filter((op) => {
    if (op.command_type === 'CompletePartySeries' && JSON.parse(op.payload_json).finishScopeHash && !lifecycleSupported) return false;
    if (op.command_type !== 'UpdateBatchSettings' && op.command_type !== 'CompletePattaBatch') return true;
    if (op.operation_id !== firstUnresolvedBatch?.operation_id) return false;
    if (batchMutationSeen) return false;
    batchMutationSeen = true;
    return true;
  });

  if (eligible.length === 0) {
    // Preserve bounded diagnostic sampling; do not load blocked payloads or count
    // the entire queue merely to report a no-op.
    const blockedCount = db.prepare(`SELECT operation_id FROM local_outbox
      WHERE company_id = ? AND status = 'PENDING' LIMIT ?`).all(companyId, batchSize).length;
    return { attempted: 0, synced: 0, conflict: 0, deadLetter: 0, transientErrors: 0,
      ...(blockedCount ? { blockedCount } : {}) };
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
      const accepted = db.transaction(() => {
        if (op.command_type === 'UpsertWorker' && res.payloadHash
          && (res.payloadHash !== op.payload_hash || Number(res.serverRevision) !== Number(op.base_revision) + 1)) {
          updateOperationStatus(db, companyId, op.operation_id, 'CONFLICT', 'ACK_WORKER_PAYLOAD_OR_REVISION_MISMATCH');
          return false;
        }
        if (op.entity_type === 'ticket' && ['SubmitTicket', 'UpdateTicket', 'DeleteTicket'].includes(op.command_type)
          && res.payloadHash === op.payload_hash && Number(res.serverRevision) !== Number(op.base_revision) + 1) {
          updateOperationStatus(db, companyId, op.operation_id, 'CONFLICT', 'ACK_TICKET_REVISION_MISMATCH');
          return false;
        }
        if (op.command_type === 'SubmitTicket') {
          const capturedPeriod = db.prepare('SELECT period_id FROM tickets WHERE company_id = ? AND id = ?')
            .get(companyId, op.entity_id)?.period_id;
          if (capturedPeriod && capturedPeriod !== (res.periodId || null)) {
            updateOperationStatus(db, companyId, op.operation_id, 'CONFLICT', JSON.stringify({
              code: 'TICKET_PERIOD_AUTHORITY_MISMATCH', capturedPeriod, receivedPeriod: res.periodId ?? null
            }));
            return false;
          }
        }
        // The response must identify the exact immutable submitted payload before
        // it can serve as durable acceptance evidence. Older servers may omit
        // payloadHash: retain their legacy lifecycle, but record no proof.
        if (!acknowledgeOutboxOperation(db, companyId, op.operation_id, res.payloadHash, res.serverRevision, res.cursor)) {
          if (res.payloadHash && res.payloadHash !== op.payload_hash) {
            updateOperationStatus(db, companyId, op.operation_id, 'CONFLICT', 'ACK_PAYLOAD_HASH_MISMATCH');
            return false;
          }
          updateOperationStatus(db, companyId, op.operation_id, 'SYNCED');
        }

        const newerTicketMutation = op.entity_type === 'ticket' && db.prepare(`SELECT 1 FROM local_outbox
          WHERE company_id = ? AND entity_id = ? AND entity_type = 'ticket'
            AND command_type IN ('SubmitTicket', 'UpdateTicket', 'DeleteTicket')
            AND operation_id <> ? AND (base_revision > ? OR causal_sequence > ?)
            LIMIT 1`).get(companyId, op.entity_id, op.operation_id, op.base_revision, op.causal_sequence);

        if (op.command_type === 'SubmitTicket' && !newerTicketMutation) {
          db.prepare(`
            UPDATE tickets
             SET status = 'CONFIRMED', period_id = COALESCE(period_id, ?), server_revision = MAX(server_revision, ?)
            WHERE company_id = ? AND id = ? AND server_revision <= ?
          `).run(res.periodId || null, res.serverRevision || 0, companyId, op.entity_id, res.serverRevision || 0);
          factsUpdated++;
        } else if (op.command_type === 'DeleteTicket') {
          db.prepare(`UPDATE tickets SET status = 'VOIDED', server_revision = ? WHERE company_id = ? AND id = ? AND server_revision <= ?`)
            .run(res.serverRevision || 0, companyId, op.entity_id, res.serverRevision || 0);
          factsUpdated++;
        } else if (op.command_type === 'UpdateTicket' && !newerTicketMutation) {
          db.prepare(`UPDATE tickets SET server_revision = MAX(server_revision, ?)
            WHERE company_id = ? AND id = ?`).run(res.serverRevision || 0, companyId, op.entity_id);
          factsUpdated++;
        } else if (op.command_type === 'RecordProductionAdjustment') {
          db.prepare(`UPDATE production_adjustments SET server_revision = MAX(server_revision, ?)
            WHERE company_id = ? AND adjustment_id = ?`).run(res.serverRevision || 0, companyId, op.entity_id);
          factsUpdated++;
        } else if (op.command_type === 'UpsertModel' || op.command_type === 'DeactivateModel') {
          const status = op.command_type === 'DeactivateModel' ? 'INACTIVE' : 'ACTIVE';
          const modelAlias = db.prepare(`SELECT canonical_model_id FROM model_id_aliases
            WHERE company_id = ? AND legacy_model_id = ?`).get(companyId, op.entity_id);
          const modelId = modelAlias?.canonical_model_id || op.entity_id;
          db.prepare(`UPDATE models SET status = ?, server_revision = ?, updated_at = ? WHERE company_id = ? AND id = ? AND server_revision <= ?`)
            .run(status, res.serverRevision, res.committedAt || new Date().toISOString(), companyId, modelId, res.serverRevision);
          if (op.command_type === 'UpsertModel') {
            db.prepare(`UPDATE local_outbox SET status = 'SUPERSEDED', error_message = NULL, last_error = NULL,
              updated_at = ? WHERE company_id = ? AND command_type = 'UpsertModel' AND status = 'DEAD_LETTER'
              AND entity_id IN (
                SELECT legacy_model_id FROM model_id_aliases
                WHERE company_id = ? AND canonical_model_id = ?
              )`).run(new Date().toISOString(), companyId, companyId, modelId);
          }
          factsUpdated++;
        } else if (op.command_type === 'UpsertWorker' || op.command_type === 'DeactivateWorker' || op.command_type === 'ActivateWorker') {
          const status = op.command_type === 'DeactivateWorker' ? 'INACTIVE' : 'ACTIVE';
          const updatedAt = res.committedAt instanceof Date ? res.committedAt.toISOString()
            : res.committedAt || new Date().toISOString();
          db.prepare(`UPDATE workers SET status = ?, server_revision = ?, updated_at = ? WHERE company_id = ? AND id = ? AND server_revision <= ?`)
            .run(status, res.serverRevision, updatedAt, companyId, Number(op.entity_id), res.serverRevision);
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
            status = ?, updated_at = COALESCE(?, updated_at) WHERE company_id = ? AND id = ? AND server_revision <= ?`)
            .run(res.serverRevision, isClosed, closedAt, isClosed ? 'CLOSED' : 'OPEN', res.committedAt || null, companyId, op.entity_id, res.serverRevision);
          if (op.command_type === 'ClosePeriod' && payload.nextPeriod?.id) {
            db.prepare(`UPDATE periods SET server_revision = MAX(server_revision, 1), status = 'OPEN'
              WHERE company_id = ? AND id = ? AND server_revision <= 1 AND is_closed = 0`)
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
           const pendingFinish = db.prepare(`SELECT local_archive_json FROM local_outbox WHERE company_id = ? AND command_type = 'CompletePartySeries'
             AND status IN ('PENDING','SENDING','SYNCED') AND local_archive_json IS NOT NULL`).all(companyId)
             .some((row) => JSON.parse(row.local_archive_json)?.effects?.partyIds?.includes(partyId));
           db.prepare(`UPDATE parties SET server_revision = ?, status = CASE WHEN ? OR ended_at IS NOT NULL THEN status ELSE ? END,
             is_closed = CASE WHEN ? THEN is_closed ELSE ? END,
             closed_at = COALESCE(?, closed_at), updated_at = COALESCE(?, updated_at)
             WHERE company_id = ? AND id = ? AND server_revision <= ?`)
             .run(res.serverRevision, Boolean(pendingFinish) ? 1 : 0, status,
               Boolean(pendingFinish) ? 1 : 0, status === 'CLOSED' ? 1 : 0,
              status === 'CLOSED' ? (res.committedAt || new Date().toISOString()) : null,
              res.committedAt || null, companyId, partyId, res.serverRevision);
          factsUpdated++;
        } else if (op.command_type === 'UpdateBatchSettings') {
          db.prepare(`UPDATE company_batch_settings SET server_revision = ?, updated_at = ? WHERE company_id = ? AND server_revision <= ?`)
            .run(res.serverRevision, res.committedAt || new Date().toISOString(), companyId, res.serverRevision);
          supersedeOlderBatchSettingsConflicts(db, companyId, op);
          factsUpdated++;
        } else if (op.command_type === 'CompletePattaBatch') {
          const payload = JSON.parse(op.payload_json);
          const acceptedSettingsRevision = payload.batchSettingsBaseRevision + 1;
          db.prepare(`UPDATE company_batch_settings SET server_revision = MAX(server_revision, ?), updated_at = ?
            WHERE company_id = ?`).run(acceptedSettingsRevision, res.committedAt || new Date().toISOString(), companyId);
          factsUpdated++;
        } else if (op.command_type === 'CompletePartySeries') {
          factsUpdated++;
        } else if (op.command_type === 'ReverseProductionAdjustment') {
          const payload = JSON.parse(op.payload_json);
          db.prepare(`UPDATE production_adjustments SET server_revision = MAX(server_revision, ?)
            WHERE company_id = ? AND adjustment_id = ?`).run(res.serverRevision || 0, companyId, op.entity_id);
          if (payload.originalAdjustmentId) {
            db.prepare(`
              UPDATE production_adjustments
              SET status = 'REVERSED', server_revision = ?
              WHERE company_id = ? AND adjustment_id = ? AND server_revision <= ?
            `).run(res.serverRevision, companyId, payload.originalAdjustmentId, res.serverRevision);
          }
          factsUpdated++;
        }
      })();
      if (accepted === false) conflict++;
      else synced++;
    } else if (res.status === 'CONFLICT') {
      const errJson = JSON.stringify(res.error || { code: 'CONFLICT' });
      updateOperationStatus(db, companyId, op.operation_id, 'CONFLICT', errJson);
      if (op.command_type === 'CompletePattaBatch') {
        // Keep exact print intent in the outbox, but discard only new,
        // unaccepted local party facts not referenced by another operation.
        const payload = JSON.parse(op.payload_json);
        for (const party of payload.parties || []) {
          db.prepare(`DELETE FROM parties WHERE company_id = ? AND id = ?
            AND provenance = 'LOCAL_COMMAND' AND server_revision = 0
            AND NOT EXISTS (SELECT 1 FROM tickets WHERE tickets.company_id = parties.company_id AND tickets.party_record_id = parties.id)
            AND NOT EXISTS (SELECT 1 FROM local_outbox other WHERE other.company_id = parties.company_id
              AND other.entity_id = parties.id AND other.operation_id <> ? AND other.status <> 'SUPERSEDED')`)
            .run(companyId, party.partyRecordId, op.operation_id);
        }
        factsUpdated++;
      }
      if (op.command_type === 'DeleteTicket') {
        db.prepare(`UPDATE tickets SET status = 'CONFIRMED' WHERE company_id = ? AND id = ? AND status = 'PENDING_DELETE'`)
          .run(companyId, op.entity_id);
        factsUpdated++;
      } else if (op.command_type === 'UpdateTicket') {
        // A feed may already have installed a newer authoritative server revision.
        // Rolling back to the edit's local archive in that case would overwrite
        // the newer server fact; retain the conflicted intent in the outbox.
        if (!hasNewerServerTicketRevision(db, companyId, op) && restoreTicketEntries(db, companyId, op)) {
          factsUpdated++;
        }
      }
      if (op.command_type === 'CompletePartySeries' || op.command_type === 'ClosePeriod') {
        if (restoreRejectedLifecycleEffects(db, companyId, op)) factsUpdated++;
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
      if (op.command_type === 'CompletePartySeries' || op.command_type === 'ClosePeriod') {
        if (restoreRejectedLifecycleEffects(db, companyId, op)) factsUpdated++;
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

// A rejected provisional reset may only restore rows still carrying this
// operation's own write timestamp/revision. Accepted newer feed facts win.
function restoreRejectedLifecycleEffects(db, companyId, op) {
  if (!op.local_archive_json) return false;
  const record = JSON.parse(op.local_archive_json);
  if (record.version !== 1 || record.operationId !== op.operation_id ||
      !['series-finish-effects', 'period-close-effects'].includes(record.kind)) return false;
  const appliedAt = record.effects?.appliedAt;
  if (!appliedAt) return false;
  db.transaction(() => {
    for (const party of record.before?.parties || []) {
      if (party.company_id !== companyId) continue;
      db.prepare(`UPDATE parties SET status = ?, is_closed = ?, closed_at = ?, archived_patta_numbers_json = ?,
        updated_at = ? WHERE company_id = ? AND id = ? AND updated_at = ? AND server_revision = ?
        AND ended_at IS NULL AND month_closed_period_id IS NULL`)
        .run(party.status, party.is_closed, party.closed_at, party.archived_patta_numbers_json,
          party.updated_at, companyId, party.id, appliedAt, party.server_revision);
    }
    for (const ticket of record.before?.tickets || []) {
      if (record.kind === 'period-close-effects' &&
          db.prepare('SELECT close_operation_id FROM periods WHERE company_id = ? AND id = ?')
            .get(companyId, op.entity_id)?.close_operation_id) continue;
      db.prepare(`UPDATE tickets SET is_closed = ? WHERE company_id = ? AND id = ?
        AND is_closed = 1 AND server_revision = ?`)
        .run(ticket.is_closed, companyId, ticket.id, ticket.server_revision);
    }
    if (record.kind === 'series-finish-effects') {
      for (const settings of record.before?.settings || []) {
        db.prepare(`UPDATE patta_batch_settings SET party_number = ?, is_custom_party = ?, total_ish_soni = ?,
          sizes_json = ?, updated_at = ? WHERE company_id = ? AND model_id = ? AND updated_at = ? AND server_revision = ?`)
          .run(settings.party_number, settings.is_custom_party, settings.total_ish_soni, settings.sizes_json,
            settings.updated_at, companyId, settings.model_id, appliedAt, settings.server_revision);
      }
      const sequence = record.before?.sequence;
      if (sequence) db.prepare(`UPDATE company_patta_sequences SET next_patta_number = ?, updated_at = ?
        WHERE company_id = ? AND next_patta_number = 1 AND updated_at = ?`)
        .run(sequence.next_patta_number, sequence.updated_at, companyId, appliedAt);
      else db.prepare(`DELETE FROM company_patta_sequences WHERE company_id = ? AND next_patta_number = 1 AND updated_at = ?`)
        .run(companyId, appliedAt);
    } else if (record.before?.period?.company_id === companyId) {
      const period = record.before.period;
      db.prepare(`UPDATE periods SET end_date = ?, is_closed = ?, closed_at = ?, archive_filename = ?,
        status = ?, updated_at = ? WHERE company_id = ? AND id = ? AND updated_at = ? AND server_revision = ?
        AND close_operation_id IS NULL`)
        .run(period.end_date, period.is_closed, period.closed_at, period.archive_filename,
          period.status, period.updated_at, companyId, period.id, appliedAt, period.server_revision);
      // A provisional archive is removed only if no authority has installed a
      // canonical close. Never rewrite an accepted archive/hash here.
      db.prepare(`DELETE FROM period_archives WHERE company_id = ? AND period_id = ?
        AND sha256 = ? AND NOT EXISTS (
        SELECT 1 FROM periods WHERE company_id = ? AND id = ? AND close_operation_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM local_meta WHERE key = ?)`)
        .run(companyId, period.id, record.effects?.provisionalArchiveSha256 || '',
          companyId, period.id, `accepted_archive_sha256:${period.id}`);
      const nextId = JSON.parse(op.payload_json).nextPeriod?.id;
      if (nextId) db.prepare(`DELETE FROM periods WHERE company_id = ? AND id = ? AND provenance = 'LOCAL_COMMAND'
        AND server_revision = 0 AND is_closed = 0 AND NOT EXISTS (
          SELECT 1 FROM tickets t WHERE t.company_id = periods.company_id AND t.period_id = periods.id)
        AND NOT EXISTS (SELECT 1 FROM local_outbox child WHERE child.company_id = periods.company_id
          AND child.operation_id <> ? AND child.entity_id = periods.id AND child.status <> 'SUPERSEDED')`)
        .run(companyId, nextId, op.operation_id);
    }
  })();
  return true;
}

module.exports = {
  isDependencySatisfied,
  dispatchOutbox,
  restoreTicketEntries,
  supersedeOlderBatchSettingsConflicts
};
