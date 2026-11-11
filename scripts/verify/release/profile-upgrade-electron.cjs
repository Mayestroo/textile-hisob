'use strict';
// Electron native ABI + modules from the built app.asar; no replacement database
// implementation. Synthetic existing v15 profile, not the missing original v15 file.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const archive = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
assert(archive.startsWith('C:\\Users\\bekbo\\AppData\\Local\\Temp\\opencode\\'));
assert(output.startsWith('C:\\Users\\bekbo\\AppData\\Local\\Temp\\opencode\\'));
fs.mkdirSync(output, { recursive: false });
app.setPath('userData', path.join(output, 'electron-profile'));
app.whenReady().then(async () => {
  const load = name => require(path.join(archive, 'apps/desktop/electron/database', name));
  const Database = require(path.join(archive, 'node_modules/better-sqlite3'));
  const manager = load('core/databaseManager.cjs');
  const runner = load('core/migrationRunner.cjs');
  const { MIGRATIONS } = load('core/schema.cjs');
  const { canonicalStringify, computePayloadHash } = load('core/canonicalPayload.cjs');
  const { sanitizeCompanyDbPath } = load('core/companyPath.cjs');
  const { backupCompanyDatabase, restoreCompanyDatabase } = load('maintenance/sqliteBackup.cjs');
  const company = 'phase3-profile';
  const profile = path.join(output, 'existing-profile');
  const file = sanitizeCompanyDbPath(profile, company);
  const now = '2026-09-01T00:00:00.000Z';
  let db = new Database(file);
  manager.configurePragmas(db);
  runner.applyMigrations(db, { targetVersion: 15 });
  db.prepare('INSERT INTO workers(id,company_id,name,staj,created_at,updated_at) VALUES (1,?,?,3,?,?)').run(company, 'Synthetic', now, now);
  db.prepare('INSERT INTO models(id,company_id,name,operations_json,created_at,updated_at) VALUES (?,?,?, ?,?,?)')
    .run('m', company, 'Synthetic model', '[{"name":"Sew","rate":7}]', now, now);
  db.prepare('INSERT INTO periods(id,company_id,name,start_date,end_date,is_closed,created_at) VALUES (?,?,?,?,?,1,?)')
    .run('Q', company, 'Closed Q', '2026-08-01', '2026-08-31', now);
  db.prepare('INSERT INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,provenance,created_at) VALUES (?,?,1,?,?,5,?,?)')
    .run('advance', company, 'Q', 'AVANS', 'SYNTHETIC_UPGRADE', now);
  db.prepare('INSERT INTO production_adjustments(adjustment_id,company_id,model_id,worker_id,op_name,delta_qty,reason,created_at,created_by) VALUES (?,?,?,1,?,2,?,?,?)')
    .run('correction', company, 'm', 'Sew', 'retained legacy correction', now, 'fixture');
  const frozen = canonicalStringify({ companyId: company, period: { id: 'Q' }, models: [{ id: 'm', operations: [{ name: 'Sew', rate: 7 }] }], submittedTickets: [] });
  db.prepare('INSERT INTO period_archives(company_id,period_id,archive_json,sha256,archived_at) VALUES (?,?,?,?,?)')
    .run(company, 'Q', frozen, computePayloadHash(frozen), now);
  const payload = canonicalStringify({ companyId: company, operationId: 'pending', workerId: 1, name: 'Synthetic', staj: 3 });
  db.prepare(`INSERT INTO local_outbox(operation_id,company_id,command_type,entity_type,entity_id,payload_json,payload_hash,created_at,updated_at)
    VALUES ('pending',?,'UpsertWorker','worker','1',?,?,?,?)`).run(company, payload, computePayloadHash(payload), now, now);
  const facts = db => ({ ledger: db.prepare('SELECT id,company_id,worker_id,period_id,type,amount,status FROM worker_adjustments').all(),
    archive: db.prepare('SELECT archive_json,sha256 FROM period_archives').all(),
    pending: db.prepare('SELECT operation_id,payload_json,payload_hash,status FROM local_outbox').all() });
  const original = facts(db);
  const preUpgradeBackup = path.join(output, 'pre-upgrade-v15.sqlite');
  await db.backup(preUpgradeBackup); db.close();
  db = manager.getCompanyDatabase(profile, company);
  assert.equal(runner.verifySchemaVersionConsistency(db), MIGRATIONS.at(-1).version);
  assert.deepEqual(facts(db), original);
  assert.equal(db.prepare("SELECT attribution_status FROM production_adjustments WHERE adjustment_id='correction'").get().attribution_status, 'UNRESOLVED');
  manager.closeCompanyDatabase(company);
  db = manager.getCompanyDatabase(profile, company);
  assert.deepEqual(facts(db), original);
  const backup = await backupCompanyDatabase(profile, company, path.join(output, 'upgraded.sqlite'));
  const recovered = path.join(output, 'recovered-profile');
  restoreCompanyDatabase(backup.backupPath, recovered, company);
  const restored = manager.getCompanyDatabase(recovered, company);
  assert.notEqual(restored.name, db.name); assert.deepEqual(facts(restored), original);
  const integrity = manager.runDatabaseIntegrityChecks(restored);
  manager.closeAllCompanyDatabases();
  // Rollback is restoration of the untouched v15 backup into a separate profile,
  // not a schema downgrade of the upgraded file and not an installer rollback.
  const rollback = new Database(preUpgradeBackup, { readonly: true });
  assert.equal(runner.verifySchemaVersionConsistency(rollback), 15); assert.deepEqual(facts(rollback), original); rollback.close();
  const evidence = { status: 'PASS', electronVersion: process.versions.electron, legacyVersion: 15,
    upgradedVersion: MIGRATIONS.at(-1).version, exactLedgerArchiveAndPendingPayloadPreserved: true,
    reopenPreserved: true, onlineBackupRecovery: true, originalV15BackupIntact: true, integrity,
    scope: 'Packaged SQLite modules/native ABI, synthetic v15 file; NOT old executable compatibility or Windows installer upgrade/rollback' };
  fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('PROFILE_UPGRADE_PASS ' + JSON.stringify(evidence)); app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });
