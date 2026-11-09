'use strict';
const { cursor, verifyPage, recordAppliedHead, markFeedUnavailable } = require('./feedEvidence.cjs');
const { acknowledgeOutboxOperation } = require('../database/outboxManager.cjs');

/**
 * Applies remote change feed items to local SQLite database.
 * Phase 2 — Step 4: Authoritative Distributed Synchronization & Leases
 *
 * Enforces:
 * - Idempotency: Applying the same change twice produces 0 duplicate facts.
 * - Atomicity: Facts update and local sync cursor advance in ONE local transaction.
 * - Fail-closed cursor advance: If transaction aborts, cursor NEVER advances.
 */

function getLocalCursor(db) {
  const row = db.prepare(`SELECT value FROM local_meta WHERE key = 'sync_cursor'`).get();
  if (!row || !row.value) return 0;
  if (!/^\d+$/.test(String(row.value))) return 0;
  try {
    const parsed = BigInt(row.value);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed.toString();
  } catch {
    return 0;
  }
}

function setLocalCursor(db, cursor) {
  const existing = db.prepare("SELECT value FROM local_meta WHERE key='sync_cursor'").get();
  if (existing && String(getLocalCursor(db)) === String(cursor)) return;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO local_meta (key, value, updated_at)
    VALUES ('sync_cursor', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(String(cursor), now);
}

function resolveEntityAlias(db, table, legacyColumn, canonicalColumn, companyId, value) {
  if (value === null || value === undefined) return value;
  const alias = db.prepare(`SELECT "${canonicalColumn}" AS canonical_id FROM "${table}"
    WHERE company_id = ? AND "${legacyColumn}" = ?`).get(companyId, String(value));
  return alias?.canonical_id || value;
}

function advancePattaSequence(db, companyId, pattaEndNumber) {
  const end = Number(pattaEndNumber);
  if (!Number.isSafeInteger(end) || end < 1) return;
  db.prepare(`INSERT INTO company_patta_sequences(company_id, next_patta_number, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(company_id) DO UPDATE SET
      next_patta_number = MAX(company_patta_sequences.next_patta_number, excluded.next_patta_number),
      updated_at = excluded.updated_at`).run(companyId, end + 1, new Date().toISOString());
}

function resetPattaSequence(db, companyId, nextPattaNumber) {
  if (!Number.isSafeInteger(nextPattaNumber) || nextPattaNumber < 1) {
    throw new Error('REMOTE_PARTY_SERIES_SEQUENCE_INVALID');
  }
  if (db.prepare('SELECT next_patta_number FROM company_patta_sequences WHERE company_id=?')
    .get(companyId)?.next_patta_number === nextPattaNumber) return;
  db.prepare(`INSERT INTO company_patta_sequences(company_id, next_patta_number, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(company_id) DO UPDATE SET
      next_patta_number = excluded.next_patta_number,
      updated_at = excluded.updated_at`).run(companyId, nextPattaNumber, new Date().toISOString());
}

/**
 * Applies a batch of pulled changes to local SQLite transactionally.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @param {Array<object>} items
 * @param {string|number} nextCursor
 * @param {object} [options={}]
 * @param {() => void} [options.testHookBeforeCommit]
 * @param {number} [options.nextPattaNumber]
 * @returns {object} { appliedCount, nextCursor }
 */
function applyChangesBatch(db, companyId, items, nextCursor, options = {}) {
  const proof = options.feedResponse === undefined ? null
    : verifyPage(options.feedResponse, companyId, getLocalCursor(db));
  if (proof && (items !== options.feedResponse.items || String(nextCursor) !== String(options.feedResponse.nextCursor)))
    throw new Error('FEED_PROOF_INVALID');
  if (proof && cursor(nextCursor) !== null && cursor(nextCursor) < cursor(getLocalCursor(db)))
    throw new Error('FEED_PROOF_INVALID');
  if (!Array.isArray(items) || items.length === 0) {
    db.transaction(() => {
      if (options.nextPattaNumber !== undefined) {
        resetPattaSequence(db, companyId, Number(options.nextPattaNumber));
      }
      if (nextCursor !== undefined && nextCursor !== null) setLocalCursor(db, nextCursor);
      if (proof?.terminal) recordAppliedHead(db, companyId, proof.head);
      else markFeedUnavailable(db);
    }).immediate();
    return { appliedCount: 0, nextCursor: getLocalCursor(db) };
  }

  let appliedCount = 0;

  db.transaction(() => {
    for (const item of items) {
      const { entityType, changeType } = item;
      if (!item.payload) continue;
      let entityId = item.entityId;
      const payload = { ...item.payload };
      if (entityType === 'model' || payload.modelId) {
        entityId = resolveEntityAlias(db, 'model_id_aliases', 'legacy_model_id', 'canonical_model_id', companyId, entityId);
        if (payload.modelId) payload.modelId = resolveEntityAlias(db, 'model_id_aliases', 'legacy_model_id', 'canonical_model_id', companyId, payload.modelId);
      }
      if (Array.isArray(payload.configs)) {
        payload.configs = payload.configs.map((config) => ({
          ...config,
          ...(config.modelId ? { modelId: resolveEntityAlias(db, 'model_id_aliases', 'legacy_model_id', 'canonical_model_id', companyId, config.modelId) } : {})
        }));
      }
      if (entityType === 'party' || payload.partyRecordId) {
        entityId = resolveEntityAlias(db, 'party_id_aliases', 'legacy_party_id', 'canonical_party_id', companyId, entityId);
        if (payload.partyRecordId) payload.partyRecordId = resolveEntityAlias(db, 'party_id_aliases', 'legacy_party_id', 'canonical_party_id', companyId, payload.partyRecordId);
      }

      if (entityType === 'ticket') {
        applyTicketChange(db, companyId, entityId, changeType, payload, item.entityRevision);
        appliedCount++;
      } else if (entityType === 'production_adjustment') {
        applyAdjustmentChange(db, companyId, entityId, changeType, payload, item.entityRevision, item.committedAt);
        appliedCount++;
      } else if (entityType === 'model') {
        applyModelChange(db, companyId, entityId, changeType, payload, item.entityRevision);
        appliedCount++;
      } else if (entityType === 'worker') {
        applyWorkerChange(db, companyId, entityId, changeType, payload, item.entityRevision,
          item.operationId, item.changeId);
        appliedCount++;
      } else if (entityType === 'period') {
        applyPeriodChange(db, companyId, entityId, changeType, payload, item.entityRevision);
        appliedCount++;
      } else if (entityType === 'party') {
        applyPartyChange(db, companyId, entityId, changeType, payload, item.entityRevision);
        appliedCount++;
      } else if (entityType === 'batch_settings') {
        applyBatchSettingsChange(db, companyId, payload, item.entityRevision);
        appliedCount++;
      } else if (entityType === 'party_series') {
        if (payload.pattaSequenceReset === true) {
          resetPattaSequence(db, companyId, Number(payload.nextPattaNumber));
        }
        appliedCount++;
      } else if (entityType === 'patta_batch' || entityType === 'period_archive' || entityType === 'party_history') {
        // The typed fact events for these aggregates carry their row-level changes.
        appliedCount++;
      }
    }

    if (options.nextPattaNumber !== undefined) {
      resetPattaSequence(db, companyId, Number(options.nextPattaNumber));
    }

    // Advance cursor inside the same commit boundary
    if (nextCursor !== undefined && nextCursor !== null) {
      setLocalCursor(db, nextCursor);
    }
    if (proof?.terminal) recordAppliedHead(db, companyId, proof.head);
    else markFeedUnavailable(db);

    // Test failure hook for crash/rollback atomicity testing
    if (typeof options.testHookBeforeCommit === 'function') {
      options.testHookBeforeCommit();
    }
  })();

  return {
    appliedCount,
    nextCursor: getLocalCursor(db)
  };
}

function applyTicketChange(db, companyId, ticketId, changeType, payload, entityRevision = 1) {
  const existing = db.prepare('SELECT id, status, period_id, server_revision FROM tickets WHERE company_id = ? AND id = ?').get(companyId, ticketId);

  if (existing) {
    // A replay must not overwrite a newer local edit/delete or resurrect a void.
    if (existing.status === 'VOIDED' || Number(existing.server_revision) > Number(entityRevision)) return;
    const pending = db.prepare(`SELECT 1 FROM local_outbox WHERE company_id = ? AND entity_type = 'ticket'
      AND entity_id = ? AND command_type IN ('UpdateTicket','DeleteTicket')
      AND status IN ('PENDING','SENDING')
      AND base_revision >= ? LIMIT 1`)
      .get(companyId, ticketId, Number(entityRevision));
    if (pending) return;
    if (changeType === 'UPDATE') {
      if (payload.periodId !== undefined && existing.period_id && existing.period_id !== (payload.periodId || null)) {
        db.prepare(`UPDATE tickets SET status = 'CONFLICT', server_revision = MAX(server_revision, ?)
          WHERE company_id = ? AND id = ?`).run(entityRevision, companyId, ticketId);
        return;
      }
      const assignments = [];
      const values = [];
      if (payload.isClosed !== undefined) {
        assignments.push('is_closed = ?');
        values.push(payload.isClosed ? 1 : 0);
      }
      if (payload.status !== undefined) {
        assignments.push('status = ?');
        values.push(payload.status);
      }
      if (payload.periodId !== undefined) {
        assignments.push('period_id = COALESCE(period_id, ?)');
        values.push(payload.periodId || null);
      }
      if (Number.isSafeInteger(entityRevision)) {
        assignments.push('server_revision = MAX(server_revision, ?)');
        values.push(entityRevision);
      }
      if (assignments.length) {
        db.prepare(`UPDATE tickets SET ${assignments.join(', ')} WHERE company_id = ? AND id = ?`)
          .run(...values, companyId, ticketId);
      }
      if (Array.isArray(payload.entries)) {
        db.prepare('DELETE FROM ticket_entries WHERE company_id = ? AND ticket_id = ?').run(companyId, ticketId);
        const insertEntry = db.prepare(`INSERT INTO ticket_entries (
          id, ticket_id, company_id, op_name, worker_id, worker_name_snapshot,
          rate_snapshot, brak, qty, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const now = new Date().toISOString();
        payload.entries.forEach((entry, index) => {
          insertEntry.run(
            entry.entryId || `${ticketId}_entry_${index + 1}`,
            ticketId,
            companyId,
            entry.opName,
            entry.workerId,
            entry.workerNameSnapshot || null,
            entry.rateSnapshot ?? null,
            entry.brak || null,
            entry.qty,
            entry.createdAt || now
          );
        });
      }
      return;
    }
    // If ticket exists locally, ensure ACK and server-owned fields are applied.
    if (existing.period_id && existing.period_id !== (payload.periodId || null)) {
      db.prepare(`UPDATE tickets SET status = 'CONFLICT', server_revision = MAX(server_revision, ?)
        WHERE company_id = ? AND id = ?`).run(entityRevision, companyId, ticketId);
      return;
    }
    db.prepare(`
      UPDATE tickets
      SET status = COALESCE(?, 'CONFIRMED'), period_id = COALESCE(period_id, ?), server_revision = MAX(server_revision, ?)
      WHERE company_id = ? AND id = ?
    `).run(payload.status || null, payload.periodId || null, entityRevision, companyId, ticketId);
    return; // Idempotent: do not duplicate
  }

  const {
    modelId,
    periodId,
    partyNumber,
    partyRecordId,
    pattaNumber,
    qty,
    size,
    color,
    konveyer,
    submittedAt,
    entries
  } = payload;

  const now = submittedAt || new Date().toISOString();

  // Insert ticket fact as CONFIRMED
  db.prepare(`
    INSERT INTO tickets (
      id, company_id, model_id, period_id, party_number, party_record_id, patta_number,
      qty, size, color, konveyer, status, is_closed, submitted_at, created_at, provenance, server_revision
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, 'CONFIRMED', 0, ?, ?, 'REMOTE_SYNC', ?
    )
  `).run(
    ticketId,
    companyId,
    modelId,
    periodId || null,
    partyNumber,
    partyRecordId || null,
    pattaNumber,
    qty,
    size || null,
    color || null,
    konveyer || null,
    now,
    now,
    Number.isSafeInteger(entityRevision) ? entityRevision : 1
  );

  // Insert ticket entries
  if (Array.isArray(entries)) {
    const entryStmt = db.prepare(`
      INSERT OR IGNORE INTO ticket_entries (
        id, ticket_id, company_id, op_name, worker_id, worker_name_snapshot,
        rate_snapshot, brak, qty, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const entryId = `${ticketId}_entry_${i + 1}`;
      entryStmt.run(
        entryId,
        ticketId,
        companyId,
        e.opName,
        e.workerId,
        e.workerNameSnapshot || null,
        e.rateSnapshot !== undefined ? e.rateSnapshot : null,
        e.brak || null,
        qty,
        now
      );
    }
  }
}

function applyAdjustmentChange(db, companyId, adjustmentId, changeType, payload, entityRevision = 1, committedAt) {
  // Older servers logged the reversal command, not a complete adjustment fact.
  const reversalId = payload.reversalId || payload.adjustmentId || payload.reversalAdjustmentId;
  const isLegacyReversal = payload.originalAdjustmentId && reversalId &&
    (changeType === 'UPDATE' ? payload.originalAdjustmentId === adjustmentId : reversalId === adjustmentId);
  const status = payload.status === undefined
    ? (isLegacyReversal ? 'REVERSED' : changeType === 'INSERT' ? 'APPROVED' : undefined)
    : payload.status;
  if (!['APPROVED', 'PENDING_REVIEW', 'REVERSED'].includes(status)) {
    throw new Error('INVALID_PRODUCTION_ADJUSTMENT_STATUS');
  }
  const revision = Number(entityRevision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('INVALID_PRODUCTION_ADJUSTMENT_REVISION');
  const existing = db.prepare('SELECT server_revision, original_ticket_id, original_entry_id, original_period_id, original_rate_snapshot, attribution_status FROM production_adjustments WHERE company_id = ? AND adjustment_id = ?')
    .get(companyId, adjustmentId);
  // Equal revisions can be locally-created optimistic facts (default revision 1).
  if (existing && Number(existing.server_revision) > revision) return;
  if (existing) {
    const legacyOriginalUpdate = changeType === 'UPDATE' && isLegacyReversal;
    db.prepare(`UPDATE production_adjustments SET status = ?, server_revision = ?, created_at = COALESCE(?, created_at),
      created_by = COALESCE(?, created_by),
      original_ticket_id = ?, original_entry_id = ?, original_period_id = ?,
      original_rate_snapshot = ?, attribution_status = ?
      WHERE company_id = ? AND adjustment_id = ?`)
       .run(status, revision, legacyOriginalUpdate ? null : payload.createdAt || null,
         legacyOriginalUpdate ? null : payload.createdBy || null,
         payload.attributionStatus === undefined ? existing.original_ticket_id : payload.originalTicketId ?? null,
         payload.attributionStatus === undefined ? existing.original_entry_id : payload.originalEntryId ?? null,
         payload.attributionStatus === undefined ? existing.original_period_id : payload.originalPeriodId ?? null,
         payload.attributionStatus === undefined ? existing.original_rate_snapshot : payload.originalRateSnapshot ?? null,
         payload.attributionStatus === undefined ? existing.attribution_status : payload.attributionStatus,
         companyId, adjustmentId);
  } else if (changeType === 'INSERT') {
    const original = isLegacyReversal ? db.prepare(`SELECT model_id, worker_id, op_name, delta_qty,
        original_ticket_id, original_entry_id, original_period_id, original_rate_snapshot, attribution_status
      FROM production_adjustments WHERE company_id = ? AND adjustment_id = ?`).get(companyId, payload.originalAdjustmentId) : null;
    const { reason, createdBy, originalAdjustmentId } = payload;
    const modelId = payload.modelId ?? original?.model_id;
    const workerId = payload.workerId ?? original?.worker_id;
    const opName = payload.opName ?? original?.op_name;
    const deltaQty = payload.deltaQty ?? (original ? -Number(original.delta_qty) : undefined);

    db.prepare(`
      INSERT INTO production_adjustments (
        adjustment_id, company_id, model_id, worker_id, op_name,
         delta_qty, reason, status, server_revision, provenance, created_at, created_by, original_adjustment_id,
         original_ticket_id, original_entry_id, original_period_id, original_rate_snapshot, attribution_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'REMOTE_SYNC', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      adjustmentId,
      companyId,
      modelId,
      workerId,
      opName,
      deltaQty,
      reason || 'REMOTE_SYNC',
      status,
      revision,
      payload.createdAt || committedAt || new Date().toISOString(),
      createdBy || 'REMOTE',
       originalAdjustmentId || null,
       payload.originalTicketId ?? original?.original_ticket_id ?? null,
       payload.originalEntryId ?? original?.original_entry_id ?? null,
       payload.originalPeriodId ?? original?.original_period_id ?? null,
       payload.originalRateSnapshot ?? original?.original_rate_snapshot ?? null,
       payload.attributionStatus || original?.attribution_status || 'UNRESOLVED'
    );
  }
}

function applyModelChange(db, companyId, entityId, changeType, payload, entityRevision = 1) {
  const modelId = String(payload.modelId || payload.id || entityId);
  const current = db.prepare('SELECT company_id, server_revision FROM models WHERE id = ?').get(modelId);
  if (current && current.company_id !== companyId) throw new Error('CROSS_COMPANY_MODEL_CHANGE_REJECTED');
  if (current && Number(current.server_revision || 0) >= Number(entityRevision || 0)) return;
  const status = payload.status || 'ACTIVE';
  if (status !== 'ACTIVE') {
    if (!current) return;
    db.prepare('UPDATE models SET status = ?, server_revision = ?, updated_at = ? WHERE company_id = ? AND id = ?')
      .run(status, entityRevision, payload.updatedAt || new Date().toISOString(), companyId, modelId);
    db.prepare('DELETE FROM local_ticket_forms WHERE company_id = ? AND model_id = ?').run(companyId, modelId);
    return;
  }
  if (typeof payload.name !== 'string' || !Array.isArray(payload.operations)) {
    throw new Error('REMOTE_MODEL_CHANGE_INVALID');
  }
  const now = payload.updatedAt || new Date().toISOString();
  const values = [
    companyId,
    payload.name,
    payload.hisobSheetName || `${payload.name}-hisob`,
    payload.title || `Model- ${payload.name}`,
    payload.party || '',
    payload.color || '',
    payload.size || '',
    JSON.stringify(payload.operations),
    JSON.stringify(payload.pattaOpsOrder || []),
    now,
    entityRevision,
    modelId
  ];
  if (current) {
    db.prepare(`UPDATE models SET name = ?, hisob_sheet_name = ?, title = ?, party = ?, color = ?, size = ?,
      operations_json = ?, patta_ops_order_json = ?, status = 'ACTIVE', updated_at = ?, server_revision = ?
      WHERE company_id = ? AND id = ?`).run(
      payload.name, payload.hisobSheetName || `${payload.name}-hisob`, payload.title || `Model- ${payload.name}`,
      payload.party || '', payload.color || '', payload.size || '', JSON.stringify(payload.operations),
      JSON.stringify(payload.pattaOpsOrder || []), now, entityRevision, companyId, modelId
    );
  } else {
    db.prepare(`INSERT INTO models (
      id, company_id, name, hisob_sheet_name, title, party, color, size, operations_json,
      patta_ops_order_json, legacy_hisob_quantities_json, created_at, updated_at, provenance, status, server_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, 'REMOTE_SYNC', 'ACTIVE', ?)`)
      .run(modelId, ...values.slice(0, 9), now, now, entityRevision);
    db.prepare('INSERT OR IGNORE INTO patta_batch_settings (company_id, model_id) VALUES (?, ?)').run(companyId, modelId);
  }
  for (const rename of payload.operationRenames || []) {
    db.prepare(`UPDATE ticket_entries SET op_name = ? WHERE company_id = ? AND op_name = ?
      AND ticket_id IN (SELECT id FROM tickets WHERE company_id = ? AND model_id = ?)`)
      .run(rename.toName, companyId, rename.fromName, companyId, modelId);
    db.prepare(`UPDATE production_adjustments SET op_name = ? WHERE company_id = ? AND model_id = ? AND op_name = ?`)
      .run(rename.toName, companyId, modelId, rename.fromName);
  }
}

function applyWorkerChange(db, companyId, entityId, changeType, payload, entityRevision = 1, operationId, changeId) {
  const workerId = Number(payload.id ?? payload.workerId ?? entityId);
  if (!Number.isSafeInteger(workerId) || workerId <= 0) throw new Error('REMOTE_WORKER_CHANGE_INVALID');
  const current = db.prepare('SELECT company_id, server_revision FROM workers WHERE id = ?').get(workerId);
  if (current && current.company_id !== companyId) throw new Error('CROSS_COMPANY_WORKER_CHANGE_REJECTED');
  const staleRevision = current && Number(current.server_revision || 0) >= Number(entityRevision || 0);
  if (staleRevision) {
    applyWorkerBalanceFacts(db, companyId, workerId, payload.balanceAdjustments || [], undefined,
      operationId, entityRevision, changeId);
    return;
  }
  const status = payload.status || 'ACTIVE';
  if (status !== 'ACTIVE') {
    if (!current) return;
    db.prepare('UPDATE workers SET status = ?, server_revision = ?, updated_at = ? WHERE company_id = ? AND id = ?')
      .run(status, entityRevision, payload.updatedAt || new Date().toISOString(), companyId, workerId);
    return;
  }
  if (typeof payload.name !== 'string') throw new Error('REMOTE_WORKER_CHANGE_INVALID');
  const now = payload.updatedAt || new Date().toISOString();
  if (current) {
    db.prepare(`UPDATE workers SET name = ?, staj = ?, role = ?, status = 'ACTIVE', server_revision = ?, updated_at = ?
      WHERE company_id = ? AND id = ?`).run(payload.name, Number(payload.staj || 0), payload.role || null, entityRevision, now, companyId, workerId);
  } else {
    db.prepare(`INSERT INTO workers (
      id, company_id, name, staj, role, status, legacy_avans, legacy_jarima,
      created_at, updated_at, provenance, server_revision
    ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', 0, 0, ?, ?, 'REMOTE_SYNC', ?)`)
      .run(workerId, companyId, payload.name, Number(payload.staj || 0), payload.role || null, now, now, entityRevision);
  }
  applyWorkerBalanceFacts(db, companyId, workerId, payload.balanceAdjustments || [], now,
    operationId, entityRevision, changeId);
}

function applyWorkerBalanceFacts(db, companyId, workerId, adjustments, committedAt = new Date().toISOString(),
  operationId, entityRevision, changeId) {
  if (!Array.isArray(adjustments)) throw new Error('REMOTE_WORKER_ADJUSTMENTS_INVALID');
  const ids = new Set(); const types = new Set();
  for (const adjustment of adjustments) {
    if (!adjustment || typeof adjustment !== 'object' || Array.isArray(adjustment)
      || typeof adjustment.adjustmentId !== 'string' || !adjustment.adjustmentId.trim()
      || !['AVANS', 'JARIMA', 'OKLAD', 'MAGAZIN'].includes(adjustment.type)
      || typeof adjustment.amountDelta !== 'number' || !Number.isFinite(adjustment.amountDelta)
      || adjustment.amountDelta === 0 || ids.has(adjustment.adjustmentId) || types.has(adjustment.type)) {
      throw new Error('REMOTE_WORKER_ADJUSTMENTS_INVALID');
    }
    if (['OKLAD', 'MAGAZIN'].includes(adjustment.type)
      && (!Number.isSafeInteger(adjustment.amountDelta) || typeof adjustment.periodId !== 'string' || !adjustment.periodId.trim())) {
      throw new Error('REMOTE_WORKER_ADJUSTMENTS_INVALID');
    }
    if (adjustment.periodId != null) {
      const period = db.prepare('SELECT id FROM periods WHERE company_id = ? AND id = ?').get(companyId, adjustment.periodId);
      if (!period) throw new Error('CROSS_COMPANY_WORKER_ADJUSTMENT_PERIOD_REJECTED');
    }
    ids.add(adjustment.adjustmentId); types.add(adjustment.type);
  }
  const find = db.prepare(`SELECT company_id, worker_id, period_id, type, amount FROM worker_adjustments WHERE id = ?`);
  const insert = db.prepare(`INSERT INTO worker_adjustments (
    id, company_id, worker_id, period_id, type, amount, description, provenance, status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'REMOTE_SYNC', 'POSTED', ?)`);
  for (const adjustment of adjustments) {
    const existing = find.get(adjustment.adjustmentId);
    if (existing) {
      if (existing.company_id !== companyId || Number(existing.worker_id) !== Number(workerId)
        || existing.period_id !== (adjustment.periodId || null) || existing.type !== adjustment.type
        || Number(existing.amount) !== Number(adjustment.amountDelta)) {
        throw new Error('WORKER_ADJUSTMENT_ID_CONFLICT');
      }
      continue;
    }
    insert.run(adjustment.adjustmentId, companyId, workerId, adjustment.periodId || null, adjustment.type,
      adjustment.amountDelta, adjustment.description || null, committedAt);
  }
  if (operationId && adjustments.length && Number.isSafeInteger(Number(entityRevision))
    && Number(entityRevision) > 0 && cursor(changeId) !== null) {
    const op = db.prepare(`SELECT payload_json,payload_hash FROM local_outbox WHERE company_id=?
      AND operation_id=? AND entity_type='worker' AND entity_id=? AND command_type='UpsertWorker'`)
      .get(companyId, operationId, String(workerId));
    if (op) {
      let payload;
      try { payload = JSON.parse(op.payload_json); } catch { payload = null; }
      const local = Array.isArray(payload?.balanceAdjustments) ? payload.balanceAdjustments : [];
      const remoteById = new Map(adjustments.map((item) => [item.adjustmentId, item]));
      const exactFacts = Number(payload?.workerId) === Number(workerId) && local.length === adjustments.length
        && local.every((item) => {
          const remote = remoteById.get(item.adjustmentId);
          return remote && item.type === remote.type && Number(item.amountDelta) === Number(remote.amountDelta)
            && (item.periodId || null) === (remote.periodId || null);
        });
      if (exactFacts) acknowledgeOutboxOperation(db, companyId, operationId, op.payload_hash,
        Number(entityRevision), String(cursor(changeId)));
    }
  }
}

function applyPeriodChange(db, companyId, entityId, changeType, payload, entityRevision = 1) {
  const periodId = String(payload.periodId || payload.id || entityId);
  const current = db.prepare('SELECT company_id, server_revision FROM periods WHERE id = ?').get(periodId);
  if (current && current.company_id !== companyId) throw new Error('CROSS_COMPANY_PERIOD_CHANGE_REJECTED');
  if (current && Number(current.server_revision || 0) >= Number(entityRevision || 0)) return;
  if (typeof payload.name !== 'string' || typeof payload.startDate !== 'string') {
    if (payload.status === 'CLOSED' && current) {
      db.prepare(`UPDATE periods SET end_date = ?, is_closed = 1, closed_at = ?, archive_filename = COALESCE(?, archive_filename),
        status = 'CLOSED', server_revision = ?, updated_at = ? WHERE company_id = ? AND id = ?`).run(
        payload.endDate || null, payload.closedAt || new Date().toISOString(), payload.archiveFilename || null,
        entityRevision, payload.closedAt || new Date().toISOString(), companyId, periodId
      );
      if (payload.nextPeriod?.id) {
        applyPeriodChange(db, companyId, payload.nextPeriod.id, 'INSERT', {
          ...payload.nextPeriod, periodId: payload.nextPeriod.id, isClosed: false
        }, 1);
      }
      return;
    }
    if (!current) throw new Error('REMOTE_PERIOD_CHANGE_INVALID');
    return;
  }
  const isClosed = Boolean(payload.isClosed || payload.status === 'CLOSED');
  const now = payload.updatedAt || payload.closedAt || new Date().toISOString();
  if (current) {
    db.prepare(`UPDATE periods SET name = ?, start_date = ?, end_date = ?, is_closed = ?, closed_at = ?, notes = ?,
      archive_filename = ?, status = ?, server_revision = ?, updated_at = ? WHERE company_id = ? AND id = ?`)
      .run(payload.name, payload.startDate, payload.endDate || null, isClosed ? 1 : 0, payload.closedAt || null,
        payload.notes || null, payload.archiveFilename || null, isClosed ? 'CLOSED' : 'OPEN', entityRevision, now, companyId, periodId);
  } else {
    db.prepare(`INSERT INTO periods (
      id, company_id, name, start_date, end_date, is_closed, closed_at, notes, archive_filename,
      status, created_at, updated_at, server_revision, provenance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REMOTE_SYNC')`)
      .run(periodId, companyId, payload.name, payload.startDate, payload.endDate || null, isClosed ? 1 : 0,
        payload.closedAt || null, payload.notes || null, payload.archiveFilename || null,
        isClosed ? 'CLOSED' : 'OPEN', now, now, entityRevision);
  }
}

function applyPartyChange(db, companyId, entityId, changeType, payload, entityRevision = 1) {
  const partyId = String(payload.partyRecordId || payload.id || entityId);
  const current = db.prepare(`SELECT company_id, server_revision, status, is_closed, closed_at, size_order_json,
    archived_patta_numbers_json, is_archived FROM parties WHERE id = ?`).get(partyId);
  if (current && current.company_id !== companyId) throw new Error('CROSS_COMPANY_PARTY_CHANGE_REJECTED');
  if (current && Number(current.server_revision || 0) >= Number(entityRevision || 0)) return;
  const now = payload.updatedAt || payload.closedAt || new Date().toISOString();
  const hasFullPartyPayload = typeof payload.partyNumber === 'string' && typeof payload.modelId === 'string';
  if (!hasFullPartyPayload && payload.isArchived === true) {
    if (current) {
      db.prepare(`UPDATE parties SET status = 'CLOSED', is_closed = 1, is_archived = 1, closed_at = ?,
        server_revision = ?, updated_at = ? WHERE company_id = ? AND id = ?`)
        .run(payload.closedAt || now, entityRevision, now, companyId, partyId);
    }
    return;
  }
  if (!hasFullPartyPayload && (payload.status === 'CLOSED' || payload.isClosed === true)) {
    if (!current) return;
    db.prepare(`UPDATE parties SET status = 'CLOSED', is_closed = 1, closed_at = ?, server_revision = ?, updated_at = ?
      WHERE company_id = ? AND id = ?`).run(payload.closedAt || now, entityRevision, now, companyId, partyId);
    return;
  }
  if (!hasFullPartyPayload && Array.isArray(payload.archivedPattaNumbers)) {
    if (current) db.prepare(`UPDATE parties SET archived_patta_numbers_json = ?, server_revision = ?, updated_at = ? WHERE company_id = ? AND id = ?`)
      .run(JSON.stringify(payload.archivedPattaNumbers), entityRevision, now, companyId, partyId);
    return;
  }
  if (!hasFullPartyPayload && current && (
    Object.prototype.hasOwnProperty.call(payload, 'ishSoniPerPatta')
    || Object.prototype.hasOwnProperty.call(payload, 'totalIshSoni')
    || Object.prototype.hasOwnProperty.call(payload, 'ishSoni')
  )) {
    const isProtectedCollision = db.prepare(`SELECT 1 FROM legacy_party_collision_exceptions
      WHERE company_id = ? AND party_id = ? AND status = 'ACTIVE' LIMIT 1`).get(companyId, partyId);
    if (!isProtectedCollision) throw new Error('PARTIAL_PARTY_CHANGE_NOT_ALLOWED');
    db.prepare(`UPDATE parties SET ish_soni_per_patta = ?, total_ish_soni = ?, ish_soni = ?,
      cumulative_ish_soni = ?, server_revision = ?, updated_at = ? WHERE company_id = ? AND id = ?`)
      .run(payload.ishSoniPerPatta ?? null, payload.totalIshSoni ?? null, Number(payload.ishSoni || 0),
        Number(payload.cumulativeIshSoni || 0), entityRevision, now, companyId, partyId);
    return;
  }
  if (!hasFullPartyPayload) throw new Error('REMOTE_PARTY_CHANGE_INVALID');
  const values = [
    partyId, companyId, payload.partyNumber, payload.physicalPartyNumber || payload.partyNumber, payload.modelId,
    payload.modelName || null, payload.color || null, Number(payload.pattaCount || 0), Number(payload.cumulativePattaCount || 0),
    payload.pattaStartNumber ?? null, payload.pattaEndNumber ?? null,
    payload.ishSoniPerPatta ?? null, payload.totalIshSoni ?? null, Number(payload.ishSoni || 0),
    Number(payload.cumulativeIshSoni || 0), JSON.stringify(payload.sizes || {}), payload.sizeOrder == null ? null : JSON.stringify(payload.sizeOrder), payload.printedAt || now, 0,
    JSON.stringify(payload.archivedPattaNumbers || []), 'ACTIVE', now, now, entityRevision
  ];
  if (current) {
    const preserveClosedState = current.status === 'CLOSED'
      || Number(current.is_closed || 0) === 1
      || Number(current.is_archived || 0) === 1;
    const payloadIsClosed = payload.status === 'CLOSED' || payload.isClosed === true || payload.isArchived === true;
    const updateParty = preserveClosedState
      ? `UPDATE parties SET model_name = ?, color = ?, patta_count = ?, cumulative_patta_count = ?,
        patta_start_number = ?, patta_end_number = ?,
        ish_soni_per_patta = ?, total_ish_soni = ?, ish_soni = ?, cumulative_ish_soni = ?, sizes_json = ?, size_order_json = ?,
        printed_at = ?, server_revision = ?, updated_at = ? WHERE company_id = ? AND id = ?`
      : `UPDATE parties SET model_name = ?, color = ?, patta_count = ?, cumulative_patta_count = ?,
      patta_start_number = ?, patta_end_number = ?,
      ish_soni_per_patta = ?, total_ish_soni = ?, ish_soni = ?, cumulative_ish_soni = ?, sizes_json = ?, size_order_json = ?,
      printed_at = ?, archived_patta_numbers_json = ?, status = ?, is_closed = ?,
      closed_at = CASE WHEN ? THEN ? ELSE closed_at END,
      is_archived = CASE WHEN ? THEN 1 ELSE is_archived END, server_revision = ?, updated_at = ?
      WHERE company_id = ? AND id = ?`;
    const partyValues = [
      payload.modelName || null, payload.color || null, Number(payload.pattaCount || 0), Number(payload.cumulativePattaCount || 0),
      payload.pattaStartNumber ?? null, payload.pattaEndNumber ?? null,
      payload.ishSoniPerPatta ?? null, payload.totalIshSoni ?? null, Number(payload.ishSoni || 0),
      Number(payload.cumulativeIshSoni || 0), JSON.stringify(payload.sizes || {}), current ? current.size_order_json : (payload.sizeOrder == null ? null : JSON.stringify(payload.sizeOrder)), payload.printedAt || now
    ];
    if (!preserveClosedState) {
      partyValues.push(
        JSON.stringify(payload.archivedPattaNumbers || []),
        payloadIsClosed ? 'CLOSED' : 'ACTIVE',
        payloadIsClosed ? 1 : 0,
        payloadIsClosed ? 1 : 0,
        payload.closedAt || now,
        payload.isArchived === true ? 1 : 0
      );
    }
    partyValues.push(entityRevision, now, companyId, partyId);
      db.prepare(updateParty).run(...partyValues);
  } else {
    db.prepare(`INSERT INTO parties (
      id, company_id, party_number, physical_party_number, model_id, model_name, color, patta_count,
      cumulative_patta_count, patta_start_number, patta_end_number,
      ish_soni_per_patta, total_ish_soni, ish_soni, cumulative_ish_soni,
       sizes_json, size_order_json, printed_at, is_closed, archived_patta_numbers_json, status, created_at, updated_at,
      provenance, server_revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REMOTE_SYNC', ?)`)
      .run(...values);
  }
  advancePattaSequence(db, companyId, payload.pattaEndNumber);
}

function applyBatchSettingsChange(db, companyId, payload, entityRevision = 1) {
  const current = db.prepare('SELECT server_revision FROM company_batch_settings WHERE company_id = ?').get(companyId);
  if (Number(current?.server_revision || 0) > Number(entityRevision)) return;
  const now = payload.updatedAt || new Date().toISOString();
  if (payload.availableSizes !== undefined) {
    db.prepare(`INSERT INTO company_batch_settings (company_id, available_sizes_json, server_revision, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(company_id) DO UPDATE SET available_sizes_json = excluded.available_sizes_json,
        server_revision = MAX(company_batch_settings.server_revision, excluded.server_revision), updated_at = excluded.updated_at`)
      .run(companyId, JSON.stringify(payload.availableSizes || []), entityRevision, now);
  }
  for (const config of payload.configs || []) {
    db.prepare(`INSERT INTO patta_batch_settings (
      company_id, model_id, party_number, is_custom_party, total_ish_soni, color, sizes_json, size_names_json, server_revision, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, model_id) DO UPDATE SET party_number = excluded.party_number,
      is_custom_party = excluded.is_custom_party, total_ish_soni = excluded.total_ish_soni,
      color = excluded.color, sizes_json = excluded.sizes_json,
      size_names_json = COALESCE(excluded.size_names_json, patta_batch_settings.size_names_json),
      server_revision = MAX(patta_batch_settings.server_revision, excluded.server_revision), updated_at = excluded.updated_at`)
      .run(companyId, config.modelId, config.partyNumber || '', config.isCustomParty ? 1 : 0,
        config.totalIshSoni || '', config.color || null, JSON.stringify(config.sizes || {}), config.sizeNames == null ? null : JSON.stringify(config.sizeNames), entityRevision, now);
  }
}

module.exports = {
  getLocalCursor,
  setLocalCursor,
  applyWorkerChange,
  applyChangesBatch
};
