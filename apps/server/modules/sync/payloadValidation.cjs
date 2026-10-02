'use strict';

const { canonicalStringify } = require('./canonicalPayload.cjs');

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_OPERATIONS = 100;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_ARRAY_ITEMS = 1000;
const MAX_OBJECT_KEYS = 128;
const MAX_DEPTH = 12;
const MAX_STRING_LENGTH = 4096;

const COMMANDS = Object.freeze({
  SubmitTicket: { entityType: 'ticket', entityId: 'ticketId' },
  RecordProductionAdjustment: { entityType: 'production_adjustment', entityId: 'adjustmentId' },
  ReverseProductionAdjustment: { entityType: 'production_adjustment', entityId: 'adjustmentId' },
  CreateParty: { entityType: 'party', entityId: 'partyRecordId' },
  UpdateParty: { entityType: 'party', entityId: 'partyRecordId' },
  CloseParty: { entityType: 'party', entityId: 'partyRecordId' },
  ArchivePartyHistory: { entityType: 'party_history', entityId: 'companyId' },
  UpsertModel: { entityType: 'model', entityId: 'modelId' },
  DeactivateModel: { entityType: 'model', entityId: 'modelId' },
  UpsertWorker: { entityType: 'worker', entityId: 'workerId' },
  DeactivateWorker: { entityType: 'worker', entityId: 'workerId' },
  CreatePeriod: { entityType: 'period', entityId: 'periodId' },
  UpdatePeriod: { entityType: 'period', entityId: 'periodId' },
  ClosePeriod: { entityType: 'period', entityId: 'periodId' },
  UpdateBatchSettings: { entityType: 'batch_settings', entityId: 'companyId' },
  CompletePattaBatch: { entityType: 'patta_batch', entityId: 'batchId' },
  CompletePartySeries: { entityType: 'party_series', entityId: 'periodId' },
  DeleteTicket: { entityType: 'ticket', entityId: 'ticketId' },
  ResolveMigrationReconciliationCandidate: {
    entityType: 'reconciliation_candidate',
    entityId: 'candidateId'
  }
});

const RECONCILIATION_DECISIONS = Object.freeze([
  'CONFIRM_LEGACY_AS_ADJUSTMENT',
  'REJECT_LEGACY_DIFFERENCE',
  'LINK_TO_MISSING_SOURCE',
  'DEFER_REVIEW'
]);

const AUTHORITY_FIELDS = Object.freeze([
  'operator',
  'operatorId',
  'operatorRole',
  'role',
  'admin',
  'accountant',
  'serverRevision',
  'grandfathered',
  'legacyException',
  'exceptionGroupId',
  'approvedBy'
]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function resolveEnvelopeAlias(operation, camelField, snakeField, label = camelField) {
  const hasCamel = hasOwn(operation, camelField);
  const hasSnake = hasOwn(operation, snakeField);
  if (hasCamel && hasSnake && !Object.is(operation[camelField], operation[snakeField])) {
    throw createValidationError('FIELD_CONFLICT', `${label} aliases must match`, {
      fields: [camelField, snakeField]
    });
  }
  if (hasCamel) return operation[camelField];
  if (hasSnake) return operation[snakeField];
  return undefined;
}

function createValidationError(code, message, details = null) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.details = details;
  error.statusCode = 400;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function assertPlainObject(value, code = 'INVALID_PAYLOAD') {
  if (!isPlainObject(value)) {
    throw createValidationError(code, 'Expected a bounded plain object');
  }
  if (Object.keys(value).length > MAX_OBJECT_KEYS) {
    throw createValidationError('PAYLOAD_TOO_LARGE', 'Object contains too many fields');
  }
  return value;
}

function assertBoundedValue(value, path = 'payload', depth = 0) {
  if (depth > MAX_DEPTH) {
    throw createValidationError('PAYLOAD_TOO_DEEP', 'Payload nesting exceeds the supported depth', { path });
  }

  if (value === null) return value;
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH || value.includes('\u0000')) {
      throw createValidationError('STRING_TOO_LONG', 'String exceeds the supported size', { path });
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw createValidationError('INVALID_NUMBER', 'Numeric values must be finite', { path });
    }
    return value;
  }
  if (typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      throw createValidationError('ARRAY_TOO_LARGE', 'Array contains too many items', { path });
    }
    value.forEach((item, index) => assertBoundedValue(item, `${path}[${index}]`, depth + 1));
    return value;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > MAX_OBJECT_KEYS) {
      throw createValidationError('PAYLOAD_TOO_LARGE', 'Object contains too many fields', { path });
    }
    for (const key of keys) {
      if (key.length > 128) {
        throw createValidationError('FIELD_NAME_TOO_LONG', 'Field name exceeds the supported size', { path });
      }
      assertBoundedValue(value[key], `${path}.${key}`, depth + 1);
    }
    return value;
  }

  throw createValidationError('INVALID_PAYLOAD_VALUE', 'Payload contains an unsupported value type', { path });
}

