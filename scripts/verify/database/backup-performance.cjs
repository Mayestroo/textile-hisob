'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { Pool } = require('pg');
const { readCompanySnapshot } = require('../../../apps/server/modules/sync/bootstrapSnapshot.cjs');
const { loadPayroll } = require('../../../apps/server/modules/workers/payrollValuation.cjs');
async function main() {
  assert(!process.env.DATABASE_URL && !process.env.NOVDA_PG_URL);
  const url = new URL(process.env.NOVDA_AUDIT_PG_URL || '');
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55432');
  assert(/^\/novda_(local_current|audit_[a-z0-9_]+)$/.test(url.pathname));
  const pool = new Pool({ connectionString: url.toString() });
  const client = await pool.connect();
  const samples = { bootstrap: [], payrollAllWorkers: [] };
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const company = (await client.query('SELECT company_id FROM activation_companies ORDER BY company_id')).rows;
    assert.equal(company.length, 1, 'Performance fixture requires explicit single-company backup');
    const companyId = company[0].company_id;
    const periods = (await client.query('SELECT id FROM periods WHERE company_id=$1 ORDER BY id', [companyId])).rows;
    let counts, snapshotBytes;
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      const result = await readCompanySnapshot(client, companyId);
      samples.bootstrap.push(performance.now() - start);
      const snapshot = result.snapshot;
      snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
      counts = { workers: snapshot.workers.length, tickets: snapshot.tickets.length, periods: snapshot.periods.length };
      for (const period of periods) {
        const begin = performance.now();
        const payroll = await loadPayroll(client, companyId, period.id);
        samples.payrollAllWorkers.push(performance.now() - begin);
        assert.equal(payroll.workers.length, counts.workers);
      }
    }
    const evidence = { source: url.pathname.slice(1), capturedAt: new Date().toISOString(), counts, snapshotBytes,
      measurements: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, { samples: values.length,
        p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: Math.max(...values) }])),
      nodeRssBytes: process.memoryUsage().rss, errors: 0, writes: 0,
      limitations: 'Local warm sequential DB/service calls; no network/TLS/renderer/physical printer/load saturation measurement. Not an approved production SLO or capacity signoff.' };
    fs.writeFileSync(process.argv[2], JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(evidence));
  } finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
