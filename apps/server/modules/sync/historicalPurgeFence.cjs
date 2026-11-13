'use strict';

const { businessDate } = require('../../../../packages/domain/periodWriteGuard.cjs');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function formatCalendarDateInTimezone(timestampIso, timezone = 'Asia/Tashkent') {
  if (typeof timestampIso !== 'string' || !timestampIso.trim()) return null;
  const ms = Date.parse(timestampIso);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(ms));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!map.year || !map.month || !map.day) return null;
  return `${map.year}-${map.month}-${map.day}`;
}

function resolvePurgeBusinessDate(effectiveDate, timestampIso, timezone = 'Asia/Tashkent') {
  if (effectiveDate !== undefined && effectiveDate !== null) {
    return businessDate(effectiveDate, timestampIso);
  }
  const zoned = formatCalendarDateInTimezone(timestampIso, timezone);
  if (zoned) return zoned;
  return businessDate(effectiveDate, timestampIso);
}

function createFenceError(code, message, details = null) {
  const err = new Error(message);
  err[Symbol.for('hisob.sync.applicationError')] = true;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function formatPurgeEraMetadata(row) {
  if (!row) return null;
  const cutoffDate = row.cutoff_date instanceof Date
    ? row.cutoff_date.toISOString().slice(0, 10)
    : String(row.cutoff_date || '').slice(0, 10);
  const cutoffUtc = row.cutoff_utc instanceof Date
    ? row.cutoff_utc.toISOString()
    : String(row.cutoff_utc || '');
  return {
    purgeId: row.purge_id,
    companyId: row.company_id,
    purgeGeneration: Number(row.purge_generation),
    cutoffDate,
    cutoffUtc,
    timezone: row.timezone || 'Asia/Tashkent',
    minValidCursor: String(row.min_valid_cursor ?? '0'),
    manifestSha256: row.manifest_sha256,
    baselinePurged: Boolean(row.baseline_purged),
    executedAt: row.executed_at instanceof Date ? row.executed_at.toISOString() : String(row.executed_at || '')
  };
}

async function readActivePurgeEra(client, companyId) {
  if (!companyId) return null;
  const result = await client.query(
    `SELECT purge_id, company_id, purge_generation, cutoff_date::text AS cutoff_date,
            cutoff_utc, timezone, min_valid_cursor::text AS min_valid_cursor,
            manifest_sha256, baseline_purged, executed_at
     FROM historical_purge_eras
     WHERE company_id = $1 AND status = UPPER('committed')
     ORDER BY purge_generation DESC
     LIMIT 1`,
    [companyId]
  );
  return formatPurgeEraMetadata(result?.rows?.[0] || null);
}

function parseOptionalPurgeGeneration(rawValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return null;
  const text = String(rawValue).trim();
  if (!/^\d{1,12}$/.test(text)) {
    throw createFenceError('INVALID_PURGE_GENERATION', 'purgeGeneration must be a non-negative integer');
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw createFenceError('INVALID_PURGE_GENERATION', 'purgeGeneration must be a non-negative integer');
  }
  return parsed;
}

function assertChangeFeedAllowedUnderPurgeFence(era, cursor, clientPurgeGeneration = null) {
  if (!era) return { allowed: true };
  if (BigInt(cursor) < BigInt(era.minValidCursor)) {
    return {
      allowed: false,
      code: 'HISTORY_PURGED_REBOOTSTRAP_REQUIRED',
      message: `Client cursor ${cursor} precedes historical purge watermark ${era.minValidCursor}; full re-bootstrap required`,
      era
    };
  }
  if (clientPurgeGeneration !== null && clientPurgeGeneration !== era.purgeGeneration) {
    return {
      allowed: false,
      code: 'HISTORY_PURGED_REBOOTSTRAP_REQUIRED',
      message: `Client purge generation ${clientPurgeGeneration} mismatches authoritative generation ${era.purgeGeneration}; full re-bootstrap required`,
      era
    };
  }
  return { allowed: true, era };
}

function collectEntityReferences(envelope, payload) {
  const refs = [];
  const add = (entityType, entityId) => {
    if (typeof entityId === 'string' && entityId.trim()) {
      refs.push([entityType, entityId.trim()]);
    }
  };
  const { commandType, entityType, entityId } = envelope;
  if (entityType && entityId) add(entityType, entityId);
  if (!payload || typeof payload !== 'object') return refs;

  add('ticket', payload.ticketId);
  add('ticket', payload.originalTicketId);
  add('party', payload.partyRecordId);
  add('period', payload.periodId);
  add('production_adjustment', payload.adjustmentId);
  add('production_adjustment', payload.originalAdjustmentId);
  add('patta_batch', payload.batchId);

  if (commandType === 'CompletePattaBatch' && Array.isArray(payload.parties)) {
    for (const party of payload.parties) {
      add('party', party?.partyRecordId);
    }
  }
  return refs;
}

function resolveAuthoritativeDatePreCutoff(envelope, payload, era) {
  const { commandType } = envelope;
  const cutoffDate = era.cutoffDate;
  const cutoffMs = Date.parse(era.cutoffUtc);
  if (!payload || typeof payload !== 'object') return null;

  if (commandType === 'SubmitTicket') {
    const effective = resolvePurgeBusinessDate(payload.effectiveDate, payload.submittedAt, era.timezone);
    if (effective < cutoffDate) {
      return { reason: 'SubmitTicket business date precedes purge cutoff', effectiveDate: effective };
    }
  }
  if (commandType === 'RecordProductionAdjustment') {
    if (typeof payload.effectiveDate === 'string' && ISO_DATE_RE.test(payload.effectiveDate) && payload.effectiveDate < cutoffDate) {
      return { reason: 'RecordProductionAdjustment effectiveDate precedes purge cutoff', effectiveDate: payload.effectiveDate };
    }
    if (payload.createdAt && Number.isFinite(cutoffMs)) {
      const createdMs = Date.parse(payload.createdAt);
      if (Number.isFinite(createdMs) && createdMs < cutoffMs) {
        return { reason: 'RecordProductionAdjustment createdAt precedes purge cutoff', createdAt: payload.createdAt };
      }
    }
  }
  if (commandType === 'CreatePeriod' || commandType === 'UpdatePeriod') {
    if (typeof payload.endDate === 'string' && ISO_DATE_RE.test(payload.endDate) && payload.endDate < cutoffDate) {
      return { reason: `${commandType} endDate precedes purge cutoff`, endDate: payload.endDate };
    }
  }
  if (commandType === 'ClosePeriod') {
    if (typeof payload.endDate === 'string' && ISO_DATE_RE.test(payload.endDate) && payload.endDate < cutoffDate) {
      return { reason: 'ClosePeriod endDate precedes purge cutoff', endDate: payload.endDate };
    }
  }
  const opTimestamp = envelope.clientCreatedAt || payload.clientCreatedAt;
  if (opTimestamp && Number.isFinite(cutoffMs)) {
    const ms = Date.parse(opTimestamp);
    if (Number.isFinite(ms) && ms < cutoffMs && ['UpdateBatchSettings', 'ArchivePartyHistory', 'CompletePartySeries'].includes(commandType)) {
      return { reason: `${commandType} queued prior to historical purge cutoff`, clientCreatedAt: opTimestamp };
    }
  }
  return null;
}

async function assertOperationAllowedUnderPurgeFence(client, companyId, req, envelope, payload) {
  const era = await readActivePurgeEra(client, companyId);
  if (!era) return null;

  const rawGen = envelope?.purgeGeneration !== undefined
    ? envelope.purgeGeneration
    : req?.headers?.['x-purge-generation'];
  const clientGeneration = parseOptionalPurgeGeneration(rawGen);
  if (clientGeneration !== null && clientGeneration < era.purgeGeneration) {
    throw createFenceError(
      'HISTORY_PURGED_REBOOTSTRAP_REQUIRED',
      `Operation rejected: client purgeGeneration=${clientGeneration} is older than authoritative purgeGeneration=${era.purgeGeneration}`,
      { purgeGeneration: era.purgeGeneration, cutoffDate: era.cutoffDate, minValidCursor: era.minValidCursor }
    );
  }

  const opTombstone = await client.query(
    `SELECT operation_id, purge_generation
     FROM purged_operation_tombstones
     WHERE company_id = $1 AND operation_id = $2
     LIMIT 1`,
    [companyId, envelope.operationId]
  );
  if (opTombstone?.rows?.length) {
    throw createFenceError(
      'OPERATION_PURGED_IN_HISTORICAL_RESET',
      `Operation "${envelope.operationId}" belongs to purged historical operations before ${era.cutoffDate}`,
      { operationId: envelope.operationId, purgeGeneration: Number(opTombstone.rows[0].purge_generation), cutoffDate: era.cutoffDate }
    );
  }

  const refs = collectEntityReferences(envelope, payload);
  for (const [entityType, entityId] of refs) {
    const entityTombstone = await client.query(
      `SELECT entity_type, entity_id, purge_generation
       FROM purged_entity_tombstones
       WHERE company_id = $1 AND entity_type = $2 AND entity_id = $3
       LIMIT 1`,
      [companyId, entityType, entityId]
    );
    if (entityTombstone?.rows?.length) {
      throw createFenceError(
        'HISTORICAL_ENTITY_PURGED',
        `Referenced ${entityType} "${entityId}" was permanently deleted in historical purge before ${era.cutoffDate}`,
        { entityType, entityId, purgeGeneration: Number(entityTombstone.rows[0].purge_generation), cutoffDate: era.cutoffDate }
      );
    }
  }

  const preCutoff = resolveAuthoritativeDatePreCutoff(envelope, payload, era);
  if (preCutoff) {
    throw createFenceError(
      'HISTORY_PURGED_PRE_CUTOFF',
      `${preCutoff.reason} (cutoff=${era.cutoffDate})`,
      { ...preCutoff, cutoffDate: era.cutoffDate, purgeGeneration: era.purgeGeneration }
    );
  }

  return era;
}

module.exports = {
  readActivePurgeEra,
  formatPurgeEraMetadata,
  parseOptionalPurgeGeneration,
  assertChangeFeedAllowedUnderPurgeFence,
  assertOperationAllowedUnderPurgeFence
};
