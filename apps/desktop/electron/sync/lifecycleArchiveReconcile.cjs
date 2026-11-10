'use strict';

const { isDeepStrictEqual } = require('node:util');
const { validatePeriodArchive, readCanonicalPeriodTickets } = require('../database/periodArchiveValidator.cjs');

function captureFirstAcceptanceContext(db, companyId, periodId, operationId) {
  const period = db.prepare('SELECT * FROM periods WHERE company_id = ? AND id = ?').get(companyId, periodId) || null;
  const marker = db.prepare('SELECT value, updated_at FROM local_meta WHERE key = ?')
    .get(`accepted_archive_sha256:${periodId}`) || null;
  const archive = db.prepare('SELECT * FROM period_archives WHERE company_id = ? AND period_id = ?')
    .get(companyId, periodId) || null;
  const outbox = db.prepare(`SELECT * FROM local_outbox WHERE company_id = ? AND operation_id = ?
    AND command_type = 'ClosePeriod' AND entity_id = ?`).get(companyId, operationId, periodId) || null;
  return { companyId, periodId, period, marker, archive, outbox };
}

// Only a locally authored provisional archive can be replaced on first
// acceptance. A previously installed authoritative snapshot is immutable.
async function reconcileLifecycleArchives(db, companyId, client) {
  if (typeof client.getPeriodArchive !== 'function') return { reconciled: 0, incomplete: 0 };
  const rows = db.prepare(`SELECT o.operation_id, o.entity_id, p.close_operation_id,
    o.accepted_change_id, o.local_archive_json FROM local_outbox o
    JOIN periods p ON p.company_id = o.company_id AND p.id = o.entity_id
    WHERE o.company_id = ? AND o.command_type = 'ClosePeriod'
      AND o.local_archive_json IS NOT NULL`).all(companyId);
  let reconciled = 0;
  let incomplete = 0;
  const integrityProblems = [];
  for (const row of rows) {
    const canonicalTickets = readCanonicalPeriodTickets(db, companyId, row.entity_id);
    const record = JSON.parse(row.local_archive_json);
    if (record.kind !== 'period-close-effects') continue;
    if (row.close_operation_id !== row.operation_id) {
      incomplete++;
      integrityProblems.push({ code: 'ACCEPTED_ARCHIVE_CONTEXT_MISMATCH', periodId: row.entity_id });
      continue;
    }
    const knownKey = `accepted_archive_sha256:${row.entity_id}`;
    const known = db.prepare('SELECT value FROM local_meta WHERE key = ?').get(knownKey)?.value;
    const stored = db.prepare('SELECT archive_json, sha256 FROM period_archives WHERE company_id = ? AND period_id = ?')
      .get(companyId, row.entity_id);
    if (known) {
      let storedData = null;
      try { storedData = stored && JSON.parse(stored.archive_json); } catch { /* invalid stored evidence */ }
      const close = db.prepare('SELECT close_operation_id FROM periods WHERE company_id = ? AND id = ?')
        .get(companyId, row.entity_id);
      const acceptedContext = close?.close_operation_id === row.operation_id;
      if (acceptedContext && stored && stored.sha256 === known &&
          !validatePeriodArchive(storedData, stored.sha256, companyId, row.entity_id,
            { binding: 'retained-local-owner', canonicalTickets })) continue;
      incomplete++;
      integrityProblems.push({ code: 'ACCEPTED_ARCHIVE_REPAIR_REQUIRED', periodId: row.entity_id });
      continue;
    }
    const captured = captureFirstAcceptanceContext(db, companyId, row.entity_id, row.operation_id);
    if (!captured.period || !captured.period.is_closed || captured.period.close_operation_id !== row.operation_id ||
        !captured.outbox || captured.outbox.local_archive_json !== row.local_archive_json) {
      incomplete++;
      integrityProblems.push({ code: 'ACCEPTED_ARCHIVE_CONTEXT_MISMATCH', periodId: row.entity_id });
      continue;
    }
    // A feed fact, not an ACK or optimistic local closure, certifies the
    // accepted operation ID before we request its frozen archive.
    let response;
    try { response = await client.getPeriodArchive(row.entity_id); }
    catch { incomplete++; continue; }
    let archive;
    try { archive = typeof response?.archive_json === 'string' ? JSON.parse(response.archive_json) : response?.archive_json; }
    catch { incomplete++; continue; }
    const hash = response?.sha256;
    // The client method is the authenticated, tenant-scoped GET adapter. Its
    // request scope is trusted; no claim inside archive_json grants this mode.
    const admissionProblem = validatePeriodArchive(archive, hash, companyId, row.entity_id,
      { binding: 'authenticated-request-scope', canonicalTickets });
    if (admissionProblem) {
      incomplete++;
      integrityProblems.push({ code: admissionProblem, periodId: row.entity_id });
      continue;
    }
    try { db.transaction(() => {
      const current = captureFirstAcceptanceContext(db, companyId, row.entity_id, row.operation_id);
      if (!isDeepStrictEqual(current, captured)) throw new Error('ACCEPTED_PERIOD_ARCHIVE_STALE_CONTEXT');
      const existing = current.archive;
      let existingData = null;
      try { existingData = existing && JSON.parse(existing.archive_json); } catch { /* allow repair only for invalid installed bytes */ }
      const existingValid = existing && !validatePeriodArchive(existingData, existing.sha256, companyId, row.entity_id,
        { binding: 'retained-local-owner', canonicalTickets });
      const isOwnProvisional = existing && record.effects?.provisionalArchiveSha256 === existing.sha256;
      if (existingValid && existing.sha256 !== hash && !isOwnProvisional) throw new Error('ACCEPTED_PERIOD_ARCHIVE_CHANGED');
      if (!existingValid && existing && !isOwnProvisional) throw new Error('ACCEPTED_PERIOD_ARCHIVE_REPAIR_REQUIRED');
      const period = current.period;
      if (!period?.is_closed || period.close_operation_id !== row.operation_id) throw new Error('ACCEPTED_PERIOD_ARCHIVE_STALE_CONTEXT');
      // If an already-valid row has the accepted digest, preserve its exact
      // bytes and timestamp. First acceptance only replaces an exact own
      // provisional row; otherwise a missing row is inserted.
      if (!existingValid || existing.sha256 !== hash) {
        const archiveJson = typeof response.archive_json === 'string' ? response.archive_json : JSON.stringify(archive);
        db.prepare(`INSERT INTO period_archives(company_id, period_id, archive_json, sha256, archived_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(company_id, period_id) DO UPDATE SET
          archive_json = excluded.archive_json, sha256 = excluded.sha256, archived_at = excluded.archived_at`)
          .run(companyId, row.entity_id, archiveJson, hash, response.archived_at || new Date().toISOString());
      }
      db.prepare(`INSERT INTO local_meta(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(knownKey, hash, new Date().toISOString());
    }).immediate(); }
    catch (error) {
      incomplete++;
      integrityProblems.push({ code: error?.message === 'ACCEPTED_PERIOD_ARCHIVE_REPAIR_REQUIRED'
        ? 'ACCEPTED_ARCHIVE_REPAIR_REQUIRED' : error?.message === 'ACCEPTED_PERIOD_ARCHIVE_STALE_CONTEXT'
          ? 'ACCEPTED_ARCHIVE_STALE_CONTEXT' : 'ACCEPTED_ARCHIVE_CONTEXT_MISMATCH', periodId: row.entity_id });
      continue;
    }
    reconciled++;
  }
  const repairRequired = integrityProblems.some(({ code }) => code.includes('REPAIR_REQUIRED') || code.includes('CONTEXT_MISMATCH'));
  return { reconciled, incomplete, ...(integrityProblems.length ? { integrityProblems } : {}),
    ...(repairRequired ? { repairRequired: true } : {}) };
}

module.exports = { reconcileLifecycleArchives };
