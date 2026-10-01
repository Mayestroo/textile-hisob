'use strict';

const crypto = require('crypto');
const { isSafeCompanyId } = require('./companyPath.cjs');
const { getCompanyDatabase } = require('./databaseManager.cjs');
const { insertOutboxOperation, getOperation } = require('./outboxManager.cjs');
const { rebuildCompanyProjections } = require('./projectionReader.cjs');
const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');
const { validateCausalOrdering } = require('./commandPipeline.cjs');

const COMMAND_ENTITY_TYPES = Object.freeze({
  UpsertModel: 'model',
  DeactivateModel: 'model',
  UpsertWorker: 'worker',
  DeactivateWorker: 'worker',
  CreateWorker: 'worker_create_request',
  CreatePeriod: 'period',
  UpdatePeriod: 'period',
  ClosePeriod: 'period',
  CreateParty: 'party',
  UpdateParty: 'party',
  CloseParty: 'party',
  ArchivePartyHistory: 'party_history',
  UpdateBatchSettings: 'batch_settings',
  CompletePattaBatch: 'patta_batch',
  CompletePartySeries: 'party_series'
});

function createCommandError(code, message, details = {}) {
  const error = new Error(`[CommandError: ${code}] ${message}`);
  error.name = 'CommandError';
  error.code = code;
  error.details = details;
  return error;
}

function assertText(value, field, maxLength = 4096) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength || value.includes('\u0000')) {
    throw createCommandError('INVALID_FIELD', `${field} must be a bounded non-empty string`);
  }
  return value.trim();
}

function assertEntityKey(value, field) {
  const key = assertText(value, field, 128);
  if (/[\u0001-\u001f\u007f]/.test(key)) {
    throw createCommandError('INVALID_ENTITY_ID', `${field} contains unsupported control characters`);
  }
  return key;
}

function assertIdentifier(value, field) {
  const id = assertText(value, field, 128);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw createCommandError('INVALID_IDENTIFIER', `${field} contains unsupported identifier characters`);
  }
  return id;
}

function assertRevision(value, fallback = 0) {
  const revision = value === undefined || value === null ? fallback : value;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw createCommandError('INVALID_BASE_REVISION', 'baseRevision must be a non-negative safe integer');
  }
  return revision;
}

function assertNonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw createCommandError('INVALID_QUANTITY', `${field} must be a non-negative safe integer`);
  return number;
}

function assertCompanyContext(activeCompanyId, commandCompanyId) {
  if (!isSafeCompanyId(commandCompanyId)) {
    throw createCommandError('INVALID_COMPANY_ID', 'companyId is invalid');
  }
  if (activeCompanyId !== commandCompanyId) {
    throw createCommandError('CROSS_COMPANY_REJECTED', 'Active company and command company do not match');
  }
}

function normalizeOperation(operation, index) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw createCommandError('INVALID_MODEL_OPERATION', `operations[${index}] must be an object`);
  }
  const name = assertText(operation.name, `operations[${index}].name`, 256);
  const rate = Number(operation.rate);
  if (!Number.isFinite(rate) || rate < 0) {
    throw createCommandError('INVALID_MODEL_RATE', `operations[${index}].rate must be a finite non-negative number`);
  }
  return {
    id: operation.id === undefined || operation.id === null ? `op_${index + 1}` : assertText(String(operation.id), `operations[${index}].id`, 128),
    name,
    rate
  };
}

function normalizeModelPayload(command, companyId, operationId, commandId) {
  const input = command.payload;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw createCommandError('INVALID_COMMAND_PAYLOAD', 'UpsertModel payload must be an object');
  }
  const modelId = assertEntityKey(input.id || input.modelId, 'modelId');
  if (modelId !== command.entityId) {
    throw createCommandError('ENTITY_ID_MISMATCH', 'Model ID does not match the operation entityId');
  }
  if (!Array.isArray(input.operations) || input.operations.length > 128) {
    throw createCommandError('INVALID_MODEL_OPERATIONS', 'operations must be an array with at most 128 items');
  }
  const operations = input.operations.map(normalizeOperation);
  const names = new Set();
  for (const operation of operations) {
    const key = operation.name.toLocaleLowerCase();
    if (names.has(key)) throw createCommandError('DUPLICATE_MODEL_OPERATION', 'Model operation names must be unique');
    names.add(key);
  }
  const pattaOpsOrder = input.pattaOpsOrder === undefined
    ? operations.map((operation) => operation.name)
    : input.pattaOpsOrder;
  if (!Array.isArray(pattaOpsOrder) || pattaOpsOrder.length > 128 || pattaOpsOrder.some((name) => !names.has(String(name).toLocaleLowerCase()))) {
    throw createCommandError('INVALID_PATTA_OPERATION_ORDER', 'pattaOpsOrder must contain only model operation names');
  }
  const normalized = {
    commandId,
    operationId,
    companyId,
    modelId,
    name: assertText(input.name, 'name', 160),
    hisobSheetName: input.hisobSheetName === undefined ? undefined : assertText(input.hisobSheetName, 'hisobSheetName', 160),
    title: input.title === undefined ? undefined : assertText(input.title, 'title', 256),
    party: input.party === undefined || input.party === null ? '' : String(input.party).trim(),
    color: input.color === undefined || input.color === null ? '' : assertText(String(input.color), 'color', 128),
    size: input.size === undefined || input.size === null ? '' : assertText(String(input.size), 'size', 128),
    operations,
    pattaOpsOrder: pattaOpsOrder.map((name) => assertText(name, 'pattaOpsOrder item', 256))
  };
  if (input.operationRenames !== undefined) {
    if (!Array.isArray(input.operationRenames) || input.operationRenames.length > 128) {
      throw createCommandError('INVALID_OPERATION_RENAMES', 'operationRenames must be a bounded array');
    }
    const newOperationNames = new Set(operations.map((operation) => operation.name.toLocaleLowerCase()));
    normalized.operationRenames = input.operationRenames.map((rename, index) => {
      assertObject(rename, `operationRenames[${index}]`);
      const fromName = assertText(rename.fromName, `operationRenames[${index}].fromName`, 256);
      const toName = assertText(rename.toName, `operationRenames[${index}].toName`, 256);
      if (!newOperationNames.has(toName.toLocaleLowerCase())) {
        throw createCommandError('INVALID_OPERATION_RENAMES', `Renamed operation "${toName}" is not in the new model operation list`);
      }
      return { fromName, toName };
    });
  }
  return normalized;
}

function assertFiniteNumber(value, field, options = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || (options.min !== undefined && number < options.min) || (options.nonZero && number === 0)) {
    throw createCommandError('INVALID_NUMBER', `${field} is outside the supported range`);
  }
  return number;
}

function assertCalendarDate(value, field) {
  const date = assertText(value, field, 32);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw createCommandError('INVALID_DATE', `${field} must use YYYY-MM-DD`);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw createCommandError('INVALID_DATE', `${field} is not a valid calendar date`);
  }
  return date;
}

function assertObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createCommandError('INVALID_FIELD', `${field} must be an object`);
  }
  return value;
}

function normalizeWorkerAdjustment(adjustment, index) {
  assertObject(adjustment, `balanceAdjustments[${index}]`);
  const type = assertIdentifier(adjustment.type, `balanceAdjustments[${index}].type`);
  if (type !== 'AVANS' && type !== 'JARIMA') {
    throw createCommandError('INVALID_WORKER_ADJUSTMENT_TYPE', 'Worker balance type must be AVANS or JARIMA');
  }
  const amountDelta = assertFiniteNumber(adjustment.amountDelta, `balanceAdjustments[${index}].amountDelta`, { nonZero: true });
  return {
    adjustmentId: assertIdentifier(adjustment.adjustmentId, `balanceAdjustments[${index}].adjustmentId`),
    type,
    amountDelta,
    periodId: assertEntityKey(adjustment.periodId, `balanceAdjustments[${index}].periodId`),
    description: adjustment.description === undefined ? null : assertText(String(adjustment.description), `balanceAdjustments[${index}].description`, 500)
  };
}