function assertPayloadSize(payload) {
  let canonical;
  try {
    canonical = canonicalStringify(payload);
  } catch (error) {
    throw createValidationError('INVALID_PAYLOAD_VALUE', 'Payload cannot be canonically serialized');
  }
  if (Buffer.byteLength(canonical, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw createValidationError('PAYLOAD_TOO_LARGE', 'Payload exceeds the 64 KiB limit');
  }
}

function normalizeText(value, field, options = {}) {
  const { identifier = false, company = false, maxLength = MAX_STRING_LENGTH } = options;
  if (typeof value !== 'string') {
    throw createValidationError('INVALID_FIELD_TYPE', `${field} must be a string`, { field });
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\u0000')) {
    throw createValidationError('INVALID_FIELD', `${field} must be a bounded non-empty string`, { field });
  }
  if (identifier && !IDENTIFIER.test(normalized)) {
    throw createValidationError('INVALID_IDENTIFIER', `${field} contains unsupported identifier characters`, { field });
  }
  if (company && !COMPANY_ID.test(normalized)) {
    throw createValidationError('INVALID_COMPANY_ID', `${field} contains an invalid company identifier`, { field });
  }
  return normalized;
}

function strictText(value, field, options = {}) {
  const { whitespaceCode = 'INVALID_FIELD' } = options;
  const normalized = normalizeText(value, field, options);
  if (value !== normalized) {
    throw createValidationError(whitespaceCode, `${field} must not have leading or trailing whitespace`, { field });
  }
  return normalized;
}

function optionalText(payload, field, options = {}) {
  if (!hasOwn(payload, field) || payload[field] === undefined || payload[field] === null) return undefined;
  return normalizeText(payload[field], field, options);
}

function requiredIdentifier(payload, fields, label = fields[0]) {
  const present = fields.filter((field) => hasOwn(payload, field) && payload[field] !== undefined && payload[field] !== null);
  if (present.length === 0) {
    throw createValidationError('MISSING_FIELD', `${label} is required`, { field: label });
  }

  const first = normalizeText(payload[present[0]], label, { identifier: true });
  for (const field of present.slice(1)) {
    const other = normalizeText(payload[field], field, { identifier: true });
    if (other !== first) {
      throw createValidationError('FIELD_CONFLICT', `${label} aliases must match`, { fields: present });
    }
  }
  return first;
}

function requiredEntityKey(value, field = 'entityId', maxLength = 128) {
  return normalizeText(value, field, { maxLength });
}

function revisionContext(payload, context) {
  const payloadRevision = optionalNumber(payload, 'baseRevision', { safeInteger: true, min: 0 });
  const envelopeRevision = context.baseRevision !== undefined
    ? context.baseRevision
    : context.operation?.baseRevision;
  if (envelopeRevision !== undefined && envelopeRevision !== null &&
      payloadRevision !== undefined && envelopeRevision !== payloadRevision) {
    throw createValidationError('FIELD_CONFLICT', 'Envelope and payload baseRevision values must match', {
      fields: ['baseRevision']
    });
  }
  return payloadRevision !== undefined ? payloadRevision : envelopeRevision;
}

function optionalIdentifier(payload, field) {
  if (!hasOwn(payload, field) || payload[field] === undefined || payload[field] === null) return undefined;
  return normalizeText(payload[field], field, { identifier: true });
}

function requiredCompany(value, field = 'companyId') {
  return normalizeText(value, field, { company: true });
}

function finiteNumber(value, field, options = {}) {
  const { integer = false, safeInteger = false, min = -Infinity, nonZero = false } = options;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw createValidationError('INVALID_NUMBER', `${field} must be a finite number`, { field });
  }
  if ((integer && !Number.isInteger(value)) || (safeInteger && !Number.isSafeInteger(value))) {
    throw createValidationError('INVALID_NUMBER', `${field} must be an integer`, { field });
  }
  if (value < min || (nonZero && value === 0)) {
    throw createValidationError('INVALID_QUANTITY', `${field} is outside the allowed range`, { field });
  }
  return value;
}

function optionalNumber(payload, field, options = {}) {
  if (!hasOwn(payload, field) || payload[field] === undefined || payload[field] === null) return undefined;
  return finiteNumber(payload[field], field, options);
}

function positiveQuantity(value, field) {
  return finiteNumber(value, field, { safeInteger: true, min: 1 });
}

function nonNegativeInteger(value, field) {
  return finiteNumber(value, field, { safeInteger: true, min: 0 });
}

function workerReference(value, field) {
  if (typeof value === 'number') {
    return nonNegativeInteger(value, field);
  }
  if (typeof value === 'string') {
    const normalized = normalizeText(value, field, { identifier: true });
    if (!/^\d+$/.test(normalized)) {
      throw createValidationError('INVALID_WORKER_ID', `${field} must match the integer worker reference contract`, { field });
    }
    return normalized;
  }
  throw createValidationError('INVALID_WORKER_ID', `${field} must be a worker identifier`, { field });
}

function validCalendarDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateValue(payload, field, options = {}) {
  if (!hasOwn(payload, field) || payload[field] === undefined || payload[field] === null) return undefined;
  if (typeof payload[field] !== 'string') {
    throw createValidationError('INVALID_DATE', `${field} must be a date string`, { field });
  }
  const value = payload[field].trim();
  const timestampDate = /^\d{4}-\d{2}-\d{2}T/.test(value) ? value.slice(0, 10) : null;
  const valid = options.calendarOnly
    ? validCalendarDate(value)
    : (validCalendarDate(value) || (
      timestampDate !== null &&
      validCalendarDate(timestampDate) &&
      !Number.isNaN(Date.parse(value))
    ));
  if (!valid) {
    throw createValidationError('INVALID_DATE', `${field} is not a valid ISO date`, { field });
  }
  return value;
}

function rejectAuthorityFields(payload, fields = AUTHORITY_FIELDS) {
  const found = fields.find((field) => hasOwn(payload, field));
  if (found) {
    throw createValidationError('FORBIDDEN_AUTHORITY_FIELD', `${found} is server-authoritative and cannot be supplied by the client`, { field: found });
  }
}

function assertEntity(operation, commandType, entityId) {
  const contract = COMMANDS[commandType];
  if (operation && operation.entityType !== contract.entityType) {
    throw createValidationError('ENTITY_TYPE_MISMATCH', `entityType does not match ${commandType}`, {
      expected: contract.entityType
    });
  }
  if (operation && operation.entityId !== entityId) {
    throw createValidationError('ENTITY_ID_MISMATCH', `entityId does not match ${commandType}`, {
      field: contract.entityId
    });
  }
}

function validateReconciliationContext(context = {}) {
  const operator = context.auth?.operator;
  if (!operator || typeof operator.operatorId !== 'string' || !operator.operatorId.trim() ||
      typeof operator.companyId !== 'string' || typeof operator.deviceId !== 'string' ||
      typeof context.auth?.companyId !== 'string' || typeof context.auth?.deviceId !== 'string' ||
      operator.companyId !== context.auth.companyId || operator.deviceId !== context.auth.deviceId ||
      operator.isActive !== true || !['admin', 'accountant'].includes(operator.role)) {
    throw createValidationError(
      'RECONCILIATION_RBAC_BLOCKED',
      'A current, active admin or accountant operator session bound to this device and company is required.'
    );
  }
  return {
    operatorId: normalizeText(operator.operatorId, 'operatorId', { identifier: true }),
    role: operator.role
  };
}

function validateOperationVersion(operation) {
  for (const [field, snakeField] of [['version', 'version'], ['protocolVersion', 'protocol_version'], ['schemaVersion', 'schema_version']]) {
    const hasField = hasOwn(operation, field) || hasOwn(operation, snakeField);
    if (!hasField) continue;
    const value = field === snakeField ? operation[field] : resolveEnvelopeAlias(operation, field, snakeField);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value !== 1) {
      throw createValidationError('UNSUPPORTED_VERSION', `${field} is not supported`, { field, supported: [1] });
    }
  }
}

