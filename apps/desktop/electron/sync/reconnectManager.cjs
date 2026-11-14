'use strict';

const { getLocalCursor, applyChangesBatch } = require('./changeFeedApplier.cjs');
const { markFeedUnavailable } = require('./feedEvidence.cjs');
const { dispatchOutbox } = require('./outboxDispatcher.cjs');
const { reapplyBootstrapAfterHistoricalPurge } = require('./bootstrapApplier.cjs');
const { rebuildCompanyProjections } = require('../database/readers/projectionReader.cjs');
const {
  acknowledgeOutboxOperation,
  listOutboxReconciliationCandidates,
  recoverStrandedSendingOperations,
  recoverPeriodScopeMismatchTickets,
  recoverCapturedTicketProvenanceTickets,
  recoverVoidedPattaDuplicateTickets,
  recoverLegacyPattaBatches,
  supersedeBatchSettingsAlreadyApplied
} = require('../database/outbox/outboxManager.cjs');

async function reconcileAcceptedOutboxOperations(db, companyId, syncClient) {
  if (typeof syncClient?.getOperationStatuses !== 'function') return 0;
  let reconciledCount = 0;
  let afterRowId = 0;
  // Keyset pagination is essential: the first 100 unaccepted operations must
  // not permanently hide accepted CONFLICT/DEAD_LETTER rows further down.
  while (true) {
    const candidates = listOutboxReconciliationCandidates(db, companyId, 100, afterRowId);
    if (!candidates.length) break;
    afterRowId = candidates[candidates.length - 1].reconciliation_cursor;

    const response = await syncClient.getOperationStatuses(candidates.map(({ operation_id, payload_hash }) => ({
      operationId: operation_id,
      payloadHash: payload_hash
    })));
    if (!Array.isArray(response?.results)) break;
    const results = new Map(response.results.map((result) => [result.operationId, result]));
    db.transaction(() => {
      for (const candidate of candidates) {
        const result = results.get(candidate.operation_id);
        if (result?.status !== 'APPLIED' || result.payloadHash !== candidate.payload_hash) continue;
        const op = db.prepare(`SELECT command_type, entity_type, entity_id, base_revision, causal_sequence FROM local_outbox
          WHERE company_id = ? AND operation_id = ?`).get(companyId, candidate.operation_id);
        if (op?.entity_type === 'ticket' && ['SubmitTicket', 'UpdateTicket', 'DeleteTicket'].includes(op.command_type)
          && Number(result.serverRevision) !== Number(op.base_revision) + 1) continue;
        if (!op || (op.command_type === 'SubmitTicket' && result.periodId &&
          db.prepare('SELECT period_id FROM tickets WHERE company_id = ? AND id = ?').get(companyId, op.entity_id)?.period_id !== result.periodId)) continue;
        if (acknowledgeOutboxOperation(db, companyId, candidate.operation_id, result.payloadHash, result.serverRevision)) {
          reconciledCount++;
          if (op.entity_type === 'ticket' && !db.prepare(`SELECT 1 FROM local_outbox WHERE company_id = ?
            AND entity_type = 'ticket' AND entity_id = ? AND operation_id <> ?
            AND (base_revision > ? OR causal_sequence > ?) LIMIT 1`)
            .get(companyId, op.entity_id, candidate.operation_id, op.base_revision, op.causal_sequence)) {
            if (op.command_type === 'SubmitTicket') db.prepare(`UPDATE tickets SET status = 'CONFIRMED',
              server_revision = MAX(server_revision, ?) WHERE company_id = ? AND id = ?
              AND status = 'PENDING_SYNC'`).run(result.serverRevision, companyId, op.entity_id);
            if (op.command_type === 'UpdateTicket') db.prepare(`UPDATE tickets SET server_revision = MAX(server_revision, ?)
              WHERE company_id = ? AND id = ? AND status = 'CONFIRMED'`)
              .run(result.serverRevision, companyId, op.entity_id);
            if (op.command_type === 'DeleteTicket') db.prepare(`UPDATE tickets SET status = 'VOIDED',
              server_revision = MAX(server_revision, ?) WHERE company_id = ? AND id = ?
              AND status = 'PENDING_DELETE'`).run(result.serverRevision, companyId, op.entity_id);
          }
          if (op.command_type === 'RecordProductionAdjustment' || op.command_type === 'ReverseProductionAdjustment') {
            db.prepare(`UPDATE production_adjustments SET server_revision = MAX(server_revision, ?)
              WHERE company_id = ? AND adjustment_id = ?`).run(result.serverRevision, companyId, op.entity_id);
          }
        }
      }
    }).immediate();
  }
  return reconciledCount;
}