function normalizeWorkerPayload(command, companyId, operationId, commandId, { deactivate = false } = {}) {
  const input = assertObject(command.payload, 'UpsertWorker payload');
  const workerId = Number(input.workerId ?? command.entityId);
  if (!Number.isSafeInteger(workerId) || workerId <= 0 || String(workerId) !== String(command.entityId)) {
    throw createCommandError('INVALID_WORKER_ID', 'workerId must be a positive safe integer matching entityId');
  }
  if (deactivate) return { commandId, operationId, companyId, workerId };
  const status = input.status === undefined ? 'ACTIVE' : assertIdentifier(input.status, 'status');
  if (status !== 'ACTIVE') throw createCommandError('FORBIDDEN_AUTHORITY_FIELD', 'Only the active worker state may be set by UpsertWorker');
  if (input.balanceAdjustments !== undefined && (!Array.isArray(input.balanceAdjustments) || input.balanceAdjustments.length > 2)) {
    throw createCommandError('INVALID_WORKER_ADJUSTMENTS', 'balanceAdjustments must contain at most two entries');
  }
  return {
    commandId,
    operationId,
    companyId,
    workerId,
    name: assertText(input.name, 'name', 160),
    staj: assertFiniteNumber(input.staj ?? 0, 'staj', { min: 0 }),
    role: input.role === undefined || input.role === null || input.role === '' ? null : assertText(String(input.role), 'role', 128),
    status,
    balanceAdjustments: (input.balanceAdjustments || []).map(normalizeWorkerAdjustment)
  };
}

function normalizeCreateWorkerPayload(command, companyId, operationId, commandId) {
  const input = assertObject(command.payload, 'CreateWorker payload');
  for (const field of ['id', 'workerId', 'canonicalWorkerId', 'deletedWorkerIds']) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw createCommandError('CLIENT_WORKER_ID_FORBIDDEN', `${field} cannot be supplied in a worker create request`);
    }
  }
  const allowed = new Set(['requestId', 'name', 'staj', 'role', 'balanceAdjustments']);
  if (Object.keys(input).some((field) => !allowed.has(field))) {
    throw createCommandError('INVALID_WORKER_CREATE_REQUEST', 'Worker create request contains unsupported fields');
  }
  const requestId = assertIdentifier(input.requestId, 'requestId');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
    || command.entityId !== `pending-worker:${requestId}`) {
    throw createCommandError('INVALID_WORKER_CREATE_REQUEST_ID', 'CreateWorker requires a temporary pending-worker request key');
  }
  if (input.status !== undefined) throw createCommandError('FORBIDDEN_AUTHORITY_FIELD', 'Worker status is set only by the server');
  if (input.balanceAdjustments !== undefined && (!Array.isArray(input.balanceAdjustments) || input.balanceAdjustments.length > 2)) {
    throw createCommandError('INVALID_WORKER_ADJUSTMENTS', 'balanceAdjustments must contain at most two entries');
  }
  return {
    commandId,
    operationId,
    companyId,
    requestId,
    name: assertText(input.name, 'name', 160),
    staj: assertFiniteNumber(input.staj ?? 0, 'staj', { min: 0 }),
    role: input.role === undefined || input.role === null || input.role === '' ? null : assertText(String(input.role), 'role', 128),
    balanceAdjustments: (input.balanceAdjustments || []).map(normalizeWorkerAdjustment)
  };
}

function normalizePeriodPayload(command, companyId, operationId, commandId, commandType) {
  const input = assertObject(command.payload, `${commandType} payload`);
  const periodId = assertEntityKey(input.periodId ?? command.entityId, 'periodId');
  if (periodId !== command.entityId) throw createCommandError('ENTITY_ID_MISMATCH', 'periodId does not match entityId');
  if (commandType === 'ClosePeriod') {
    if (input.completedPartyIds !== undefined || input.rolledOverParties !== undefined) {
      throw createCommandError('FORBIDDEN_AUTHORITY_FIELD', 'Party completion and rollover are derived from local canonical facts');
    }
    const nextPeriod = assertObject(input.nextPeriod, 'nextPeriod');
    const localArchive = command.localArchive === undefined ? null : JSON.stringify(command.localArchive);
    if (localArchive !== null && Buffer.byteLength(localArchive, 'utf8') > 8 * 1024 * 1024) {
      throw createCommandError('PERIOD_ARCHIVE_TOO_LARGE', 'Local period archive exceeds 8 MiB');
    }
    return {
      commandId,
      operationId,
      companyId,
      periodId,
      endDate: assertCalendarDate(input.endDate, 'endDate'),
      nextPeriod: {
        id: assertEntityKey(nextPeriod.id, 'nextPeriod.id'),
        name: assertText(nextPeriod.name, 'nextPeriod.name', 160),
        startDate: assertCalendarDate(nextPeriod.startDate, 'nextPeriod.startDate')
      },
      archiveFilename: input.archiveFilename === undefined ? null : assertText(input.archiveFilename, 'archiveFilename', 256),
      localArchiveJson: localArchive
    };
  }

  return {
    commandId,
    operationId,
    companyId,
    periodId,
    name: assertText(input.name, 'name', 160),
    startDate: assertCalendarDate(input.startDate, 'startDate')
  };
}

function normalizePartyPayload(command, companyId, operationId, commandId, commandType) {
  const input = assertObject(command.payload, `${commandType} payload`);
  const partyRecordId = assertEntityKey(input.partyRecordId ?? input.id ?? command.entityId, 'partyRecordId');
  if (partyRecordId !== command.entityId) throw createCommandError('ENTITY_ID_MISMATCH', 'partyRecordId does not match entityId');
  if (commandType === 'CloseParty') return {
    commandId,
    operationId,
    companyId,
    partyRecordId,
    ...(input.baseRevision === undefined || input.baseRevision === null ? {} : { baseRevision: assertRevision(input.baseRevision) })
  };
  const partyNumber = assertEntityKey(input.partyNumber, 'partyNumber');
  const modelId = assertEntityKey(input.modelId, 'modelId');
  const rawSizes = input.sizes === undefined ? {} : assertObject(input.sizes, 'sizes');
  const sizes = {};
  for (const [size, count] of Object.entries(rawSizes)) {
    const normalizedSize = assertText(size, 'sizes key', 64);
    sizes[normalizedSize] = assertNonNegativeInteger(count, `sizes.${normalizedSize}`);
  }
  return {
    commandId,
    operationId,
    companyId,
    partyRecordId,
    ...(input.baseRevision === undefined || input.baseRevision === null ? {} : { baseRevision: assertRevision(input.baseRevision) }),
    partyNumber,
    modelId,
    physicalPartyNumber: input.physicalPartyNumber === undefined ? partyNumber : assertEntityKey(input.physicalPartyNumber, 'physicalPartyNumber'),
    modelName: input.modelName === undefined ? '' : assertText(String(input.modelName), 'modelName', 256),
    color: input.color === undefined ? '' : assertText(String(input.color), 'color', 128),
    pattaCount: assertNonNegativeInteger(input.pattaCount ?? 0, 'pattaCount'),
    cumulativePattaCount: assertNonNegativeInteger(input.cumulativePattaCount ?? 0, 'cumulativePattaCount'),
    ishSoniPerPatta: input.ishSoniPerPatta === undefined ? null : assertFiniteNumber(input.ishSoniPerPatta, 'ishSoniPerPatta', { min: 0 }),
    totalIshSoni: input.totalIshSoni === undefined ? null : assertFiniteNumber(input.totalIshSoni, 'totalIshSoni', { min: 0 }),
    ishSoni: assertFiniteNumber(input.ishSoni ?? 0, 'ishSoni', { min: 0 }),
    cumulativeIshSoni: assertFiniteNumber(input.cumulativeIshSoni ?? 0, 'cumulativeIshSoni', { min: 0 }),
    sizes,
    printedAt: input.printedAt === undefined ? new Date().toISOString() : assertText(input.printedAt, 'printedAt', 64)
  };
}

