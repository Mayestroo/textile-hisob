'use strict';
// Read-only inventory/classifier for a loopback disposable PostgreSQL copy.
// Never infers issuance from quantity, dates, or client payload assertions.
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

function classifyCandidate(candidate) {
  const reasons = [];
  if (!candidate.companyId || !candidate.ticketId || !candidate.partyRecordId) reasons.push('CANONICAL_IDENTITY_INCOMPLETE');
  if (candidate.identityConflicts?.length) reasons.push(...candidate.identityConflicts);
  const evidence = candidate.issuanceEvidence || [];
  const exact = evidence.filter(e => e.companyId === candidate.companyId && e.partyRecordId === candidate.partyRecordId
    && e.ticketId === candidate.ticketId && e.pattaNumber === candidate.pattaNumber
    && e.operationId && e.payloadHash && e.receiptReference && e.receiptPayloadHash === e.payloadHash);
  if (evidence.length > 1 || candidate.duplicateReferences) reasons.push('DUPLICATE_ISSUANCE_REFERENCE');
  if (evidence.some(e => e.companyId !== candidate.companyId)) reasons.push('CROSS_TENANT_EVIDENCE');
  if (evidence.some(e => e.ticketId !== candidate.ticketId || e.partyRecordId !== candidate.partyRecordId || e.pattaNumber !== candidate.pattaNumber)) reasons.push('ISSUANCE_IDENTITY_MISMATCH');
  if (reasons.some(r => ['CROSS_TENANT_EVIDENCE','ISSUANCE_IDENTITY_MISMATCH','DUPLICATE_ISSUANCE_REFERENCE'].includes(r))) return { classification: 'AMBIGUOUS', reasons };
  if (exact.length === 1) return { classification: 'VERIFIED', reasons: ['EXACT_TENANT_SCOPED_IMMUTABLE_ISSUANCE_AND_RECEIPT'] };
  if (!evidence.length) reasons.push('NO_IMMUTABLE_ISSUANCE_OPERATION_REFERENCE');
  else if (!exact.length) reasons.push('NO_EXACT_RECEIPT_BOUND_ISSUANCE');
  return { classification: 'MISSING_EVIDENCE', reasons };
}

async function run(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const schema = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
    const tables = new Set(schema.rows.map(r => r.table_name));
    for (const required of ['tickets','parties','operations_dedup']) if (!tables.has(required)) throw new Error(`REQUIRED_TABLE_MISSING:${required}`);
    const result = await client.query(`SELECT t.company_id,t.id AS ticket_id,t.party_record_id,t.party_number,t.patta_number,t.model_id,
        p.company_id AS party_company_id,p.id AS canonical_party_id,
        d.operation_id,d.payload_hash,d.command_type,d.entity_type,d.entity_id,d.result_json,d.accepted_at
      FROM tickets t LEFT JOIN parties p ON p.company_id=t.company_id AND p.id=t.party_record_id
      LEFT JOIN operations_dedup d ON d.company_id=t.company_id AND d.entity_type='ticket' AND d.entity_id=t.id
      ORDER BY t.company_id,t.id,d.operation_id`);
    const grouped = new Map();
    for (const row of result.rows) {
      const key = `${row.company_id}\0${row.ticket_id}`;
      let c = grouped.get(key);
      if (!c) { c = { companyId: row.company_id, ticketId: row.ticket_id, partyRecordId: row.party_record_id,
        partyNumber: row.party_number, pattaNumber: Number(row.patta_number), modelId: row.model_id,
        operationIds: [], payloadHashes: [], receiptReferences: [], issuanceReferences: [],
        identityConflicts: row.party_company_id == null ? ['CANONICAL_PARTY_NOT_FOUND_IN_TENANT'] : [] };
        grouped.set(key,c); }
      if (row.operation_id) { c.operationIds.push(row.operation_id); c.payloadHashes.push(row.payload_hash);
        c.receiptReferences.push({ operationId: row.operation_id, payloadHash: row.payload_hash, acceptedAt: row.accepted_at,
          serverRevision: row.result_json?.serverRevision ?? null }); }
    }
    // Current schema has no source issuance-operation FK/reference on parties or printed_pattas.
    // Keep a count and explicit reason rather than treating a ticket receipt as issuance proof.
    const records = [...grouped.values()].map(c => ({ ...c, classification: classifyCandidate(c).classification,
      reasons: classifyCandidate(c).reasons, issuanceReferences: [], issuanceEvidence: [] }));
    const classifications = { VERIFIED: 0, AMBIGUOUS: 0, MISSING_EVIDENCE: 0 };
    for (const r of records) classifications[r.classification]++;
    return { audit: 'legacy-issuance-reconciliation', source: 'caller-provided disposable local PostgreSQL copy',
      sourceWrites: 0, transaction: 'REPEATABLE READ READ ONLY', candidates: records.length, classifications,
      limitations: ['No source issuance-operation reference is persisted in the inspected current schema.',
        'Ticket acceptance receipts do not prove a link to the original party/patta issuance operation.'], records };
  } finally { await client.query('ROLLBACK'); }
}

async function main() {
  if (process.env.DATABASE_URL || process.env.NOVDA_PG_URL) throw new Error('AMBIENT_DATABASE_URL_FORBIDDEN');
  const url = new URL(process.env.NOVDA_AUDIT_PG_URL || '');
  if (url.hostname !== '127.0.0.1' || url.port !== '55432' || !/^\/novda_audit_[a-z0-9_]+$/.test(url.pathname)) throw new Error('ONLY_NAMED_LOOPBACK_DISPOSABLE_DATABASE_ALLOWED');
  if (!process.argv[2]) throw new Error('OUTPUT_PATH_REQUIRED');
  const pool = new Pool({ connectionString: url.toString(), options: '-c default_transaction_read_only=on' });
  try {
    const client = await pool.connect();
    try { const report = await run(client); fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(report,null,2)+'\n',{flag:'wx'});
      console.log(JSON.stringify({candidates:report.candidates,classifications:report.classifications,sourceWrites:0})); }
    finally { client.release(); }
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(e => { console.error(e.message || 'LEGACY_ISSUANCE_AUDIT_FAILED'); process.exitCode=1; });
module.exports = { classifyCandidate, run };
