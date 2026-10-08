'use strict';

const { canonicalStringify, computePayloadHash } = require('../canonicalPayload.cjs');
const { validateCompanyScope } = require('../../../auth/auth.cjs');
const { businessDate } = require('../../../../../packages/domain/periodWriteGuard.cjs');
const {
  MAX_OPERATIONS,
  validateOperationEnvelope,
  validateCommandPayload
} = require('../payloadValidation.cjs');
const { isAllowedGrandfatheredPair } = require('../../../../../packages/domain/partyPolicy.cjs');
const { findAvailablePattaStart } = require('../../../../../packages/domain/pattaSequence.cjs');
const { executeWorkbookOperation, appendChange } = require('../workbookOperations.cjs');
const { acquireCompanyChangeLock } = require('../changeFeedWatermark.cjs');

function dateOnly(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
}

async function resolveTicketPeriodForDate(client, companyId, effectiveDate, requestedPeriodId = null) {
  const openPeriodsResult = await client.query(`SELECT id, start_date, end_date FROM periods
    WHERE company_id = $1 AND is_closed = 0 ORDER BY start_date DESC, id DESC`, [companyId]);
  const openPeriods = openPeriodsResult.rows || [];
  const matchingPeriod = openPeriods.find((period) => {
    const startDate = dateOnly(period.start_date);
    const endDate = period.end_date ? dateOnly(period.end_date) : null;
    return effectiveDate >= startDate && (!endDate || effectiveDate <= endDate);
  });
  if (matchingPeriod) return matchingPeriod.id;

  // Keep legacy companies without periods working, but never attach a dated ticket
  // to an unrelated or closed period.
  if (!openPeriods.length && !requestedPeriodId) return null;

  const requestedPeriod = openPeriods.find((period) => period.id === requestedPeriodId);
  const scope = requestedPeriod || openPeriods[0] || null;
  const range = scope
    ? `${dateOnly(scope.start_date)}${scope.end_date ? ` — ${dateOnly(scope.end_date)}` : ' дан бошлаб'}`
    : 'очиқ давр';
  throw createOpError(
    'PERIOD_SCOPE_MISMATCH',
    `Ticket sanasi (${effectiveDate}) ochiq davr (${range}) oralig‘ida emas`,
    { effectiveDate, requestedPeriodId, openPeriodId: scope?.id || null }
  );
}

/**
 * Creates operation execution handler for Fastify.
 *
 * @param {import('pg').Pool} pool
 */
function createOperationsHandler(pool) {
  return async function handleOperations(req, reply) {
    const { operations } = req.body || {};
    if (!Array.isArray(operations) || operations.length === 0) {
      return reply.code(400).send({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'Request body must contain non-empty "operations" array' }
      });
    }
    if (operations.length > MAX_OPERATIONS) {
      return reply.code(400).send({
        success: false,
        error: { code: 'TOO_MANY_OPERATIONS', message: `A request may contain at most ${MAX_OPERATIONS} operations` }
      });
    }

    const results = [];

    for (const op of operations) {
      const opResult = await processSingleOperation(pool, req, op);
      results.push(opResult);
    }

    return reply.send({
      success: true,
      results
    });
  };
}

function createOperationStatusHandler(pool) {
  return async function handleOperationStatuses(req, reply) {
    const operations = req.body?.operations;
    if (!Array.isArray(operations) || operations.length === 0 || operations.length > MAX_OPERATIONS) {
      return reply.code(400).send({
        success: false,
        error: { code: 'INVALID_OPERATION_STATUS_REQUEST', message: 'operations must contain between 1 and 100 identities' }
      });
    }

    const seen = new Set();
    for (const operation of operations) {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)
        || typeof operation.operationId !== 'string' || !operation.operationId.trim()
        || operation.operationId.length > 128
        || typeof operation.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(operation.payloadHash)) {
        return reply.code(400).send({
          success: false,
          error: { code: 'INVALID_OPERATION_STATUS_REQUEST', message: 'Each operation requires a valid operationId and payloadHash' }
        });
      }
      if (seen.has(operation.operationId)) {
        return reply.code(400).send({
          success: false,
          error: { code: 'INVALID_OPERATION_STATUS_REQUEST', message: 'operationId values must be unique' }
        });
      }
      seen.add(operation.operationId);
    }

    const companyId = req.auth.companyId;
    const rows = await pool.query(`
      SELECT operation_id, payload_hash, result_json, server_revision, accepted_at
      FROM operations_dedup
      WHERE company_id = $1 AND operation_id = ANY($2::varchar[])
    `, [companyId, operations.map((operation) => operation.operationId)]);
    const acceptedById = new Map(rows.rows.map((row) => [row.operation_id, row]));

    return reply.send({
      success: true,
      results: operations.map((operation) => {
        const accepted = acceptedById.get(operation.operationId);
        if (!accepted) return { operationId: operation.operationId, status: 'NOT_FOUND' };
        if (accepted.payload_hash !== operation.payloadHash) {
          return { operationId: operation.operationId, status: 'IDEMPOTENCY_CONFLICT' };
        }
        return {
          operationId: operation.operationId,
          payloadHash: accepted.payload_hash,
          status: 'APPLIED',
          serverRevision: accepted.server_revision,
          cursor: accepted.result_json?.cursor || null,
          ...(accepted.result_json?.periodId ? { periodId: accepted.result_json.periodId } : {}),
          committedAt: accepted.accepted_at,
          isReplay: true
        };
      })
    });
  };
}

/**
 * Processes a single operation inside ONE isolated PostgreSQL transaction.
 */
