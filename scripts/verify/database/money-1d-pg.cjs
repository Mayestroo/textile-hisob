'use strict';
// Stage 1d: fresh synthetic DB in the documented owned container; synthetic secret stays in process.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const container = 'hisob_test_display_05d2b2';
const identity = 'f8070090fa5aaedf8aa34a983c8606be4b8954d4d0aa7f7993352caf29a0c9d3';
const name = `hisob_test_money_1d_${crypto.randomBytes(6).toString('hex')}`;
const password = crypto.randomBytes(32).toString('hex');
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, APPDATA: process.env.APPDATA,
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' };
// These may be deliberately poisoned in the interactive shell; never inherit/use them.
delete process.env.DATABASE_URL;
delete process.env.NOVDA_PG_URL;
delete process.env.NOVDA_LOCAL_TEST_PG_URL;
function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', env, timeout: 30000 });
  assert.equal(result.status, 0, `verified owned-container command failed: ${args[0]}`);
  return result.stdout.trim();
}
function guard(url) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'assert-local-pg.cjs')],
    { encoding: 'utf8', env: { NOVDA_LOCAL_TEST_PG_URL: url } });
  assert.equal(result.status, 0, 'explicit own-PG guard failed before PG client');
}
function main() {
  assert.equal(docker(['inspect', '--format', '{{.Id}}', container]), identity, 'owned-container identity mismatch');
  assert.equal(docker(['inspect', '--format', '{{.State.Status}}', container]), 'running', 'owned container must already be running');
  const binding = docker(['port', container, '5432/tcp']);
  assert.match(binding, /^127\.0\.0\.1:\d+$/, 'owned DB must be published only on loopback');
  const url = `postgresql://${name}:${password}@${binding}/${name}`;
  try {
    guard(url); // before the first PG socket/client, including provisioning through this container's own Unix socket.
    const provision = `CREATE ROLE ${name} LOGIN PASSWORD '${password}';\nCREATE DATABASE ${name} OWNER ${name};\n`;
    docker(['exec', '-i', '-u', 'postgres', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
      '-U', 'hisob_test_display', '-d', 'hisob_test_display', '-q'], provision);
    guard(url);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'money-1d-bridge-acceptance.cjs')], {
      cwd: root, encoding: 'utf8', timeout: 180000,
      env: { ...env, NOVDA_LOCAL_TEST_PG_URL: url, MONEY_1D_FIXTURE_DB: name }
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.replaceAll(password, '[redacted]');
    if (result.status !== 0) {
      const lines=output.split(/\r?\n/);
      throw new Error([...lines.slice(0,5),'... bridge tail ...',...lines.slice(-20)].join('\n') || `bridge acceptance exited ${result.status}`);
    }
    process.stdout.write(output);
  } finally {
    assert.equal(docker(['inspect', '--format', '{{.Id}}', container]), identity);
    assert.equal(docker(['port', container, '5432/tcp']), binding);
    docker(['stop', container]);
  }
}
try { main(); } catch (error) {
  console.error(String(error.message || error).split('\n').slice(0, 35).join('\n'));
  process.exitCode = 1;
}