function normalizeBatchSettings(command, companyId, operationId, commandId) {
  const input = assertObject(command.payload, 'UpdateBatchSettings payload');
  if (command.entityId !== companyId) throw createCommandError('ENTITY_ID_MISMATCH', 'Batch settings entityId must equal companyId');
  if (input.availableSizes !== undefined && (!Array.isArray(input.availableSizes) || input.availableSizes.length > 128)) {
    throw createCommandError('INVALID_BATCH_SIZES', 'availableSizes must be a bounded array');
  }
  if (input.configs !== undefined && (!Array.isArray(input.configs) || input.configs.length > 128)) {
    throw createCommandError('INVALID_BATCH_CONFIGS', 'configs must be a bounded array');
  }
  const configs = (input.configs || []).map((config, index) => {
    assertObject(config, `configs[${index}]`);
    if (config.isCustomParty !== undefined && typeof config.isCustomParty !== 'boolean') {
      throw createCommandError('INVALID_BATCH_CONFIG', `configs[${index}].isCustomParty must be boolean`);
    }
    const sizes = config.sizes === undefined ? {} : assertObject(config.sizes, `configs[${index}].sizes`);
    const normalizedSizes = {};
    for (const [key, value] of Object.entries(sizes)) {
      const normalizedKey = assertText(key, `configs[${index}].sizes key`, 64);
      const normalizedValue = value === null ? '' : String(value);
      if (normalizedValue.length > 32) throw createCommandError('INVALID_BATCH_SIZE', 'Batch size text is too long');
      normalizedSizes[normalizedKey] = normalizedValue;
    }
    return {
      modelId: assertEntityKey(config.modelId, `configs[${index}].modelId`),
      partyNumber: config.partyNumber === undefined || config.partyNumber === '' ? '' : assertText(String(config.partyNumber), `configs[${index}].partyNumber`, 64),
      isCustomParty: config.isCustomParty === true,
      totalIshSoni: config.totalIshSoni === undefined || config.totalIshSoni === '' ? '' : assertText(String(config.totalIshSoni), `configs[${index}].totalIshSoni`, 32),
      color: config.color === undefined || config.color === '' ? '' : assertText(String(config.color), `configs[${index}].color`, 128),
      sizes: normalizedSizes
    };
  });
  const availableSizes = input.availableSizes?.map((size, index) => assertText(size, `availableSizes[${index}]`, 64));
  if (availableSizes && new Set(availableSizes.map((size) => size.toLocaleUpperCase())).size !== availableSizes.length) {
    throw createCommandError('DUPLICATE_BATCH_SIZE', 'availableSizes must be unique');
  }
  return { commandId, operationId, companyId, availableSizes, configs };
}

function normalizeCompleteBatch(command, companyId, operationId, commandId) {
  const input = assertObject(command.payload, 'CompletePattaBatch payload');
  const batchId = assertIdentifier(input.batchId ?? command.entityId, 'batchId');
  if (batchId !== command.entityId) throw createCommandError('ENTITY_ID_MISMATCH', 'batchId does not match entityId');
  if (!Array.isArray(input.parties) || input.parties.length < 1 || input.parties.length > 128) {
    throw createCommandError('INVALID_BATCH_PARTIES', 'Completed patta batch must contain 1–128 parties');
  }
  const parties = input.parties.map((party, index) => {
    const normalized = normalizePartyPayload({ entityId: party.id, payload: party }, companyId, operationId, commandId, 'CreateParty');
    return { ...normalized, partyRecordId: assertIdentifier(party.id, `parties[${index}].id`),
      ...(party.baseRevision === undefined || party.baseRevision === null ? {} : { baseRevision: assertRevision(party.baseRevision) }) };
  });
  const duplicatePartyNumbers = new Set();
  for (const party of parties) {
    if (duplicatePartyNumbers.has(party.partyNumber)) throw createCommandError('ACTIVE_PARTY_EXISTS', `Duplicate party number ${party.partyNumber} in one batch`);
    duplicatePartyNumbers.add(party.partyNumber);
  }
  const settings = normalizeBatchSettings({
    entityId: companyId,
    payload: { availableSizes: input.availableSizes, configs: input.configs }
  }, companyId, operationId, commandId);
  return { commandId, operationId, companyId, batchId, parties, availableSizes: settings.availableSizes, configs: settings.configs };
}

function getNextEntityRevision(db, companyId, entityType, entityId, currentRevision) {
  const pending = db.prepare(`
    SELECT COUNT(*) AS count
    FROM local_outbox
    WHERE company_id = ? AND entity_type = ? AND entity_id = ? AND status IN ('PENDING', 'SENDING')
  `).get(companyId, entityType, entityId);
  return Number(currentRevision || 0) + Number(pending?.count || 0);
}

function normalizeCommand(command, activeCompanyId) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw createCommandError('INVALID_COMMAND_PAYLOAD', 'Workbook command must be an object');
  }
  const commandType = assertIdentifier(command.commandType, 'commandType');
  const entityType = COMMAND_ENTITY_TYPES[commandType];
  if (!entityType) throw createCommandError('UNKNOWN_COMMAND', `Unsupported workbook command: ${commandType}`);
  const companyId = assertText(command.companyId, 'companyId', 64);
  assertCompanyContext(activeCompanyId, companyId);
  const commandId = assertIdentifier(command.commandId, 'commandId');
  const operationId = assertIdentifier(command.operationId, 'operationId');
  const entityId = assertEntityKey(command.entityId, 'entityId');
  const baseRevision = command.baseRevision === undefined || command.baseRevision === null
    ? null
    : assertRevision(command.baseRevision);
  const dependsOnOperationId = command.dependsOnOperationId === undefined || command.dependsOnOperationId === null
    ? null
    : assertIdentifier(command.dependsOnOperationId, 'dependsOnOperationId');
  const causalSequence = validateCausalOrdering(operationId, dependsOnOperationId, command.causalSequence);

  let payload;
  if (commandType === 'UpsertModel') {
    payload = normalizeModelPayload(command, companyId, operationId, commandId);
  } else if (commandType === 'DeactivateModel') {
    payload = { commandId, operationId, companyId, modelId: assertEntityKey(command.payload?.modelId ?? entityId, 'modelId') };
    if (payload.modelId !== entityId) throw createCommandError('ENTITY_ID_MISMATCH', 'modelId does not match entityId');
  } else if (commandType === 'UpsertWorker') {
    payload = normalizeWorkerPayload(command, companyId, operationId, commandId);
  } else if (commandType === 'DeactivateWorker') {
    payload = normalizeWorkerPayload(command, companyId, operationId, commandId, { deactivate: true });
  } else if (commandType === 'CreateWorker') {
    payload = normalizeCreateWorkerPayload(command, companyId, operationId, commandId);
  } else if (['CreatePeriod', 'UpdatePeriod', 'ClosePeriod'].includes(commandType)) {
    payload = normalizePeriodPayload(command, companyId, operationId, commandId, commandType);
  } else if (['CreateParty', 'UpdateParty', 'CloseParty'].includes(commandType)) {
    payload = normalizePartyPayload(command, companyId, operationId, commandId, commandType);
  } else if (commandType === 'ArchivePartyHistory') {
    const rawIds = command.payload?.partyRecordIds;
    if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 1000) {
      throw createCommandError('INVALID_PARTY_ARCHIVE', 'partyRecordIds must contain 1–1000 party IDs');
    }
    const partyRecordIds = rawIds.map((id, index) => assertEntityKey(id, `partyRecordIds[${index}]`));
    if (new Set(partyRecordIds).size !== partyRecordIds.length) throw createCommandError('DUPLICATE_PARTY_ID', 'partyRecordIds must be unique');
    if (entityId !== companyId) throw createCommandError('ENTITY_ID_MISMATCH', 'Party-history archive entityId must equal companyId');
    payload = { commandId, operationId, companyId, partyRecordIds };
  } else if (commandType === 'UpdateBatchSettings') {
    payload = normalizeBatchSettings(command, companyId, operationId, commandId);
  } else if (commandType === 'CompletePattaBatch') {
    payload = normalizeCompleteBatch(command, companyId, operationId, commandId);
  } else if (commandType === 'CompletePartySeries') {
    const periodId = assertEntityKey(command.payload?.periodId, 'periodId');
    if (entityId !== periodId) throw createCommandError('ENTITY_ID_MISMATCH', 'periodId does not match entityId');
    payload = {
      commandId,
      operationId,
      companyId,
      periodId,
      endDate: assertCalendarDate(command.payload?.endDate || new Date().toISOString().slice(0, 10), 'endDate')
    };
  } else {
    throw createCommandError('UNKNOWN_COMMAND', `Unsupported workbook command: ${commandType}`);
  }

  const localArchiveJson = payload.localArchiveJson || null;
  if (Object.prototype.hasOwnProperty.call(payload, 'localArchiveJson')) delete payload.localArchiveJson;
  return {
    commandType,
    entityType,
    entityId,
    companyId,
    commandId,
    operationId,
    baseRevision,
    dependsOnOperationId,
    causalSequence,
    localArchiveJson,
    payload
  };
}

