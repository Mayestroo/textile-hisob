'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getCompanyDatabase, runIntegrityCheck } = require('./databaseManager.cjs');
const {
  getWorkerAdjustmentId,
  getTicketEntryId,
  getReconciliationCandidateId,
  getQuarantineId,
  NOVDA_NAMESPACE,
  createCanonicalEntityUuid,
  resolveEntityId
} = require('./identifierPolicy.cjs');
const { isSafeCompanyId } = require('./companyPath.cjs');

function isCanonicalUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeImportedCompanyIds(db, companyId) {
  db.pragma('defer_foreign_keys = ON');
  const now = new Date().toISOString();
  const map = (rows) => new Map(rows.map(({ oldId, newId }) => [oldId, newId]));
  const modelRows = db.prepare('SELECT id FROM models WHERE company_id = ? ORDER BY id').all(companyId);
  const modelIdMap = map(modelRows.filter((row) => !isCanonicalUuid(row.id))
    .map((row) => ({ oldId: row.id, newId: createCanonicalEntityUuid('model', companyId, row.id) })));
  const partyRows = db.prepare(`
    SELECT p.id FROM parties p
    WHERE p.company_id = ? AND p.status != 'CLOSED' AND p.is_archived = 0
      AND NOT EXISTS (
        SELECT 1 FROM legacy_party_collision_exceptions e
        WHERE e.company_id = p.company_id AND e.party_id = p.id
          AND e.party_number = p.party_number AND e.status = 'ACTIVE'
      )
    ORDER BY p.id
  `).all(companyId);
  const partyIdMap = map(partyRows.filter((row) => !isCanonicalUuid(row.id))
    .map((row) => ({ oldId: row.id, newId: createCanonicalEntityUuid('party', companyId, row.id) })));

  const updateScoped = (table, column, idMap) => {
    const tableColumns = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name));
    if (!tableColumns.has(column) || !tableColumns.has('company_id')) return;
    const rows = db.prepare(`SELECT rowid, "${column}" AS value FROM "${table}" WHERE company_id = ?`)
      .all(companyId);
    const update = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`);
    for (const row of rows) {
      const newId = idMap.get(row.value);
      if (newId) update.run(newId, row.rowid);
    }
  };

  for (const [oldId, newId] of modelIdMap) {
    db.prepare(`INSERT INTO model_id_aliases(company_id, legacy_model_id, canonical_model_id, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(company_id, legacy_model_id)
      DO UPDATE SET canonical_model_id = excluded.canonical_model_id`).run(companyId, oldId, newId, now);
    for (const table of [
      'tickets', 'production_adjustments', 'patta_batch_settings', 'local_ticket_forms',
      'migration_quarantine_parties', 'migration_quarantine_tickets',
      'migration_reconciliation_candidates'
    ]) updateScoped(table, 'model_id', new Map([[oldId, newId]]));
    db.prepare(`UPDATE parties SET model_id = ? WHERE company_id = ? AND model_id = ?
      AND NOT EXISTS (SELECT 1 FROM legacy_party_collision_exceptions e
        WHERE e.company_id = parties.company_id AND e.party_id = parties.id
          AND e.party_number = parties.party_number AND e.status = 'ACTIVE')`).run(newId, companyId, oldId);
    db.prepare('UPDATE models SET id = ? WHERE company_id = ? AND id = ?').run(newId, companyId, oldId);
  }

  const partyTriggers = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'parties'`).all();
  for (const trigger of partyTriggers) {
    if (trigger.name === 'trg_parties_identity_immutable_update'
      || trigger.name === 'trg_parties_identity_immutable'
      || trigger.name === 'trg_parties_exact_party_2_update') {
      db.exec(`DROP TRIGGER IF EXISTS "${trigger.name}"`);
    }
  }
  updateScoped('tickets', 'party_record_id', partyIdMap);
  updateScoped('migration_party_resolutions', 'party_id', partyIdMap);
  updateScoped('migration_quarantine_parties', 'resolved_party_id', partyIdMap);
  for (const [oldId, newId] of partyIdMap) {
    db.prepare(`INSERT INTO party_id_aliases(company_id, legacy_party_id, canonical_party_id, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(company_id, legacy_party_id)
      DO UPDATE SET canonical_party_id = excluded.canonical_party_id`).run(companyId, oldId, newId, now);
    db.prepare('UPDATE parties SET id = ? WHERE company_id = ? AND id = ?').run(newId, companyId, oldId);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_parties_identity_immutable_update
    BEFORE UPDATE ON parties FOR EACH ROW
    WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
    BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_PARTY_IDENTITY: parties.id and parties.company_id cannot be modified'); END;
    CREATE TRIGGER IF NOT EXISTS trg_parties_exact_party_2_update
    BEFORE UPDATE OF id, company_id, status, party_number ON parties
    FOR EACH ROW
    WHEN NEW.status != 'CLOSED' OR NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
    BEGIN
      SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
        THEN RAISE(ABORT, 'IMMUTABLE_PARTY_IDENTITY: parties.id and parties.company_id cannot be modified') END;
      SELECT CASE WHEN NEW.status != 'CLOSED' AND EXISTS (
        SELECT 1 FROM parties p WHERE p.company_id = NEW.company_id
          AND p.party_number = NEW.party_number AND p.status != 'CLOSED' AND p.id != NEW.id
      ) AND NOT EXISTS (
        SELECT 1 FROM legacy_party_collision_exceptions e
        WHERE e.company_id = NEW.company_id AND e.party_id = NEW.id
          AND e.party_number = NEW.party_number AND e.status = 'ACTIVE'
          AND e.collision_group_id IN (
            SELECT e2.collision_group_id FROM legacy_party_collision_exceptions e2
            WHERE e2.company_id = NEW.company_id AND e2.party_number = NEW.party_number
              AND e2.status = 'ACTIVE' GROUP BY e2.collision_group_id HAVING COUNT(*) = 2
          )
      ) THEN RAISE(ABORT, 'ACTIVE_PARTY_EXISTS: Cannot reopen party; another active party already exists') END;
    END;
  `);

  db.prepare(`DELETE FROM tickets WHERE company_id = ? AND party_record_id IN (
    SELECT id FROM parties WHERE company_id = ? AND (status = 'CLOSED' OR is_archived = 1)
  )`).run(companyId, companyId);
  db.prepare(`DELETE FROM migration_party_resolutions WHERE company_id = ? AND party_id IN (
    SELECT id FROM parties WHERE company_id = ? AND (status = 'CLOSED' OR is_archived = 1)
  )`).run(companyId, companyId);
  db.prepare(`DELETE FROM legacy_party_collision_exceptions WHERE company_id = ? AND party_id IN (
    SELECT id FROM parties WHERE company_id = ? AND (status = 'CLOSED' OR is_archived = 1)
  )`).run(companyId, companyId);
  db.prepare(`DELETE FROM parties WHERE company_id = ? AND (status = 'CLOSED' OR is_archived = 1)`).run(companyId);
  db.prepare(`DELETE FROM tickets WHERE company_id = ? AND period_id IN (
    SELECT id FROM periods WHERE company_id = ? AND (is_closed = 1 OR status = 'CLOSED')
  )`).run(companyId, companyId);
  db.prepare(`DELETE FROM worker_adjustments WHERE company_id = ? AND period_id IN (
    SELECT id FROM periods WHERE company_id = ? AND (is_closed = 1 OR status = 'CLOSED')
  )`).run(companyId, companyId);
  db.prepare(`DELETE FROM period_archives WHERE company_id = ? AND period_id IN (
    SELECT id FROM periods WHERE company_id = ? AND (is_closed = 1 OR status = 'CLOSED')
  )`).run(companyId, companyId);
  db.prepare(`DELETE FROM periods WHERE company_id = ? AND (is_closed = 1 OR status = 'CLOSED')`).run(companyId);

  const protectedIds = new Set(db.prepare(`SELECT party_id FROM legacy_party_collision_exceptions
    WHERE company_id = ? AND status = 'ACTIVE'`).all(companyId).map((row) => row.party_id));
  const parties = db.prepare(`SELECT id, patta_count, printed_at, created_at FROM parties
    WHERE company_id = ? ORDER BY COALESCE(printed_at, created_at), id`).all(companyId);
  const updateRange = db.prepare(`UPDATE parties SET patta_start_number = ?, patta_end_number = ?, cumulative_patta_count = ?
    WHERE company_id = ? AND id = ?`);
  const saveProtectedRange = db.prepare(`INSERT INTO protected_party_patta_ranges(
    company_id, party_record_id, patta_start_number, patta_end_number
  ) VALUES (?, ?, ?, ?) ON CONFLICT(company_id, party_record_id) DO UPDATE SET
    patta_start_number = excluded.patta_start_number, patta_end_number = excluded.patta_end_number`);
  let nextPattaNumber = 1;
  for (const party of parties) {
    const count = Number(party.patta_count || 0);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`PATTA_SEQUENCE_MIGRATION_BLOCKED: invalid patta_count for ${party.id}`);
    if (count === 0) continue;
    const start = nextPattaNumber;
    const end = start + count - 1;
    if (!Number.isSafeInteger(end)) throw new Error('PATTA_SEQUENCE_MIGRATION_BLOCKED: sequence exceeds safe integer range');
    if (protectedIds.has(party.id)) saveProtectedRange.run(companyId, party.id, start, end);
    else updateRange.run(start, end, end, companyId, party.id);
    nextPattaNumber = end + 1;
  }
  db.prepare(`INSERT INTO company_patta_sequences(company_id, next_patta_number, updated_at)
    VALUES (?, ?, ?) ON CONFLICT(company_id) DO UPDATE SET
    next_patta_number = excluded.next_patta_number, updated_at = excluded.updated_at`)
    .run(companyId, nextPattaNumber, now);

  db.prepare(`UPDATE tickets SET patta_number = (
    SELECT r.patta_start_number + tickets.patta_number - 1
    FROM (
      SELECT id AS party_record_id, company_id, patta_count, patta_start_number FROM parties
      WHERE company_id = ? AND patta_start_number IS NOT NULL
      UNION ALL
      SELECT party_record_id, company_id,
        (patta_end_number - patta_start_number + 1) AS patta_count, patta_start_number
      FROM protected_party_patta_ranges WHERE company_id = ?
    ) r WHERE r.company_id = tickets.company_id AND r.party_record_id = tickets.party_record_id
      AND tickets.patta_number BETWEEN 1 AND r.patta_count
  ) WHERE company_id = ? AND party_record_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM parties p WHERE p.company_id = tickets.company_id AND p.id = tickets.party_record_id
      AND tickets.patta_number BETWEEN 1 AND p.patta_count
      AND COALESCE(p.patta_start_number, (SELECT pr.patta_start_number FROM protected_party_patta_ranges pr
        WHERE pr.company_id = p.company_id AND pr.party_record_id = p.id)) > 1
  )`).run(companyId, companyId, companyId);
}

/**
 * Discovers the authoritative legacy V1 JSON file for a given company.
 * Implements strict precedence and fails closed if ownership cannot be independently verified.
 *
 * @param {string} baseUserDataPath
 * @param {string} companyId
 * @returns {{ path: string|null, status: 'VALID' | 'NOT_FOUND' | 'AMBIGUOUS_LEGACY_SOURCE', error?: string }}
 */
function discoverLegacySource(baseUserDataPath, companyId) {
  if (!isSafeCompanyId(companyId)) {
    return { path: null, status: 'NOT_FOUND', error: `Invalid company ID: ${companyId}` };
  }

  const dataDir = path.resolve(baseUserDataPath, 'NovdaData');

  // Precedence 1: Company-specific file: NovdaData/hisob_database_<companyId>.json
  const companySpecificPath = path.resolve(dataDir, `hisob_database_${companyId}.json`);
  if (fs.existsSync(companySpecificPath)) {
    try {
      const raw = fs.readFileSync(companySpecificPath, 'utf8');
      const parsed = JSON.parse(raw);
      // Verify ownership if companyId is embedded
      if (parsed.companyId && parsed.companyId !== companyId) {
        return {
          path: companySpecificPath,
          status: 'AMBIGUOUS_LEGACY_SOURCE',
          error: `Company file contains conflicting companyId "${parsed.companyId}" (expected "${companyId}")`
        };
      }
      return { path: companySpecificPath, status: 'VALID' };
    } catch (err) {
      return { path: companySpecificPath, status: 'AMBIGUOUS_LEGACY_SOURCE', error: `Unparseable company JSON: ${err.message}` };
    }
  }

  // Precedence 2: Global legacy file: NovdaData/hisob_database.json
  // ONLY valid if ownership can be independently established from trusted metadata/content.
  const globalPath = path.resolve(dataDir, 'hisob_database.json');
  if (fs.existsSync(globalPath)) {
    try {
      const raw = fs.readFileSync(globalPath, 'utf8');
      const parsed = JSON.parse(raw);
      // FAIL CLOSED: If companyId is not explicitly matching this company, reject as ambiguous
      if (parsed.companyId === companyId) {
        return { path: globalPath, status: 'VALID' };
      }
      return {
        path: globalPath,
        status: 'AMBIGUOUS_LEGACY_SOURCE',
        error: `Global legacy database has ambiguous ownership (embedded companyId: "${parsed.companyId || 'none'}"); cannot assign to "${companyId}"`
      };
    } catch (err) {
      return { path: globalPath, status: 'AMBIGUOUS_LEGACY_SOURCE', error: `Unparseable global JSON: ${err.message}` };
    }
  }

  return { path: null, status: 'NOT_FOUND', error: 'No legacy database found' };
}

/**
 * Computes SHA-256 hash of a file or buffer.
 *
 * @param {string|Buffer} content
 * @returns {string} Hex SHA-256
 */
function computeSha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Executes a transactional, read-only V1 JSON to  SQLite migration for a company.
 * Source JSON is NEVER mutated, truncated, or removed.
 *
 * @param {string} baseUserDataPath
 * @param {string} companyId
 * @param {object} [options={}]
 * @param {string} [options.explicitSourcePath] For testing or specific migration runs
 * @returns {object} Migration summary & parity report
 */
function migrateLegacyData(baseUserDataPath, companyId, options = {}) {
  if (!isSafeCompanyId(companyId)) {
    throw new Error(`Invalid company ID "${companyId}"`);
  }

  // 1. Discover source
  let sourcePath = options.explicitSourcePath;
  if (!sourcePath) {
    const discovery = discoverLegacySource(baseUserDataPath, companyId);
    if (discovery.status !== 'VALID') {
      return {
        success: false,
        status: discovery.status,
        companyId,
        error: discovery.error || 'Legacy source discovery failed',
        migrationReady: false
      };
    }
    sourcePath = discovery.path;
  }

  if (!fs.existsSync(sourcePath)) {
    return {
      success: false,
      status: 'SOURCE_NOT_FOUND',
      companyId,
      sourcePath,
      error: `Source file does not exist: ${sourcePath}`,
      migrationReady: false
    };
  }

  // 2. Read and hash source (Read-only, completely immutable)
  const sourceRaw = fs.readFileSync(sourcePath, 'utf8');
  const sourceSha256 = computeSha256(sourceRaw);

  let legacyData;
  try {
    legacyData = JSON.parse(sourceRaw);
  } catch (parseErr) {
    return {
      success: false,
      status: 'PARSING_ERROR',
      companyId,
      sourcePath,
      sourceSha256,
      error: `Failed to parse legacy JSON: ${parseErr.message}`,
      migrationReady: false
    };
  }

  // Verify company ownership if embedded
  if (legacyData.companyId && legacyData.companyId !== companyId) {
    return {
      success: false,
      status: 'AMBIGUOUS_LEGACY_SOURCE',
      companyId,
      sourcePath,
      sourceSha256,
      error: `Source JSON payload owned by "${legacyData.companyId}", cannot migrate into company "${companyId}"`,
      migrationReady: false
    };
  }

  // 3. Normalize and validate the immutable legacy snapshot before opening SQLite.
  const migrationRunId = `run_${Date.now()}_${sourceSha256.slice(0, 8)}`;
  const startedAt = new Date().toISOString();

  const warnings = [];
  const errors = [];

  const legacyModels = Array.isArray(legacyData.models) ? legacyData.models : [];
  const legacyWorkers = Array.isArray(legacyData.workers) ? legacyData.workers : [];
  const legacyTickets = Array.isArray(legacyData.submittedTickets) ? legacyData.submittedTickets : [];
  const legacyParties = Array.isArray(legacyData.printedPartyHistory) ? legacyData.printedPartyHistory : [];
  const legacyPeriods = Array.isArray(legacyData.periods) ? legacyData.periods : [];
  const currentPeriod = legacyData.currentPeriod || null;

  // V9 requires every canonical ticket to use a UUID-shaped identity and a real,
  // same-company Party FK. Validate the complete legacy ticket set before opening
  // the database transaction so an unsafe reference can never produce partial data.
  const legacyPartyRecords = legacyParties.map((party) => ({
    raw: party,
    id: resolveEntityId(party.id, 'party', companyId, String(party.partyNumber || '').trim(), party.modelId),
    modelId: party.modelId,
    partyNumber: String(party.partyNumber || '').trim()
  }));
  const ticketIdentityErrors = [];
  const canonicalTickets = [];
  const ticketIds = new Set();
  const getCanonicalTicketId = (ticket, index) => {
    const legacyIdentity = ticket.id === null || ticket.id === undefined || String(ticket.id).trim() === ''
      ? `position:${index}:${ticket.modelId || ''}:${ticket.partyNumber || ''}:${ticket.pattaNumber || ''}`
      : `id:${String(ticket.id).trim()}`;
    const hash = crypto.createHash('sha256')
      .update(`${NOVDA_NAMESPACE}:legacy-v1-ticket:${companyId}:${legacyIdentity}`, 'utf8')
      .digest('hex');
    // This is a deterministic UUIDv4-shaped canonical identity, scoped by the
    // established identifier-policy namespace rather than by mutable ticket data.
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
  };

  legacyTickets.forEach((ticket, index) => {
    const ticketId = getCanonicalTicketId(ticket, index);
    const modelId = ticket.modelId;
    const partyNumber = String(ticket.partyNumber ?? '').trim();
    const explicitPartyId = ticket.partyRecordId === null || ticket.partyRecordId === undefined
      ? ''
      : String(ticket.partyRecordId).trim();
    const candidates = explicitPartyId
      ? legacyPartyRecords.filter((party) => party.id === explicitPartyId)
      : legacyPartyRecords.filter((party) => party.modelId === modelId && party.partyNumber === partyNumber);

    if (ticketIds.has(ticketId)) {
      ticketIdentityErrors.push({ index, legacyTicketId: ticket.id ?? null, reason: 'DUPLICATE_LEGACY_TICKET_IDENTITY', canonicalTicketId: ticketId });
      return;
    }
    ticketIds.add(ticketId);

    if (candidates.length !== 1) {
      ticketIdentityErrors.push({
        index,
        legacyTicketId: ticket.id ?? null,
        reason: explicitPartyId ? (candidates.length ? 'MISMATCHED_EXPLICIT_PARTY_REFERENCE' : 'MISSING_EXPLICIT_PARTY_REFERENCE') : (candidates.length ? 'AMBIGUOUS_MODEL_PARTY_REFERENCE' : 'MISSING_MODEL_PARTY_REFERENCE'),
        modelId,
        partyNumber,
        partyRecordId: explicitPartyId || null,
        candidatePartyIds: candidates.map((party) => party.id)
      });
      return;
    }

    const party = candidates[0];
    if (party.modelId !== modelId || party.partyNumber !== partyNumber) {
      ticketIdentityErrors.push({
        index,
        legacyTicketId: ticket.id ?? null,
        reason: 'MISMATCHED_EXPLICIT_PARTY_REFERENCE',
        modelId,
        partyNumber,
        partyRecordId: explicitPartyId,
        resolvedPartyId: party.id,
        resolvedModelId: party.modelId,
        resolvedPartyNumber: party.partyNumber
      });
      return;
    }

    canonicalTickets.push({ ticket, ticketId, partyRecordId: party.id });
  });

  if (ticketIdentityErrors.length) {
    return {
      success: false,
      status: 'LEGACY_TICKET_PARTY_RESOLUTION_FAILED',
      companyId,
      sourcePath,
      sourceSha256,
      error: `Legacy ticket Party resolution failed for ${ticketIdentityErrors.length} record(s): ${ticketIdentityErrors.map((record) => `index ${record.index}, legacy ticket ${record.legacyTicketId ?? 'none'}: ${record.reason}`).join('; ')}`,
      records: ticketIdentityErrors,
      migrationReady: false
    };
  }

  // 4. Open SQLite only after the legacy snapshot has passed reference validation.
  const db = getCompanyDatabase(baseUserDataPath, companyId);
  runIntegrityCheck(db);
  const schemaVersionRow = db.prepare('SELECT MAX(version) AS v FROM schema_meta').get();
  const schemaVersion = schemaVersionRow?.v === null || schemaVersionRow?.v === undefined
    ? 0
    : Number(schemaVersionRow.v);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    const error = new Error('SCHEMA_LINEAGE_MISSING: schema_meta has no verified applied migration');
    error.code = 'SCHEMA_LINEAGE_MISSING';
    throw error;
  }

  // 5. Check previous migration runs
  const previousRun = db.prepare(`
    SELECT * FROM migration_runs
    WHERE company_id = ? AND status = 'COMPLETED'
    ORDER BY started_at DESC LIMIT 1
  `).get(companyId);

  if (previousRun && !options.forceRerun && !(options.partyResolutions && previousRun.quarantine_count > 0)) {
    if (previousRun.source_sha256 === sourceSha256) {
      let parsedParity = null;
      try { parsedParity = JSON.parse(previousRun.parity_json); } catch {}
      return {
        success: true, status: 'IDEMPOTENT_ALREADY_MIGRATED', isRerun: true,
        migrationRunId: previousRun.migration_run_id, companyId, sourcePath, sourceSha256,
        schemaVersion: previousRun.schema_version,
        counts: { models: previousRun.model_count, workers: previousRun.worker_count, tickets: previousRun.ticket_count, parties: previousRun.party_count, quarantine: previousRun.quarantine_count },
        parity: parsedParity,
        migrationReady: previousRun.quarantine_count === 0 && previousRun.error_count === 0
      };
    }
    return {
      success: false, status: 'SOURCE_CHANGED_AFTER_MIGRATION', companyId, sourcePath, sourceSha256,
      previousSha256: previousRun.source_sha256, previousRunId: previousRun.migration_run_id,
      error: `Source file has changed (hash: ${sourceSha256}) since previous migration (hash: ${previousRun.source_sha256})`,
      migrationReady: false
    };
  }

  // 6. Execute Migration Transaction

  let modelCount = 0;
  let workerCount = 0;
  let ticketCount = 0;
  let partyCount = 0;
  let quarantineCount = 0;
  let candidateCount = 0;
  let totalLegacyHisob = 0;
  let totalReconstructedHisob = 0;
  const reconciliationDifferences = [];

  const executeMigration = db.transaction(() => {
    // If forceRerun is requested or prior run exists and we are resolving, clean prior run tables
    if (options.forceRerun || (options.partyResolutions && previousRun)) {
      db.prepare(`DELETE FROM ticket_entries WHERE company_id = ?`).run(companyId);
      db.prepare(`DELETE FROM tickets WHERE company_id = ?`).run(companyId);
      db.prepare(`DELETE FROM parties WHERE company_id = ?`).run(companyId);
      db.prepare(`DELETE FROM worker_adjustments WHERE company_id = ? AND provenance = 'MIGRATION_OPENING_BALANCE'`).run(companyId);
      db.prepare(`DELETE FROM workers WHERE company_id = ?`).run(companyId);
      db.prepare(`DELETE FROM models WHERE company_id = ?`).run(companyId);
      db.prepare(`DELETE FROM periods WHERE company_id = ?`).run(companyId);
      db.prepare(`DELETE FROM migration_quarantine_parties WHERE company_id = ?`).run(companyId);
      db.prepare(`DELETE FROM migration_quarantine_tickets WHERE company_id = ?`).run(companyId);
      db.prepare(`DELETE FROM migration_quarantine_ticket_entries WHERE company_id = ?`).run(companyId);
      db.prepare(`DELETE FROM migration_reconciliation_candidates WHERE company_id = ?`).run(companyId);
      db.prepare(`DELETE FROM migration_runs WHERE company_id = ?`).run(companyId);
    }

    // Record run as IN_PROGRESS
    db.prepare(`
      INSERT INTO migration_runs (
        migration_run_id, company_id, source_path, source_sha256, started_at, status, schema_version
      ) VALUES (?, ?, ?, ?, ?, 'IN_PROGRESS', ?)
    `).run(migrationRunId, companyId, sourcePath, sourceSha256, startedAt, schemaVersion);

    const nowIso = new Date().toISOString();

    // A. Migrate Models
    const modelSet = new Set();
    const insertModel = db.prepare(`
      INSERT INTO models (
        id, company_id, name, hisob_sheet_name, title, party, color, size,
        operations_json, patta_ops_order_json, legacy_hisob_quantities_json,
        created_at, updated_at, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LEGACY_MIGRATION')
    `);

    for (const m of legacyModels) {
      const modelId = resolveEntityId(m.id, 'model', companyId, m.name);
      modelSet.add(modelId);
      insertModel.run(
        modelId,
        companyId,
        m.name || 'Nomsiz model',
        m.hisobSheetName || null,
        m.title || null,
        m.party || null,
        m.color || null,
        m.size || null,
        JSON.stringify(m.operations || []),
        JSON.stringify(m.pattaOpsOrder || []),
        JSON.stringify(m.hisobQuantities || {}),
        nowIso,
        nowIso
      );
      modelCount++;
    }

    // B. Migrate Workers (Mandatory Amendment 1: staj -> workers.staj; avans/jarima -> worker_adjustments)
    const workerSet = new Set();
    const insertWorker = db.prepare(`
      INSERT INTO workers (
        id, company_id, name, staj, role, status, legacy_avans, legacy_jarima, created_at, updated_at, provenance
      ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, 'LEGACY_MIGRATION')
    `);

    const insertAdjustment = db.prepare(`
      INSERT INTO worker_adjustments (
        id, company_id, worker_id, period_id, type, amount, description, provenance, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'MIGRATION_OPENING_BALANCE', 'POSTED', ?)
    `);

    const currentPeriodId = currentPeriod?.id || 'opening_period';

    for (const w of legacyWorkers) {
      if (w.id === undefined || w.id === null) {
        errors.push(`Worker record missing ID: ${JSON.stringify(w)}`);
        continue;
      }
      const workerId = Number(w.id);
      workerSet.add(workerId);
      const avans = Number(w.avans || 0);
      const jarima = Number(w.jarima || 0);
      const staj = Number(w.staj || 0);

      insertWorker.run(
        workerId,
        companyId,
        w.name || `Ishchi #${workerId}`,
        staj,
        w.role || null,
        avans,
        jarima,
        nowIso,
        nowIso
      );
      workerCount++;

      // Create opening balance adjustments for non-zero avans/jarima
      if (avans > 0) {
        const adjId = getWorkerAdjustmentId(companyId, 'AVANS', workerId, currentPeriodId);
        insertAdjustment.run(
          adjId,
          companyId,
          workerId,
          currentPeriodId,
          'AVANS',
          avans,
          'Legacy avans opening balance',
          nowIso
        );
      }
      if (jarima > 0) {
        const adjId = getWorkerAdjustmentId(companyId, 'JARIMA', workerId, currentPeriodId);
        insertAdjustment.run(
          adjId,
          companyId,
          workerId,
          currentPeriodId,
          'JARIMA',
          jarima,
          'Legacy jarima opening balance',
          nowIso
        );
      }
    }

    // C. Migrate Periods
    const insertPeriod = db.prepare(`
      INSERT INTO periods (
        id, company_id, name, start_date, end_date, is_closed, closed_at, notes, archive_filename, status, created_at, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LEGACY_MIGRATION')
    `);

    const allPeriods = [...legacyPeriods];
    if (currentPeriod && !allPeriods.some(p => p.id === currentPeriod.id)) {
      allPeriods.push(currentPeriod);
    }

    for (const p of allPeriods) {
      const periodId = resolveEntityId(p.id, 'period', companyId, p.startDate || p.name);
      insertPeriod.run(
        periodId,
        companyId,
        p.name || 'Nomsiz davr',
        p.startDate || nowIso.slice(0, 10),
        p.endDate || null,
        p.isClosed ? 1 : 0,
        p.closedAt || null,
        p.notes || null,
        p.archiveFilename || null,
        p.isClosed ? 'CLOSED_ARCHIVED' : 'OPEN',
        nowIso
      );
    }

    // D. Migrate Parties & Collision Quarantine (Sec 16, 17)
    // Ambiguous duplicate party numbers must NOT be renamed or suffixed!
    // NO HEURISTIC MAY MANUFACTURE CLOSURE STATE!
    // Absence of tickets is NOT proof of closure; later creation is NOT proof of closure.
    // If source says isClosed=false, closedAt=null => migration must NOT invent status=CLOSED
    // unless an authorized operator explicitly resolves the historical collision.

    // Load any operator resolutions from database and options
    const operatorResolutions = new Map();
    try {
      const resRows = db.prepare(`SELECT * FROM migration_party_resolutions WHERE company_id = ?`).all(companyId);
      for (const r of resRows) {
        operatorResolutions.set(r.party_id, r);
        if (r.quarantine_id) operatorResolutions.set(r.quarantine_id, r);
      }
    } catch (e) {}

    if (Array.isArray(options.partyResolutions)) {
      for (const r of options.partyResolutions) {
        if (r.partyId) operatorResolutions.set(r.partyId, r);
        if (r.quarantineId) operatorResolutions.set(r.quarantineId, r);
      }
    }

    const quarPartyCols = db.prepare(`PRAGMA table_info(migration_quarantine_parties)`).all().map((c) => c.name);
    const hasExtendedQuarCols = quarPartyCols.includes('original_is_closed');

    const insertParty = db.prepare(`
      INSERT INTO parties (
        id, company_id, party_number, physical_party_number, model_id, model_name, color,
        patta_count, cumulative_patta_count, ish_soni_per_patta, total_ish_soni,
        ish_soni, cumulative_ish_soni, sizes_json, printed_at, is_closed, closed_at,
        archived_patta_numbers_json, status, created_at, updated_at, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertPartyQuarantine = hasExtendedQuarCols
      ? db.prepare(`
          INSERT INTO migration_quarantine_parties (
            quarantine_id, company_id, original_party_number, model_id, ticket_count,
            printed_at, legacy_record_id, resolution_status, resolved_party_id,
            resolution_decision, resolution_operator_id, resolved_at, resolution_notes,
            quarantined_at, original_is_closed, original_closed_at, collision_type, raw_source_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
      : db.prepare(`
          INSERT INTO migration_quarantine_parties (
            quarantine_id, company_id, original_party_number, model_id, ticket_count,
            printed_at, legacy_record_id, resolution_status, quarantined_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING_REVIEW', ?)
        `);

    // Group parties by partyNumber to determine active-party collision scope
    const partiesByNumber = new Map();
    for (const p of legacyParties) {
      const num = String(p.partyNumber || '').trim();
      if (!partiesByNumber.has(num)) {
        partiesByNumber.set(num, []);
      }
      partiesByNumber.get(num).push(p);
    }

    for (const [num, group] of partiesByNumber.entries()) {
      const partyStates = group.map((p) => {
        const legacyId = resolveEntityId(p.id, 'party', companyId, num, p.modelId);
        const quarId = getQuarantineId('party', companyId, legacyId);
        const resolution = operatorResolutions.get(legacyId) || operatorResolutions.get(quarId) || null;
        const sourceIsClosed = Boolean(p.isClosed) || p.status === 'CLOSED';
        return {
          raw: p,
          legacyId,
          quarId,
          sourceIsClosed,
          sourceClosedAt: p.closedAt || null,
          resolution
        };
      });

      for (const ps of partyStates) {
        const p = ps.raw;
        const legacyId = ps.legacyId;
        const quarId = ps.quarId;
        const res = ps.resolution;

        const isAuthorizedGrandfather = partyStates.length === 2
          && partyStates.every((state) => !state.sourceIsClosed
            && state.resolution?.decision === 'GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED');

        if (res) {
          if (res.decision === 'CONFIRM_HISTORICALLY_CLOSED') {
            // Operator confirmed party was closed.
            // DO NOT fabricate historical closed_at if unknown in source: keep source closed_at (null if unknown)
            // Provenance explicitly reflects operator decision
            insertParty.run(
              legacyId,
              companyId,
              num,
              num,
              p.modelId || 'UNKNOWN_MODEL',
              p.modelName || null,
              p.color || null,
              Number(p.pattaCount || 0),
              Number(p.cumulativePattaCount || 0),
              p.ishSoniPerPatta ? Number(p.ishSoniPerPatta) : null,
              p.totalIshSoni ? Number(p.totalIshSoni) : null,
              Number(p.ishSoni || 0),
              Number(p.cumulativeIshSoni || 0),
              JSON.stringify(p.sizes || {}),
              p.printedAt || null,
              1, // is_closed = 1
              ps.sourceClosedAt, // source closed_at preserved as null if unknown; NOT fabricated
              JSON.stringify(p.archivedPattaNumbers || []),
              'CLOSED',
              nowIso,
              nowIso,
              'OPERATOR_MIGRATION_DECISION'
            );
            partyCount++;

            if (hasExtendedQuarCols) {
              insertPartyQuarantine.run(
                quarId,
                companyId,
                num,
                p.modelId || 'UNKNOWN_MODEL',
                Number(p.pattaCount || 0),
                p.printedAt || nowIso,
                legacyId,
                'RESOLVED',
                legacyId,
                res.decision,
                res.operator_id || res.operatorId || 'OPERATOR',
                res.decided_at || res.decidedAt || nowIso,
                res.reason || res.notes || null,
                nowIso,
                ps.sourceIsClosed ? 1 : 0,
                ps.sourceClosedAt,
                'LEGACY_SIMULTANEOUS_ACTIVE_COLLISION',
                JSON.stringify(p)
              );
            } else {
              insertPartyQuarantine.run(
                quarId,
                companyId,
                num,
                p.modelId || 'UNKNOWN_MODEL',
                Number(p.pattaCount || 0),
                p.printedAt || nowIso,
                legacyId,
                'RESOLVED',
                nowIso
              );
            }
            continue;
          } else if (res.decision === 'MARK_LEGACY_VOID') {
            if (hasExtendedQuarCols) {
              insertPartyQuarantine.run(
                quarId,
                companyId,
                num,
                p.modelId || 'UNKNOWN_MODEL',
                Number(p.pattaCount || 0),
                p.printedAt || nowIso,
                legacyId,
                'RESOLVED',
                legacyId,
                res.decision,
                res.operator_id || res.operatorId || 'OPERATOR',
                res.decided_at || res.decidedAt || nowIso,
                res.reason || res.notes || null,
                nowIso,
                ps.sourceIsClosed ? 1 : 0,
                ps.sourceClosedAt,
                'LEGACY_SIMULTANEOUS_ACTIVE_COLLISION',
                JSON.stringify(p)
              );
            } else {
              insertPartyQuarantine.run(
                quarId,
                companyId,
                num,
                p.modelId || 'UNKNOWN_MODEL',
                Number(p.pattaCount || 0),
                p.printedAt || nowIso,
                legacyId,
                'RESOLVED',
                nowIso
              );
            }
            continue;
          }
        }

        // Handle Authorized Grandfathered Exception
        if (isAuthorizedGrandfather && !ps.sourceIsClosed) {
          // 1. Register grandfather exception in legacy_party_collision_exceptions if table exists
          const excCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_party_collision_exceptions'`).get();
          if (excCheck) {
            const groupId = `col_group_${companyId}_party_${num}`;
            db.prepare(`
              INSERT OR IGNORE INTO legacy_party_collision_exceptions (
                exception_id, company_id, party_number, party_id, collision_group_id,
                approved_by, approved_at, reason, status, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
            `).run(
              `exc_${companyId}_${legacyId}`,
              companyId,
              num,
              legacyId,
              groupId,
              (res && (res.operator_id || res.operatorId)) || 'OWNER_BUSINESS_DECISION',
              (res && (res.decided_at || res.decidedAt)) || nowIso,
              (res && (res.reason || res.notes)) || 'Existing production Party #2 duplicates are allowed to remain active until their normal operator-driven closure.',
              nowIso
            );
          }

          // 2. Record audit trail in migration_party_resolutions
          recordPartyResolution(db, {
            quarantineId: quarId,
            companyId,
            partyId: legacyId,
            decision: 'GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED',
            operatorId: (res && (res.operator_id || res.operatorId)) || 'OWNER_BUSINESS_DECISION',
            decidedAt: (res && (res.decided_at || res.decidedAt)) || nowIso,
            sourceSnapshotHash: sourceSha256,
            reason: (res && (res.reason || res.notes)) || 'Existing production Party #2 duplicates are allowed to remain active until their normal operator-driven closure.',
            originalIsClosed: ps.sourceIsClosed ? 1 : 0,
            originalClosedAt: ps.sourceClosedAt,
            resolutionProvenance: 'OWNER_BUSINESS_DECISION',
            resolutionNotes: 'Approved grandfathered legacy exception until individually closed'
          });

          // 3. Insert party as ACTIVE without fabricating closed_at
          insertParty.run(
            legacyId,
            companyId,
            num,
            num,
            p.modelId || 'UNKNOWN_MODEL',
            p.modelName || null,
            p.color || null,
            Number(p.pattaCount || 0),
            Number(p.cumulativePattaCount || 0),
            p.ishSoniPerPatta ? Number(p.ishSoniPerPatta) : null,
            p.totalIshSoni ? Number(p.totalIshSoni) : null,
            Number(p.ishSoni || 0),
            Number(p.cumulativeIshSoni || 0),
            JSON.stringify(p.sizes || {}),
            p.printedAt || null,
            0, // is_closed = 0
            null, // closed_at = null
            JSON.stringify(p.archivedPattaNumbers || []),
            'ACTIVE',
            nowIso,
            nowIso,
            'GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED'
          );
          partyCount++;

          // 4. Mark quarantine record as RESOLVED
          if (hasExtendedQuarCols) {
            insertPartyQuarantine.run(
              quarId,
              companyId,
              num,
              p.modelId || 'UNKNOWN_MODEL',
              Number(p.pattaCount || 0),
              p.printedAt || nowIso,
              legacyId,
              'RESOLVED',
              legacyId,
              'GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED',
              (res && (res.operator_id || res.operatorId)) || 'OWNER_BUSINESS_DECISION',
              (res && (res.decided_at || res.decidedAt)) || nowIso,
              'Approved grandfathered legacy exception until individually closed',
              nowIso,
              ps.sourceIsClosed ? 1 : 0,
              ps.sourceClosedAt,
              'LEGACY_SIMULTANEOUS_ACTIVE_COLLISION',
              JSON.stringify(p)
            );
          } else {
            insertPartyQuarantine.run(
              quarId,
              companyId,
              num,
              p.modelId || 'UNKNOWN_MODEL',
              Number(p.pattaCount || 0),
              p.printedAt || nowIso,
              legacyId,
              'RESOLVED',
              nowIso
            );
          }
          continue;
        }

        // Check if there is ANY other active party for this number (including grandfathered ones)
        const hasOtherActiveParty = partyStates.some((otherPs) => {
          if (otherPs.legacyId === ps.legacyId) return false;
          return !otherPs.sourceIsClosed;
        });

        if (hasOtherActiveParty && !ps.sourceIsClosed) {
          // Simultaneous active collision without grandfathered authorization: MANDATORY QUARANTINE!
          // DO NOT auto-close either party!
          if (hasExtendedQuarCols) {
            insertPartyQuarantine.run(
              quarId,
              companyId,
              num,
              p.modelId || 'UNKNOWN_MODEL',
              Number(p.pattaCount || 0),
              p.printedAt || nowIso,
              legacyId,
              'PENDING_REVIEW',
              null,
              null,
              null,
              null,
              'Simultaneous active party collision; requires operator resolution',
              nowIso,
              0,
              null,
              'LEGACY_SIMULTANEOUS_ACTIVE_COLLISION',
              JSON.stringify(p)
            );
          } else {
            insertPartyQuarantine.run(
              quarId,
              companyId,
              num,
              p.modelId || 'UNKNOWN_MODEL',
              Number(p.pattaCount || 0),
              p.printedAt || nowIso,
              legacyId,
              'PENDING_REVIEW',
              nowIso
            );
          }
          quarantineCount++;
          warnings.push(`Party #${num} (ID: ${legacyId}) collided with another ACTIVE party (#${num}) and was quarantined pending operator review`);
        } else {
          // Legitimate sequential reuse (e.g. Party A CLOSED, Party B ACTIVE), or standalone active party
          const isPartyClosed = ps.sourceIsClosed;
          insertParty.run(
            legacyId,
            companyId,
            num,
            num,
            p.modelId || 'UNKNOWN_MODEL',
            p.modelName || null,
            p.color || null,
            Number(p.pattaCount || 0),
            Number(p.cumulativePattaCount || 0),
            p.ishSoniPerPatta ? Number(p.ishSoniPerPatta) : null,
            p.totalIshSoni ? Number(p.totalIshSoni) : null,
            Number(p.ishSoni || 0),
            Number(p.cumulativeIshSoni || 0),
            JSON.stringify(p.sizes || {}),
            p.printedAt || null,
            isPartyClosed ? 1 : 0,
            ps.sourceClosedAt,
            JSON.stringify(p.archivedPattaNumbers || []),
            isPartyClosed ? 'CLOSED' : 'ACTIVE',
            nowIso,
            nowIso,
            'LEGACY_MIGRATION'
          );
          partyCount++;
        }
      }
    }

    // E. Migrate Tickets & Entries (Foreign Key Preservation & Staging Quarantine)
    const insertTicket = db.prepare(`
      INSERT INTO tickets (
        id, company_id, model_id, party_number, party_record_id, patta_number, qty,
        size, color, konveyer, status, is_closed, submitted_at, created_at, provenance, raw_legacy_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, 'LEGACY_MIGRATION', ?)
    `);

    const insertTicketQuarantine = db.prepare(`
      INSERT INTO migration_quarantine_tickets (
        quarantine_id, company_id, legacy_ticket_id, model_id, party_number, patta_number, qty, reason, raw_legacy_json, quarantined_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTicketEntry = db.prepare(`
      INSERT INTO ticket_entries (
        id, ticket_id, company_id, op_name, worker_id, worker_name_snapshot, rate_snapshot, brak, qty, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertEntryQuarantine = db.prepare(`
      INSERT INTO migration_quarantine_ticket_entries (
        quarantine_id, company_id, legacy_ticket_id, op_name, worker_id, reason, raw_legacy_json, quarantined_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Accumulate ticket sums per (modelId, workerId, opName) for hisob reconciliation
    const ticketDerivedQuantities = new Map(); // key: `${modelId}:${workerId}:${opName}` -> number

    for (const normalizedTicket of canonicalTickets) {
      const { ticket: t, ticketId, partyRecordId } = normalizedTicket;
      const modelId = t.modelId;

      // Referential check: Ticket -> Model
      if (!modelId || !modelSet.has(modelId)) {
        const quarId = getQuarantineId('ticket', companyId, ticketId);
        insertTicketQuarantine.run(
          quarId,
          companyId,
          ticketId,
          modelId || 'MISSING_MODEL_ID',
          String(t.partyNumber ?? ''),
          Number(t.pattaNumber ?? 0),
          Number(t.qty ?? 0),
          'MISSING_MODEL_REFERENCE',
          JSON.stringify(t),
          nowIso
        );
        quarantineCount++;
        warnings.push(`Ticket ${ticketId} references non-existent model "${modelId}"; quarantined`);
        continue;
      }

      const qty = Number(t.qty || 0);

      insertTicket.run(
        ticketId,
        companyId,
        modelId,
        String(t.partyNumber || ''),
        partyRecordId,
        Number(t.pattaNumber || 0),
        qty,
        t.size || null,
        t.color || null,
        t.konveyer || null,
        t.isClosed ? 1 : 0,
        t.submittedAt || nowIso,
        nowIso,
        JSON.stringify({
          ...t,
          _migration: {
            legacyTicketId: t.id ?? null,
            canonicalTicketId: ticketId,
            canonicalPartyRecordId: partyRecordId
          }
        })
      );
      ticketCount++;

      // Entries
      const entries = Array.isArray(t.entries) ? t.entries : [];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const workerId = Number(e.workerId);
        const opName = String(e.opName || '').trim();

        // Referential check: Entry -> Worker
        if (!workerSet.has(workerId)) {
          const quarId = getQuarantineId('entry', companyId, `${ticketId}_${i}`);
          insertEntryQuarantine.run(
            quarId,
            companyId,
            ticketId,
            opName,
            isNaN(workerId) ? -1 : workerId,
            'MISSING_WORKER_REFERENCE',
            JSON.stringify(e),
            nowIso
          );
          quarantineCount++;
          warnings.push(`Ticket ${ticketId} entry references non-existent worker ID ${workerId}; quarantined`);
          continue;
        }

        const entryId = getTicketEntryId(ticketId, i, opName, workerId);
        insertTicketEntry.run(
          entryId,
          ticketId,
          companyId,
          opName,
          workerId,
          e.workerNameSnapshot || e.workerName || null,
          e.rateSnapshot !== undefined ? Number(e.rateSnapshot) : null,
          e.brak || null,
          qty,
          nowIso
        );

        // Track derived hisob quantities
        const key = `${modelId}:${workerId}:${opName}`;
        ticketDerivedQuantities.set(key, (ticketDerivedQuantities.get(key) || 0) + qty);
      }
    }

    // F. Hisob Quantities Reconciliation (Mandatory Amendment 2: Dedicated Candidate Table)
    const candCols = db.prepare(`PRAGMA table_info(migration_reconciliation_candidates)`).all().map((c) => c.name);
    const hasHashCol = candCols.includes('source_snapshot_hash');

    const insertReconciliationCandidate = hasHashCol
      ? db.prepare(`
          INSERT INTO migration_reconciliation_candidates (
            candidate_id, company_id, model_id, worker_id, operation_name,
            legacy_qty, ticket_derived_qty, delta_qty, status, reason, created_at, source_snapshot_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_REVIEW', ?, ?, ?)
        `)
      : db.prepare(`
          INSERT INTO migration_reconciliation_candidates (
            candidate_id, company_id, model_id, worker_id, operation_name,
            legacy_qty, ticket_derived_qty, delta_qty, status, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_REVIEW', ?, ?)
        `);

    for (const m of legacyModels) {
      const modelId = m.id;
      const legacyHisob = m.hisobQuantities || {};

      for (const [wIdStr, ops] of Object.entries(legacyHisob)) {
        const wId = Number(wIdStr);
        if (typeof ops !== 'object' || ops === null) continue;

        for (const [opName, legQtyRaw] of Object.entries(ops)) {
          const legQty = Number(legQtyRaw || 0);
          totalLegacyHisob += legQty;
          const key = `${modelId}:${wId}:${opName}`;
          const derivedQty = ticketDerivedQuantities.get(key) || 0;

          if (legQty !== derivedQty) {
            const delta = legQty - derivedQty;
            const candidateId = getReconciliationCandidateId(companyId, modelId, wId, opName);

            if (hasHashCol) {
              insertReconciliationCandidate.run(
                candidateId,
                companyId,
                modelId,
                wId,
                opName,
                legQty,
                derivedQty,
                delta,
                'LEGACY_HISOB_QUANTITY_MISMATCH',
                nowIso,
                sourceSha256
              );
            } else {
              insertReconciliationCandidate.run(
                candidateId,
                companyId,
                modelId,
                wId,
                opName,
                legQty,
                derivedQty,
                delta,
                'LEGACY_HISOB_QUANTITY_MISMATCH',
                nowIso
              );
            }
            candidateCount++;

            reconciliationDifferences.push({
              modelId,
              workerId: wId,
              operation: opName,
              legacyQty: legQty,
              ticketDerivedQty: derivedQty,
              deltaQty: delta,
              status: 'PENDING_REVIEW',
              reason: 'Legacy model.hisobQuantities differs from reconstructed ticket sum'
            });
          }
        }
      }
    }

    // Sum all ticket-derived quantities for overall parity metric
    for (const qty of ticketDerivedQuantities.values()) {
      totalReconstructedHisob += qty;
    }

    normalizeImportedCompanyIds(db, companyId);

    // G. Determine Migration Readiness
    // Migration is NOT ready for cutover if there are unhandled errors, unresolved quarantine items, or candidate discrepancies
    const migrationReady = (errors.length === 0 && quarantineCount === 0 && candidateCount === 0);

    const parityData = {
      companyId,
      sourceSha256,
      legacy: {
        modelCount: legacyModels.length,
        workerCount: legacyWorkers.length,
        ticketCount: legacyTickets.length,
        partyCount: legacyParties.length
      },
      sqlite: {
        modelCount,
        workerCount,
        ticketCount,
        partyCount
      },
      financial: {
        legacyHisobTotals: totalLegacyHisob,
        reconstructedHisobTotals: totalReconstructedHisob,
        differenceCount: reconciliationDifferences.length,
        differenceMagnitude: Math.abs(totalLegacyHisob - totalReconstructedHisob),
        reconciliationDifferences
      },
      quarantineCount,
      candidateCount,
      warnings,
      errors,
      migrationReady
    };

    // H. Finalize migration_runs record
    const completedAt = new Date().toISOString();
    db.prepare(`
      UPDATE migration_runs SET
        completed_at = ?,
        status = 'COMPLETED',
        model_count = ?,
        worker_count = ?,
        ticket_count = ?,
        party_count = ?,
        quarantine_count = ?,
        warning_count = ?,
        error_count = ?,
        warnings_json = ?,
        errors_json = ?,
        parity_json = ?
      WHERE migration_run_id = ?
    `).run(
      completedAt,
      modelCount,
      workerCount,
      ticketCount,
      partyCount,
      quarantineCount,
      warnings.length,
      errors.length,
      JSON.stringify(warnings),
      JSON.stringify(errors),
      JSON.stringify(parityData),
      migrationRunId
    );

    return {
      success: true,
      status: 'COMPLETED',
      migrationRunId,
      companyId,
      sourcePath,
      sourceSha256,
      schemaVersion,
      counts: {
        models: modelCount,
        workers: workerCount,
        tickets: ticketCount,
        parties: partyCount,
        quarantine: quarantineCount,
        reconciliationCandidates: candidateCount
      },
      parity: parityData,
      warnings,
      errors,
      migrationReady
    };
  });

  return executeMigration.immediate();
}

/**
 * Records an explicit operator resolution for a historical party collision into migration_party_resolutions.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} resolution
 * @param {string} resolution.quarantineId
 * @param {string} resolution.companyId
 * @param {string} resolution.partyId
 * @param {'CONFIRM_HISTORICALLY_CLOSED' | 'MARK_LEGACY_VOID' | 'KEEP_BOTH_REQUIRES_MANUAL_DISAMBIGUATION' | 'DEFER_REVIEW'} resolution.decision
 * @param {string} resolution.operatorId
 * @param {string} resolution.reason
 * @param {string} resolution.sourceSnapshotHash
 * @param {string} [resolution.decidedAt]
 * @param {number} [resolution.originalIsClosed=0]
 * @param {string|null} [resolution.originalClosedAt=null]
 * @param {string} [resolution.notes]
 * @returns {object} The recorded resolution audit record
 */
function recordPartyResolution(db, resolution) {
  const {
    quarantineId,
    companyId,
    partyId,
    decision,
    operatorId,
    reason,
    sourceSnapshotHash,
    decidedAt = new Date().toISOString(),
    originalIsClosed = 0,
    originalClosedAt = null,
    notes = null
  } = resolution;

  const validDecisions = [
    'CONFIRM_HISTORICALLY_CLOSED',
    'MARK_LEGACY_VOID',
    'KEEP_BOTH_REQUIRES_MANUAL_DISAMBIGUATION',
    'DEFER_REVIEW',
    'GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED'
  ];

  if (!validDecisions.includes(decision)) {
    throw new Error(`Invalid operator resolution decision: "${decision}". Must be one of: ${validDecisions.join(', ')}`);
  }
  if (decision === 'GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED'
    && (typeof companyId !== 'string' || !companyId.trim() || typeof partyId !== 'string' || !partyId.trim())) {
    const error = new Error('LEGACY_COLLISION_EXCEPTION_REQUIRED');
    error.code = 'LEGACY_COLLISION_EXCEPTION_REQUIRED';
    throw error;
  }

  const resolutionId = `res_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const resolutionProvenance = resolution.resolutionProvenance || (
    decision === 'CONFIRM_HISTORICALLY_CLOSED'
      ? 'OPERATOR_MIGRATION_DECISION'
      : (decision === 'GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED' ? 'OWNER_BUSINESS_DECISION' : 'OPERATOR_DISPOSITION')
  );

  const insertStmt = db.prepare(`
    INSERT INTO migration_party_resolutions (
      resolution_id, quarantine_id, company_id, party_id, decision,
      operator_id, decided_at, source_snapshot_hash, reason,
      original_is_closed, original_closed_at, resolution_provenance,
      resolution_notes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertStmt.run(
    resolutionId,
    quarantineId,
    companyId,
    partyId,
    decision,
    operatorId,
    decidedAt,
    sourceSnapshotHash,
    reason,
    originalIsClosed ? 1 : 0,
    originalClosedAt,
    resolutionProvenance,
    notes,
    new Date().toISOString()
  );

  return {
    resolutionId,
    quarantineId,
    companyId,
    partyId,
    decision,
    operatorId,
    decidedAt,
    sourceSnapshotHash,
    reason,
    originalIsClosed: originalIsClosed ? 1 : 0,
    originalClosedAt,
    resolutionProvenance
  };
}

/**
 * Applies an operator resolution to an already migrated database or quarantined party.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} resolution
 * @returns {object} Application result including audit record
 */
function applyPartyQuarantineResolution(db, resolution) {
  const audit = recordPartyResolution(db, resolution);
  const { quarantineId, partyId, companyId, decision, operatorId, decidedAt, reason } = resolution;

  const quarRow = db.prepare(`
    SELECT * FROM migration_quarantine_parties
    WHERE quarantine_id = ? OR (company_id = ? AND legacy_record_id = ?)
  `).get(quarantineId, companyId, partyId);

  if (!quarRow) {
    return { success: false, audit, error: `Quarantine record not found for party "${partyId}"` };
  }

  const targetQuarId = quarRow.quarantine_id;
  const targetPartyId = quarRow.legacy_record_id;
  const originalPartyNumber = quarRow.original_party_number;

  const nowIso = new Date().toISOString();

  if (decision === 'CONFIRM_HISTORICALLY_CLOSED') {
    // 1. Insert/update resolved party as CLOSED
    // DO NOT fabricate historical closed_at if unknown: keep original closed_at (null if unknown)
    let rawObj = {};
    try { rawObj = JSON.parse(quarRow.raw_source_json || '{}'); } catch {}

    const originalClosedAt = quarRow.original_closed_at || null;

    db.prepare(`
      INSERT OR REPLACE INTO parties (
        id, company_id, party_number, physical_party_number, model_id, model_name, color,
        patta_count, cumulative_patta_count, ish_soni_per_patta, total_ish_soni,
        ish_soni, cumulative_ish_soni, sizes_json, printed_at, is_closed, closed_at,
        archived_patta_numbers_json, status, created_at, updated_at, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'CLOSED', ?, ?, 'OPERATOR_MIGRATION_DECISION')
    `).run(
      targetPartyId,
      companyId,
      originalPartyNumber,
      originalPartyNumber,
      quarRow.model_id || 'UNKNOWN_MODEL',
      rawObj.modelName || null,
      rawObj.color || null,
      Number(quarRow.ticket_count || 0),
      Number(rawObj.cumulativePattaCount || 0),
      rawObj.ishSoniPerPatta ? Number(rawObj.ishSoniPerPatta) : null,
      rawObj.totalIshSoni ? Number(rawObj.totalIshSoni) : null,
      Number(rawObj.ishSoni || 0),
      Number(rawObj.cumulativeIshSoni || 0),
      JSON.stringify(rawObj.sizes || {}),
      quarRow.printed_at || null,
      originalClosedAt, // source closed_at preserved as null if unknown; NOT fabricated
      JSON.stringify(rawObj.archivedPattaNumbers || []),
      nowIso,
      nowIso
    );

    // Update target quarantine record as RESOLVED
    db.prepare(`
      UPDATE migration_quarantine_parties SET
        resolution_status = 'RESOLVED',
        resolved_party_id = ?,
        resolution_decision = ?,
        resolution_operator_id = ?,
        resolved_at = ?,
        resolution_notes = ?
      WHERE quarantine_id = ?
    `).run(targetPartyId, decision, operatorId, decidedAt || nowIso, reason, targetQuarId);

    // 2. Check if other quarantined parties for this party_number can now be safely imported as ACTIVE
    const otherQuarantined = db.prepare(`
      SELECT * FROM migration_quarantine_parties
      WHERE company_id = ? AND original_party_number = ? AND resolution_status = 'PENDING_REVIEW'
    `).all(companyId, originalPartyNumber);

    if (otherQuarantined.length === 1) {
      const other = otherQuarantined[0];
      let otherRaw = {};
      try { otherRaw = JSON.parse(other.raw_source_json || '{}'); } catch {}

      db.prepare(`
        INSERT OR REPLACE INTO parties (
          id, company_id, party_number, physical_party_number, model_id, model_name, color,
          patta_count, cumulative_patta_count, ish_soni_per_patta, total_ish_soni,
          ish_soni, cumulative_ish_soni, sizes_json, printed_at, is_closed, closed_at,
          archived_patta_numbers_json, status, created_at, updated_at, provenance
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 'ACTIVE', ?, ?, 'LEGACY_MIGRATION')
      `).run(
        other.legacy_record_id,
        companyId,
        originalPartyNumber,
        originalPartyNumber,
        other.model_id || 'UNKNOWN_MODEL',
        otherRaw.modelName || null,
        otherRaw.color || null,
        Number(other.ticket_count || 0),
        Number(otherRaw.cumulativePattaCount || 0),
        otherRaw.ishSoniPerPatta ? Number(otherRaw.ishSoniPerPatta) : null,
        otherRaw.totalIshSoni ? Number(otherRaw.totalIshSoni) : null,
        Number(otherRaw.ishSoni || 0),
        Number(otherRaw.cumulativeIshSoni || 0),
        JSON.stringify(otherRaw.sizes || {}),
        other.printed_at || null,
        JSON.stringify(otherRaw.archivedPattaNumbers || []),
        nowIso,
        nowIso
      );

      db.prepare(`
        UPDATE migration_quarantine_parties SET
          resolution_status = 'RESOLVED',
          resolved_party_id = ?,
          resolution_decision = 'RELEASED_ACTIVE',
          resolution_operator_id = ?,
          resolved_at = ?,
          resolution_notes = 'Released to ACTIVE following resolution of colliding party'
        WHERE quarantine_id = ?
      `).run(other.legacy_record_id, operatorId, decidedAt || nowIso, other.quarantine_id);
    }
  } else if (decision === 'GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED') {
    const activeCollisionRows = db.prepare(`
      SELECT id FROM parties WHERE company_id = ? AND party_number = ? AND status != 'CLOSED'
    `).all(companyId, originalPartyNumber);
    if (activeCollisionRows.length !== 1
      || (activeCollisionRows[0].id !== targetPartyId && !quarRow)) {
      const error = new Error('LEGACY_COLLISION_EXCEPTION_REQUIRED: a grandfathered collision must match persisted active rows');
      error.code = 'LEGACY_COLLISION_EXCEPTION_REQUIRED';
      throw error;
    }

    let rawObj = {};
    try { rawObj = JSON.parse(quarRow.raw_source_json || '{}'); } catch {}

    const excCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_party_collision_exceptions'`).get();
    if (excCheck) {
      const groupId = `col_group_${companyId}_party_${originalPartyNumber}`;
      db.prepare(`
        INSERT OR IGNORE INTO legacy_party_collision_exceptions (
          exception_id, company_id, party_number, party_id, collision_group_id,
          approved_by, approved_at, reason, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
      `).run(
        `exc_${companyId}_${targetPartyId}`,
        companyId,
        originalPartyNumber,
        targetPartyId,
        groupId,
        operatorId || 'OWNER_BUSINESS_DECISION',
        decidedAt || nowIso,
        reason || 'Existing production Party #2 duplicates are allowed to remain active until their normal operator-driven closure.',
        nowIso
      );
    }

    db.prepare(`
      INSERT OR REPLACE INTO parties (
        id, company_id, party_number, physical_party_number, model_id, model_name, color,
        patta_count, cumulative_patta_count, ish_soni_per_patta, total_ish_soni,
        ish_soni, cumulative_ish_soni, sizes_json, printed_at, is_closed, closed_at,
        archived_patta_numbers_json, status, created_at, updated_at, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 'ACTIVE', ?, ?, 'GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED')
    `).run(
      targetPartyId,
      companyId,
      originalPartyNumber,
      originalPartyNumber,
      quarRow.model_id || 'UNKNOWN_MODEL',
      rawObj.modelName || null,
      rawObj.color || null,
      Number(quarRow.ticket_count || 0),
      Number(rawObj.cumulativePattaCount || 0),
      rawObj.ishSoniPerPatta ? Number(rawObj.ishSoniPerPatta) : null,
      rawObj.totalIshSoni ? Number(rawObj.totalIshSoni) : null,
      Number(rawObj.ishSoni || 0),
      Number(rawObj.cumulativeIshSoni || 0),
      JSON.stringify(rawObj.sizes || {}),
      quarRow.printed_at || null,
      JSON.stringify(rawObj.archivedPattaNumbers || []),
      nowIso,
      nowIso
    );

    db.prepare(`
      UPDATE migration_quarantine_parties SET
        resolution_status = 'RESOLVED',
        resolved_party_id = ?,
        resolution_decision = ?,
        resolution_operator_id = ?,
        resolved_at = ?,
        resolution_notes = ?
      WHERE quarantine_id = ?
    `).run(targetPartyId, decision, operatorId || 'OWNER_BUSINESS_DECISION', decidedAt || nowIso, reason, targetQuarId);
  }

  // Recalculate remaining quarantine count
  const pendingQuar = db.prepare(`
    SELECT COUNT(*) as c FROM migration_quarantine_parties
    WHERE company_id = ? AND resolution_status = 'PENDING_REVIEW'
  `).get(companyId);

  return {
    success: true,
    audit,
    remainingQuarantineCount: pendingQuar.c
  };
}

/**
 * Retrieves all migration reconciliation candidates for a company.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @returns {Array<object>}
 */
function getReconciliationCandidates(db, companyId) {
  return db.prepare(`
    SELECT * FROM migration_reconciliation_candidates
    WHERE company_id = ?
    ORDER BY model_id, worker_id, operation_name
  `).all(companyId);
}

/**
 * Retrieves all reconciliation resolution audit rows for a company.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @returns {Array<object>}
 */
function getReconciliationResolutions(db, companyId) {
  return db.prepare(`
    SELECT * FROM migration_reconciliation_resolutions
    WHERE company_id = ?
    ORDER BY decided_at ASC
  `).all(companyId);
}

/**
 * Computes live reconciliation metrics for a company, verifying the delta conservation invariant.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @returns {object} Summary of approved, rejected, pending, and linked deltas
 */
function getReconciliationSummary(db, companyId) {
  const candidates = getReconciliationCandidates(db, companyId);
  let approvedAdjustmentTotal = 0;
  let rejectedTotal = 0;
  let stillPendingTotal = 0;
  let linkedSourceTotal = 0;
  let totalDelta = 0;
  let unresolvedCount = 0;

  for (const c of candidates) {
    const delta = Number(c.delta_qty || 0);
    totalDelta += delta;

    const decision = c.resolution_decision || (c.status === 'APPROVED' ? 'CONFIRM_LEGACY_AS_ADJUSTMENT' : null);
    if (decision === 'CONFIRM_LEGACY_AS_ADJUSTMENT' || c.status === 'APPROVED') {
      approvedAdjustmentTotal += delta;
    } else if (decision === 'REJECT_LEGACY_DIFFERENCE' || c.status === 'REJECTED') {
      rejectedTotal += delta;
    } else if (decision === 'LINK_TO_MISSING_SOURCE' || c.status === 'LINKED_SOURCE_PENDING') {
      linkedSourceTotal += delta;
      unresolvedCount++;
    } else {
      stillPendingTotal += delta;
      unresolvedCount++;
    }
  }

  const roundedApproved = Math.round(approvedAdjustmentTotal * 1e6) / 1e6;
  const roundedRejected = Math.round(rejectedTotal * 1e6) / 1e6;
  const roundedPending = Math.round(stillPendingTotal * 1e6) / 1e6;
  const roundedLinked = Math.round(linkedSourceTotal * 1e6) / 1e6;
  const roundedTotal = Math.round(totalDelta * 1e6) / 1e6;

  const sumCheck = Math.round((roundedApproved + roundedRejected + roundedPending + roundedLinked) * 1e6) / 1e6;
  if (sumCheck !== roundedTotal) {
    throw new Error(`[ReconciliationSummary] Conservation invariant broken: sum (${sumCheck}) != total (${roundedTotal})`);
  }

  return {
    approvedAdjustmentTotal: roundedApproved,
    rejectedTotal: roundedRejected,
    stillPendingTotal: roundedPending,
    linkedSourceTotal: roundedLinked,
    totalDelta: roundedTotal,
    candidateCount: candidates.length,
    unresolvedCount
  };
}

module.exports = {
  discoverLegacySource,
  computeSha256,
  migrateLegacyData,
  recordPartyResolution,
  applyPartyQuarantineResolution,
  getReconciliationCandidates,
  getReconciliationResolutions,
  getReconciliationSummary
};
