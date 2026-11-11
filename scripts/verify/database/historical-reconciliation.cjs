'use strict';
// Evidence-only reconciliation. Never updates attribution or infers it from dates,
// matching quantities, model totals or current rates. Outputs no names/credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { canonicalStringify, computePayloadHash } = require('../../../apps/desktop/electron/database/core/canonicalPayload.cjs');

function classifyAdjustment(row, evidence) {
  const reasons = [];
  const direct = evidence.sources.filter(source => source.adjustmentId === row.adjustment_id);
  const exact = direct.filter(source => source.companyId === row.company_id && source.modelId === row.model_id
    && Number(source.workerId) === row.worker_id && source.opName === row.op_name
    && Number(source.deltaQty) === Number(row.delta_qty));
  if (direct.length !== exact.length) reasons.push('CONFLICTING_DIRECT_SOURCE');
  const links = exact.filter(source => source.originalTicketId && source.originalEntryId && source.originalPeriodId
    && source.originalRateSnapshot != null);
  const fingerprints = new Set(links.map(source => JSON.stringify([source.originalTicketId, source.originalEntryId,
    source.originalPeriodId, String(source.originalRateSnapshot)])));
  if (fingerprints.size > 1) reasons.push('CONFLICTING_ATTRIBUTION');
  const proven = links.filter(source => evidence.immutableEntries.some(entry =>
    entry.companyId === row.company_id && entry.ticketId === source.originalTicketId
    && entry.entryId === source.originalEntryId && entry.periodId === source.originalPeriodId
    && entry.modelId === row.model_id && Number(entry.workerId) === row.worker_id && entry.opName === row.op_name
    && entry.rateSnapshot != null && Number(entry.rateSnapshot) === Number(source.originalRateSnapshot)));
  if (proven.length === links.length && proven.length && fingerprints.size === 1 && !reasons.length) {
    return { classification: 'VERIFIED', reasons: ['DIRECT_SOURCE_AND_IMMUTABLE_WORK_MATCH'], acceptedEvidenceCount: exact.length };
  }
  if (links.length && !proven.length) reasons.push('ATTRIBUTION_NOT_IMMUTABLY_CORROBORATED');
  if (!links.length) reasons.push('NO_EXPLICIT_ORIGINAL_WORK_ATTRIBUTION');
  if (!direct.length) reasons.push('NO_RETAINED_COMMAND_PAYLOAD');
  return { classification: reasons.some(reason => reason.startsWith('CONFLICTING')) ? 'AMBIGUOUS' : 'UNRESOLVED',
    reasons, acceptedEvidenceCount: exact.length };
}