async function performPurgeRebootstrap(db, companyId, syncClient, options = {}) {
  if (typeof syncClient?.getBootstrap !== 'function') {
    throw new Error('SYNC_BOOTSTRAP_UNAVAILABLE');
  }
  const bootstrapResponse = await syncClient.getBootstrap();
  if (options.isContextCurrent && !options.isContextCurrent()) {
    throw new Error('SYNC_CONTEXT_CHANGED');
  }
  const result = reapplyBootstrapAfterHistoricalPurge(db, companyId, bootstrapResponse, options);
  const nextGen = result?.purgeGeneration
    ?? bootstrapResponse?.purgeEra?.purgeGeneration
    ?? bootstrapResponse?.purgeGeneration
    ?? bootstrapResponse?.feedBaseline?.purgeGeneration;
  if (nextGen !== undefined && nextGen !== null && typeof syncClient?.setPurgeGeneration === 'function') {
    syncClient.setPurgeGeneration(nextGen);
  }
  return result;
}

async function executePullOnlyProtocol(db, companyId, syncClient, options = {}) {
  if (typeof syncClient?.pullChanges !== 'function') throw new Error('SYNC_PULL_UNAVAILABLE');
  const maxPages = Number.isSafeInteger(options.maxPages) && options.maxPages > 0 ? options.maxPages : 10;
  let pulledCount = 0;
  let proofChanged = false;
  let pages = 0;
  let hasMore = true;
  let lastPull = { items: [], nextCursor: getLocalCursor(db), hasMore: false };

  try { while (hasMore && pages < maxPages) {
    const currentCursor = getLocalCursor(db);
    try {
      lastPull = await syncClient.pullChanges(currentCursor, 100);
    } catch (pullErr) {
      if (pullErr?.code === 'HISTORY_PURGED_REBOOTSTRAP_REQUIRED') {
        const rebootstrap = await performPurgeRebootstrap(db, companyId, syncClient, options);
        proofChanged = true;
        hasMore = false;
        return {
          success: true,
          pulledCount,
          pages: pages + 1,
          hasMore: false,
          proofChanged: true,
          purgeRebootstrapped: true,
          rebootstrap,
          finalCursor: getLocalCursor(db),
          nextPattaNumber: db.prepare(`SELECT next_patta_number FROM company_patta_sequences WHERE company_id = ?`).get(companyId)?.next_patta_number || 1
        };
      }
      throw pullErr;
    }
    if (options.isContextCurrent && !options.isContextCurrent()) throw new Error('SYNC_CONTEXT_CHANGED');
    const items = Array.isArray(lastPull.items) ? lastPull.items : [];
    const nextCursor = lastPull.nextCursor ?? currentCursor;
    const remoteNextPatta = Number(lastPull.nextPattaNumber);
    const localNextPatta = Number(db.prepare(`SELECT next_patta_number FROM company_patta_sequences WHERE company_id = ?`)
      .get(companyId)?.next_patta_number || 1);
    const cursorChanged = String(nextCursor) !== String(currentCursor);
    const pattaSequenceChanged = Number.isSafeInteger(remoteNextPatta) && remoteNextPatta !== localNextPatta;
    const contactState = db.prepare("SELECT value FROM local_meta WHERE key='feed_contact_state'").get()?.value;
    const proofNeedsCommit = lastPull.feedProtocolVersion === 1
      ? contactState !== 'VERIFIED' : contactState === 'VERIFIED';
    if (items.length > 0 || cursorChanged || pattaSequenceChanged || proofNeedsCommit) {
      const beforeProof = `${contactState || ''}:${String(getLocalCursor(db))}`;
      const applyOptions = { ...(pattaSequenceChanged ? { nextPattaNumber: remoteNextPatta } : {}), feedResponse: lastPull };
      const applyResult = applyChangesBatch(db, companyId, items, nextCursor, applyOptions);
      pulledCount += applyResult.appliedCount;
      const afterProof = `${db.prepare("SELECT value FROM local_meta WHERE key='feed_contact_state'").get()?.value || ''}:${String(getLocalCursor(db))}`;
      if (beforeProof !== afterProof)
        proofChanged = true;
    }
    pages += 1;
    hasMore = lastPull.hasMore === true;
    if (hasMore && items.length === 0) throw new Error('SYNC_PULL_CURSOR_DID_NOT_ADVANCE');
    if (hasMore) await new Promise((resolve) => setImmediate(resolve));
  } } catch (error) { if (!options.isContextCurrent || options.isContextCurrent()) markFeedUnavailable(db); throw error; }

  return {
    success: true,
    pulledCount,
    pages,
    hasMore,
    proofChanged,
    finalCursor: getLocalCursor(db),
    nextPattaNumber: lastPull.nextPattaNumber
  };
}

