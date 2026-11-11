'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { verifyPostgresReleaseState } = require('../../../apps/server/infrastructure/postgresIntegrity.cjs');
async function main() {
  assert(!process.env.DATABASE_URL && !process.env.NOVDA_PG_URL);
  const url = new URL(process.env.NOVDA_AUDIT_PG_URL || '');
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55432');
  assert(/^\/novda_(audit_[a-z0-9_]+|local_current)$/.test(url.pathname));
  assert(process.argv[2] && !fs.existsSync(process.argv[2]));
  const source = url.pathname.slice(1), pool = new Pool({ connectionString: url.href });
  url.pathname = '/novda_local'; // Preserved migration-22 reference, READ ONLY.
  const reference = new Pool({ connectionString: url.href });
  const client = await pool.connect(), ref = await reference.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await ref.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const checks = [];
    for (const [table, key] of [['production_adjustments', 'adjustment_id'], ['worker_adjustments', 'id'], ['period_archives', 'period_id']]) {
      const sql = "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY column_name";
      const a = (await client.query(sql, [table])).rows.map(row => row.column_name), b = (await ref.query(sql, [table])).rows.map(row => row.column_name);
      const columns = a.filter(name => b.includes(name));
      assert(columns.length && columns.every(name => /^[a-z0-9_]+$/.test(name)));
      const query = `SELECT ${columns.join(',')} FROM ${table} ORDER BY company_id,${key}`;
      const original = (await ref.query(query)).rows, current = (await client.query(query)).rows;
      const map = new Map(current.map(row => [JSON.stringify([row.company_id, row[key]]), row]));
      for (const row of original) assert.deepEqual(map.get(JSON.stringify([row.company_id, row[key]])), row, table + ' original row changed');
      checks.push({ table, originalRows: original.length, comparedColumns: columns,
        originalRowsUnchanged: true, referenceSha256: crypto.createHash('sha256').update(JSON.stringify(original)).digest('hex') });
    }
    const health = await verifyPostgresReleaseState(client);
    assert(Object.values(health.orphanCounts).every(count => Number(count) === 0));
    assert.equal(health.foreignKeys.presentAndValidated, 17); assert.equal(health.baseline.scopePreserved, true);
    const evidence = { status: 'PASS', source, reference: 'novda_local migration-22', sourceWrites: 0, checks,
      migrations: health.migrations.rows.length, requiredForeignKeys: health.foreignKeys.presentAndValidated,
      zeroOrphanCounters: Object.keys(health.orphanCounts).length, baselineScopePreserved: health.baseline.scopePreserved };
    fs.writeFileSync(process.argv[2], JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(evidence));
  } finally {
    await client.query('ROLLBACK'); await ref.query('ROLLBACK'); client.release(); ref.release(); await pool.end(); await reference.end();
  }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