async function processSingleOperation(pool, req, op, options = {}) {
  let client = null;
  let transactionStarted = false;
  let envelope = null;
  try {
    // Envelope and tenant checks happen before acquiring a connection or mutation lock.
    envelope = validateOperationEnvelope(op);
    validateCompanyScope(req, envelope.companyId);
    const companyId = req.auth.companyId;

    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    // The same company lock fences bootstrap snapshots from uncommitted log IDs.
    await acquireCompanyChangeLock(client, req.auth.companyId);

    const { operationId, commandType, entityType, entityId, payloadHash, baseRevision, payload: parsedPayload } = envelope;

    // Acquire transaction-level advisory lock on companyId:operationId
    // to serialize concurrent requests for the same operation deterministically
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2))`, [companyId, operationId]);

    // 2. Independently canonicalize payload and verify hash
    const serverCanonical = canonicalStringify(parsedPayload);
    const serverHash = computePayloadHash(serverCanonical);
    const suppliedHash = payloadHash;

    if (suppliedHash !== serverHash) {
      throw createOpError(
        'PAYLOAD_HASH_MISMATCH',
        `Supplied payload hash (${suppliedHash}) does not match server computed hash (${serverHash})`
      );
    }

    // Validate the command before deduplication and before the command switch.
    // This keeps replay requests behind the same authority and shape checks.
    const validatedPayload = validateCommandPayload(commandType, parsedPayload, {
      companyId,
      operation: envelope,
      baseRevision,
      auth: req.auth
    });

    // 3. Operations Deduplication & Distributed Idempotency Check
    const dedupRes = await client.query(
      `SELECT company_id, operation_id, command_type, entity_type, entity_id, 
              payload_hash, result_json, server_revision, accepted_at
       FROM operations_dedup
       WHERE company_id = $1 AND operation_id = $2
       FOR UPDATE`,
      [companyId, operationId]
    );

    if (dedupRes.rows.length > 0) {
      const existing = dedupRes.rows[0];
      if (existing.payload_hash === serverHash) {
        // Replay: exact semantic match
        await client.query('COMMIT');
        return {
          operationId,
          status: 'APPLIED',
          serverRevision: existing.server_revision,
          cursor: existing.result_json?.cursor || null,
          ...(existing.result_json?.periodId ? { periodId: existing.result_json.periodId } : {}),
          committedAt: existing.accepted_at,
          isReplay: true
        };
      } else {
        // Idempotency conflict: same operationId, different payload hash
        throw createOpError(
          'IDEMPOTENCY_CONFLICT',
          `Operation "${operationId}" was previously executed with different semantic payload`
        );
      }
    }

    // 4. Authoritative Command Execution & CAS Validation
    let mutationResult = null;
    if (commandType === 'SubmitTicket') {
      mutationResult = await executeSubmitTicket(client, companyId, operationId, validatedPayload, serverCanonical);
    } else if (commandType === 'UpdateTicket') {
      mutationResult = await executeUpdateTicket(client, companyId, operationId, validatedPayload);
    } else if (commandType === 'RecordProductionAdjustment') {
      mutationResult = await executeRecordAdjustment(client, companyId, operationId, validatedPayload, serverCanonical, req);
    } else if (commandType === 'ReverseProductionAdjustment') {
      mutationResult = await executeReverseAdjustment(client, companyId, operationId, validatedPayload, serverCanonical, req);
    } else if (commandType === 'CreateParty') {
      mutationResult = await executeCreateParty(client, companyId, operationId, validatedPayload, serverCanonical);
    } else if (commandType === 'CloseParty') {
      mutationResult = await executeCloseParty(client, companyId, operationId, validatedPayload, serverCanonical);
    } else if (commandType === 'ResolveMigrationReconciliationCandidate') {
      mutationResult = await executeResolveCandidate(client, companyId, operationId, validatedPayload, serverCanonical, req);
    } else if ([
      'UpsertModel', 'DeactivateModel', 'UpsertWorker', 'DeactivateWorker',
       'CreatePeriod', 'UpdatePeriod', 'ClosePeriod', 'UpdateParty', 'ArchivePartyHistory',
       'UpdateBatchSettings', 'CompletePattaBatch', 'CompletePartySeries', 'DeleteTicket'
    ].includes(commandType)) {
      mutationResult = await executeWorkbookOperation(
        client,
        companyId,
        operationId,
        commandType,
        validatedPayload,
        serverCanonical,
        envelope,
        { executeCreateParty, deviceId: req.auth.deviceId }
      );
    } else {
      throw createOpError('UNKNOWN_COMMAND', `Unsupported command type: "${commandType}"`);
    }

    const { serverRevision, entityId: targetEntityId, changeId, committedAt } = mutationResult;

    // Optional failure injection hook for testing atomicity
    if (typeof options.testHookBeforeCommit === 'function') {
      await options.testHookBeforeCommit();
    }

    // 5. Store Dedup durable record
    const resultJson = {
      status: 'APPLIED',
      serverRevision,
      cursor: String(changeId),
      ...(mutationResult.periodId ? { periodId: mutationResult.periodId } : {}),
      committedAt
    };

    await client.query(
      `INSERT INTO operations_dedup (
        company_id, operation_id, command_type, entity_type, entity_id,
        payload_hash, result_json, server_revision, accepted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        companyId,
        operationId,
        commandType,
        entityType,
        targetEntityId,
        serverHash,
        resultJson,
        serverRevision,
        committedAt
      ]
    );

    await client.query('COMMIT');

    return {
      operationId,
      status: 'APPLIED',
      serverRevision,
      cursor: String(changeId),
      ...(mutationResult.periodId ? { periodId: mutationResult.periodId } : {}),
      committedAt,
      isReplay: false
    };
  } catch (err) {
    if (client && transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rbErr) {
        // ignore rollback err
      }
    }

    const code = err.code || 'OPERATION_FAILED';
    const isConflict = code === 'IDEMPOTENCY_CONFLICT' || code === 'REVISION_CONFLICT';
    const status = isConflict ? 'CONFLICT' : 'REJECTED';

    return {
      operationId: envelope?.operationId || (typeof op?.operationId === 'string' && op.operationId.trim() ? op.operationId.trim() : 'unknown'),
      status,
      error: {
        code,
        message: err.message,
        details: err.details || null
      }
    };
  } finally {
    if (client) {
      client.release();
    }
  }
}

function resolveTicketValidationMode(payload = {}, companyPolicy = null) {
  const defaultStrictValidation = companyPolicy?.require_ticket_validation !== false;
  return {
    strictParty: payload.strictParty ?? defaultStrictValidation,
    strictPatta: payload.strictPatta ?? defaultStrictValidation
  };
}

