'use strict';

const { canonicalStringify, computePayloadHash } = require('../database/canonicalPayload.cjs');

// Only a locally authored provisional archive can be replaced on first
// acceptance. A previously installed authoritative snapshot is immutable.
async function reconcileLifecycleArchives(db, companyId, client) {
  if (typeof client.getPeriodArchive !== 'function') return { reconciled: 0, incomplete: 0 };
  const rows = db.prepare(`SELECT o.operation_id, o.entity_id, p.close_operation_id,
    o.accepted_change_id, o.local_archive_json FROM local_outbox o
    JOIN periods p ON p.company_id = o.company_id AND p.id = o.entity_id
    WHERE o.company_id = ? AND o.command_type = 'ClosePeriod' AND p.close_operation_id = o.operation_id
      AND o.local_archive_json IS NOT NULL`).all(companyId);
  let reconciled = 0;
  let incomplete = 0;
  for (const row of rows) {
    const record = JSON.parse(row.local_archive_json);
    if (record.kind !== 'period-close-effects') continue;
    const knownKey = `accepted_archive_sha256:${row.entity_id}`;
    const known = db.prepare('SELECT value FROM local_meta WHERE key = ?').get(knownKey)?.value;
    if (known) continue;
    // A feed fact, not an ACK or optimistic local closure, certifies the
    // accepted operation ID before we request its frozen archive.
    let response;
    try { response = await client.getPeriodArchive(row.entity_id); }
    catch { incomplete++; continue; }
    const archive = typeof response?.archive_json === 'string' ? JSON.parse(response.archive_json) : response?.archive_json;
    const hash = response?.sha256;
    if (!archive || !/^[a-f0-9]{64}$/.test(hash || '') ||
        archive.period?.id !== row.entity_id ||
        computePayloadHash(canonicalStringify(archive)) !== hash) throw new Error('ACCEPTED_PERIOD_ARCHIVE_INTEGRITY_FAILURE');
    db.transaction(() => {
      const existing = db.prepare(`SELECT archive_json, sha256 FROM period_archives WHERE company_id = ? AND period_id = ?`)
        .get(companyId, row.entity_id);
      if (existing && existing.sha256 !== hash &&
          record.effects?.provisionalArchiveSha256 !== existing.sha256) throw new Error('ACCEPTED_PERIOD_ARCHIVE_CHANGED');
      const period = db.prepare('SELECT close_operation_id FROM periods WHERE company_id = ? AND id = ?')
        .get(companyId, row.entity_id);
      if (period?.close_operation_id !== row.operation_id) throw new Error('ACCEPTED_PERIOD_ARCHIVE_CONTEXT_CHANGED');
      db.prepare(`INSERT INTO period_archives(company_id, period_id, archive_json, sha256, archived_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(company_id, period_id) DO UPDATE SET
        archive_json = excluded.archive_json, sha256 = excluded.sha256, archived_at = excluded.archived_at`)
        .run(companyId, row.entity_id, JSON.stringify(archive), hash, response.archived_at || new Date().toISOString());
      db.prepare(`INSERT INTO local_meta(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(knownKey, hash, new Date().toISOString());
    }).immediate();
    reconciled++;
  }
  return { reconciled, incomplete };
}

module.exports = { reconcileLifecycleArchives };