/**
 * Executes the 4-Phase Pull-First Reconnect Protocol.
 * Phase 2 — Step 4: Authoritative Distributed Synchronization & Leases
 *
 * Protocol Order:
 * 0. RECOVER stranded SENDING operations to PENDING
 * 1. PULL remote authoritative changes
 * 2. Apply/reconcile locally
 * 3. Rebase pending operations if required
 * 4. PUSH pending local outbox
 * 5. Process responses
 * 6. FINAL PULL
 * 7. Rebuild projections
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @param {import('./syncClient.cjs').SyncClient} syncClient
 * @param {object} [options={}]
 * @param {string} [options.baseUserDataPath]
 * @returns {Promise<object>} ReconnectResult
 */
async function executeReconnectProtocol(db, companyId, syncClient, options = {}) {
  let pulledInitial = 0;
  let pulledFinal = 0;
  const initialProofState = `${db.prepare("SELECT value FROM local_meta WHERE key='feed_contact_state'").get()?.value || ''}:${String(getLocalCursor(db))}`;
  let proofChanged = false;

  // ----------------------------------------------------
  // STEP 0: Recover stranded SENDING operations to PENDING
  // ----------------------------------------------------
  const recoveredOps = recoverStrandedSendingOperations(db, companyId);
  const recoveredCount = recoveredOps.length;

  // ----------------------------------------------------
  // STEP 1 & 2: Pull remote authoritative changes & apply
  // ----------------------------------------------------
  let hasMore = true;
  let voidedPattaReuseSupported = false;
  let legacyPattaBatchReplaySupported = false;
  let purgeRebootstrapped = false;
  let rebootstrapStats = null;
  try { while (hasMore) {
    const currentCursor = getLocalCursor(db);
    let pullRes;
    try {
      pullRes = await syncClient.pullChanges(currentCursor, 100);
    } catch (pullErr) {
      if (pullErr?.code === 'HISTORY_PURGED_REBOOTSTRAP_REQUIRED' && !purgeRebootstrapped) {
        rebootstrapStats = await performPurgeRebootstrap(db, companyId, syncClient, options);
        purgeRebootstrapped = true;
        voidedPattaReuseSupported = true;
        hasMore = true;
        continue;
      }
      throw pullErr;
    }
    if (options.isContextCurrent && !options.isContextCurrent()) throw new Error('SYNC_CONTEXT_CHANGED');
    if (pullRes.capabilities?.voidedPattaReuse === true) voidedPattaReuseSupported = true;
    if (pullRes.capabilities?.legacyPattaBatchReplayV1 === true) legacyPattaBatchReplaySupported = true;
    db.prepare(`INSERT INTO local_meta(key, value, updated_at) VALUES('patta_lifecycle_v1', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(pullRes.capabilities?.pattaLifecycleV1 === true ? '1' : '0', new Date().toISOString());

    const pulledItems = Array.isArray(pullRes.items) ? pullRes.items : [];
    if (pulledItems.length > 0) {
      const applyRes = applyChangesBatch(db, companyId, pulledItems, pullRes.nextCursor, {
        nextPattaNumber: pullRes.nextPattaNumber, feedResponse: pullRes
      });
      pulledInitial += applyRes.appliedCount;
    } else {
      applyChangesBatch(db, companyId, pulledItems, pullRes.nextCursor ?? String(currentCursor), {
        nextPattaNumber: pullRes.nextPattaNumber, feedResponse: pullRes
      });
    }

    hasMore = Boolean(pullRes.hasMore);
  } } catch (error) { if (!options.isContextCurrent || options.isContextCurrent()) markFeedUnavailable(db); throw error; }

  // A previous process can lose the HTTP acknowledgement after the server commits.
  // Reconcile BEFORE any retry/supersession so accepted commands are acknowledged,
  // not resent or hidden by local recovery decisions.
  let reconciledCount = 0;
  try {
    reconciledCount = await reconcileAcceptedOutboxOperations(db, companyId, syncClient);
  } catch (error) {
    // Status reconciliation is a recovery aid; the normal idempotent push path still runs.
    options.onOperationStatusReconciliationError?.(error);
  }

  const supersededBatchSettingsCount = supersedeBatchSettingsAlreadyApplied(db, companyId);
  const recoveredVoidedPattaDuplicateCount = voidedPattaReuseSupported
    ? recoverVoidedPattaDuplicateTickets(db, companyId)
    : 0;
  const recoveredPeriodScopeMismatchCount = recoverPeriodScopeMismatchTickets(db, companyId);
  const recoveredCapturedTicketCount = recoverCapturedTicketProvenanceTickets(db, companyId);
  const recoveredLegacyPattaBatchCount = legacyPattaBatchReplaySupported ? recoverLegacyPattaBatches(db, companyId) : 0;
  const deferredPartyArchives = legacyPattaBatchReplaySupported
    ? await require('./deferredPartyArchiveRecovery.cjs').recoverDeferredPartyArchives(db, companyId, syncClient)
    : { queued: 0, retried: 0 };

  // ----------------------------------------------------
  // STEP 3 & 4 & 5: Push pending local outbox operations
  // ----------------------------------------------------
  let pushRes = await dispatchOutbox(db, companyId, syncClient, options);
  if (pushRes.rebootstrapRequired > 0 && !purgeRebootstrapped) {
    rebootstrapStats = await performPurgeRebootstrap(db, companyId, syncClient, options);
    purgeRebootstrapped = true;
    pushRes = await dispatchOutbox(db, companyId, syncClient, options);
  }

  // ----------------------------------------------------
  // STEP 6: Final pull of any interleaved changes
  // ----------------------------------------------------
  const finalCursor = getLocalCursor(db);
  let finalPullRes;
  try {
    finalPullRes = await syncClient.pullChanges(finalCursor, 100);
    if (options.isContextCurrent && !options.isContextCurrent()) throw new Error('SYNC_CONTEXT_CHANGED');
  } catch (error) {
    if (error?.code === 'HISTORY_PURGED_REBOOTSTRAP_REQUIRED' && !purgeRebootstrapped) {
      rebootstrapStats = await performPurgeRebootstrap(db, companyId, syncClient, options);
      purgeRebootstrapped = true;
      finalPullRes = await syncClient.pullChanges(getLocalCursor(db), 100);
      if (options.isContextCurrent && !options.isContextCurrent()) throw new Error('SYNC_CONTEXT_CHANGED');
    } else {
      if (!options.isContextCurrent || options.isContextCurrent()) markFeedUnavailable(db);
      throw error;
    }
  }
  const finalItems = Array.isArray(finalPullRes.items) ? finalPullRes.items : [];
  let applyRes;
  try { applyRes = applyChangesBatch(db, companyId, finalItems, finalPullRes.nextCursor, {
    nextPattaNumber: finalPullRes.nextPattaNumber, feedResponse: finalPullRes
  }); } catch (error) { markFeedUnavailable(db); throw error; }
  await require('./lifecycleArchiveReconcile.cjs').reconcileLifecycleArchives(db, companyId, syncClient);
  const finalProofState = `${db.prepare("SELECT value FROM local_meta WHERE key='feed_contact_state'").get()?.value || ''}:${String(getLocalCursor(db))}`;
  proofChanged = initialProofState !== finalProofState;
  pulledFinal += applyRes.appliedCount;

  // ----------------------------------------------------
  // STEP 7: Deterministic projection rebuild
  // ----------------------------------------------------
  let projections = null;
  if (options.baseUserDataPath) {
    projections = rebuildCompanyProjections(options.baseUserDataPath, companyId);
  }

  return {
    success: true,
    recoveredCount,
    pulledInitial,
    supersededBatchSettingsCount,
    recoveredVoidedPattaDuplicateCount,
    recoveredPeriodScopeMismatchCount,
    recoveredCapturedTicketCount,
    recoveredLegacyPattaBatchCount,
    deferredPartyArchives,
    reconciledCount,
    pushed: pushRes,
    pulledFinal,
    proofChanged,
    finalCursor: getLocalCursor(db),
    purgeRebootstrapped,
    ...(rebootstrapStats ? { rebootstrap: rebootstrapStats } : {}),
    projections
  };
}

module.exports = {
  reconcileAcceptedOutboxOperations,
  executePullOnlyProtocol,
  executeReconnectProtocol
};