function validateOperationEnvelope(operation) {
  assertPlainObject(operation, 'INVALID_OPERATION_ENVELOPE');
  assertBoundedValue(operation, 'operation');
  validateOperationVersion(operation);

  const rawOperationId = resolveEnvelopeAlias(operation, 'operationId', 'operation_id');
  if (typeof rawOperationId !== 'string' || !IDENTIFIER.test(rawOperationId.trim())) {
    throw createValidationError('INVALID_OPERATION_ID', 'operationId is required and must be a bounded identifier');
  }
  const operationId = rawOperationId.trim();
  const rawCompanyId = resolveEnvelopeAlias(operation, 'companyId', 'company_id');
  if (typeof rawCompanyId !== 'string' || !COMPANY_ID.test(rawCompanyId.trim())) {
    throw createValidationError('INVALID_COMPANY_ID', 'companyId is required and must be a bounded company identifier');
  }
  const companyId = rawCompanyId.trim();
  const rawCommandId = resolveEnvelopeAlias(operation, 'commandId', 'command_id');
  const hasCommandId = hasOwn(operation, 'commandId') || hasOwn(operation, 'command_id');
  const commandId = hasCommandId
    ? normalizeText(rawCommandId, 'commandId', { identifier: true })
    : undefined;
  const commandType = strictText(
    resolveEnvelopeAlias(operation, 'commandType', 'command_type'),
    'commandType'
  );
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, commandType)) {
    throw createValidationError('UNKNOWN_COMMAND', `Unsupported command type: ${commandType}`, { commandType });
  }

  const entityType = strictText(
    resolveEnvelopeAlias(operation, 'entityType', 'entity_type'),
    'entityType',
    { identifier: true }
  );
  const rawEntityId = resolveEnvelopeAlias(operation, 'entityId', 'entity_id');
  if (typeof rawEntityId !== 'string') throw createValidationError('INVALID_ENTITY_ID', 'entityId is required and must be a bounded identifier');
  const entityId = requiredEntityKey(rawEntityId, 'entityId');
  if (entityType !== COMMANDS[commandType].entityType) {
    throw createValidationError('ENTITY_TYPE_MISMATCH', `entityType does not match ${commandType}`, {
      expected: COMMANDS[commandType].entityType
    });
  }

  const hashValue = resolveEnvelopeAlias(operation, 'payloadHash', 'payload_hash');
  if (typeof hashValue !== 'string' || !HASH.test(hashValue)) {
    throw createValidationError('INVALID_PAYLOAD_HASH', 'payloadHash must be 64 lowercase hexadecimal characters');
  }
  const baseRevision = resolveEnvelopeAlias(operation, 'baseRevision', 'base_revision');
  if (baseRevision !== undefined && baseRevision !== null) {
    finiteNumber(baseRevision, 'baseRevision', { safeInteger: true, min: 0 });
  }

  const hasPayload = hasOwn(operation, 'payload');
  const hasPayloadJson = hasOwn(operation, 'payload_json');
  let payload;
  let parsedPayloadJson;
  if (hasPayload) {
    assertPlainObject(operation.payload, 'INVALID_PAYLOAD');
    payload = operation.payload;
  }
  if (hasPayloadJson) {
    if (typeof operation.payload_json !== 'string') {
      throw createValidationError('INVALID_FIELD_TYPE', 'payload_json must be a JSON string', { field: 'payload_json' });
    }
    if (Buffer.byteLength(operation.payload_json, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw createValidationError('PAYLOAD_TOO_LARGE', 'payload_json exceeds the 64 KiB limit');
    }
    try {
      parsedPayloadJson = JSON.parse(operation.payload_json);
    } catch (error) {
      throw createValidationError('MALFORMED_PAYLOAD_JSON', 'payload_json is not valid JSON');
    }
    assertPlainObject(parsedPayloadJson, 'INVALID_PAYLOAD');
    if (payload !== undefined && canonicalStringify(payload) !== canonicalStringify(parsedPayloadJson)) {
      throw createValidationError('PAYLOAD_CONFLICT', 'payload and payload_json must be semantically identical');
    }
    payload = parsedPayloadJson;
  }
  if (!hasPayload && !hasPayloadJson) {
    throw createValidationError('MISSING_PAYLOAD', 'Operation must contain a payload object');
  }

  assertPlainObject(payload, 'INVALID_PAYLOAD');
  assertBoundedValue(payload);
  assertPayloadSize(payload);

  return {
    commandId,
    operationId,
    companyId,
    commandType,
    entityType,
    entityId,
    payloadHash: hashValue,
    baseRevision,
    payload
  };
}

function validateSubmitTicket(payload, context) {
  rejectAuthorityFields(payload, [...AUTHORITY_FIELDS, 'status']);
  if (Array.isArray(payload.entries)) {
    payload.entries.forEach((entry) => rejectAuthorityFields(entry));
  }

  const commandId = requiredIdentifier(payload, ['commandId']);
  const operationId = requiredIdentifier(payload, ['operationId']);
  const causal = validateCausalFields(payload, operationId);
  const companyId = requiredCompany(payload.companyId);
  if (context.companyId && companyId !== context.companyId) {
    throw createValidationError('COMPANY_SCOPE_MISMATCH', 'Command companyId does not match authenticated company');
  }
  if (context.operation?.operationId && operationId !== context.operation.operationId) {
    throw createValidationError('OPERATION_ID_MISMATCH', 'Command operationId does not match envelope operationId');
  }

  const ticketId = requiredIdentifier(payload, ['ticketId']);
  if (!UUID.test(ticketId)) {
    throw createValidationError('INVALID_TICKET_UUID', 'ticketId must be an RFC 4122 canonical UUID', { field: 'ticketId' });
  }
  const modelId = requiredEntityKey(payload.modelId, 'modelId');
  const periodId = optionalIdentifier(payload, 'periodId');
  const partyNumber = normalizeText(payload.partyNumber, 'partyNumber', { maxLength: 64 });
  const partyRecordId = payload.partyRecordId === undefined || payload.partyRecordId === null
    ? null
    : requiredEntityKey(payload.partyRecordId, 'partyRecordId');
  const pattaNumber = nonNegativeInteger(payload.pattaNumber, 'pattaNumber');
  const qty = positiveQuantity(payload.qty, 'qty');

  if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
    throw createValidationError('INVALID_ENTRIES', 'entries must be a non-empty array');
  }
  if (payload.entries.length > MAX_ARRAY_ITEMS) {
    throw createValidationError('ARRAY_TOO_LARGE', 'entries contains too many items');
  }
  const entries = payload.entries.map((entry, index) => {
    assertPlainObject(entry, 'INVALID_ENTRY');
    const opName = normalizeText(entry.opName, `entries[${index}].opName`, { maxLength: 256 });
    const workerId = workerReference(entry.workerId, `entries[${index}].workerId`);
    const result = { ...entry, opName, workerId };
    if (hasOwn(entry, 'qty') && entry.qty !== undefined && entry.qty !== null) {
      result.qty = finiteNumber(entry.qty, `entries[${index}].qty`, { min: 0 });
    }
    if (hasOwn(entry, 'rateSnapshot') && entry.rateSnapshot !== undefined && entry.rateSnapshot !== null) {
      result.rateSnapshot = finiteNumber(entry.rateSnapshot, `entries[${index}].rateSnapshot`);
    }
    if (hasOwn(entry, 'workerNameSnapshot') && entry.workerNameSnapshot !== undefined && entry.workerNameSnapshot !== null) {
      result.workerNameSnapshot = normalizeText(entry.workerNameSnapshot, `entries[${index}].workerNameSnapshot`);
    }
    if (hasOwn(entry, 'brak') && entry.brak !== undefined && entry.brak !== null) {
      result.brak = normalizeText(entry.brak, `entries[${index}].brak`);
    }
    return result;
  });

  const normalized = {
    ...payload,
    commandId,
    operationId,
    companyId,
    ticketId,
    modelId,
    partyNumber,
    partyRecordId,
    pattaNumber,
    qty,
    entries
  };
  if (periodId !== undefined) normalized.periodId = periodId;
  for (const field of ['effectiveDate', 'submittedAt']) {
    const value = dateValue(payload, field, { calendarOnly: field === 'effectiveDate' });
    if (value !== undefined) normalized[field] = value;
  }
  for (const field of ['konveyer', 'size', 'color']) {
    const value = optionalText(payload, field, { maxLength: 64 });
    if (value !== undefined) normalized[field] = value;
  }
  for (const field of ['originDeviceId', 'originUserId']) {
    const value = optionalText(payload, field, { maxLength: 128 });
    if (value !== undefined) normalized[field] = value;
  }
  Object.assign(normalized, causal);
  assertEntity(context.operation, 'SubmitTicket', ticketId);
  return normalized;
}