function executeUpsertModel(db, companyId, entityId, baseRevision, payload) {
  const existing = db.prepare('SELECT server_revision, status FROM models WHERE company_id = ? AND id = ?').get(companyId, entityId);
  const expectedRevision = getNextEntityRevision(db, companyId, 'model', entityId, existing?.server_revision);
  if (expectedRevision !== baseRevision) {
    throw createCommandError('REVISION_CONFLICT', `Model revision changed; expected ${expectedRevision}, received ${baseRevision}`);
  }
  if (existing && existing.status !== 'ACTIVE') {
    throw createCommandError('MODEL_INACTIVE', `Model "${entityId}" is not active`);
  }

  const now = new Date().toISOString();
  if (!existing) {
    if (baseRevision !== 0) throw createCommandError('REVISION_CONFLICT', 'A new model must start at revision zero');
    db.prepare(`
      INSERT INTO models (
        id, company_id, name, hisob_sheet_name, title, party, color, size,
        operations_json, patta_ops_order_json, legacy_hisob_quantities_json,
        created_at, updated_at, provenance, status, server_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, 'LOCAL_COMMAND', 'ACTIVE', 0)
    `).run(
      entityId,
      companyId,
      payload.name,
      payload.hisobSheetName || `${payload.name}-hisob`,
      payload.title || `Model- ${payload.name}`,
      payload.party,
      payload.color,
      payload.size,
      JSON.stringify(payload.operations),
      JSON.stringify(payload.pattaOpsOrder),
      now,
      now
    );
    db.prepare(`
      INSERT OR IGNORE INTO patta_batch_settings (company_id, model_id, updated_at)
      VALUES (?, ?, ?)
    `).run(companyId, entityId, now);
  } else {
    for (const rename of payload.operationRenames || []) {
      db.prepare(`UPDATE ticket_entries SET op_name = ? WHERE company_id = ? AND op_name = ?
        AND ticket_id IN (SELECT id FROM tickets WHERE company_id = ? AND model_id = ?)`)
        .run(rename.toName, companyId, rename.fromName, companyId, entityId);
      db.prepare(`UPDATE production_adjustments SET op_name = ? WHERE company_id = ? AND model_id = ? AND op_name = ?`)
        .run(rename.toName, companyId, entityId, rename.fromName);
    }
    db.prepare(`
      UPDATE models SET name = ?, hisob_sheet_name = ?, title = ?, party = ?, color = ?, size = ?,
        operations_json = ?, patta_ops_order_json = ?, updated_at = ?
      WHERE company_id = ? AND id = ?
    `).run(
      payload.name,
      payload.hisobSheetName || `${payload.name}-hisob`,
      payload.title || `Model- ${payload.name}`,
      payload.party,
      payload.color,
      payload.size,
      JSON.stringify(payload.operations),
      JSON.stringify(payload.pattaOpsOrder),
      now,
      companyId,
      entityId
    );
  }
}

function readRevision(db, table, companyId, entityId, entityColumn) {
  const row = db.prepare(`SELECT server_revision FROM ${table} WHERE company_id = ? AND ${entityColumn} = ?`).get(companyId, entityId);
  return row ? Number(row.server_revision || 0) : 0;
}

function resolveCommandRevision(db, normalized, { table, entityColumn, mustExist = false, mustBeNew = false } = {}) {
  const exists = table
    ? db.prepare(`SELECT 1 AS present FROM ${table} WHERE company_id = ? AND ${entityColumn} = ?`).get(normalized.companyId, normalized.entityId)
    : null;
  if (mustExist && !exists) throw createCommandError('ENTITY_NOT_FOUND', `${normalized.entityType} "${normalized.entityId}" was not found`);
  if (mustBeNew && exists) throw createCommandError('ENTITY_ALREADY_EXISTS', `${normalized.entityType} "${normalized.entityId}" already exists`);
  const current = exists && table ? readRevision(db, table, normalized.companyId, normalized.entityId, entityColumn) : 0;
  const expected = table
    ? getNextEntityRevision(db, normalized.companyId, normalized.entityType, normalized.entityId, current)
    : 0;
  if (normalized.baseRevision !== null && normalized.baseRevision !== expected) {
    throw createCommandError('REVISION_CONFLICT', `${normalized.entityType} revision changed; expected ${expected}, received ${normalized.baseRevision}`);
  }
  return expected;
}

function assertActiveModel(db, companyId, modelId) {
  const alias = db.prepare(`SELECT canonical_model_id FROM model_id_aliases
    WHERE company_id = ? AND legacy_model_id = ?`).get(companyId, modelId);
  const canonicalModelId = alias?.canonical_model_id || modelId;
  const row = db.prepare('SELECT id FROM models WHERE company_id = ? AND id = ? AND status = \'ACTIVE\'').get(companyId, canonicalModelId);
  if (!row) throw createCommandError('MODEL_NOT_FOUND', `Active model "${modelId}" was not found`);
}

