'use strict';

// Opt-in acceptance against a RESTORED, disposable local production backup.
// Never uses DATABASE_URL, never resets business tables, never contacts Telegram.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { buildFastifyServer } = require('../../../apps/server/app.cjs');
const { hashToken } = require('../../../apps/server/auth/auth.cjs');
const { provisionOperator } = require('../../../apps/server/auth/operatorAuth.cjs');
const { SyncClient } = require('../../../apps/desktop/electron/sync/syncClient.cjs');
const manager = require('../../../apps/desktop/electron/database/core/databaseManager.cjs');
const { ensureCompanyBootstrapped } = require('../../../apps/desktop/electron/sync/bootstrapInitializer.cjs');
const { loadWorkbookProjectionFromSqlite } = require('../../../apps/desktop/electron/database/readers/projectionReader.cjs');
const { loadPayrollValuationFromSqlite } = require('../../../apps/desktop/electron/database/readers/payrollReader.cjs');
const { loadPayroll } = require('../../../apps/server/modules/workers/payrollValuation.cjs');
const { verifyPostgresReleaseState } = require('../../../apps/server/infrastructure/postgresIntegrity.cjs');
const { executeWorkbookCommand } = require('../../../apps/desktop/electron/database/commands/workbookCommandPipeline.cjs');
const { executeReconnectProtocol } = require('../../../apps/desktop/electron/sync/reconnectManager.cjs');
const { verifyBackupPayroll } = require('./payroll-oracle.cjs');