function validateRecordAdjustment(payload, context) {
  rejectAuthorityFields(payload);
  const commandId = requiredIdentifier(payload, ['commandId']);
  const operationId = requiredIdentifier(payload, ['operationId']);
  const causal = validateCausalFields(payload, operationId);
  const companyId = requiredCompany(payload.companyId);
  if (context.companyId && companyId !== context.companyId) {
    throw createValidationError('COMPANY_SCOPE_MISMATCH', 'Command companyId does not match authenticated company');
  }
  if (context.operation?.operationId && operationId !== context.operation.operationId) {
    throw createValidationError('OPERATION_ID_MISMATCH', 'Command operationId does not match envelope operationId');
  }

  const adjustmentId = requiredIdentifier(payload, ['adjustmentId']);
  const modelId = requiredEntityKey(payload.modelId, 'modelId');
  const workerId = workerReference(payload.workerId, 'workerId');
  const opName = normalizeText(payload.opName, 'opName', { maxLength: 256 });
  const deltaQty = finiteNumber(payload.deltaQty, 'deltaQty', { nonZero: true });
  const reason = optionalText(payload, 'reason');
  const createdBy = optionalText(payload, 'createdBy');
  const status = hasOwn(payload, 'status')
    ? strictText(payload.status, 'status', { maxLength: 32, whitespaceCode: 'INVALID_ADJUSTMENT_STATUS' })
    : 'APPROVED';
  if (status !== undefined && !['APPROVED', 'PENDING_REVIEW'].includes(status)) {
    throw createValidationError('INVALID_ADJUSTMENT_STATUS', 'status is not a supported adjustment status');
  }
  const provenance = optionalText(payload, 'provenance', { maxLength: 128 });
  const effectiveDate = dateValue(payload, 'effectiveDate', { calendarOnly: true });
  const createdAt = dateValue(payload, 'createdAt');

  const normalized = {
    ...payload,
    commandId,
    operationId,
    companyId,
    adjustmentId,
    modelId,
    workerId,
    opName,
    deltaQty
  };
  for (const [field, value] of Object.entries({ reason, createdBy, status, provenance, effectiveDate, createdAt })) {
    if (value !== undefined) normalized[field] = value;
  }
  Object.assign(normalized, causal);
  assertEntity(context.operation, 'RecordProductionAdjustment', adjustmentId);
  return normalized;
}

function validateReverseAdjustment(payload, context) {
  rejectAuthorityFields(payload, [...AUTHORITY_FIELDS, 'status']);
  const commandId = requiredIdentifier(payload, ['commandId']);
  const operationId = requiredIdentifier(payload, ['operationId']);
  const causal = validateCausalFields(payload, operationId);
  const companyId = requiredCompany(payload.companyId);
  if (context.companyId && companyId !== context.companyId) {
    throw createValidationError('COMPANY_SCOPE_MISMATCH', 'Command companyId does not match authenticated company');
  }
  if (context.operation?.operationId && operationId !== context.operation.operationId) {
    throw createValidationError('OPERATION_ID_MISMATCH', 'Command operationId does not match envelope operationId');
  }

  const originalAdjustmentId = requiredIdentifier(payload, ['originalAdjustmentId']);
  const reversalId = requiredIdentifier(payload, ['adjustmentId', 'reversalId', 'reversalAdjustmentId'], 'adjustmentId');
  const createdBy = optionalText(payload, 'createdBy');
  const reason = optionalText(payload, 'reason');
  const payloadBaseRevision = optionalNumber(payload, 'baseRevision', { safeInteger: true, min: 0 });
  const envelopeBaseRevision = context.baseRevision !== undefined
    ? context.baseRevision
    : context.operation?.baseRevision;
  if (envelopeBaseRevision !== undefined && envelopeBaseRevision !== null &&
      payloadBaseRevision !== undefined && envelopeBaseRevision !== payloadBaseRevision) {
    throw createValidationError('FIELD_CONFLICT', 'Envelope and payload baseRevision values must match', {
      fields: ['baseRevision']
    });
  }
  const baseRevision = payloadBaseRevision !== undefined
    ? payloadBaseRevision
    : envelopeBaseRevision;
  const effectiveDate = dateValue(payload, 'effectiveDate', { calendarOnly: true });
  const createdAt = dateValue(payload, 'createdAt');

  const normalized = {
    ...payload,
    commandId,
    operationId,
    companyId,
    originalAdjustmentId,
    reversalId,
    adjustmentId: reversalId
  };
  for (const [field, value] of Object.entries({ createdBy, reason, baseRevision, effectiveDate, createdAt })) {
    if (value !== undefined) normalized[field] = value;
  }
  Object.assign(normalized, causal);
  assertEntity(context.operation, 'ReverseProductionAdjustment', reversalId);
  return normalized;
}

function validateSizeMap(value) {
  assertPlainObject(value, 'INVALID_SIZE_STRUCTURE');
  for (const [key, quantity] of Object.entries(value)) {
    normalizeText(key, 'sizes key', { maxLength: 64 });
    nonNegativeInteger(quantity, `sizes.${key}`);
  }
  return value;
}

