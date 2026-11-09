'use strict';
// Fresh PostgreSQL schema proof in the exact documented owned container only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const root = path.resolve(__dirname, '../../..');
const container = 'hisob_test_display_05d2b2';
const identity = 'f8070090fa5aaedf8aa34a983c8606be4b8954d4d0aa7f7993352caf29a0c9d3';
const name = `hisob_test_model_sizes_${crypto.randomBytes(5).toString('hex')}`;
const password = crypto.randomBytes(32).toString('hex');
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, APPDATA: process.env.APPDATA };
delete process.env.DATABASE_URL;
delete process.env.NOVDA_PG_URL;
delete process.env.NOVDA_LOCAL_TEST_PG_URL;
function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', env, timeout: 30000 });
  assert.equal(result.status, 0, `owned-container command failed: ${args[0]}`);
  return result.stdout.trim();
}
function guard(url) {
  const result = spawnSync(process.execPath, [path.join(root, '.opencode/deep-audit/output/local-test-db/assert-local-pg.cjs')],
    { env: { NOVDA_LOCAL_TEST_PG_URL: url }, encoding: 'utf8' });
  assert.equal(result.status, 0, 'local PostgreSQL boundary check failed');
}
async function main() {
  assert.equal(docker(['inspect', '--format', '{{.Id}}', container]), identity, 'owned-container identity mismatch');
  const status = docker(['inspect', '--format', '{{.State.Status}}', container]);
  if (status === 'exited') docker(['start', container]);
  assert.equal(docker(['inspect', '--format', '{{.Id}}', container]), identity);
  const binding = docker(['port', container, '5432/tcp']);
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  const url = `postgresql://${name}:${password}@${binding}/${name}`;
  try {
    guard(url);
    docker(['exec', '-i', '-u', 'postgres', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'hisob_test_display', '-d', 'hisob_test_display', '-q'],
      `CREATE ROLE ${name} LOGIN PASSWORD '${password}';\nCREATE DATABASE ${name} OWNER ${name};\n`);
    guard(url);
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      for (const file of ['schema.sql', 'migrations/deploy_business_mutations_migration.sql', 'migrations/deploy_model_batch_size_names_migration.sql']) {
        await client.query(fs.readFileSync(path.join(root, 'apps/server/database', file), 'utf8'));
      }
      await client.query("INSERT INTO models(company_id,id,name) VALUES ('c','a','A'),('c','b','B')");
      await client.query("INSERT INTO patta_batch_settings(company_id,model_id,size_names_json,sizes_json) VALUES ('c','a','[\"M\",\"XXL\"]'::jsonb,'{\"XXL\":\"2\"}'::jsonb),('c','b','[]'::jsonb,'{}'::jsonb)");
      const rows = (await client.query(`SELECT model_id, size_names_json, sizes_json,
        (SELECT is_nullable FROM information_schema.columns WHERE table_name='patta_batch_settings' AND column_name='size_names_json') AS nullable
        FROM patta_batch_settings ORDER BY model_id`)).rows;
      assert.deepEqual(rows, [
        { model_id: 'a', size_names_json: ['M', 'XXL'], sizes_json: { XXL: '2' }, nullable: 'YES' },
        { model_id: 'b', size_names_json: [], sizes_json: {}, nullable: 'YES' }
      ]);
      console.log('MODEL_SIZES_STAGE_A_PG_FRESH_SCHEMA_PASS: nullable JSONB, explicit empty, independent model metadata verified');
    } finally { await client.end(); }
  } finally {
    assert.equal(docker(['inspect', '--format', '{{.Id}}', container]), identity);
    docker(['stop', container]);
  }
}
main().catch((error) => { console.error(String(error.message || error).replaceAll(password, '[redacted]')); process.exitCode = 1; });