async function executeUpdateTicket(client, companyId, operationId, payload) {
  const ticketId = payload.ticketId;
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':ticket:' || $2))`, [companyId, ticketId]);
  const ticketResult = await client.query(`SELECT id, model_id, qty, status, is_closed, server_revision
    FROM tickets WHERE company_id = $1 AND id = $2 FOR UPDATE`, [companyId, ticketId]);
  const ticket = ticketResult.rows[0];
  if (!ticket) throw createOpError('TICKET_NOT_FOUND', `Ticket "${ticketId}" was not found`);
  if (ticket.status === 'VOIDED' || ticket.is_closed) {
    throw createOpError('TICKET_NOT_EDITABLE', 'Deleted or closed-period tickets cannot be edited');
  }
  if (Number(ticket.server_revision || 0) !== payload.baseRevision) {
    throw createOpError('REVISION_CONFLICT', `Ticket revision conflict; current revision is ${ticket.server_revision}`);
  }

  const modelResult = await client.query(`SELECT operations_json, status FROM models
    WHERE company_id = $1 AND id = $2`, [companyId, ticket.model_id]);
  const model = modelResult.rows[0];
  if (!model) throw createOpError('MODEL_NOT_FOUND', `Ticket model "${ticket.model_id}" was not found`);
  if (model.status !== 'ACTIVE') throw createOpError('MODEL_INACTIVE', `Ticket model "${ticket.model_id}" is inactive`);
  let modelOperations = model.operations_json;
  if (typeof modelOperations === 'string') {
    try { modelOperations = JSON.parse(modelOperations); } catch { modelOperations = []; }
  }
  if (!Array.isArray(modelOperations)) modelOperations = [];
  const operationByName = new Map(modelOperations.map((entry) => [
    typeof entry === 'string' ? entry : entry?.name,
    typeof entry === 'string' ? null : Number.isFinite(Number(entry?.rate)) ? Number(entry.rate) : null
  ]));
  for (const entry of payload.entries) {
    if (!operationByName.has(entry.opName)) {
      throw createOpError('UNKNOWN_OPERATION', `Operation "${entry.opName}" is not defined in the ticket model`);
    }
  }

  const workerIds = [...new Set(payload.entries.map((entry) => Number(entry.workerId)))];
  const workersResult = await client.query(`SELECT id, name, status FROM workers
    WHERE company_id = $1 AND id = ANY($2::int[])`, [companyId, workerIds]);
  const workers = new Map(workersResult.rows.map((worker) => [Number(worker.id), worker]));
  for (const workerId of workerIds) {
    const worker = workers.get(workerId);
    if (!worker) throw createOpError('WORKER_NOT_FOUND', `Worker "${workerId}" was not found`);
    if (worker.status !== 'ACTIVE') throw createOpError('WORKER_INACTIVE', `Worker "${workerId}" is inactive`);
  }

  const serverRevision = Number(ticket.server_revision || 0) + 1;
  const committedAt = new Date().toISOString();
  await client.query(`DELETE FROM ticket_entries WHERE company_id = $1 AND ticket_id = $2`, [companyId, ticketId]);
  const entries = payload.entries.map((entry, index) => ({
    entryId: `${ticketId}_entry_${index + 1}`,
    opName: entry.opName,
    workerId: Number(entry.workerId),
    workerNameSnapshot: workers.get(Number(entry.workerId)).name,
    rateSnapshot: operationByName.get(entry.opName),
    brak: null,
    qty: Number(ticket.qty)
  }));
  for (const entry of entries) {
    await client.query(`INSERT INTO ticket_entries (
      id, ticket_id, company_id, op_name, worker_id, worker_name_snapshot,
      rate_snapshot, brak, qty, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [
      entry.entryId, ticketId, companyId, entry.opName, entry.workerId,
      entry.workerNameSnapshot, entry.rateSnapshot, entry.brak, entry.qty, committedAt
    ]);
  }
  await client.query(`UPDATE tickets SET server_revision = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, ticketId, serverRevision]);
  const change = await appendChange(client, companyId, 'ticket', ticketId, serverRevision,
    operationId, 'UPDATE', { ticketId, status: ticket.status, entries }, committedAt);
  return {
    serverRevision,
    entityId: ticketId,
    changeId: Number(change.rows[0].change_id),
    committedAt
  };
}

async function executeSubmitTicket(client, companyId, operationId, payload, canonicalJson) {
  const {
    ticketId,
    modelId: requestedModelId,
    partyNumber,
    pattaNumber,
    strictParty: requestedStrictParty,
    strictPatta: requestedStrictPatta,
    qty,
    entries,
    partyRecordId: requestedPartyRecordId,
    konveyer,
    size,
    color,
    submittedAt
  } = payload;
  const modelAlias = await client.query(`SELECT canonical_model_id FROM model_id_aliases
    WHERE company_id = $1 AND legacy_model_id = $2`, [companyId, requestedModelId]);
  const modelId = modelAlias.rows[0]?.canonical_model_id || requestedModelId;
  const partyAlias = requestedPartyRecordId
    ? await client.query(`SELECT canonical_party_id FROM party_id_aliases
      WHERE company_id = $1 AND legacy_party_id = $2`, [companyId, requestedPartyRecordId])
    : null;
  const partyRecordId = partyAlias?.rows[0]?.canonical_party_id || requestedPartyRecordId;

  await assertServerPeriodOpen(client, companyId, payload.effectiveDate, submittedAt);
  const effectiveDate = businessDate(payload.effectiveDate, submittedAt);

  const activationPolicy = await client.query(`
    SELECT require_ticket_validation, is_active
    FROM activation_companies WHERE company_id = $1 FOR SHARE
  `, [companyId]);
  const companyPolicy = activationPolicy.rows[0];
  if (companyPolicy && !companyPolicy.is_active) throw createOpError('COMPANY_POLICY_INACTIVE', 'The company activation policy is inactive');
  // Company activation policy supplies the default for older clients and for
  // tickets that do not carry per-ticket mode choices. The Patta screen's
  // explicit switches are part of the canonical ticket command and must govern
  // that ticket so the server matches the validation the operator selected.
  const { strictParty, strictPatta } = resolveTicketValidationMode({
    strictParty: requestedStrictParty,
    strictPatta: requestedStrictPatta
  }, companyPolicy);
  if (strictParty && !partyRecordId) {
    throw createOpError('PARTY_RECORD_REQUIRED', 'A printed party is required while strict ticket validation is enabled');
  }
  if (strictPatta && Number(pattaNumber) <= 0) {
    throw createOpError('PATTA_NUMBER_REQUIRED', 'A positive patta number is required while strict patta validation is enabled');
  }

  // 1. Canonical Ticket ID uniqueness check (Approach A: Canonical UUID Identity)
  const idRes = await client.query(
    `SELECT id FROM tickets WHERE company_id = $1 AND id = $2`,
    [companyId, ticketId]
  );
  if (idRes.rows.length > 0) {
    throw createOpError('DUPLICATE_TICKET_ID', `Ticket with ID "${ticketId}" already exists`);
  }

  const modelRes = await client.query(
    `SELECT id, operations_json, status FROM models WHERE company_id = $1 AND id = $2`,
    [companyId, modelId]
  );
  if (modelRes.rows.length === 0) {
    throw createOpError('MODEL_NOT_FOUND', `Model "${modelId}" not found for company "${companyId}"`);
  }
  if (modelRes.rows[0].status !== 'ACTIVE') throw createOpError('MODEL_INACTIVE', `Model "${modelId}" is inactive`);

  let modelOperations = [];
  try {
    const storedOperations = modelRes.rows[0].operations_json;
    modelOperations = typeof storedOperations === 'string' ? JSON.parse(storedOperations) : (storedOperations || []);
  } catch (error) {
    modelOperations = [];
  }
  if (!Array.isArray(modelOperations)) modelOperations = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const knownOperation = modelOperations.some((modelOperation) => {
      if (typeof modelOperation === 'string') return modelOperation === entry.opName;
      return modelOperation && modelOperation.name === entry.opName;
    });
    if (!knownOperation) {
      throw createOpError('UNKNOWN_OPERATION', `Operation "${entry.opName}" at entry index ${index} is not defined in model "${modelId}" operations`);
    }
  }

  const workerIds = [...new Set(entries.map((entry) => entry.workerId))];
  for (const workerId of workerIds) {
    const workerRes = await client.query(
      `SELECT id, status FROM workers WHERE company_id = $1 AND id = $2`,
      [companyId, workerId]
    );
    if (workerRes.rows.length === 0) {
      throw createOpError('WORKER_NOT_FOUND', `Worker "${workerId}" not found for company "${companyId}"`);
    }
    if (workerRes.rows[0].status !== 'ACTIVE') throw createOpError('WORKER_INACTIVE', `Worker "${workerId}" is inactive`);
  }

  if (partyRecordId) {
    const partyRes = await client.query(
      `SELECT p.id, p.party_number, p.model_id, p.patta_count,
        COALESCE(p.patta_start_number, r.patta_start_number) AS patta_start_number,
        COALESCE(p.patta_end_number, r.patta_end_number) AS patta_end_number
       FROM parties p
       LEFT JOIN protected_party_patta_ranges r ON r.company_id = p.company_id AND r.party_record_id = p.id
       WHERE p.company_id = $1 AND p.id = $2`, [companyId, partyRecordId]
    );
    if (partyRes.rows.length === 0) {
      throw createOpError('PARTY_NOT_FOUND', `Party "${partyRecordId}" not found for company "${companyId}"`);
    }
    const party = partyRes.rows[0];
    const partyModelAlias = await client.query(`SELECT canonical_model_id FROM model_id_aliases
      WHERE company_id = $1 AND legacy_model_id = $2`, [companyId, party.model_id]);
    const canonicalPartyModelId = partyModelAlias.rows[0]?.canonical_model_id || party.model_id;
    if (party.party_number !== partyNumber || canonicalPartyModelId !== modelId) {
      throw createOpError('PARTY_IDENTITY_MISMATCH', 'Ticket party identity does not match its printed party record');
    }
    if (party.patta_start_number !== null && party.patta_end_number !== null
      && (Number(pattaNumber) < Number(party.patta_start_number) || Number(pattaNumber) > Number(party.patta_end_number))) {
      throw createOpError('PATTA_NUMBER_OUT_OF_RANGE', 'Ticket patta number is outside the assigned party-series range');
    }
  }

  const serverRevision = 1;
  const now = submittedAt || new Date().toISOString();
  const periodId = await resolveTicketPeriodForDate(client, companyId, effectiveDate, payload.periodId || null);

  // 3. Insert Authoritative Ticket Fact
  await client.query(
    `INSERT INTO tickets (
      id, company_id, model_id, period_id, party_number, party_record_id, patta_number,
      qty, size, color, konveyer, status, is_closed, submitted_at, created_at, server_revision
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, 'CONFIRMED', 0, $12, NOW(), $13
    )`,
    [
      ticketId,
      companyId,
      modelId,
      periodId,
      partyNumber,
      partyRecordId,
      pattaNumber,
      qty,
      size || null,
      color || null,
      konveyer || null,
      now,
      serverRevision
    ]
  );

  // 4. Insert Ticket Entries
  if (Array.isArray(entries)) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const entryId = `${ticketId}_entry_${i + 1}`;
      await client.query(
        `INSERT INTO ticket_entries (
          id, ticket_id, company_id, op_name, worker_id, worker_name_snapshot,
          rate_snapshot, brak, qty, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, NOW()
        )`,
        [
          entryId,
          ticketId,
          companyId,
          e.opName,
          e.workerId,
          e.workerNameSnapshot || null,
          e.rateSnapshot !== undefined ? e.rateSnapshot : null,
          e.brak || null,
          qty
        ]
      );
    }
  }

  // 5. Append-only Change Log
  const clRes = await client.query(
    `INSERT INTO change_log (
      company_id, entity_type, entity_id, entity_revision, operation_id, change_type, payload_json, committed_at
    ) VALUES ($1, 'ticket', $2, $3, $4, 'INSERT', $5, NOW())
    RETURNING change_id, committed_at`,
    [companyId, ticketId, serverRevision, operationId, canonicalStringify({ ...payload, periodId })]
  );

  return {
    serverRevision,
    entityId: ticketId,
    periodId,
    changeId: clRes.rows[0].change_id,
    committedAt: clRes.rows[0].committed_at
  };
}

async function executeRecordAdjustment(client, companyId, operationId, payload, canonicalJson, req) {
  const {
    adjustmentId,
    modelId,
    workerId,
    opName,
    deltaQty,
    reason,
    status
  } = payload;

  await assertServerPeriodOpen(client, companyId, payload.effectiveDate, payload.createdAt);

  const modelRes = await client.query(
    `SELECT id FROM models WHERE company_id = $1 AND id = $2`,
    [companyId, modelId]
  );
  if (modelRes.rows.length === 0) {
    throw createOpError('MODEL_NOT_FOUND', `Model "${modelId}" not found for company "${companyId}"`);
  }
  const workerRes = await client.query(
    `SELECT id FROM workers WHERE company_id = $1 AND id = $2`,
    [companyId, workerId]
  );
  if (workerRes.rows.length === 0) {
    throw createOpError('WORKER_NOT_FOUND', `Worker "${workerId}" not found for company "${companyId}"`);
  }

  const serverRevision = 1;
  const authoritativeStatus = status === undefined ? 'APPROVED' : status;
  const trustedAuditActor = resolveTrustedAuditActor(req);

  await client.query(
    `INSERT INTO production_adjustments (
      adjustment_id, company_id, model_id, worker_id, op_name,
      delta_qty, reason, status, server_revision, created_at, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)`,
    [
      adjustmentId,
      companyId,
      modelId,
      workerId,
      opName,
      deltaQty,
      reason || 'MANUAL_ADJUSTMENT',
      authoritativeStatus,
      serverRevision,
      trustedAuditActor
    ]
  );

  const clRes = await client.query(
    `INSERT INTO change_log (
      company_id, entity_type, entity_id, entity_revision, operation_id, change_type, payload_json, committed_at
    ) VALUES ($1, 'production_adjustment', $2, $3, $4, 'INSERT', $5, NOW())
    RETURNING change_id, committed_at`,
    [companyId, adjustmentId, serverRevision, operationId, canonicalJson]
  );

  return {
    serverRevision,
    entityId: adjustmentId,
    changeId: clRes.rows[0].change_id,
    committedAt: clRes.rows[0].committed_at
  };
}

async function executeReverseAdjustment(client, companyId, operationId, payload, canonicalJson, req) {
  const {
    adjustmentId,
    reversalId,
    originalAdjustmentId,
    baseRevision,
    reason
  } = payload;

  const effectiveReversalId = reversalId || adjustmentId;
  const trustedAuditActor = resolveTrustedAuditActor(req);
  await assertServerPeriodOpen(client, companyId, payload.effectiveDate, payload.createdAt);

  // 1. Fetch original adjustment with row lock
  const origRes = await client.query(
    `SELECT adjustment_id, model_id, worker_id, op_name, delta_qty, status, server_revision
     FROM production_adjustments
     WHERE company_id = $1 AND adjustment_id = $2
     FOR UPDATE`,
    [companyId, originalAdjustmentId]
  );

  if (origRes.rows.length === 0) {
    throw createOpError('ENTITY_NOT_FOUND', `Original adjustment "${originalAdjustmentId}" not found`);
  }

  const orig = origRes.rows[0];
  if (orig.status === 'REVERSED') {
    throw createOpError('ALREADY_REVERSED', `Adjustment "${originalAdjustmentId}" is already reversed`);
  }
  if (orig.status !== 'APPROVED') {
    throw createOpError(
      'CANNOT_REVERSE_UNAPPROVED',
      `Cannot reverse adjustment "${originalAdjustmentId}" with status "${orig.status}". Only APPROVED adjustments can be reversed.`
    );
  }

  // 2. CAS Base Revision Check
  if (baseRevision !== undefined && baseRevision !== null) {
    if (orig.server_revision !== baseRevision) {
      const casErr = createOpError(
        'REVISION_CONFLICT',
        `Revision conflict on adjustment "${originalAdjustmentId}". Expected: ${orig.server_revision}, supplied: ${baseRevision}`
      );
      casErr.details = { currentRevision: orig.server_revision, baseRevision };
      throw casErr;
    }
  }

  const nextRevision = orig.server_revision + 1;

  // 3. Update original adjustment to REVERSED
  await client.query(
    `UPDATE production_adjustments
     SET status = 'REVERSED', server_revision = $1
     WHERE company_id = $2 AND adjustment_id = $3`,
    [nextRevision, companyId, originalAdjustmentId]
  );

  // 4. Insert reversal adjustment
  await client.query(
    `INSERT INTO production_adjustments (
      adjustment_id, company_id, model_id, worker_id, op_name,
      delta_qty, reason, status, server_revision, created_at, created_by, original_adjustment_id, provenance
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'REVERSED', 1, NOW(), $8, $9, 'REVERSAL')`,
    [
      effectiveReversalId,
      companyId,
      orig.model_id,
      orig.worker_id,
      orig.op_name,
      -Number(orig.delta_qty),
      reason || `Reversal of ${originalAdjustmentId}`,
      trustedAuditActor,
      originalAdjustmentId
    ]
  );

  // 5. Change log for the update of original
  await client.query(
    `INSERT INTO change_log (
      company_id, entity_type, entity_id, entity_revision, operation_id, change_type, payload_json, committed_at
    ) VALUES ($1, 'production_adjustment', $2, $3, $4, 'UPDATE', $5, NOW())`,
    [companyId, originalAdjustmentId, nextRevision, operationId, canonicalJson]
  );

  // 6. Change log for the insertion of reversal
  const clRes = await client.query(
    `INSERT INTO change_log (
      company_id, entity_type, entity_id, entity_revision, operation_id, change_type, payload_json, committed_at
    ) VALUES ($1, 'production_adjustment', $2, 1, $3, 'INSERT', $4, NOW())
    RETURNING change_id, committed_at`,
    [companyId, effectiveReversalId, operationId, canonicalJson]
  );

  return {
    serverRevision: nextRevision,
    entityId: effectiveReversalId,
    changeId: clRes.rows[0].change_id,
    committedAt: clRes.rows[0].committed_at
  };
}

async function executeCreateParty(client, companyId, operationId, payload, canonicalJson) {
  const partyAlias = await client.query(`SELECT canonical_party_id FROM party_id_aliases
    WHERE company_id = $1 AND legacy_party_id = $2`, [companyId, payload.partyRecordId]);
  const partyRecordId = partyAlias.rows[0]?.canonical_party_id || payload.partyRecordId;
  const partyNumber = payload.partyNumber;
  const modelAlias = await client.query(`SELECT canonical_model_id FROM model_id_aliases
    WHERE company_id = $1 AND legacy_model_id = $2`, [companyId, payload.modelId]);
  const modelId = modelAlias.rows[0]?.canonical_model_id || payload.modelId;
  if (Number(payload.baseRevision || 0) !== 0) {
    throw createOpError('REVISION_CONFLICT', 'A new party must start at revision zero');
  }
  if (!Number.isSafeInteger(Number(payload.pattaCount)) || Number(payload.pattaCount) < 1) {
    throw createOpError('INVALID_PATTA_COUNT', 'A printed party must contain at least one patta');
  }

  // Serialize all authoritative reads and the insert for this company/number.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':party:' || $2))`, [companyId, partyNumber]);

  const modelRes = await client.query(
    `SELECT id FROM models WHERE company_id = $1 AND id = $2`,
    [companyId, modelId]
  );
  if (modelRes.rows.length === 0) {
    throw createOpError('MODEL_NOT_FOUND', `Model "${modelId}" not found for company "${companyId}"`);
  }

  // Existing exceptions are represented by persisted, company-scoped approval rows.
  const activePartyRes = await client.query(
    `SELECT p.id, p.company_id, p.party_number, p.model_id, p.status,
            e.collision_group_id
     FROM parties p
      LEFT JOIN legacy_party_collision_exceptions e
        ON e.company_id = p.company_id AND e.party_id = p.id
       AND e.party_number = p.party_number AND e.status = 'ACTIVE'
      WHERE p.company_id = $1 AND p.party_number = $2 AND p.status != 'CLOSED'
      FOR UPDATE OF p`,
    [companyId, partyNumber]
  );
  const candidateException = await client.query(
    `SELECT collision_group_id FROM legacy_party_collision_exceptions
     WHERE company_id = $1 AND party_id = $2 AND party_number = $3 AND status = 'ACTIVE'`,
    [companyId, partyRecordId, partyNumber]
  );
  const candidate = {
    id: partyRecordId,
    company_id: companyId,
    party_number: partyNumber,
    status: 'ACTIVE',
    collision_group_id: candidateException.rows[0]?.collision_group_id || null
  };
  if (activePartyRes.rows.length > 0 && !isAllowedGrandfatheredPair(activePartyRes.rows, candidate)) {
    throw createOpError(
      'ACTIVE_PARTY_EXISTS',
      `Active party #${partyNumber} already exists for company "${companyId}" (ID: ${activePartyRes.rows[0].id}, status: ${activePartyRes.rows[0].status})`
    );
  }

  // 3. Check Party ID primary key uniqueness
  const idRes = await client.query(
    `SELECT id FROM parties WHERE company_id = $1 AND id = $2`,
    [companyId, partyRecordId]
  );
  if (idRes.rows.length > 0) {
    throw createOpError('DUPLICATE_PARTY_ID', `Party with ID "${partyRecordId}" already exists`);
  }

  const serverRevision = 1;
  let pattaStartNumber = null;
  let pattaEndNumber = null;
  let cumulativePattaCount = 0;
  if (Number(payload.pattaCount || 0) > 0) {
    await client.query(`INSERT INTO company_patta_sequences(company_id, next_patta_number)
      VALUES ($1, 1) ON CONFLICT (company_id) DO NOTHING`, [companyId]);
    const sequence = await client.query(`SELECT next_patta_number FROM company_patta_sequences
      WHERE company_id = $1 FOR UPDATE`, [companyId]);
    const currentNextPattaNumber = Number(sequence.rows[0].next_patta_number);
    const partyRanges = await client.query(`SELECT COALESCE(p.patta_start_number, r.patta_start_number) AS patta_start_number,
      COALESCE(p.patta_end_number, r.patta_end_number) AS patta_end_number, p.status, p.is_archived
      FROM parties p LEFT JOIN protected_party_patta_ranges r
        ON r.company_id = p.company_id AND r.party_record_id = p.id
      WHERE p.company_id = $1`, [companyId]);
    pattaStartNumber = findAvailablePattaStart({
      nextPattaNumber: currentNextPattaNumber,
      pattaCount: Number(payload.pattaCount),
      parties: partyRanges.rows
    });
    pattaEndNumber = pattaStartNumber + Number(payload.pattaCount) - 1;
    if (!Number.isSafeInteger(pattaEndNumber)) {
      throw createOpError('INVALID_PATTA_COUNT', 'Patta sequence exceeds the safe integer range');
    }
    cumulativePattaCount = pattaEndNumber;
    if (pattaStartNumber >= currentNextPattaNumber) {
      await client.query(`UPDATE company_patta_sequences SET next_patta_number = $2, updated_at = NOW()
        WHERE company_id = $1`, [companyId, pattaEndNumber + 1]);
    }
  }

  // 4. Insert Authoritative Party Fact
  await client.query(
    `INSERT INTO parties (
      id, company_id, party_number, physical_party_number, model_id, model_name, color,
      patta_count, cumulative_patta_count, patta_start_number, patta_end_number,
      ish_soni_per_patta, total_ish_soni,
      ish_soni, cumulative_ish_soni, sizes_json, printed_at, is_closed, status,
      server_revision, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13,
      $14, $15, $16, $17, 0, 'ACTIVE',
      $18, NOW(), NOW()
    )`,
    [
      partyRecordId,
      companyId,
      partyNumber,
      payload.physicalPartyNumber || partyNumber,
      modelId,
      payload.modelName || null,
      payload.color || null,
      payload.pattaCount ?? 0,
      cumulativePattaCount,
      pattaStartNumber,
      pattaEndNumber,
      payload.ishSoniPerPatta !== undefined ? payload.ishSoniPerPatta : null,
      payload.totalIshSoni !== undefined ? payload.totalIshSoni : null,
      payload.ishSoni ?? 0,
      payload.cumulativeIshSoni ?? 0,
      payload.sizes !== undefined ? JSON.stringify(payload.sizes) : null,
      payload.printedAt || new Date().toISOString(),
      serverRevision
    ]
  );

  // 5. Append-only Change Log
  const clRes = await client.query(
    `INSERT INTO change_log (
      company_id, entity_type, entity_id, entity_revision, operation_id, change_type, payload_json, committed_at
    ) VALUES ($1, 'party', $2, $3, $4, 'INSERT', $5, NOW())
    RETURNING change_id, committed_at`,
    [companyId, partyRecordId, serverRevision, operationId, JSON.stringify({
      ...payload,
      cumulativePattaCount,
      pattaStartNumber,
      pattaEndNumber
    })]
  );

  return {
    serverRevision,
    entityId: partyRecordId,
    changeId: clRes.rows[0].change_id,
    committedAt: clRes.rows[0].committed_at
  };
}

async function executeCloseParty(client, companyId, operationId, payload, canonicalJson) {
  const partyAlias = await client.query(`SELECT canonical_party_id FROM party_id_aliases
    WHERE company_id = $1 AND legacy_party_id = $2`, [companyId, payload.partyRecordId]);
  const partyRecordId = partyAlias.rows[0]?.canonical_party_id || payload.partyRecordId;

  // Serialize identity reads before resolving the number used by the shared
  // company/number lock. The identity lock avoids reading a row while another
  // close operation is resolving the same party.
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1 || ':party-identity:' || $2))`,
    [companyId, partyRecordId]
  );

  const partyNumberRes = await client.query(
    `SELECT party_number FROM parties WHERE company_id = $1 AND id = $2`,
    [companyId, partyRecordId]
  );

  if (partyNumberRes.rows.length === 0) {
    throw createOpError('PARTY_NOT_FOUND', `Party "${partyRecordId}" not found for company "${companyId}"`);
  }

  const partyNumber = partyNumberRes.rows[0].party_number;

  // Use the same company/number lock as CreateParty and the database trigger.
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1 || ':party:' || $2))`,
    [companyId, partyNumber]
  );

  // Re-read and lock the authoritative target row after the number lock is held.
  const partyRes = await client.query(
    `SELECT id, party_number, status, server_revision FROM parties 
      WHERE company_id = $1 AND id = $2 
     FOR UPDATE`,
    [companyId, partyRecordId]
  );

  if (partyRes.rows.length === 0) {
    throw createOpError('PARTY_NOT_FOUND', `Party "${partyRecordId}" not found for company "${companyId}"`);
  }

  const existing = partyRes.rows[0];

  if (payload.baseRevision !== undefined && payload.baseRevision !== null && payload.baseRevision !== existing.server_revision) {
    const conflict = createOpError('REVISION_CONFLICT', `Revision conflict on party "${partyRecordId}"`);
    conflict.details = { currentRevision: existing.server_revision, baseRevision: payload.baseRevision };
    throw conflict;
  }

  // 2. Validate current status is ACTIVE
  if (existing.status === 'CLOSED') {
    throw createOpError('PARTY_ALREADY_CLOSED', `Party "${partyRecordId}" is already closed`);
  }

  const newRevision = existing.server_revision + 1;

  // 3. Transition to CLOSED
  const updateRes = await client.query(
    `UPDATE parties 
     SET status = 'CLOSED', is_closed = 1, closed_at = NOW(), server_revision = $3, updated_at = NOW() 
     WHERE company_id = $1 AND id = $2 
     RETURNING closed_at`,
    [companyId, partyRecordId, newRevision]
  );

  const closedAt = updateRes.rows[0].closed_at;

  // 4. Append-only Change Log
  const clRes = await client.query(
    `INSERT INTO change_log (
      company_id, entity_type, entity_id, entity_revision, operation_id, change_type, payload_json, committed_at
    ) VALUES ($1, 'party', $2, $3, $4, 'UPDATE', $5, NOW())
    RETURNING change_id, committed_at`,
    [companyId, partyRecordId, newRevision, operationId, canonicalStringify({
      partyRecordId,
      status: 'CLOSED',
      isClosed: true,
      closedAt: closedAt instanceof Date ? closedAt.toISOString() : String(closedAt)
    })]
  );

  return {
    serverRevision: newRevision,
    entityId: partyRecordId,
    changeId: clRes.rows[0].change_id,
    committedAt: clRes.rows[0].committed_at,
    closedAt
  };
}