function validateCausalFields(payload, operationId) {
  const dependsOnOperationId = optionalIdentifier(payload, 'dependsOnOperationId');
  let causalSequence;
  if (hasOwn(payload, 'causalSequence') && payload.causalSequence !== undefined && payload.causalSequence !== null) {
    if (typeof payload.causalSequence !== 'number' || !Number.isSafeInteger(payload.causalSequence) || payload.causalSequence < 0) {
      throw createValidationError('INVALID_CAUSAL_SEQUENCE', 'causalSequence must be a non-negative safe integer', {
        field: 'causalSequence'
      });
    }
    causalSequence = payload.causalSequence;
  }

  if (dependsOnOperationId !== undefined) {
    if (dependsOnOperationId === operationId) {
      throw createValidationError('SELF_CAUSAL_DEPENDENCY', `Operation "${operationId}" cannot depend on itself`);
    }
    if (causalSequence !== undefined && causalSequence < 1) {
      throw createValidationError(
        'INVALID_CAUSAL_SEQUENCE',
        'When dependsOnOperationId is present, causalSequence must be a safe integer >= 1'
      );
    }
    return { dependsOnOperationId, causalSequence: causalSequence === undefined ? 1 : causalSequence };
  }

  if (causalSequence !== undefined && causalSequence !== 0) {
    throw createValidationError('INVALID_CAUSAL_SEQUENCE', 'causalSequence must be zero without a dependency');
  }
  return { dependsOnOperationId: undefined, causalSequence: 0 };
}

function partyContextField(payload, field, context, validator, mismatchCode, required = true) {
  const expected = [];
  if (context.operation && context.operation[field] !== undefined && context.operation[field] !== null) {
    expected.push(context.operation[field]);
  }
  if (field === 'companyId' && context.companyId !== undefined && context.companyId !== null) {
    expected.push(context.companyId);
  }

  let value;
  if (hasOwn(payload, field)) {
    value = validator(payload[field], field);
  } else if (expected.length > 0) {
    value = expected[0];
  } else if (required) {
    throw createValidationError('MISSING_FIELD', `${field} is required`, { field });
  } else {
    return undefined;
  }

  if (expected.some((candidate) => value !== candidate)) {
    throw createValidationError(mismatchCode, `${field} does not match the operation or authenticated context`, { field });
  }
  return value;
}

function validateCreateParty(payload, context) {
  rejectAuthorityFields(payload, [...AUTHORITY_FIELDS, 'status', 'isClosed', 'is_closed', 'closedAt', 'closed_at', 'createdAt', 'created_at']);
  const commandId = partyContextField(payload, 'commandId', context, (value, field) => normalizeText(value, field, { identifier: true }), 'COMMAND_ID_MISMATCH', false);
  const operationId = partyContextField(payload, 'operationId', context, (value, field) => normalizeText(value, field, { identifier: true }), 'OPERATION_ID_MISMATCH');
  const companyId = partyContextField(payload, 'companyId', context, requiredCompany, 'COMPANY_SCOPE_MISMATCH');
  const causal = validateCausalFields(payload, operationId);

  const partyRecordId = requiredEntityKey(payload.partyRecordId ?? payload.id, 'partyRecordId');
  const partyNumber = normalizeText(payload.partyNumber, 'partyNumber', { maxLength: 64 });
  const modelId = requiredEntityKey(payload.modelId, 'modelId');
  const normalized = { ...payload, operationId, companyId, partyRecordId, modelId, partyNumber };
  if (commandId !== undefined) normalized.commandId = commandId;
  for (const field of ['physicalPartyNumber', 'modelName', 'color']) {
    const value = optionalText(payload, field, { maxLength: 256 });
    if (value !== undefined) normalized[field] = value;
  }
  for (const field of ['pattaCount', 'cumulativePattaCount']) {
    const value = optionalNumber(payload, field, { safeInteger: true, min: 0 });
    if (value !== undefined) normalized[field] = value;
  }
  for (const field of ['ishSoniPerPatta', 'totalIshSoni', 'ishSoni', 'cumulativeIshSoni']) {
    const value = optionalNumber(payload, field, { min: 0 });
    if (value !== undefined) normalized[field] = value;
  }
  if (hasOwn(payload, 'sizes') && payload.sizes !== undefined && payload.sizes !== null) {
    normalized.sizes = validateSizeMap(payload.sizes);
  }
  const printedAt = dateValue(payload, 'printedAt');
  if (printedAt !== undefined) normalized.printedAt = printedAt;
  Object.assign(normalized, causal);
  normalized.baseRevision = revisionContext(payload, context);
  assertEntity(context.operation, 'CreateParty', partyRecordId);
  return normalized;
}

function validateCloseParty(payload, context) {
  rejectAuthorityFields(payload, [...AUTHORITY_FIELDS, 'status', 'isClosed', 'is_closed', 'closedAt', 'closed_at']);
  const commandId = partyContextField(payload, 'commandId', context, (value, field) => normalizeText(value, field, { identifier: true }), 'COMMAND_ID_MISMATCH', false);
  const operationId = partyContextField(payload, 'operationId', context, (value, field) => normalizeText(value, field, { identifier: true }), 'OPERATION_ID_MISMATCH');
  const companyId = partyContextField(payload, 'companyId', context, requiredCompany, 'COMPANY_SCOPE_MISMATCH');
  const causal = validateCausalFields(payload, operationId);
  const partyRecordId = requiredEntityKey(payload.partyRecordId ?? payload.id, 'partyRecordId');
  const normalized = { ...payload, operationId, companyId, partyRecordId };
  if (commandId !== undefined) normalized.commandId = commandId;
  Object.assign(normalized, causal);
  normalized.baseRevision = revisionContext(payload, context);
  assertEntity(context.operation, 'CloseParty', partyRecordId);
  return normalized;
}

function validateWorkbookScope(payload, context) {
  const commandId = requiredIdentifier(payload, ['commandId']);
  const operationId = requiredIdentifier(payload, ['operationId']);
  const companyId = requiredCompany(payload.companyId);
  if (context.companyId && companyId !== context.companyId) {
    throw createValidationError('COMPANY_SCOPE_MISMATCH', 'Command companyId does not match authenticated company');
  }
  if (context.operation?.operationId && operationId !== context.operation.operationId) {
    throw createValidationError('OPERATION_ID_MISMATCH', 'Command operationId does not match envelope operationId');
  }
  return { commandId, operationId, companyId, ...validateCausalFields(payload, operationId) };
}

function validateModelOperations(value) {
  if (!Array.isArray(value) || value.length > 128) {
    throw createValidationError('INVALID_MODEL_OPERATIONS', 'operations must be a bounded array');
  }
  const names = new Set();
  const operations = value.map((operation, index) => {
    assertPlainObject(operation, 'INVALID_MODEL_OPERATION');
    rejectAuthorityFields(operation);
    const name = normalizeText(operation.name, `operations[${index}].name`, { maxLength: 256 });
    const key = name.toLocaleLowerCase();
    if (names.has(key)) throw createValidationError('DUPLICATE_MODEL_OPERATION', 'Model operation names must be unique');
    names.add(key);
    const rate = finiteNumber(operation.rate, `operations[${index}].rate`, { min: 0 });
    const id = optionalText(operation, 'id', { maxLength: 128 });
    return { ...(id === undefined ? {} : { id }), name, rate };
  });
  return { operations, names };
}