function insertPartyRecord(db, companyId, party) {
  const now = new Date().toISOString();
  assertActiveModel(db, companyId, party.modelId);
  db.prepare(`
    INSERT INTO parties (
      id, company_id, party_number, physical_party_number, model_id, model_name, color,
      patta_count, cumulative_patta_count, patta_start_number, patta_end_number,
      ish_soni_per_patta, total_ish_soni,
      ish_soni, cumulative_ish_soni, sizes_json, printed_at, is_closed,
      archived_patta_numbers_json, status, created_at, updated_at, provenance, server_revision
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 'ACTIVE', ?, ?, 'LOCAL_COMMAND', 0
    )
  `).run(
    party.partyRecordId,
    companyId,
    party.partyNumber,
    party.physicalPartyNumber || party.partyNumber,
    party.modelId,
    party.modelName || null,
    party.color || null,
    party.pattaCount,
    party.cumulativePattaCount,
    party.pattaStartNumber,
    party.pattaEndNumber,
    party.ishSoniPerPatta,
    party.totalIshSoni,
    party.ishSoni,
    party.cumulativeIshSoni,
    JSON.stringify(party.sizes || {}),
    party.printedAt || now,
    now,
    now
  );
}

function updatePartyRecord(db, companyId, party) {
  const current = db.prepare(`
    SELECT id, model_id, party_number, status, patta_count, cumulative_patta_count, patta_start_number, patta_end_number
    FROM parties WHERE company_id = ? AND id = ?
  `).get(companyId, party.partyRecordId);
  if (!current) throw createCommandError('PARTY_NOT_FOUND', `Party "${party.partyRecordId}" was not found`);
  const modelAlias = db.prepare(`SELECT canonical_model_id FROM model_id_aliases
    WHERE company_id = ? AND legacy_model_id = ?`).get(companyId, current.model_id);
  const canonicalModelId = modelAlias?.canonical_model_id || current.model_id;
  if (canonicalModelId !== party.modelId || current.party_number !== party.partyNumber) {
    throw createCommandError('IMMUTABLE_PARTY_IDENTITY', 'Party model and party number are immutable');
  }
  if (current.status === 'CLOSED') throw createCommandError('PARTY_ALREADY_CLOSED', 'A closed party cannot be updated');
  const isProtectedCollision = db.prepare(`SELECT 1 FROM legacy_party_collision_exceptions
    WHERE company_id = ? AND party_id = ? AND status = 'ACTIVE' LIMIT 1`).get(companyId, party.partyRecordId);
  if (isProtectedCollision) {
    db.prepare(`UPDATE parties SET ish_soni_per_patta = ?, total_ish_soni = ?, ish_soni = ?,
      cumulative_ish_soni = ?, updated_at = ? WHERE company_id = ? AND id = ?`).run(
      party.ishSoniPerPatta, party.totalIshSoni, party.ishSoni, party.cumulativeIshSoni,
      new Date().toISOString(), companyId, party.partyRecordId
    );
    return;
  }
  if (Number(current.patta_count) !== party.pattaCount) {
    throw createCommandError('IMMUTABLE_PATTA_RANGE', 'An existing printed party cannot change its patta count');
  }
  db.prepare(`
    UPDATE parties SET model_name = ?, color = ?, cumulative_patta_count = ?,
      ish_soni_per_patta = ?, total_ish_soni = ?, ish_soni = ?, cumulative_ish_soni = ?,
      sizes_json = ?, updated_at = ?
    WHERE company_id = ? AND id = ?
  `).run(
    party.modelName || null,
    party.color || null,
    current.cumulative_patta_count,
    party.ishSoniPerPatta,
    party.totalIshSoni,
    party.ishSoni,
    party.cumulativeIshSoni,
    JSON.stringify(party.sizes || {}),
    new Date().toISOString(),
    companyId,
    party.partyRecordId
  );
}

function writeBatchSettings(db, companyId, payload) {
  const now = new Date().toISOString();
  if (payload.availableSizes !== undefined) {
    db.prepare(`
      INSERT INTO company_batch_settings (company_id, available_sizes_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(company_id) DO UPDATE SET available_sizes_json = excluded.available_sizes_json, updated_at = excluded.updated_at
    `).run(companyId, JSON.stringify(payload.availableSizes), now);
  }
  for (const config of payload.configs || []) {
    assertActiveModel(db, companyId, config.modelId);
    db.prepare(`
      INSERT INTO patta_batch_settings (
        company_id, model_id, party_number, is_custom_party, total_ish_soni, color, sizes_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_id, model_id) DO UPDATE SET
        party_number = excluded.party_number,
        is_custom_party = excluded.is_custom_party,
        total_ish_soni = excluded.total_ish_soni,
        color = excluded.color,
        sizes_json = excluded.sizes_json,
        updated_at = excluded.updated_at
    `).run(
      companyId,
      config.modelId,
      config.partyNumber,
      config.isCustomParty ? 1 : 0,
      config.totalIshSoni,
      config.color || null,
      JSON.stringify(config.sizes),
      now
    );
  }
}

function executeUpsertWorker(db, normalized, baseRevision) {
  const payload = normalized.payload;
  const existing = db.prepare('SELECT id, server_revision, status FROM workers WHERE company_id = ? AND id = ?').get(normalized.companyId, payload.workerId);
  const expected = getNextEntityRevision(db, normalized.companyId, 'worker', normalized.entityId, existing?.server_revision);
  if (baseRevision !== expected) throw createCommandError('REVISION_CONFLICT', `Worker revision changed; expected ${expected}, received ${baseRevision}`);
  if (existing && existing.status !== 'ACTIVE') throw createCommandError('WORKER_INACTIVE', `Worker "${payload.workerId}" is not active`);
  const now = new Date().toISOString();
  if (!existing) {
    db.prepare(`
      INSERT INTO workers (id, company_id, name, staj, role, status, legacy_avans, legacy_jarima, created_at, updated_at, provenance, server_revision)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE', 0, 0, ?, ?, 'LOCAL_COMMAND', 0)
    `).run(payload.workerId, normalized.companyId, payload.name, payload.staj, payload.role, now, now);
  } else {
    db.prepare(`UPDATE workers SET name = ?, staj = ?, role = ?, updated_at = ? WHERE company_id = ? AND id = ?`)
      .run(payload.name, payload.staj, payload.role, now, normalized.companyId, payload.workerId);
  }
  for (const adjustment of payload.balanceAdjustments) {
    if (adjustment.periodId) {
      const period = db.prepare('SELECT id FROM periods WHERE company_id = ? AND id = ? AND is_closed = 0').get(normalized.companyId, adjustment.periodId);
      if (!period) throw createCommandError('PERIOD_NOT_FOUND', `Period "${adjustment.periodId}" was not found`);
    }
    db.prepare(`
      INSERT INTO worker_adjustments (
        id, company_id, worker_id, period_id, type, amount, description, provenance, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'WORKBOOK_COMMAND', 'POSTED', ?)
    `).run(adjustment.adjustmentId, normalized.companyId, payload.workerId, adjustment.periodId, adjustment.type, adjustment.amountDelta, adjustment.description, now);
  }
}

function executeDeactivateEntity(db, normalized, table, idColumn, status) {
  const existing = db.prepare(`SELECT id, server_revision, status FROM ${table} WHERE company_id = ? AND ${idColumn} = ?`).get(normalized.companyId, normalized.entityId);
  if (!existing) throw createCommandError('ENTITY_NOT_FOUND', `${normalized.entityType} "${normalized.entityId}" was not found`);
  const expected = getNextEntityRevision(db, normalized.companyId, normalized.entityType, normalized.entityId, existing.server_revision);
  if (normalized.baseRevision !== null && normalized.baseRevision !== expected) {
    throw createCommandError('REVISION_CONFLICT', `${normalized.entityType} revision changed; expected ${expected}, received ${normalized.baseRevision}`);
  }
  db.prepare(`UPDATE ${table} SET status = ?, updated_at = ? WHERE company_id = ? AND ${idColumn} = ?`)
    .run(status, new Date().toISOString(), normalized.companyId, normalized.entityId);
  if (table === 'models') {
    db.prepare('DELETE FROM local_ticket_forms WHERE company_id = ? AND model_id = ?').run(normalized.companyId, normalized.entityId);
  }
  return expected;
}

