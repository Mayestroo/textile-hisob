'use strict';

// Read-only diagnostics: never prints names, credentials or full archive payloads.
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { canonicalStringify, computePayloadHash } = require('../../../apps/desktop/electron/database/core/canonicalPayload.cjs');
const { sameCanonicalTicket } = require('../../../apps/desktop/electron/database/archive/periodArchiveValidator.cjs');

async function main() {
  const url = new URL(process.env.NOVDA_AUDIT_PG_URL || '');
  assert.equal(url.hostname, '127.0.0.1');
  assert(/^\/novda_(audit_[a-z0-9_]+|local_current)$/.test(url.pathname));
  const pool = new Pool({ connectionString: url.toString() });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const archives = (await client.query('SELECT company_id, period_id, archive_json, sha256 FROM period_archives')).rows;
    for (const row of archives) {
      const archive = row.archive_json;
      const tickets = (await client.query('SELECT * FROM tickets WHERE company_id=$1 AND period_id=$2', [row.company_id, row.period_id])).rows;
      const aliases = (await client.query('SELECT * FROM model_id_aliases WHERE company_id=$1', [row.company_id])).rows;
      const partyAliases = (await client.query('SELECT * FROM party_id_aliases WHERE company_id=$1', [row.company_id])).rows;
      const models = new Map(aliases.map(a => [a.legacy_model_id, a.canonical_model_id]));
      const parties = new Map(partyAliases.map(a => [a.legacy_party_id, a.canonical_party_id]));
      const byId = new Map(tickets.map(t => [t.id, t]));
      const entries = (await client.query(`SELECT e.* FROM ticket_entries e JOIN tickets t ON t.company_id=e.company_id AND t.id=e.ticket_id
        WHERE t.company_id=$1 AND t.period_id=$2`, [row.company_id, row.period_id])).rows;
      const entryMap = new Map();
      for (const e of entries) { if (!entryMap.has(e.ticket_id)) entryMap.set(e.ticket_id, []); entryMap.get(e.ticket_id).push(e); }
      const mismatches = {};
      for (const t of archive.submittedTickets) {
        const c = byId.get(t.id);
        if (!c) { mismatches.missingCanonical = (mismatches.missingCanonical || 0) + 1; continue; }
        const add = key => { mismatches[key] = (mismatches[key] || 0) + 1; };
        const candidate = { ...c, submitted_at: new Date(c.submitted_at).toISOString(),
          historicalEntries: (entryMap.get(t.id) || []).map(e => ({ ...e, rate_snapshot: e.rate_snapshot == null ? null : Number(e.rate_snapshot) })) };
        if (!sameCanonicalTicket(t, candidate)) add('validator:notMatched:' + c.status);
        if (t.modelId !== c.model_id) add('rawModelId:conflict');
        if (t.partyRecordId == null && c.party_record_id != null) add('absentParty:canonicalPresent');
        if (Date.parse(t.submittedAt) !== new Date(c.submitted_at).getTime()) add('timestamp:conflict');
        const frozenEntries = (t.entries || []).map(e => JSON.stringify([e.opName, Number(e.workerId), e.rateSnapshot ?? null, e.brak || null])).sort();
        const liveEntries = (entryMap.get(t.id) || []).map(e => JSON.stringify([e.op_name, Number(e.worker_id), e.rate_snapshot == null ? null : Number(e.rate_snapshot), e.brak || null])).sort();
        if (JSON.stringify(frozenEntries) !== JSON.stringify(liveEntries)) add('entries:conflict');
        if (t.status !== c.status) add('status:conflict');
        if (!c.is_closed) add('canonical:notClosed');
        for (const [field, column] of Object.entries({ modelId: 'model_id', partyRecordId: 'party_record_id', partyNumber: 'party_number', pattaNumber: 'patta_number', qty: 'qty', size: 'size', color: 'color' })) {
          const value = field === 'modelId' ? models.get(t[field]) || t[field] : field === 'partyRecordId' ? parties.get(t[field]) || t[field] : t[field];
          const kind = t[field] == null ? 'absent' : String(value) !== String(c[column]) ? 'conflict' : null;
          if (kind) mismatches[`${field}:${kind}`] = (mismatches[`${field}:${kind}`] || 0) + 1;
        }
      }
      console.log(JSON.stringify({ periodId: row.period_id, digestValid: computePayloadHash(canonicalStringify(archive)) === row.sha256,
        ticketCount: archive.submittedTickets.length, ticketFields: Object.keys(archive.submittedTickets[0]),
        modelAliasCount: aliases.length, partyAliasCount: partyAliases.length, mismatches }));
    }
    await client.query('ROLLBACK');
  } finally { client.release(); await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