function validateModelCommand(payload, context, commandType) {
  rejectAuthorityFields(payload, [...AUTHORITY_FIELDS, 'status', 'updatedAt', 'createdAt', 'provenance', 'legacyHisobQuantities']);
  const scope = validateWorkbookScope(payload, context);
  const modelId = requiredEntityKey(payload.modelId ?? payload.id, 'modelId');
  const normalized = { ...payload, ...scope, modelId };
  for (const field of ['name', 'hisobSheetName', 'title', 'party', 'color', 'size']) {
    if (field === 'name' && commandType === 'UpsertModel') {
      normalized.name = normalizeText(payload.name, field, { maxLength: 160 });
    } else if (field === 'party' && hasOwn(payload, field)
      && (payload[field] === undefined || payload[field] === null || String(payload[field]).trim() === '')) {
      normalized.party = '';
    } else if (hasOwn(payload, field) && payload[field] !== undefined && payload[field] !== null) {
      normalized[field] = normalizeText(String(payload[field]), field, { maxLength: field === 'title' ? 256 : 160 });
    }
  }
  if (commandType === 'UpsertModel') {
    const { operations, names } = validateModelOperations(payload.operations);
    const order = payload.pattaOpsOrder === undefined ? operations.map((operation) => operation.name) : payload.pattaOpsOrder;
    if (!Array.isArray(order) || order.length > 128) {
      throw createValidationError('INVALID_PATTA_OPERATION_ORDER', 'pattaOpsOrder must be a bounded array');
    }
    const normalizedOrder = order.map((name, index) => normalizeText(name, `pattaOpsOrder[${index}]`, { maxLength: 256 }));
    if (normalizedOrder.some((name) => !names.has(name.toLocaleLowerCase()))) {
      throw createValidationError('INVALID_PATTA_OPERATION_ORDER', 'pattaOpsOrder must contain only model operation names');
    }
    normalized.operations = operations;
    normalized.pattaOpsOrder = normalizedOrder;
    const aliases = payload.operationRenames === undefined ? [] : payload.operationRenames;
    if (!Array.isArray(aliases) || aliases.length > 128) throw createValidationError('INVALID_OPERATION_RENAMES', 'operationRenames must be a bounded array');
    normalized.operationRenames = aliases.map((alias, index) => {
      assertPlainObject(alias, 'INVALID_OPERATION_RENAME');
      const fromName = normalizeText(alias.fromName, `operationRenames[${index}].fromName`, { maxLength: 256 });
      const toName = normalizeText(alias.toName, `operationRenames[${index}].toName`, { maxLength: 256 });
      if (!names.has(toName.toLocaleLowerCase())) throw createValidationError('INVALID_OPERATION_RENAMES', `Operation "${toName}" is missing from the updated model`);
      if (fromName === toName) throw createValidationError('INVALID_OPERATION_RENAMES', 'Operation rename must change the name');
      return { fromName, toName };
    });
  }
  assertEntity(context.operation, commandType, modelId);
  normalized.baseRevision = revisionContext(payload, context);
  return normalized;
}

function validateWorkerCommand(payload, context, commandType) {
  rejectAuthorityFields(payload, AUTHORITY_FIELDS.filter((field) => field !== 'role'));
  if (hasOwn(payload, 'status') && payload.status !== 'ACTIVE') {
    throw createValidationError('FORBIDDEN_AUTHORITY_FIELD', 'Worker status is set only by a deactivate command', { field: 'status' });
  }
  const scope = validateWorkbookScope(payload, context);
  const workerId = workerReference(payload.workerId, 'workerId');
  if (Number(workerId) <= 0) throw createValidationError('INVALID_WORKER_ID', 'workerId must be greater than zero');
  const entityId = String(workerId);
  const normalized = { ...payload, ...scope, workerId };
  if (commandType === 'UpsertWorker') {
    normalized.name = normalizeText(payload.name, 'name', { maxLength: 160 });
    normalized.staj = finiteNumber(payload.staj ?? 0, 'staj', { min: 0 });
    const role = optionalText(payload, 'role', { maxLength: 128 });
    if (role !== undefined) normalized.role = role;
    const adjustments = payload.balanceAdjustments === undefined ? [] : payload.balanceAdjustments;
    if (!Array.isArray(adjustments) || adjustments.length > 2) {
      throw createValidationError('INVALID_WORKER_ADJUSTMENTS', 'balanceAdjustments must contain at most two entries');
    }
    normalized.balanceAdjustments = adjustments.map((adjustment, index) => {
      assertPlainObject(adjustment, 'INVALID_WORKER_ADJUSTMENT');
      rejectAuthorityFields(adjustment);
      const type = strictText(adjustment.type, `balanceAdjustments[${index}].type`, { maxLength: 16 });
      if (!['AVANS', 'JARIMA'].includes(type)) throw createValidationError('INVALID_WORKER_ADJUSTMENT_TYPE', 'Worker balance type must be AVANS or JARIMA');
      const periodId = requiredEntityKey(adjustment.periodId, `balanceAdjustments[${index}].periodId`);
      const description = optionalText(adjustment, 'description', { maxLength: 500 });
      const value = {
        adjustmentId: requiredIdentifier(adjustment, ['adjustmentId']),
        type,
        amountDelta: finiteNumber(adjustment.amountDelta, `balanceAdjustments[${index}].amountDelta`, { nonZero: true })
      };
      if (periodId !== undefined) value.periodId = periodId;
      if (description !== undefined) value.description = description;
      return value;
    });
  }
  assertEntity(context.operation, commandType, entityId);
  normalized.baseRevision = revisionContext(payload, context);
  return normalized;
}

function validatePeriodCommand(payload, context, commandType) {
  rejectAuthorityFields(payload, [...AUTHORITY_FIELDS, 'status', 'closedAt', 'updatedAt', 'createdAt', 'completedPartyIds', 'rolledOverParties']);
  const scope = validateWorkbookScope(payload, context);
  const periodId = requiredEntityKey(payload.periodId ?? payload.id, 'periodId');
  const normalized = { ...payload, ...scope, periodId };
  if (commandType === 'CreatePeriod' || commandType === 'UpdatePeriod') {
    normalized.name = normalizeText(payload.name, 'name', { maxLength: 160 });
    normalized.startDate = dateValue(payload, 'startDate', { calendarOnly: true });
  } else {
    normalized.endDate = dateValue(payload, 'endDate', { calendarOnly: true });
    assertPlainObject(payload.nextPeriod, 'INVALID_NEXT_PERIOD');
    normalized.nextPeriod = {
      id: requiredEntityKey(payload.nextPeriod.id, 'nextPeriod.id'),
      name: normalizeText(payload.nextPeriod.name, 'nextPeriod.name', { maxLength: 160 }),
      startDate: dateValue(payload.nextPeriod, 'startDate', { calendarOnly: true })
    };
    const archiveFilename = optionalText(payload, 'archiveFilename', { maxLength: 256 });
    if (archiveFilename !== undefined) normalized.archiveFilename = archiveFilename;
  }
  assertEntity(context.operation, commandType, periodId);
  normalized.baseRevision = revisionContext(payload, context);
  return normalized;
}

