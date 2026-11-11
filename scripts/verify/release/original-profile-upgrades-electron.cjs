'use strict';
// Operates only on previously captured, hash-checked historical-copy-* snapshots.
// No original AppData path is opened; no app main, license, credentials or network.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const rawFs = require('original-fs'); // Raw app.asar bytes, not Electron's virtual directory.
const path = require('node:path');
const crypto = require('node:crypto');
const archive = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
const temp = path.resolve(process.env.LOCALAPPDATA, 'Temp/opencode');
assert(archive.startsWith(temp + path.sep)); assert(output.startsWith(temp + path.sep));
fs.mkdirSync(output, { recursive: false }); app.setPath('userData', path.join(output, 'electron'));
app.whenReady().then(async () => {
  const load = name => require(path.join(archive, 'apps/desktop/electron/database', name));
  const Database = require(path.join(archive, 'node_modules/better-sqlite3'));
  const manager = load('core/databaseManager.cjs'), runner = load('core/migrationRunner.cjs');
  const { backupCompanyDatabase, restoreCompanyDatabase } = load('maintenance/sqliteBackup.cjs');
  const { sanitizeCompanyDbPath } = load('core/companyPath.cjs');
  const discovery = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../ops/docs/evidence/phase4-local-historical-evidence.json'), 'utf8'));
  const digest = file => crypto.createHash('sha256').update(rawFs.readFileSync(file)).digest('hex');
  const results = [];
  const quote = name => '"' + name.replaceAll('"', '""') + '"';
  for (const [index, original] of discovery.sqliteFiles.entries()) {
    assert(original.stableCopy && original.sourceUnchangedAfterInspection);
    const basename = path.basename(original.path);
    const source = fs.readdirSync(temp).filter(name => name.startsWith('historical-copy-')).map(name => path.join(temp, name, basename))
      .find(file => fs.existsSync(file) && digest(file) === original.sha256
        // SHM is a disposable reader index and may change on inspection. Only
        // main/WAL hold durable content; rebuild SHM in each new test profile.
        && Object.entries(original.sidecars).filter(([name]) => name.endsWith('-wal'))
          .every(([name, hash]) => fs.existsSync(path.join(path.dirname(file), name)) && digest(path.join(path.dirname(file), name)) === hash));
    assert(source, 'Retained disposable discovery snapshot missing; rerun discovery, never fall back to live AppData');
    const profile = path.join(output, 'profile-' + index), company = 'comp_novda';
    const file = sanitizeCompanyDbPath(profile, company);
    fs.copyFileSync(source, file);
    if (fs.existsSync(source + '-wal')) fs.copyFileSync(source + '-wal', file + '-wal');
    let db = new Database(file);
    const priorVersion = runner.verifySchemaVersionConsistency(db);
    manager.runDatabaseIntegrityChecks(db);
    const business = ['models', 'workers', 'periods', 'parties', 'tickets', 'ticket_entries', 'production_adjustments', 'worker_adjustments', 'period_archives'];
    const tables = business.filter(table => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    const columns = Object.fromEntries(tables.map(table => [table, db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => row.name)]));
    const facts = connection => Object.fromEntries(tables.map(table => [table, connection.prepare(`SELECT ${columns[table].map(quote).join(',')} FROM ${quote(table)} ORDER BY rowid`).all()]));
    const before = facts(db);
    const immutable = connection => connection.prepare(`SELECT operation_id,company_id,command_type,entity_type,entity_id,payload_json,payload_hash FROM local_outbox ORDER BY operation_id`).all();
    const pending = immutable(db), states = db.prepare('SELECT * FROM local_outbox ORDER BY operation_id').all();
    db.close(); db = manager.getCompanyDatabase(profile, company);
    assert.equal(runner.verifySchemaVersionConsistency(db), 25);
    assert.deepEqual(facts(db), before, 'Original business column changed during upgrade');
    assert.deepEqual(immutable(db), pending, 'Original outbox identity/body/hash changed');
    let permittedRetryTransitions = 0;
    const currentStates = db.prepare('SELECT * FROM local_outbox ORDER BY operation_id').all();
    for (const [i, row] of states.entries()) {
      let retry = false;
      if (priorVersion < 19 && ['CONFLICT', 'DEAD_LETTER'].includes(row.status)) {
        const code = value => { try { return JSON.parse(value)?.code; } catch { return null; } };
        const error = code(row.last_error) || code(row.error_message);
        retry = (row.command_type === 'CompletePattaBatch' && error === '42501') || (row.command_type === 'ArchivePartyHistory' && error === 'PARTY_NOT_FOUND');
      }
      assert.equal(currentStates[i].status, retry ? 'PENDING' : row.status);
      if (retry) permittedRetryTransitions++;
      if (priorVersion < 21) assert.equal(currentStates[i].accepted_payload_hash, null, 'Legacy status must not invent a receipt');
    }
    if (priorVersion < 25) {
      const parent = path.join(path.dirname(file), 'pre-upgrade'), folders = fs.readdirSync(parent);
      assert.equal(folders.length, 1);
      const saved = new Database(path.join(parent, folders[0], 'profile.sqlite'), { readonly: true });
      assert.equal(runner.verifySchemaVersionConsistency(saved), priorVersion); assert.deepEqual(facts(saved), before); assert.deepEqual(immutable(saved), pending); saved.close();
    }
    manager.closeCompanyDatabase(company); db = manager.getCompanyDatabase(profile, company);
    assert.deepEqual(facts(db), before); assert.deepEqual(immutable(db), pending);
    const backup = await backupCompanyDatabase(profile, company, path.join(output, `backup-${index}.sqlite`));
    const recovered = path.join(output, 'restored-' + index); restoreCompanyDatabase(backup.backupPath, recovered, company);
    assert(db.open);
    const restored = manager.getCompanyDatabase(recovered, company);
    assert.deepEqual(facts(restored), before); assert.deepEqual(immutable(restored), pending);
    const health = manager.runDatabaseIntegrityChecks(restored); manager.closeAllCompanyDatabases();
    results.push({ sourceSha256: original.sha256, fromVersion: priorVersion, toVersion: 25,
      businessRowsPreserved: Object.fromEntries(tables.map(table => [table, before[table].length])), outboxBodiesPreserved: pending.length,
      permittedMigration19RetryTransitions: permittedRetryTransitions, automaticBackupVerified: priorVersion < 25,
      reopenVerified: true, onlineBackupRestoreVerified: true, health });
  }
  const evidence = { status: 'PASS', electronVersion: process.versions.electron, appAsarSha256: digest(archive), profiles: results,
    originalFilesOpened: 0, credentialsRead: false, networkCalls: 0,
    scope: 'Six discovered original-profile snapshots, copied and upgraded offline with actual packaged modules; NOT an old-binary/activated desktop/Windows installer or server-replay acceptance' };
  fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('ORIGINAL_PROFILE_UPGRADES_PASS ' + JSON.stringify(evidence)); app.exit(0);
}).catch(error => {
  console.error(error.code || 'ORIGINAL_PROFILE_UPGRADE_FAILED', String(error.message).split('\n')[0],
    error.stack?.split('\n').find(line => line.trim().startsWith('at ')));
  if (error.code !== 'ERR_ASSERTION') console.error(error.stack);
  app.exit(1);
});
