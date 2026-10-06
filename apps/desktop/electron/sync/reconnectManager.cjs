'use strict';

const { getLocalCursor, applyChangesBatch } = require('./changeFeedApplier.cjs');
const { dispatchOutbox } = require('./outboxDispatcher.cjs');
const { rebuildCompanyProjections } = require('../database/projectionReader.cjs');
const {
  acknowledgeOutboxOperation,
  listOutboxReconciliationCandidates,
  recoverStrandedSendingOperations
} = require('../database/outboxManager.cjs');

async function reconcileAcceptedOutboxOperations(db, companyId, syncClient) {
  if (typeof syncClient?.getOperationStatuses !== 'function') return 0;
  const candidates = listOutboxReconciliationCandidates(db, companyId, 100);
  if (!candidates.length) return 0;

  const response = await syncClient.getOperationStatuses(candidates.map(({ operation_id, payload_hash }) => ({
    operationId: operation_id,
    payloadHash: payload_hash
  })));
  if (!Array.isArray(response?.results)) return 0;
  const results = new Map(response.results.map((result) => [result.operationId, result]));
  let reconciledCount = 0;
  db.transaction(() => {
    for (const candidate of candidates) {
      const result = results.get(candidate.operation_id);
      if (result?.status !== 'APPLIED' || result.payloadHash !== candidate.payload_hash) continue;
      if (acknowledgeOutboxOperation(db, companyId, candidate.operation_id, result.payloadHash)) reconciledCount++;
    }
  }).immediate();
  return reconciledCount;
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

  // ----------------------------------------------------
  // STEP 0: Recover stranded SENDING operations to PENDING
  // ----------------------------------------------------
  const recoveredOps = recoverStrandedSendingOperations(db, companyId);
  const recoveredCount = recoveredOps.length;

  // ----------------------------------------------------
  // STEP 1 & 2: Pull remote authoritative changes & apply
  // ----------------------------------------------------
  let hasMore = true;
  while (hasMore) {
    const currentCursor = getLocalCursor(db);
    const pullRes = await syncClient.pullChanges(currentCursor, 100);

    if (pullRes.items && pullRes.items.length > 0) {
      const applyRes = applyChangesBatch(db, companyId, pullRes.items, pullRes.nextCursor, {
        nextPattaNumber: pullRes.nextPattaNumber
      });
      pulledInitial += applyRes.appliedCount;
    } else {
      applyChangesBatch(db, companyId, [], pullRes.nextCursor ?? String(currentCursor), {
        nextPattaNumber: pullRes.nextPattaNumber
      });
    }

    hasMore = Boolean(pullRes.hasMore);
  }

  // A previous process can lose the HTTP acknowledgement after the server commits.
  // Reconcile those exact operation IDs before local causal dependencies are evaluated.
  let reconciledCount = 0;
  try {
    reconciledCount = await reconcileAcceptedOutboxOperations(db, companyId, syncClient);
  } catch (error) {
    // Status reconciliation is a recovery aid; the normal idempotent push path still runs.
    options.onOperationStatusReconciliationError?.(error);
  }

  // ----------------------------------------------------
  // STEP 3 & 4 & 5: Push pending local outbox operations
  // ----------------------------------------------------
  const pushRes = await dispatchOutbox(db, companyId, syncClient, options);

  // ----------------------------------------------------
  // STEP 6: Final pull of any interleaved changes
  // ----------------------------------------------------
  const finalCursor = getLocalCursor(db);
  const finalPullRes = await syncClient.pullChanges(finalCursor, 100);
  const finalItems = Array.isArray(finalPullRes.items) ? finalPullRes.items : [];
  const applyRes = applyChangesBatch(db, companyId, finalItems, finalPullRes.nextCursor, {
    nextPattaNumber: finalPullRes.nextPattaNumber
  });
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
    reconciledCount,
    pushed: pushRes,
    pulledFinal,
    finalCursor: getLocalCursor(db),
    projections
  };
}

module.exports = {
  reconcileAcceptedOutboxOperations,
  executeReconnectProtocol
};