function validateUpdateParty(payload, context) {
  rejectAuthorityFields(payload, [...AUTHORITY_FIELDS, 'status', 'isClosed', 'closedAt', 'serverRevision', 'updatedAt', 'createdAt']);
  const scope = validateWorkbookScope(payload, context);
  const partyRecordId = requiredEntityKey(payload.partyRecordId ?? payload.id, 'partyRecordId');
  const normalized = { ...payload, ...scope, partyRecordId };
  normalized.partyNumber = normalizeText(payload.partyNumber, 'partyNumber', { maxLength: 64 });
  normalized.modelId = requiredEntityKey(payload.modelId, 'modelId');
  for (const field of ['physicalPartyNumber', 'modelName', 'color']) {
    const value = optionalText(payload, field, { maxLength: 256 });
    if (value !== undefined) normalized[field] = value;
  }
  for (const field of ['pattaCount', 'cumulativePattaCount']) {
    normalized[field] = nonNegativeInteger(payload[field], field);
  }
  for (const field of ['ishSoniPerPatta', 'totalIshSoni', 'ishSoni', 'cumulativeIshSoni']) {
    normalized[field] = finiteNumber(payload[field], field, { min: 0 });
  }
  normalized.sizes = validateSizeMap(payload.sizes || {});
  const printedAt = dateValue(payload, 'printedAt');
  if (printedAt !== undefined) normalized.printedAt = printedAt;
  assertEntity(context.operation, 'UpdateParty', partyRecordId);
  normalized.baseRevision = revisionContext(payload, context);
  return normalized;
}

function validateBatchSettings(payload, context) {
  rejectAuthorityFields(payload, [...AUTHORITY_FIELDS, 'updatedAt', 'serverRevision']);
  const scope = validateWorkbookScope(payload, context);
  const availableSizes = payload.availableSizes === undefined ? undefined : payload.availableSizes;
  if (availableSizes !== undefined && (!Array.isArray(availableSizes) || availableSizes.length > 128)) {
    throw createValidationError('INVALID_BATCH_SIZES', 'availableSizes must be a bounded array');
  }
  const sizes = availableSizes?.map((value, index) => normalizeText(value, `availableSizes[${index}]`, { maxLength: 64 }));
  if (sizes && new Set(sizes.map((value) => value.toLocaleUpperCase())).size !== sizes.length) {
    throw createValidationError('DUPLICATE_BATCH_SIZE', 'availableSizes values must be unique');
  }
  const configs = payload.configs === undefined ? [] : payload.configs;
  if (!Array.isArray(configs) || configs.length > 128) throw createValidationError('INVALID_BATCH_CONFIGS', 'configs must be a bounded array');
  const normalizedConfigs = configs.map((config, index) => {
    assertPlainObject(config, 'INVALID_BATCH_CONFIG');
    if (config.isCustomParty !== undefined && typeof config.isCustomParty !== 'boolean') {
      throw createValidationError('INVALID_BATCH_CONFIG', 'isCustomParty must be boolean');
    }
    const modelId = requiredEntityKey(config.modelId, `configs[${index}].modelId`);
    const sizeMap = config.sizes === undefined ? {} : assertPlainObject(config.sizes, 'INVALID_BATCH_SIZE_MAP');
    const normalizedSizeMap = {};
    for (const [key, value] of Object.entries(sizeMap)) {
      const normalizedKey = normalizeText(key, `configs[${index}].sizes key`, { maxLength: 64 });
      if (typeof value !== 'string' || value.length > 32) throw createValidationError('INVALID_BATCH_SIZE', 'Batch size values must be bounded strings');
      normalizedSizeMap[normalizedKey] = value;
    }
    const partyNumber = config.partyNumber === undefined || config.partyNumber === '' ? '' : normalizeText(config.partyNumber, 'partyNumber', { maxLength: 64 });
    const totalIshSoni = config.totalIshSoni === undefined || config.totalIshSoni === '' ? '' : normalizeText(config.totalIshSoni, 'totalIshSoni', { maxLength: 32 });
    const color = config.color === undefined || config.color === null || config.color === '' ? '' : normalizeText(String(config.color), 'color', { maxLength: 128 });
    return { modelId, partyNumber, isCustomParty: config.isCustomParty === true, totalIshSoni, color, sizes: normalizedSizeMap };
  });
  const entityId = scope.companyId;
  assertEntity(context.operation, 'UpdateBatchSettings', entityId);
  return { ...payload, ...scope, availableSizes: sizes, configs: normalizedConfigs, baseRevision: revisionContext(payload, context) };
}

function validateCompletePattaBatch(payload, context) {
  rejectAuthorityFields(payload, [...AUTHORITY_FIELDS, 'status', 'serverRevision', 'updatedAt', 'createdAt']);
  const scope = validateWorkbookScope(payload, context);
  const batchId = requiredIdentifier(payload, ['batchId']);
  const rawParties = payload.parties;
  if (!Array.isArray(rawParties) || rawParties.length < 1 || rawParties.length > 128) {
    throw createValidationError('INVALID_BATCH_PARTIES', 'parties must contain 1–128 records');
  }
  const parties = rawParties.map((party) => validateCreateParty(party, {
    ...context,
    operation: undefined,
    baseRevision: party.baseRevision
  }));
  const keys = new Set();
  for (const party of parties) {
    if (keys.has(party.partyNumber)) throw createValidationError('ACTIVE_PARTY_EXISTS', 'Batch contains duplicate party numbers');
    keys.add(party.partyNumber);
  }
  const settings = validateBatchSettings({ ...scope, availableSizes: payload.availableSizes, configs: payload.configs }, {
    ...context,
    operation: undefined
  });
  assertEntity(context.operation, 'CompletePattaBatch', batchId);
  return { ...payload, ...scope, batchId, parties, availableSizes: settings.availableSizes, configs: settings.configs };
}

function validateCompletePartySeries(payload, context) {
  rejectAuthorityFields(payload, [...AUTHORITY_FIELDS, 'status', 'serverRevision', 'updatedAt', 'createdAt']);
  const scope = validateWorkbookScope(payload, context);
  const periodId = requiredEntityKey(payload.periodId, 'periodId');
  const endDate = dateValue(payload, 'endDate', { calendarOnly: true });
  assertEntity(context.operation, 'CompletePartySeries', periodId);
  return { ...payload, ...scope, periodId, endDate };
}

