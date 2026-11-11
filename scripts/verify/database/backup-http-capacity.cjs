'use strict';
// Bounded local capacity evidence, not an invented production SLO. Only synthetic
// device metadata is written, and only in an explicitly disposable restored DB.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { Pool } = require('pg');
const { buildFastifyServer } = require('../../../apps/server/app.cjs');
const { hashToken } = require('../../../apps/server/auth/auth.cjs');
const { SyncClient } = require('../../../apps/desktop/electron/sync/syncClient.cjs');

async function main() {
  assert.equal(process.env.NOVDA_AUDIT_DISPOSABLE, '1');
  assert(!process.env.DATABASE_URL && !process.env.NOVDA_PG_URL);
  const url = new URL(process.env.NOVDA_AUDIT_PG_URL || '');
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55432');
  assert(/^\/novda_audit_[a-z0-9_]+$/.test(url.pathname));
  assert(process.argv[2] && !fs.existsSync(process.argv[2]), 'New output path required');
  const pool = new Pool({ connectionString: url.href, max: 5 });
  let app;
  try {
    const companies = (await pool.query('SELECT company_id FROM activation_companies ORDER BY company_id')).rows;
    assert.equal(companies.length, 1);
    const company = companies[0].company_id;
    const before = (await pool.query(`SELECT (SELECT count(*) FROM tickets) AS tickets,
      (SELECT count(*) FROM ticket_entries) AS entries,(SELECT count(*) FROM worker_adjustments) AS balances,
      (SELECT count(*) FROM production_adjustments) AS corrections,(SELECT count(*) FROM operations_dedup) AS receipts`)).rows[0];
    const token = crypto.randomBytes(32).toString('hex'), device = 'capacity-' + crypto.randomUUID();
    await pool.query(`INSERT INTO server_devices(device_id,company_id,token_hash,client_version) VALUES ($1,$2,$3,'2.0.0')`, [device, company, hashToken(token)]);
    app = buildFastifyServer({ pool, businessMutationsEnabled: false });
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new SyncClient({ baseUrl, token, deviceId: device, clientVersion: '2.0.0', allowHttp: true });
    const samples = [], rss = [], totals = [];
    const concurrency = 3, rounds = 3;
    for (let round = 0; round < rounds; round++) {
      const responses = await Promise.all(Array.from({ length: concurrency }, async () => {
        const start = performance.now(), response = await client.getBootstrap();
        assert.equal(response.snapshot.tickets.length, Number(before.tickets));
        assert.equal(response.snapshot.workers.length, 222);
        assert.equal(response.snapshot.productionAdjustments.length, Number(before.corrections));
        samples.push(performance.now() - start);
        return Buffer.byteLength(JSON.stringify(response));
      }));
      totals.push(...responses); rss.push(process.memoryUsage().rss);
    }
    const after = (await pool.query(`SELECT (SELECT count(*) FROM tickets) AS tickets,
      (SELECT count(*) FROM ticket_entries) AS entries,(SELECT count(*) FROM worker_adjustments) AS balances,
      (SELECT count(*) FROM production_adjustments) AS corrections,(SELECT count(*) FROM operations_dedup) AS receipts`)).rows[0];
    assert.deepEqual(after, before, 'Read workload changed business facts or receipts');
    const sorted = [...samples].sort((a, b) => a - b);
    const evidence = { status: 'PASS_LOCAL_WORKLOAD', concurrency, rounds, completed: samples.length, errors: 0,
      p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      maxMs: Math.max(...samples), responseBytes: totals, rssBytesAfterEachRound: rss, businessCountsUnchanged: after,
      scope: 'Real Fastify/device-auth/HTTP/bootstrap/PG plus client JSON parsing on loopback; 9 requests is NOT multi-device endurance, TLS or approved production capacity/SLO signoff' };
    fs.writeFileSync(process.argv[2], JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(evidence));
  } finally { if (app) await app.close(); await pool.end(); }
}
main().catch(error => { console.error(error.code || error.stack); process.exitCode = 1; });