async function executeResolveCandidate(client, companyId, operationId, payload, canonicalJson, req) {
  const {
    candidateId,
    decision,
    reason,
    sourceReference
  } = payload;

  // Device authentication establishes tenant/device scope only. It does not
  // establish an operator identity or accounting permission. Never use role or
  // identity claims supplied by the client payload for this decision.
  assertReconciliationAuthority(req);
  const trustedOperatorId = req.auth.operator.operatorId;
  const trustedOperatorRole = req.auth.operator.role;

  if (!candidateId || typeof candidateId !== 'string') {
    throw createOpError('INVALID_FIELD', 'candidateId is required and must be a non-empty string');
  }
  if (!decision || typeof decision !== 'string') {
    throw createOpError('INVALID_FIELD', 'decision is required and must be a non-empty string');
  }
  if (!reason || typeof reason !== 'string') {
    throw createOpError('INVALID_FIELD', 'reason is required and must be a non-empty string');
  }
  if (payload.operatorId !== undefined && payload.operatorId !== trustedOperatorId) {
    throw createOpError('OPERATOR_INTENT_MISMATCH', 'Authenticated operator does not match the intended reconciliation operator');
  }

  const validDecisions = [
    'CONFIRM_LEGACY_AS_ADJUSTMENT',
    'REJECT_LEGACY_DIFFERENCE',
    'LINK_TO_MISSING_SOURCE',
    'DEFER_REVIEW'
  ];
  if (!validDecisions.includes(decision)) {
    throw createOpError('INVALID_DECISION', `decision must be one of: ${validDecisions.join(', ')}`);
  }

  const authorizedRoles = ['admin', 'accountant'];
  if (!authorizedRoles.includes(trustedOperatorRole)) {
    throw createOpError(
      'UNAUTHORIZED_ROLE',
      `Trusted operator "${trustedOperatorId}" with role "${trustedOperatorRole}" is not authorized to resolve reconciliation candidates.`
    );
  }

  // Acquire row-level lock on candidate
  const candRes = await client.query(
    `SELECT * FROM migration_reconciliation_candidates
     WHERE company_id = $1 AND candidate_id = $2
     FOR UPDATE`,
    [companyId, candidateId]
  );

  if (candRes.rows.length === 0) {
    throw createOpError('CANDIDATE_NOT_FOUND', `Reconciliation candidate "${candidateId}" not found for company "${companyId}"`);
  }

  const candidate = candRes.rows[0];
  await assertServerPeriodOpen(client, companyId, payload.effectiveDate, candidate.created_at);

  // Conflict Guard on Candidate Level
  const existingFinalDecision = (
    candidate.status === 'APPROVED' ? 'CONFIRM_LEGACY_AS_ADJUSTMENT' : (candidate.status === 'REJECTED' ? 'REJECT_LEGACY_DIFFERENCE' : null)
  );

  if (existingFinalDecision && existingFinalDecision !== decision) {
    throw createOpError(
      'CONFLICTING_DECISION_REJECTED',
      `Candidate "${candidateId}" already has final resolution "${existingFinalDecision}". Cannot apply conflicting decision "${decision}".`
    );
  }

  if (existingFinalDecision === decision) {
    const existingRes = await client.query(
      `SELECT created_adjustment_id, decided_at FROM migration_reconciliation_resolutions
       WHERE company_id = $1 AND candidate_id = $2 AND decision = $3
       ORDER BY created_at DESC LIMIT 1`,
      [companyId, candidateId, decision]
    );
    const existingLog = await client.query(
      `SELECT change_id, committed_at FROM change_log
       WHERE company_id = $1 AND entity_type = 'reconciliation_candidate' AND entity_id = $2
       ORDER BY change_id DESC LIMIT 1`, [companyId, candidateId]
    );
    return {
      serverRevision: 1,
      entityId: candidateId,
      changeId: existingLog.rows[0]?.change_id || 0,
      committedAt: existingLog.rows[0]?.committed_at || existingRes.rows[0]?.decided_at || new Date().toISOString()
    };
  }

  // Anti-tampering check
  if (payload.modelId !== undefined && payload.modelId !== candidate.model_id) {
    throw createOpError('CANDIDATE_TAMPERING_REJECTED', `Supplied modelId does not match candidate modelId`);
  }
  const workerMatches = payload.workerId === undefined || payload.workerId === null ||
    payload.workerId === candidate.worker_id ||
    (typeof payload.workerId === 'string' && payload.workerId === `${candidate.worker_id}`);
  if (!workerMatches) {
    throw createOpError('CANDIDATE_TAMPERING_REJECTED', `Supplied workerId does not match candidate workerId`);
  }
  if (payload.opName !== undefined && payload.opName !== candidate.operation_name) {
    throw createOpError('CANDIDATE_TAMPERING_REJECTED', `Supplied opName does not match candidate opName`);
  }
  if (payload.deltaQty !== undefined && payload.deltaQty !== null && payload.deltaQty !== Number(candidate.delta_qty)) {
    throw createOpError('CANDIDATE_TAMPERING_REJECTED', `Supplied deltaQty does not match candidate deltaQty`);
  }

  const committedAt = new Date().toISOString();
  let createdAdjustmentId = null;
  let nextCandidateStatus = 'PENDING_REVIEW';
  let changeType = 'UPDATE';
  let serverRevision = 1;

  if (decision === 'CONFIRM_LEGACY_AS_ADJUSTMENT') {
    // The server owns the adjustment identity and all accounting coordinates.
    createdAdjustmentId = `adj_rec_${candidate.candidate_id}_${operationId}`.slice(0, 128);
    nextCandidateStatus = 'APPROVED';

    // Insert into production_adjustments
    await client.query(
      `INSERT INTO production_adjustments (
        adjustment_id, company_id, model_id, worker_id, op_name, delta_qty,
        reason, status, server_revision, created_at, created_by, original_adjustment_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'APPROVED', 1, $8, $9, NULL)`,
      [
        createdAdjustmentId,
        companyId,
        candidate.model_id,
        candidate.worker_id,
        candidate.operation_name,
        candidate.delta_qty,
        `Historical reconciliation approval: ${reason}`,
        committedAt,
        trustedOperatorId
      ]
    );

    // Update candidate
    await client.query(
      `UPDATE migration_reconciliation_candidates SET
        status = 'APPROVED',
        resolution_decision = 'CONFIRM_LEGACY_AS_ADJUSTMENT',
        resolution_operator_id = $1,
        resolved_at = $2,
        created_adjustment_id = $3
      WHERE company_id = $4 AND candidate_id = $5`,
      [trustedOperatorId, committedAt, createdAdjustmentId, companyId, candidateId]
    );
  } else if (decision === 'REJECT_LEGACY_DIFFERENCE') {
    nextCandidateStatus = 'REJECTED';
    await client.query(
      `UPDATE migration_reconciliation_candidates SET
        status = 'REJECTED',
        resolution_decision = 'REJECT_LEGACY_DIFFERENCE',
        resolution_operator_id = $1,
        resolved_at = $2
      WHERE company_id = $3 AND candidate_id = $4`,
      [trustedOperatorId, committedAt, companyId, candidateId]
    );
  } else if (decision === 'LINK_TO_MISSING_SOURCE') {
    nextCandidateStatus = 'LINKED_SOURCE_PENDING';
    await client.query(
      `UPDATE migration_reconciliation_candidates SET
        status = 'LINKED_SOURCE_PENDING',
        resolution_decision = 'LINK_TO_MISSING_SOURCE',
        resolution_operator_id = $1,
        resolved_at = $2,
        source_reference = $3
      WHERE company_id = $4 AND candidate_id = $5`,
      [trustedOperatorId, committedAt, sourceReference || null, companyId, candidateId]
    );
  } else if (decision === 'DEFER_REVIEW') {
    nextCandidateStatus = 'PENDING_REVIEW';
    await client.query(
      `UPDATE migration_reconciliation_candidates SET
        status = 'PENDING_REVIEW'
      WHERE company_id = $1 AND candidate_id = $2`,
      [companyId, candidateId]
    );
  }

  // Insert audit record
  const resolutionId = `res_rec_${Date.now()}_${require('crypto').randomBytes(4).toString('hex')}`;
  const sourceHash = candidate.source_snapshot_hash || '2b94d9ef90a9c3d9eb43f8267f36bd9b6b5bf5f27f76df9a413453ade2747a6c';

  await client.query(
    `INSERT INTO migration_reconciliation_resolutions (
      resolution_id, candidate_id, company_id, decision, operator_id,
      operator_role, reason, decided_at, source_snapshot_hash, legacy_qty,
      derived_qty, delta_qty, created_adjustment_id, source_reference,
      resolution_provenance, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'OPERATOR_RECONCILIATION_RESOLUTION', $15)`,
    [
      resolutionId,
      candidateId,
      companyId,
      decision,
      trustedOperatorId,
      trustedOperatorRole,
      reason,
      committedAt,
      sourceHash,
      candidate.legacy_qty,
      candidate.ticket_derived_qty,
      candidate.delta_qty,
      createdAdjustmentId,
      sourceReference || null,
      committedAt
    ]
  );

  // Append change log
  const logRes = await client.query(
    `INSERT INTO change_log (
      company_id, entity_type, entity_id, entity_revision,
      operation_id, change_type, payload_json, committed_at
    ) VALUES ($1, 'reconciliation_candidate', $2, $3, $4, $5, $6::jsonb, $7)
    RETURNING change_id`,
    [
      companyId,
      candidateId,
      serverRevision,
      operationId,
      changeType,
      canonicalJson,
      committedAt
    ]
  );

  const changeId = logRes.rows[0].change_id;

  return {
    serverRevision,
    entityId: candidateId,
    changeId,
    committedAt
  };
}