function executeWorkbookMutation(db, normalized, options) {
  const { commandType, companyId, entityId, payload } = normalized;
  if (commandType === 'UpsertModel') {
    const existing = db.prepare('SELECT server_revision FROM models WHERE company_id = ? AND id = ?').get(companyId, entityId);
    const effectiveRevision = getNextEntityRevision(db, companyId, 'model', entityId, existing?.server_revision);
    if (normalized.baseRevision !== null && normalized.baseRevision !== effectiveRevision) {
      throw createCommandError('REVISION_CONFLICT', `Model revision changed; expected ${effectiveRevision}, received ${normalized.baseRevision}`);
    }
    executeUpsertModel(db, companyId, entityId, effectiveRevision, payload);
    return effectiveRevision;
  }
  if (commandType === 'DeactivateModel') return executeDeactivateEntity(db, normalized, 'models', 'id', 'INACTIVE');
  if (commandType === 'UpsertWorker') {
    const existing = db.prepare('SELECT server_revision FROM workers WHERE company_id = ? AND id = ?').get(companyId, payload.workerId);
    const effectiveRevision = getNextEntityRevision(db, companyId, 'worker', entityId, existing?.server_revision);
    if (normalized.baseRevision !== null && normalized.baseRevision !== effectiveRevision) {
      throw createCommandError('REVISION_CONFLICT', `Worker revision changed; expected ${effectiveRevision}, received ${normalized.baseRevision}`);
    }
    executeUpsertWorker(db, normalized, effectiveRevision);
    return effectiveRevision;
  }
  if (commandType === 'CreateWorker') return 0;
  if (commandType === 'DeactivateWorker') return executeDeactivateEntity(db, normalized, 'workers', 'id', 'INACTIVE');
  if (commandType === 'CreatePeriod') {
    const existing = db.prepare('SELECT id FROM periods WHERE company_id = ? AND id = ?').get(companyId, entityId);
    if (existing || normalized.baseRevision !== null && normalized.baseRevision !== 0) {
      throw createCommandError('ENTITY_ALREADY_EXISTS', `Period "${entityId}" already exists`);
    }
    const open = db.prepare('SELECT id FROM periods WHERE company_id = ? AND is_closed = 0').get(companyId);
    if (open) throw createCommandError('OPEN_PERIOD_EXISTS', `Open period "${open.id}" must be closed before creating another`);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO periods (id, company_id, name, start_date, is_closed, status, created_at, updated_at, server_revision, provenance)
      VALUES (?, ?, ?, ?, 0, 'OPEN', ?, ?, 0, 'LOCAL_COMMAND')
    `).run(entityId, companyId, payload.name, payload.startDate, now, now);
    return 0;
  }
  if (commandType === 'UpdatePeriod') {
    const current = db.prepare('SELECT id, server_revision, is_closed FROM periods WHERE company_id = ? AND id = ?').get(companyId, entityId);
    if (!current) throw createCommandError('PERIOD_NOT_FOUND', `Period "${entityId}" was not found`);
    if (current.is_closed) throw createCommandError('PERIOD_CLOSED', 'Closed periods cannot be changed');
    const revision = getNextEntityRevision(db, companyId, 'period', entityId, current.server_revision);
    if (normalized.baseRevision !== null && normalized.baseRevision !== revision) throw createCommandError('REVISION_CONFLICT', 'Period revision changed');
    db.prepare('UPDATE periods SET name = ?, start_date = ?, updated_at = ? WHERE company_id = ? AND id = ?')
      .run(payload.name, payload.startDate, new Date().toISOString(), companyId, entityId);
    return revision;
  }
  if (commandType === 'ClosePeriod') return executeClosePeriod(db, normalized);
  if (commandType === 'CreateParty') {
    const exists = db.prepare('SELECT id FROM parties WHERE company_id = ? AND id = ?').get(companyId, entityId);
    if (exists) throw createCommandError('DUPLICATE_PARTY_ID', `Party "${entityId}" already exists`);
    assertActiveModel(db, companyId, payload.modelId);
    insertPartyRecord(db, companyId, payload);
    return 0;
  }
  if (commandType === 'UpdateParty') {
    const current = db.prepare('SELECT server_revision FROM parties WHERE company_id = ? AND id = ?').get(companyId, entityId);
    if (!current) throw createCommandError('PARTY_NOT_FOUND', `Party "${entityId}" was not found`);
    const revision = getNextEntityRevision(db, companyId, 'party', entityId, current.server_revision);
    if (normalized.baseRevision !== null && normalized.baseRevision !== revision) throw createCommandError('REVISION_CONFLICT', 'Party revision changed');
    updatePartyRecord(db, companyId, payload);
    return revision;
  }
  if (commandType === 'CloseParty') {
    const current = db.prepare('SELECT status, server_revision FROM parties WHERE company_id = ? AND id = ?').get(companyId, entityId);
    if (!current) throw createCommandError('PARTY_NOT_FOUND', `Party "${entityId}" was not found`);
    if (current.status === 'CLOSED') throw createCommandError('PARTY_ALREADY_CLOSED', `Party "${entityId}" is already closed`);
    const revision = getNextEntityRevision(db, companyId, 'party', entityId, current.server_revision);
    if (normalized.baseRevision !== null && normalized.baseRevision !== revision) throw createCommandError('REVISION_CONFLICT', 'Party revision changed');
    db.prepare(`UPDATE parties SET status = 'CLOSED', is_closed = 1, closed_at = ?, updated_at = ? WHERE company_id = ? AND id = ?`)
      .run(new Date().toISOString(), new Date().toISOString(), companyId, entityId);
    return revision;
  }
  if (commandType === 'ArchivePartyHistory') {
    const placeholders = payload.partyRecordIds.map(() => '?').join(', ');
    const rows = db.prepare(`SELECT id FROM parties WHERE company_id = ? AND id IN (${placeholders})`)
      .all(companyId, ...payload.partyRecordIds);
    if (rows.length !== payload.partyRecordIds.length) throw createCommandError('PARTY_NOT_FOUND', 'One or more parties to archive were not found');
    const now = new Date().toISOString();
    const archive = db.prepare(`UPDATE parties SET status = 'CLOSED', is_closed = 1, is_archived = 1,
      closed_at = COALESCE(closed_at, ?), updated_at = ? WHERE company_id = ? AND id = ?`);
    for (const partyId of payload.partyRecordIds) archive.run(now, now, companyId, partyId);
    return 0;
  }
  if (commandType === 'UpdateBatchSettings') {
    const current = db.prepare('SELECT server_revision FROM company_batch_settings WHERE company_id = ?').get(companyId);
    const revision = getNextEntityRevision(db, companyId, 'batch_settings', companyId, current?.server_revision);
    if (normalized.baseRevision !== null && normalized.baseRevision !== revision) throw createCommandError('REVISION_CONFLICT', 'Batch settings revision changed');
    writeBatchSettings(db, companyId, payload);
    return revision;
  }
  if (commandType === 'CompletePattaBatch') return executeCompletePattaBatch(db, normalized);
  if (commandType === 'CompletePartySeries') return executeCompletePartySeries(db, normalized);
  throw createCommandError('UNKNOWN_COMMAND', `Unsupported workbook command: ${commandType}`);
}

function executeClosePeriod(db, normalized) {
  const { companyId, entityId, payload } = normalized;
  const period = db.prepare(`
    SELECT id, start_date, is_closed, server_revision FROM periods WHERE company_id = ? AND id = ?
  `).get(companyId, entityId);
  if (!period) throw createCommandError('PERIOD_NOT_FOUND', `Period "${entityId}" was not found`);
  if (period.is_closed) throw createCommandError('PERIOD_ALREADY_CLOSED', `Period "${entityId}" is already closed`);
  const revision = getNextEntityRevision(db, companyId, 'period', entityId, period.server_revision);
  if (normalized.baseRevision !== null && normalized.baseRevision !== revision) throw createCommandError('REVISION_CONFLICT', 'Period revision changed');
  if (payload.endDate < period.start_date) throw createCommandError('INVALID_PERIOD_RANGE', 'Period endDate precedes its startDate');
  if (payload.nextPeriod.startDate <= payload.endDate) throw createCommandError('INVALID_PERIOD_RANGE', 'Next period must start after the closed period endDate');
  if (db.prepare('SELECT id FROM periods WHERE company_id = ? AND id = ?').get(companyId, payload.nextPeriod.id)) {
    throw createCommandError('ENTITY_ALREADY_EXISTS', `Next period "${payload.nextPeriod.id}" already exists`);
  }

  const activeParties = db.prepare(`
    SELECT id, sizes_json, archived_patta_numbers_json
    FROM parties WHERE company_id = ? AND status != 'CLOSED' AND is_closed = 0 ORDER BY id
  `).all(companyId);
  const periodTickets = db.prepare(`
    SELECT party_record_id, patta_number FROM tickets
    WHERE company_id = ? AND is_closed = 0 AND (
      period_id = ? OR (period_id IS NULL AND date(submitted_at) >= date(?) AND date(submitted_at) <= date(?))
    ) ORDER BY party_record_id, patta_number
  `).all(companyId, entityId, period.start_date, payload.endDate);
  const ticketsByParty = new Map();
  for (const ticket of periodTickets) {
    if (!ticket.party_record_id) continue;
    const submitted = ticketsByParty.get(ticket.party_record_id) || [];
    submitted.push(Number(ticket.patta_number));
    ticketsByParty.set(ticket.party_record_id, submitted);
  }
  const completedPartyIds = [];
  const rolledOverParties = [];
  for (const party of activeParties) {
    let archived = [];
    let sizes = {};
    if (party.sizes_json) {
      try {
        sizes = JSON.parse(party.sizes_json);
        if (!sizes || typeof sizes !== 'object' || Array.isArray(sizes)) throw new Error('party sizes must be an object');
      } catch (error) {
        throw createCommandError('INVALID_PARTY_SIZES', `Party "${party.id}" has invalid sizes`, { cause: error.message });
      }
    }
    if (party.archived_patta_numbers_json) {
      try {
        const parsed = JSON.parse(party.archived_patta_numbers_json);
        if (!Array.isArray(parsed)) throw new Error('archived patta numbers must be an array');
        archived = parsed.map((number, index) => assertNonNegativeInteger(number, `archivedPattaNumbers[${index}]`));
      } catch (error) {
        throw createCommandError('INVALID_PARTY_ARCHIVE', `Party "${party.id}" has invalid archived patta numbers`, { cause: error.message });
      }
    }
    const completedPattaNumbers = new Set([...archived, ...(ticketsByParty.get(party.id) || [])]);
    const totalPattas = Object.values(sizes).reduce((total, count) => {
      const parsed = Number.parseInt(String(count || 0), 10);
      return parsed > 0 ? total + parsed : total;
    }, 0);
    if (totalPattas > 0 && completedPattaNumbers.size >= totalPattas) {
      completedPartyIds.push(party.id);
    } else {
      rolledOverParties.push({ partyRecordId: party.id, archivedPattaNumbers: [...completedPattaNumbers] });
    }
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE periods SET end_date = ?, is_closed = 1, closed_at = ?, archive_filename = ?,
      status = 'CLOSED', updated_at = ? WHERE company_id = ? AND id = ?
  `).run(payload.endDate, now, payload.archiveFilename, now, companyId, entityId);
  db.prepare(`
    INSERT INTO periods (id, company_id, name, start_date, is_closed, status, created_at, updated_at, server_revision, provenance)
    VALUES (?, ?, ?, ?, 0, 'OPEN', ?, ?, 0, 'LOCAL_COMMAND')
  `).run(payload.nextPeriod.id, companyId, payload.nextPeriod.name, payload.nextPeriod.startDate, now, now);

  const completeParty = db.prepare(`
    UPDATE parties SET status = 'CLOSED', is_closed = 1, closed_at = ?, updated_at = ?
    WHERE company_id = ? AND id = ? AND status != 'CLOSED'
  `);
  for (const partyId of completedPartyIds) {
    const result = completeParty.run(now, now, companyId, partyId);
    if (result.changes !== 1) throw createCommandError('PARTY_NOT_FOUND', `Completed party "${partyId}" was not found or is closed`);
  }
  const rolloverParty = db.prepare(`
    UPDATE parties SET archived_patta_numbers_json = ?, updated_at = ?
    WHERE company_id = ? AND id = ? AND status != 'CLOSED'
  `);
  for (const party of rolledOverParties) {
    const result = rolloverParty.run(JSON.stringify(party.archivedPattaNumbers), now, companyId, party.partyRecordId);
    if (result.changes !== 1) throw createCommandError('PARTY_NOT_FOUND', `Rollover party "${party.partyRecordId}" was not found or is closed`);
  }
  db.prepare(`
    UPDATE tickets SET is_closed = 1
    WHERE company_id = ? AND (
      period_id = ? OR (period_id IS NULL AND date(submitted_at) >= date(?) AND date(submitted_at) <= date(?))
    )
  `).run(companyId, entityId, period.start_date, payload.endDate);
  db.prepare('DELETE FROM local_ticket_forms WHERE company_id = ?').run(companyId);

  if (normalized.localArchiveJson) {
    const archive = JSON.parse(normalized.localArchiveJson);
    archive.completedPartiesCount = completedPartyIds.length;
    archive.rolledOverPartiesCount = rolledOverParties.length;
    const localArchiveJson = JSON.stringify(archive);
    const sha256 = computePayloadHash(canonicalStringify(archive));
    db.prepare(`
      INSERT INTO period_archives (company_id, period_id, archive_json, sha256, archived_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(company_id, period_id) DO UPDATE SET archive_json = excluded.archive_json, sha256 = excluded.sha256, archived_at = excluded.archived_at
    `).run(companyId, entityId, localArchiveJson, sha256, now);
  }
  return revision;
}