async function reconcile(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const adjustments = (await client.query('SELECT * FROM production_adjustments ORDER BY company_id,adjustment_id')).rows;
    const changes = (await client.query(`SELECT c.company_id,c.entity_id,c.operation_id,c.payload_json,d.payload_hash,d.command_type,
      d.entity_id AS accepted_entity_id FROM change_log c LEFT JOIN operations_dedup d
      ON d.company_id=c.company_id AND d.operation_id=c.operation_id
      WHERE c.entity_type='production_adjustment' ORDER BY c.change_id`)).rows;
    const archives = (await client.query('SELECT company_id,period_id,archive_json,sha256 FROM period_archives ORDER BY company_id,period_id')).rows;
    const candidates = (await client.query('SELECT company_id,created_adjustment_id FROM migration_reconciliation_candidates')).rows;
    const resolutions = (await client.query('SELECT company_id,created_adjustment_id FROM migration_reconciliation_resolutions')).rows;
    const baselines = (await client.query(`SELECT company_id,source_snapshot_hash,decision,scope_json FROM migration_baseline_decisions`)).rows;
    const workerBalances = (await client.query(`SELECT company_id,count(*)::integer AS workers,
      count(*) FILTER (WHERE legacy_avans<>0 OR legacy_jarima<>0 OR staj<>0)::integer AS workers_with_legacy_balances,
      sum(legacy_avans)::text AS legacy_avans,sum(legacy_jarima)::text AS legacy_jarima,sum(staj)::text AS staj
      FROM workers GROUP BY company_id`)).rows;
    const provenance = (await client.query(`SELECT company_id,provenance,count(*)::integer AS records,
      sum(delta_qty)::text AS signed_quantity,min(created_at) AS first_recorded,max(created_at) AS last_recorded
      FROM production_adjustments GROUP BY company_id,provenance ORDER BY company_id,provenance`)).rows;
    const immutableEntries = [];
    for (const archive of archives) {
      assert.equal(computePayloadHash(canonicalStringify(archive.archive_json)), archive.sha256, 'ARCHIVE_DIGEST_MISMATCH');
      assert.equal(archive.archive_json.period.id, archive.period_id);
      assert(archive.archive_json.companyId == null || archive.archive_json.companyId === archive.company_id);
      for (const ticket of archive.archive_json.submittedTickets || []) for (const entry of ticket.entries || []) {
        if (ticket.periodId != null && ticket.periodId !== archive.period_id) continue;
        immutableEntries.push({ companyId: archive.company_id, periodId: archive.period_id, ticketId: ticket.id,
          entryId: entry.entryId, modelId: ticket.modelId, workerId: entry.workerId, opName: entry.opName, rateSnapshot: entry.rateSnapshot });
      }
    }
    const result = adjustments.map(row => {
      const retained = changes.filter(change => change.company_id === row.company_id && change.entity_id === row.adjustment_id);
      const accepted = retained.filter(change => change.command_type === 'RecordProductionAdjustment'
        && change.accepted_entity_id === row.adjustment_id && change.payload_json.operationId === change.operation_id
        && computePayloadHash(canonicalStringify(change.payload_json)) === change.payload_hash);
      const decision = classifyAdjustment(row, { sources: accepted.map(change => change.payload_json), immutableEntries });
      return { companyId: row.company_id, adjustmentId: row.adjustment_id, workerId: row.worker_id, modelId: row.model_id,
        operation: row.op_name, deltaQty: row.delta_qty, status: row.status, provenance: row.provenance,
        storedAttribution: row.attribution_status, originalTicketId: row.original_ticket_id, originalEntryId: row.original_entry_id,
        originalPeriodId: row.original_period_id, originalRateSnapshot: row.original_rate_snapshot,
        retainedChanges: retained.length, authenticatedCommandEvidence: accepted.length,
        reconciliationCandidates: candidates.filter(c => c.company_id === row.company_id && c.created_adjustment_id === row.adjustment_id).length,
        reconciliationResolutions: resolutions.filter(c => c.company_id === row.company_id && c.created_adjustment_id === row.adjustment_id).length,
        financialAmount: null, financialAmountReason: decision.classification === 'VERIFIED'
          ? 'MONEY_NOT_CALCULATED_BY_EVIDENCE_RECONCILER' : 'NO_VERIFIED_PERIOD_AND_TARIFF', ...decision };
    });
    const counts = { VERIFIED: 0, AMBIGUOUS: 0, UNRESOLVED: 0 };
    for (const row of result) counts[row.classification]++;
    return { source: 'local restored production backup; repeatable-read read-only transaction',
      classificationScope: 'Original work/period/tariff attribution; accepted command alone is NOT financial verification',
      classifications: counts, provenance, records: result,
      archives: archives.map(a => ({ companyId: a.company_id, periodId: a.period_id, sha256: a.sha256, digestValid: true })),
      openingBalances: { classification: 'UNRESOLVED', reason: 'NO_EXTERNAL_OPENING_BALANCE_ATTESTATION', workerBalances,
        baselines: baselines.map(b => ({ companyId: b.company_id, sourceSha256: b.source_snapshot_hash, decision: b.decision,
          sourceCounts: b.scope_json?.sourceTableCounts, historicalImportDocumented: b.scope_json?.evidence?.historicalTransactionalImportDocumented,
          scope: 'Import inventory/provenance, not period-specific financial reconciliation' })) },
      mutations: 0, resolutionPolicy: 'No automatic writes; even VERIFIED findings require a reviewed explicit reconciliation command' };
  } finally { await client.query('ROLLBACK'); }
}

async function main() {
  assert(!process.env.DATABASE_URL && !process.env.NOVDA_PG_URL, 'Ambient database URLs must be unset');
  const url = new URL(process.env.NOVDA_AUDIT_PG_URL || '');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55432');
  assert(/^\/novda_(local_current|audit_[a-z0-9_]+)$/.test(url.pathname));
  const pool = new Pool({ connectionString: url.toString() });
  const client = await pool.connect();
  try {
    const report = await reconcile(client);
    assert(process.argv[2], 'Output path required');
    fs.mkdirSync(path.dirname(path.resolve(process.argv[2])), { recursive: true });
    fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ classifications: report.classifications, records: report.records.length,
      acceptedCommands: report.records.filter(r => r.authenticatedCommandEvidence).length,
      openingBalances: report.openingBalances.classification, mutations: report.mutations }));
  } finally { client.release(); await pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(error.code || 'RECONCILIATION_FAILED'); process.exitCode = 1; });
module.exports = { classifyAdjustment, reconcile };