function createOpError(code, message, details = null) {
  const err = new Error(message);
  err.code = code;
  if (details) err.details = details;
  return err;
}

function resolveTrustedAuditActor(req) {
  const operatorId = req?.auth?.operator?.operatorId;
  if (typeof operatorId === 'string' && operatorId.trim()) return operatorId.trim();

  const deviceId = req?.auth?.deviceId;
  if (typeof deviceId === 'string' && deviceId.trim()) return deviceId.trim();

  return 'SYSTEM';
}

async function assertServerPeriodOpen(client, companyId, effectiveDate, storedTimestamp) {
  const date = businessDate(effectiveDate, storedTimestamp);
  const result = await client.query(
    `SELECT id FROM periods WHERE company_id = $1 AND is_closed = 1
      AND start_date <= $2::date AND (end_date IS NULL OR end_date >= $2::date)
      ORDER BY start_date DESC LIMIT 1`, [companyId, date]
  );
  if (result.rows.length) {
    throw createOpError('PERIOD_CLOSED', `Business date ${date} belongs to closed period ${result.rows[0].id}`);
  }
}

function assertReconciliationAuthority(req) {
  const operator = req?.auth?.operator;
  if (!operator || !operator.operatorId || !operator.companyId || !operator.deviceId || !operator.isActive ||
      !['admin', 'accountant'].includes(operator.role) ||
      operator.companyId !== req?.auth?.companyId || operator.deviceId !== req?.auth?.deviceId) {
    throw createOpError(
      'RECONCILIATION_RBAC_BLOCKED',
      'A current, active admin or accountant operator session bound to this device and company is required.'
    );
  }
}

module.exports = {
  createOperationsHandler,
  createOperationStatusHandler,
  processSingleOperation,
  resolveTrustedAuditActor,
  resolveTicketValidationMode,
  executeUpdateTicket,
  resolveTicketPeriodForDate
};