function executeCompletePattaBatch(db, normalized) {
  const sequence = db.prepare(`
    SELECT next_patta_number FROM company_patta_sequences WHERE company_id = ?
  `).get(normalized.companyId);
  let nextPattaNumber = Number(sequence?.next_patta_number || 1);
  for (const party of normalized.payload.parties) {
    const current = db.prepare(`
      SELECT id, patta_count, cumulative_patta_count, patta_start_number, patta_end_number,
        EXISTS (SELECT 1 FROM legacy_party_collision_exceptions e
          WHERE e.company_id = parties.company_id AND e.party_id = parties.id AND e.status = 'ACTIVE') AS is_protected
      FROM parties WHERE company_id = ? AND id = ?
    `).get(normalized.companyId, party.partyRecordId);
    if (current) {
      if (current.is_protected) continue;
      if (Number(current.patta_count) !== party.pattaCount) {
        throw createCommandError('IMMUTABLE_PATTA_RANGE', 'An existing printed party cannot change its patta count');
      }
      party.pattaStartNumber = current.patta_start_number;
      party.pattaEndNumber = current.patta_end_number;
      party.cumulativePattaCount = Number(current.patta_end_number || current.cumulative_patta_count || 0);
      updatePartyRecord(db, normalized.companyId, party);
    } else {
      if (party.pattaCount < 1) throw createCommandError('INVALID_PATTA_COUNT', 'A printed party must contain at least one patta');
      party.pattaStartNumber = nextPattaNumber;
      party.pattaEndNumber = nextPattaNumber + party.pattaCount - 1;
      if (!Number.isSafeInteger(party.pattaEndNumber)) throw createCommandError('INVALID_PATTA_COUNT', 'Patta sequence exceeds the safe integer range');
      party.cumulativePattaCount = party.pattaEndNumber;
      nextPattaNumber = party.pattaEndNumber + 1;
      insertPartyRecord(db, normalized.companyId, party);
    }
  }
  db.prepare(`
    INSERT INTO company_patta_sequences(company_id, next_patta_number, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(company_id) DO UPDATE SET next_patta_number = excluded.next_patta_number, updated_at = excluded.updated_at
  `).run(normalized.companyId, nextPattaNumber, new Date().toISOString());
  writeBatchSettings(db, normalized.companyId, {
    availableSizes: normalized.payload.availableSizes,
    configs: normalized.payload.configs
  });
  return 0;
}

