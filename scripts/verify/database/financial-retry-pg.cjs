'use strict';
// Provision only a fresh database in the verified owned container, then run the actual signed-route UI fixture.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const container = 'hisob_test_display_05d2b2';
const identity = 'f8070090fa5aaedf8aa34a983c8606be4b8954d4d0aa7f7993352caf29a0c9d3';
const alphabet = 'abcdefghijklmnopqrstuvwxyz';
const name = `hisob_test_bot8b1_${Array.from(crypto.randomBytes(8), n => alphabet[n % alphabet.length]).join('')}`;
const password = crypto.randomBytes(32).toString('hex');
const safeEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, APPDATA: process.env.APPDATA };
function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', env: safeEnv, timeout: 30000 });
  assert.equal(result.status, 0, `owned-container ${args[0]} failed`);
  return result.stdout.trim();
}
function checkGuard(url) {
  const check = spawnSync(process.execPath,
    [path.join(root, '.opencode/deep-audit/output/local-test-db/assert-local-pg.cjs')],
    { encoding: 'utf8', env: { NOVDA_LOCAL_TEST_PG_URL: url } });
  assert.equal(check.status, 0, 'local PG guard failed before socket/client');
}
function main() {
  assert(!process.env.DATABASE_URL && !process.env.NOVDA_PG_URL && !process.env.NOVDA_LOCAL_TEST_PG_URL,
    'ambient database URLs forbidden');
  assert.equal(docker(['inspect', '--format', '{{.Id}}', container]), identity);
  const status = docker(['inspect', '--format', '{{.State.Status}}', container]);
  assert(['running', 'exited'].includes(status), 'unknown owned container state');
  if (status === 'exited') docker(['start', container]);
  try {
    const binding = docker(['port', container, '5432/tcp']);
    assert.match(binding, /^127\.0\.0\.1:\d+$/);
    const url = `postgresql://${name}:${password}@${binding}/${name}`;
    checkGuard(url); // before the first Unix socket, even though the new role/database do not exist yet.
    const input = `CREATE ROLE ${name} LOGIN PASSWORD '${password}';\nCREATE DATABASE ${name} OWNER ${name};\n`;
    // CREATE DATABASE needs an autocommit session; secrets travel only over stdin.
    docker(['exec', '-i', '-u', 'postgres', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
      '-U', 'hisob_test_display', '-d', 'hisob_test_display', '-q'], input);
    checkGuard(url);
    const run = spawnSync(process.execPath, [path.join(root, 'scripts/verify/database/worker-bot-acceptance.cjs')], {
      cwd: root, env: { ...safeEnv, NOVDA_LOCAL_TEST_PG_URL: url, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' },
      encoding: 'utf8', timeout: 120000
    });
    // Fixture prints only synthetic numeric evidence; never print its environment or DSN.
    if (run.status !== 0) {
      const sanitized = (run.stderr || run.stdout || 'fixture failed').replaceAll(password, '[redacted]');
      throw new Error(sanitized);
    }
    process.stdout.write(run.stdout.replaceAll(password, '[redacted]'));
  } finally {
    if (docker(['inspect', '--format', '{{.Id}}', container]) === identity) docker(['stop', container]);
  }
}
try { main(); } catch (error) { console.error(String(error.message || error).split('\n').slice(0, 12).join('\n')); process.exitCode = 1; }