async function main() {
  assert(process.argv.slice(2).every(arg => ['--desktop', '--lifecycle'].includes(arg)), 'Unsupported acceptance option');
  assert(!process.argv.includes('--lifecycle') || process.argv.includes('--desktop'), '--lifecycle requires --desktop');
  assert.equal(process.env.NOVDA_AUDIT_DISPOSABLE, '1', 'Explicit disposable backup opt-in required');
  const url = new URL(process.env.NOVDA_AUDIT_PG_URL || '');
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only loopback PostgreSQL is allowed');
  assert(/^\/novda_audit_[a-z0-9_]+$/.test(url.pathname), 'Only a separate novda_audit_* copy is allowed');
  assert(!process.env.DATABASE_URL && !process.env.NOVDA_PG_URL, 'Ambient database credentials forbidden');
  const pool = new Pool({ connectionString: url.toString(), max: 5 });
  const tempRoot = process.platform === 'win32' ? path.join(os.tmpdir(), 'opencode') : os.tmpdir();
  const profile = fs.mkdtempSync(path.join(tempRoot, 'novda-backup-workflows-'));
  let app;
  let runtimePool;
  const evidence = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, checks: [] };
  try {
    await verifyPostgresReleaseState(pool);
    const companies = await pool.query('SELECT company_id FROM activation_companies ORDER BY company_id');
    assert.equal(companies.rows.length, 1, 'Choose an explicitly scoped company for multi-company backups');
    const companyId = companies.rows[0].company_id;
    const runId = crypto.randomUUID();
    const deviceId = `audit-${runId}`;
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(`INSERT INTO server_devices (device_id, company_id, token_hash, client_version)
      VALUES ($1, $2, $3, '2.0.0')`, [deviceId, companyId, hashToken(token)]);
    const operatorId = `audit-${runId}`;
    const password = crypto.randomBytes(32).toString('hex');
    await provisionOperator(pool, { operatorId, companyId, displayName: 'Local audit', role: 'admin', password });
    const runtimeRole = `novda_audit_${crypto.randomBytes(8).toString('hex')}`;
    const runtimePassword = crypto.randomBytes(32).toString('hex');
    await pool.query(`CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${runtimePassword}'`);
    const policy = fs.readFileSync(path.resolve(__dirname, '../../../apps/server/database/production_roles.sql'), 'utf8');
    await pool.query(policy.replace(/\bnovda_app\b/g, runtimeRole));
    const runtimeUrl = new URL(url);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    runtimePool = new Pool({ connectionString: runtimeUrl.toString(), max: 5 });
    await verifyPostgresReleaseState(runtimePool);
    evidence.checks.push('release integrity under the same least-privilege grants as production');
    app = buildFastifyServer({ pool: runtimePool, businessMutationsEnabled: true });
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new SyncClient({ baseUrl, token, deviceId, clientVersion: '2.0.0', allowHttp: true });
    const login = await client.loginOperator(operatorId, password);
    client.operatorToken = login.token;
    evidence.checks.push('real device authentication and operator login');

    const response = await client.getBootstrap();
    const dates = (await pool.query(`SELECT id, start_date::text AS start_date, end_date::text AS end_date
      FROM periods WHERE company_id = $1`, [companyId])).rows;
    const snapshot = response.snapshot;
    evidence.counts = response.counts || snapshot?.counts;
    for (const expected of dates) {
      const actual = snapshot.periods.find(period => period.id === expected.id);
      assert.equal(actual.startDate, expected.start_date, 'Bootstrap changed a PostgreSQL calendar date');
      assert.equal(actual.endDate, expected.end_date, 'Bootstrap changed a PostgreSQL end date');
    }
    evidence.checks.push('calendar dates preserved across PostgreSQL and HTTP bootstrap');

    const db = manager.getCompanyDatabase(profile, companyId);
    const bootstrap = await ensureCompanyBootstrapped(db, companyId, client);
    const projection = loadWorkbookProjectionFromSqlite(db, companyId);
    evidence.counts = bootstrap.counts;
    manager.runDatabaseIntegrityChecks(db);
    evidence.checks.push('complete real backup bootstraps into fresh SQLite and workbook projection');
    for (const period of projection.periods) {
      const server = await loadPayroll(pool, companyId, period.id);
      const local = loadPayrollValuationFromSqlite(db, companyId, period.id);
      evidence.independentPayrollComparisons = (evidence.independentPayrollComparisons || 0)
        + await verifyBackupPayroll(pool, companyId, period, server)
        + await verifyBackupPayroll(pool, companyId, period, local);
      const localById = new Map(local.workers.map(worker => [worker.workerId, worker]));
      for (const worker of server.workers) {
        const actual = localById.get(worker.workerId);
        assert(actual, 'Payroll worker missing from desktop');
        for (const field of ['pieceworkGross', 'oklad', 'gross', 'magazin', 'avans', 'jarima', 'net', 'unknownEntryCount']) {
          assert.equal(actual[field], worker[field], `Desktop/server payroll mismatch: ${field}`);
        }
      }
    }
    evidence.checks.push('all backup periods: desktop and server payroll amounts agree');
    evidence.checks.push('independent raw-SQL quantity/tariff/balance oracle agrees for every active worker in every backup period');

    const worker = projection.workers[0];
    const command = {
      commandType: 'UpsertWorker', commandId: crypto.randomUUID(), operationId: crypto.randomUUID(), companyId,
      entityId: String(worker.id), payload: { workerId: worker.id, name: worker.name, staj: worker.staj,
        role: worker.role || null, balanceAdjustments: [{ adjustmentId: crypto.randomUUID(), type: 'AVANS',
          amountDelta: 100, periodId: projection.currentPeriod.id }] }
    };
    executeWorkbookCommand(profile, companyId, command);
    const reconnect = await executeReconnectProtocol(db, companyId, client, { baseUserDataPath: profile });
    const op = db.prepare('SELECT status, last_error FROM local_outbox WHERE operation_id = ?').get(command.operationId);
    assert.equal(op.status, 'SYNCED', 'Real worker balance update did not sync: ' + op.last_error);
    const changed = loadWorkbookProjectionFromSqlite(db, companyId).workers.find(row => row.id === worker.id);
    assert.equal(changed.avans, worker.avans + 100, 'Accepted worker balance must not be applied twice');
    await executeReconnectProtocol(db, companyId, client, { baseUserDataPath: profile });
    assert.equal(loadWorkbookProjectionFromSqlite(db, companyId).workers.find(row => row.id === worker.id).avans,
      worker.avans + 100, 'Repeated reconnect duplicated an adjustment');
    evidence.checks.push('offline AVANS edit -> outbox -> real operator-authorized HTTP write -> feed -> exact-once balance');
    evidence.reconnect = { pushed: reconnect.pushed };
    const requestId = crypto.randomUUID();
    const create = { commandType: 'CreateWorker', commandId: crypto.randomUUID(), operationId: crypto.randomUUID(),
      companyId, entityId: `pending-worker:${requestId}`, payload: { requestId,
        name: `Local audit ${requestId}`, staj: 0, role: null, balanceAdjustments: [] } };
    const maxWorker = Number((await pool.query('SELECT MAX(id) AS id FROM workers WHERE company_id = $1', [companyId])).rows[0].id);
    executeWorkbookCommand(profile, companyId, create);
    assert(!db.prepare('SELECT 1 FROM workers WHERE company_id = ? AND name = ?').get(companyId, create.payload.name),
      'Desktop must not invent a canonical worker ID while offline');
    await executeReconnectProtocol(db, companyId, client, { baseUserDataPath: profile });
    const created = db.prepare('SELECT id FROM workers WHERE company_id = ? AND name = ?').get(companyId, create.payload.name);
    assert.equal(created?.id, maxWorker + 1, 'Canonical worker allocation must include the entire production roster');
    await executeReconnectProtocol(db, companyId, client, { baseUserDataPath: profile });
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM workers WHERE company_id = $1 AND name = $2',
      [companyId, create.payload.name])).rows[0].count), 1);
    evidence.checks.push('real backup roster: offline worker creation receives exactly one server-assigned canonical ID');
    if (process.argv.includes('--desktop')) {
      const gateway = await require('./local-fault-gateway.cjs').createLocalFaultGateway(baseUrl);
      const { createServer } = require('vite');
      const vite = await createServer({ configFile: path.resolve(__dirname, '../../../vite.config.mts'),
        server: { host: '127.0.0.1', port: 0, open: false } });
      await vite.listen();
      try {
        const desktopProfile = fs.mkdtempSync(path.join(tempRoot, 'novda-backup-workflows-'));
        const desktopConfig = { companyId, deviceId, token,
          operatorToken: login.token, baseUrl: gateway.baseUrl, fixtureControlBase: gateway.baseUrl, profile: desktopProfile,
          lifecycle: process.argv.includes('--lifecycle'),
          rendererUrl: `http://127.0.0.1:${vite.httpServer.address().port}/scripts/verify/fixtures/backup-workflows.html` };
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const runDesktop = config => new Promise((resolve, reject) => {
          const child = require('node:child_process').spawn(require('electron'),
            [path.join(__dirname, '../render/backup-workflows-electron.cjs')], {
              env: { ...env, NOVDA_AUDIT_DESKTOP: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe'] });
          let output = '';
          child.stdout.on('data', chunk => { output += chunk; });
          child.stderr.on('data', chunk => { output += chunk; });
          child.on('error', reject);
          child.on('exit', code => {
            if (code !== 0 || !output.includes('BACKUP_DESKTOP_RESULT')) return reject(new Error('Desktop acceptance failed: ' + output));
            try {
              const line = output.split(/\r?\n/).find(line => line.startsWith('BACKUP_DESKTOP_RESULT '));
              const result = JSON.parse(line.slice('BACKUP_DESKTOP_RESULT '.length));
              console.log(output); resolve(result);
            } catch (error) { reject(error); }
          });
        });
        const probe = await runDesktop({ ...desktopConfig, restartProbe: 'write-offline' });
        assert(probe.restartExpected, 'Restart probe exited without durable write evidence');
        await fetch(gateway.baseUrl + '/__fixture/offline/off', { method: 'POST' });
        await runDesktop({ ...desktopConfig, restartExpected: probe.restartExpected });
      } finally { await vite.close(); await gateway.close(); }
    }
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    if (app) await app.close();
    if (runtimePool) await runtimePool.end();
    manager.closeAllCompanyDatabases();
    await pool.end();
    // The profile is deliberately retained for investigation; no source backup or DB is removed.
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.code || error.message);
  console.error(error.stack);
  process.exitCode = 1;
});

module.exports = { main };