function validateArchivePartyHistory(payload, context) {
  rejectAuthorityFields(payload, [...AUTHORITY_FIELDS, 'status', 'serverRevision', 'updatedAt', 'createdAt']);
  const scope = validateWorkbookScope(payload, context);
  const partyRecordIds = payload.partyRecordIds;
  if (!Array.isArray(partyRecordIds) || partyRecordIds.length < 1 || partyRecordIds.length > MAX_ARRAY_ITEMS) {
    throw createValidationError('INVALID_PARTY_ARCHIVE', 'partyRecordIds must contain 1–1000 IDs');
  }
  const normalizedIds = partyRecordIds.map((id, index) => requiredEntityKey(id, `partyRecordIds[${index}]`));
  if (new Set(normalizedIds).size !== normalizedIds.length) throw createValidationError('DUPLICATE_PARTY_ID', 'partyRecordIds must be unique');
  assertEntity(context.operation, 'ArchivePartyHistory', scope.companyId);
  return { ...payload, ...scope, partyRecordIds: normalizedIds };
}

function validateResolveCandidate(payload, context) {
  const authority = validateReconciliationContext(context);
  rejectAuthorityFields(payload, ['operator', 'role', 'admin', 'accountant', 'serverRevision', 'grandfathered', 'legacyException', 'exceptionGroupId', 'approvedBy', 'status']);
  if (hasOwn(payload, 'operatorId')) {
    const claimedOperatorId = strictText(payload.operatorId, 'operatorId', {
      identifier: true,
      whitespaceCode: 'OPERATOR_INTENT_MISMATCH'
    });
    if (claimedOperatorId !== authority.operatorId) {
      throw createValidationError('OPERATOR_INTENT_MISMATCH', 'Authenticated operator does not match the intended reconciliation operator');
    }
  }
  if (hasOwn(payload, 'operatorRole')) {
    const claimedRole = strictText(payload.operatorRole, 'operatorRole', {
      maxLength: 32,
      whitespaceCode: 'OPERATOR_INTENT_MISMATCH'
    });
    if (claimedRole !== authority.role) {
      throw createValidationError('OPERATOR_INTENT_MISMATCH', 'Authenticated operator role does not match the intended reconciliation role');
    }
  }
  const commandId = hasOwn(payload, 'commandId') && payload.commandId !== undefined && payload.commandId !== null
    ? requiredIdentifier(payload, ['commandId'])
    : undefined;
  const operationId = requiredIdentifier(payload, ['operationId']);
  const causal = validateCausalFields(payload, operationId);
  const companyId = requiredCompany(payload.companyId);
  if (context.companyId && companyId !== context.companyId) {
    throw createValidationError('COMPANY_SCOPE_MISMATCH', 'Command companyId does not match authenticated company');
  }
  if (context.operation?.operationId && operationId !== context.operation.operationId) {
    throw createValidationError('OPERATION_ID_MISMATCH', 'Command operationId does not match envelope operationId');
  }
  const candidateId = requiredIdentifier(payload, ['candidateId']);
  const decision = strictText(payload.decision, 'decision', {
    maxLength: 64,
    whitespaceCode: 'INVALID_DECISION'
  });
  if (!RECONCILIATION_DECISIONS.includes(decision)) {
    throw createValidationError('INVALID_DECISION', 'decision is not a supported reconciliation decision');
  }
  const reason = normalizeText(payload.reason, 'reason');
  const normalized = {
    ...payload,
    operationId,
    companyId,
    candidateId,
    decision,
    reason,
    operatorId: authority.operatorId,
    operatorRole: authority.role
  };
  if (commandId !== undefined) normalized.commandId = commandId;
  Object.assign(normalized, causal);
  for (const field of ['sourceReference', 'modelId', 'opName']) {
    const value = optionalText(payload, field, { identifier: field === 'modelId', maxLength: 256 });
    if (value !== undefined) normalized[field] = value;
  }
  if (hasOwn(payload, 'workerId') && payload.workerId !== undefined && payload.workerId !== null) {
    normalized.workerId = workerReference(payload.workerId, 'workerId');
  }
  if (hasOwn(payload, 'deltaQty') && payload.deltaQty !== undefined && payload.deltaQty !== null) {
    normalized.deltaQty = finiteNumber(payload.deltaQty, 'deltaQty');
  }
  const effectiveDate = dateValue(payload, 'effectiveDate', { calendarOnly: true });
  if (effectiveDate !== undefined) normalized.effectiveDate = effectiveDate;
  assertEntity(context.operation, 'ResolveMigrationReconciliationCandidate', candidateId);
  return normalized;
}

function validateCommandPayload(commandType, payload, context = {}) {
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, commandType)) {
    throw createValidationError('UNKNOWN_COMMAND', `Unsupported command type: ${commandType}`);
  }
  assertPlainObject(payload, 'INVALID_PAYLOAD');
  assertBoundedValue(payload);
  assertPayloadSize(payload);

  switch (commandType) {
    case 'SubmitTicket':
      return validateSubmitTicket(payload, context);
    case 'RecordProductionAdjustment':
      return validateRecordAdjustment(payload, context);
    case 'ReverseProductionAdjustment':
      return validateReverseAdjustment(payload, context);
    case 'CreateParty':
      return validateCreateParty(payload, context);
    case 'UpdateParty':
      return validateUpdateParty(payload, context);
    case 'CloseParty':
      return validateCloseParty(payload, context);
    case 'UpsertModel':
    case 'DeactivateModel':
      return validateModelCommand(payload, context, commandType);
    case 'UpsertWorker':
    case 'DeactivateWorker':
      return validateWorkerCommand(payload, context, commandType);
    case 'CreatePeriod':
    case 'UpdatePeriod':
    case 'ClosePeriod':
      return validatePeriodCommand(payload, context, commandType);
    case 'UpdateBatchSettings':
      return validateBatchSettings(payload, context);
    case 'CompletePattaBatch':
      return validateCompletePattaBatch(payload, context);
    case 'CompletePartySeries':
      return validateCompletePartySeries(payload, context);
    case 'DeleteTicket': {
      const ticketId = requiredEntityKey(payload.ticketId, 'ticketId');
      const companyId = requiredCompany(payload.companyId);
      const operationId = requiredIdentifier(payload, ['operationId']);
      const commandId = requiredIdentifier(payload, ['commandId']);
      assertEntity(context.operation, 'DeleteTicket', ticketId);
      if (context.companyId && companyId !== context.companyId) throw createValidationError('COMPANY_SCOPE_MISMATCH', 'Command companyId does not match authenticated company');
      if (context.operation?.operationId && operationId !== context.operation.operationId) throw createValidationError('OPERATION_ID_MISMATCH', 'Command operationId does not match envelope operationId');
      return { ...payload, companyId, operationId, commandId, ticketId };
    }
    case 'ArchivePartyHistory':
      return validateArchivePartyHistory(payload, context);
    case 'ResolveMigrationReconciliationCandidate':
      return validateResolveCandidate(payload, context);
    default:
      throw createValidationError('UNKNOWN_COMMAND', `Unsupported command type: ${commandType}`);
  }
}

module.exports = {
  COMMANDS,
  IDENTIFIER,
  COMPANY_ID,
  UUID,
  HASH,
  MAX_OPERATIONS,
  MAX_PAYLOAD_BYTES,
  createValidationError,
  validateOperationEnvelope,
  validateCommandPayload
};
