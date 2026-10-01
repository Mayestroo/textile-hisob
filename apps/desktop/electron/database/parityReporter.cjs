'use strict';

const fs = require('fs');
const { getCompanyDatabase } = require('./databaseManager.cjs');
const { computeSha256, discoverLegacySource } = require('./migrator.cjs');

/**
 * Computes and returns a comprehensive dual-read parity verification report
 * between the active legacy JSON file and the SQLite database.
 * Does not mutate either data source.
 *
 * @param {string} baseUserDataPath
 * @param {string} companyId
 * @returns {object} Structured Parity Report
 */
function generateParityReport(baseUserDataPath, companyId) {
  const discovery = discoverLegacySource(baseUserDataPath, companyId);
  if (discovery.status !== 'VALID' || !discovery.path) {
    return {
      success: false,
      companyId,
      status: discovery.status,
      error: discovery.error || 'Legacy source not available',
      migrationReady: false
    };
  }

  const legacyRaw = fs.readFileSync(discovery.path, 'utf8');
  const sourceSha256 = computeSha256(legacyRaw);

  let legacyData;
  try {
    legacyData = JSON.parse(legacyRaw);
  } catch (err) {
    return {
      success: false,
      companyId,
      sourceSha256,
      status: 'PARSING_ERROR',
      error: `Failed to parse legacy JSON: ${err.message}`,
      migrationReady: false
    };
  }

  const db = getCompanyDatabase(baseUserDataPath, companyId);

  // Read latest completed migration run
  const lastRun = db.prepare(`
    SELECT * FROM migration_runs
    WHERE company_id = ? AND status = 'COMPLETED'
    ORDER BY started_at DESC LIMIT 1
  `).get(companyId);

  // Query actual counts in SQLite
  const sqliteModelsCount = db.prepare('SELECT COUNT(*) as c FROM models WHERE company_id = ?').get(companyId).c;
  const sqliteWorkersCount = db.prepare('SELECT COUNT(*) as c FROM workers WHERE company_id = ?').get(companyId).c;
  const sqliteTicketsCount = db.prepare('SELECT COUNT(*) as c FROM tickets WHERE company_id = ?').get(companyId).c;
  const sqlitePartiesCount = db.prepare('SELECT COUNT(*) as c FROM parties WHERE company_id = ?').get(companyId).c;

  const partyQuarantineCount = db.prepare('SELECT COUNT(*) as c FROM migration_quarantine_parties WHERE company_id = ?').get(companyId).c;
  const ticketQuarantineCount = db.prepare('SELECT COUNT(*) as c FROM migration_quarantine_tickets WHERE company_id = ?').get(companyId).c;
  const entryQuarantineCount = db.prepare('SELECT COUNT(*) as c FROM migration_quarantine_ticket_entries WHERE company_id = ?').get(companyId).c;
  const totalQuarantineCount = partyQuarantineCount + ticketQuarantineCount + entryQuarantineCount;

  const reconciliationCandidates = db.prepare(`
    SELECT * FROM migration_reconciliation_candidates WHERE company_id = ?
  `).all(companyId);

  // Compute sums
  let legacyHisobTotals = 0;
  const legacyModels = Array.isArray(legacyData.models) ? legacyData.models : [];
  for (const m of legacyModels) {
    if (m.hisobQuantities && typeof m.hisobQuantities === 'object') {
      for (const ops of Object.values(m.hisobQuantities)) {
        if (ops && typeof ops === 'object') {
          for (const qty of Object.values(ops)) {
            legacyHisobTotals += Number(qty || 0);
          }
        }
      }
    }
  }

  const reconstructedRow = db.prepare(`
    SELECT COALESCE(SUM(qty), 0) as total FROM ticket_entries WHERE company_id = ?
  `).get(companyId);
  const reconstructedHisobTotals = Number(reconstructedRow.total);

  const errors = [];
  const warnings = [];

  if (lastRun && lastRun.source_sha256 !== sourceSha256) {
    warnings.push(`Legacy source file has changed since last migration (migrated: ${lastRun.source_sha256}, current: ${sourceSha256})`);
  }

  if (totalQuarantineCount > 0) {
    warnings.push(`${totalQuarantineCount} entity record(s) currently held in migration quarantine`);
  }

  if (reconciliationCandidates.length > 0) {
    warnings.push(`${reconciliationCandidates.length} unexplained hisob reconciliation candidate(s) awaiting review`);
  }

  const migrationReady = (
    errors.length === 0 &&
    totalQuarantineCount === 0 &&
    reconciliationCandidates.length === 0 &&
    (lastRun && lastRun.source_sha256 === sourceSha256)
  );

  return {
    success: true,
    companyId,
    sourceSha256,
    lastMigrationRunId: lastRun?.migration_run_id || null,
    legacy: {
      modelCount: legacyModels.length,
      workerCount: (legacyData.workers || []).length,
      ticketCount: (legacyData.submittedTickets || []).length,
      partyCount: (legacyData.printedPartyHistory || []).length
    },
    sqlite: {
      modelCount: sqliteModelsCount,
      workerCount: sqliteWorkersCount,
      ticketCount: sqliteTicketsCount,
      partyCount: sqlitePartiesCount
    },
    financial: {
      legacyHisobTotals,
      reconstructedHisobTotals,
      differenceCount: reconciliationCandidates.length,
      differenceMagnitude: Math.abs(legacyHisobTotals - reconstructedHisobTotals),
      reconciliationCandidates: reconciliationCandidates.map(c => ({
        candidateId: c.candidate_id,
        modelId: c.model_id,
        workerId: c.worker_id,
        operation: c.operation_name,
        legacyQty: c.legacy_qty,
        ticketDerivedQty: c.ticket_derived_qty,
        deltaQty: c.delta_qty,
        status: c.status,
        reason: c.reason
      }))
    },
    quarantine: {
      parties: partyQuarantineCount,
      tickets: ticketQuarantineCount,
      ticketEntries: entryQuarantineCount,
      total: totalQuarantineCount
    },
    warnings,
    errors,
    migrationReady
  };
}

module.exports = {
  generateParityReport
};