function executeCompletePartySeries(db, normalized) {
  const now = new Date().toISOString();
  const period = db.prepare('SELECT id, start_date, end_date FROM periods WHERE company_id = ? AND id = ? AND is_closed = 0')
    .get(normalized.companyId, normalized.payload.periodId);
  if (!period) throw createCommandError('PERIOD_NOT_FOUND', `Open period "${normalized.payload.periodId}" was not found`);
  if (normalized.payload.endDate < period.start_date || (period.end_date && normalized.payload.endDate > period.end_date)) {
    throw createCommandError('INVALID_PERIOD_RANGE', 'Party series close date is outside the open period');
  }
  db.prepare(`
    UPDATE parties SET status = 'CLOSED', is_closed = 1, closed_at = ?, updated_at = ?
    WHERE company_id = ? AND status != 'CLOSED'
  `).run(now, now, normalized.companyId);
  db.prepare(`UPDATE tickets SET is_closed = 1 WHERE company_id = ? AND (
    period_id = ? OR (period_id IS NULL AND date(submitted_at) >= date(?) AND date(submitted_at) <= date(?))
  )`).run(normalized.companyId, normalized.payload.periodId, period.start_date, normalized.payload.endDate);
  db.prepare(`
    UPDATE patta_batch_settings SET party_number = '', is_custom_party = 0, total_ish_soni = '',
      sizes_json = '{}', updated_at = ? WHERE company_id = ?
  `).run(now, normalized.companyId);
  return 0;
}

function normalizeTicketDraft(companyId, modelId, form) {
  const input = assertObject(form, 'ticketForm');
  const entries = assertObject(input.entries || {}, 'ticketForm.entries');
  const normalizedEntries = {};
  for (const [operationName, workerId] of Object.entries(entries)) {
    const name = assertText(operationName, 'ticketForm.entries key', 256);
    if (typeof workerId !== 'string' && typeof workerId !== 'number') throw createCommandError('INVALID_TICKET_DRAFT', 'Worker selection must be a string or number');
    normalizedEntries[name] = String(workerId);
  }
  const textField = (field, fallback = '') => input[field] === undefined || input[field] === null ? fallback : String(input[field]);
  const draft = {
    date: textField('date'),
    konveyer: textField('konveyer'),
    party: textField('party'),
    color: textField('color'),
    size: textField('size'),
    qty: textField('qty'),
    patta: textField('patta'),
    entries: normalizedEntries
  };
  const json = canonicalStringify(draft);
  if (Buffer.byteLength(json, 'utf8') > 16 * 1024) throw createCommandError('TICKET_DRAFT_TOO_LARGE', 'Ticket form draft exceeds 16 KiB');
  return { companyId, modelId, json };
}

function saveTicketDraft(baseUserDataPath, activeCompanyId, companyId, modelId, form) {
  const validCompanyId = assertText(companyId, 'companyId', 64);
  assertCompanyContext(activeCompanyId, validCompanyId);
  const validModelId = assertEntityKey(modelId, 'modelId');
  const draft = normalizeTicketDraft(validCompanyId, validModelId, form);
  const db = getCompanyDatabase(baseUserDataPath, validCompanyId);
  return db.transaction(() => {
    const model = db.prepare(`SELECT id FROM models WHERE company_id = ? AND id = ? AND status = 'ACTIVE'`).get(validCompanyId, validModelId);
    if (!model) throw createCommandError('MODEL_NOT_FOUND', `Active model "${validModelId}" was not found`);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO local_ticket_forms (company_id, model_id, form_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(company_id, model_id) DO UPDATE SET form_json = excluded.form_json, updated_at = excluded.updated_at
    `).run(draft.companyId, draft.modelId, draft.json, now);
    return { success: true, savedAt: now };
  }).immediate();
}

function executeWorkbookCommand(baseUserDataPath, activeCompanyId, command, options = {}) {
  const normalized = normalizeCommand(command, activeCompanyId);
  const payloadJson = canonicalStringify({
    ...normalized.payload,
    dependsOnOperationId: normalized.dependsOnOperationId,
    causalSequence: normalized.causalSequence
  });
  if (Buffer.byteLength(payloadJson, 'utf8') > 64 * 1024) {
    throw createCommandError('PAYLOAD_TOO_LARGE', 'Workbook command exceeds the 64 KiB  operation limit');
  }
  const payloadHash = computePayloadHash(payloadJson);
  const db = getCompanyDatabase(baseUserDataPath, normalized.companyId);
  const result = db.transaction(() => {
    const existingOperation = getOperation(db, normalized.companyId, normalized.operationId);
    if (existingOperation) {
      if (
        existingOperation.command_type === normalized.commandType &&
        existingOperation.entity_type === normalized.entityType &&
        existingOperation.entity_id === normalized.entityId &&
        existingOperation.payload_hash === payloadHash
      ) {
        return {
          commandId: normalized.commandId,
          operationId: normalized.operationId,
          entityId: normalized.entityId,
          status: 'PENDING_SYNC',
          committed: true,
          isReplay: true
        };
      }
      throw createCommandError('IDEMPOTENCY_CONFLICT', `Operation "${normalized.operationId}" was already used for different workbook data`);
    }

    const effectiveBaseRevision = executeWorkbookMutation(db, normalized, options);

    if (typeof options.testHooks?.afterFactWrite === 'function') options.testHooks.afterFactWrite();
    insertOutboxOperation(db, {
      operation_id: normalized.operationId,
      company_id: normalized.companyId,
      command_type: normalized.commandType,
      entity_type: normalized.entityType,
      entity_id: normalized.entityId,
      base_revision: effectiveBaseRevision,
      payload_json: payloadJson,
      payload_hash: payloadHash,
      depends_on_operation_id: normalized.dependsOnOperationId,
      causal_sequence: normalized.causalSequence,
      status: 'PENDING',
      created_at: new Date().toISOString()
    });
    if (typeof options.testHooks?.afterOutboxWrite === 'function') options.testHooks.afterOutboxWrite();

    return {
      commandId: normalized.commandId,
      operationId: normalized.operationId,
      entityId: normalized.entityId,
      status: 'PENDING_SYNC',
      committed: true,
      isReplay: false
    };
  }).immediate();

  try {
    result.projections = rebuildCompanyProjections(baseUserDataPath, normalized.companyId);
  } catch (error) {
    console.warn('[WorkbookCommandPipeline] Projection rebuild warning:', error.message);
  }
  return result;
}

module.exports = {
  COMMAND_ENTITY_TYPES,
  executeWorkbookCommand,
  saveTicketDraft,
  getNextEntityRevision,
  normalizeCommand
};
