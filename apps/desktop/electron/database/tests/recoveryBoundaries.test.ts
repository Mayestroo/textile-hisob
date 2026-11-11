import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const Database = require('better-sqlite3');
const manager = require('../core/databaseManager.cjs');
const { applyMigrations, getPragmaUserVersion } = require('../core/migrationRunner.cjs');
const { MIGRATIONS } = require('../core/schema.cjs');
const { sanitizeCompanyDbPath } = require('../core/companyPath.cjs');
const { backupCompanyDatabase, restoreCompanyDatabase } = require('../maintenance/sqliteBackup.cjs');
const roots: string[] = [];
const root = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-recovery-boundary-')); roots.push(dir); return dir; };
const company = 'recovery-company';
afterEach(() => { manager.closeAllCompanyDatabases(); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function legacy(profile: string, version = 15) {
  const db = new Database(sanitizeCompanyDbPath(profile, company));
  manager.configurePragmas(db); applyMigrations(db, { targetVersion: version });
  db.prepare("INSERT INTO workers(id,company_id,name,created_at,updated_at) VALUES (1,?,'retained','now','now')").run(company);
  return db;
}
describe('upgrade/restore boundaries, no silent tenant or data replacement', () => {
  it('rejects future profiles even on the skipMigration path without changing bytes', () => {
    const profile = root(), file = sanitizeCompanyDbPath(profile, company), db = new Database(file);
    const version = MIGRATIONS.at(-1).version + 1;
    db.exec(`CREATE TABLE schema_meta(version INTEGER PRIMARY KEY); INSERT INTO schema_meta VALUES (${version}); PRAGMA user_version=${version}`); db.close();
    const before = fs.readFileSync(file);
    expect(() => manager.getCompanyDatabase(profile, company, { skipMigration: true })).toThrowError(expect.objectContaining({ code: 'SCHEMA_VERSION_NEWER_THAN_APP' }));
    expect(fs.readFileSync(file)).toEqual(before);
  });
  it('retains an integrity-verified pre-upgrade snapshot before changing an existing profile', () => {
    const profile = root(), db = legacy(profile); db.close();
    const upgraded = manager.getCompanyDatabase(profile, company);
    expect(getPragmaUserVersion(upgraded)).toBe(MIGRATIONS.at(-1).version);
    const parent = path.join(path.dirname(upgraded.name), 'pre-upgrade');
    const folders = fs.readdirSync(parent);
    expect(folders).toHaveLength(1);
    const backup = new Database(path.join(parent, folders[0], 'profile.sqlite'), { readonly: true });
    try {
      expect(getPragmaUserVersion(backup)).toBe(15);
      expect(backup.prepare('SELECT name FROM workers WHERE id=1').get().name).toBe('retained');
      expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally { backup.close(); }
  });
  it('fails startup before migration when the pre-upgrade backup cannot be created', () => {
    const profile = root(), db = legacy(profile), file = db.name; db.close();
    fs.writeFileSync(path.join(path.dirname(file), 'pre-upgrade'), 'not a directory');
    expect(() => manager.getCompanyDatabase(profile, company)).toThrow();
    const original = new Database(file, { readonly: true });
    try { expect(getPragmaUserVersion(original)).toBe(15); expect(original.prepare('SELECT name FROM workers').get().name).toBe('retained'); }
    finally { original.close(); }
  });
  it('does not let a cached inspection-only old profile bypass a later normal upgrade', () => {
    const profile = root(), db = legacy(profile); db.close();
    const inspected = manager.getCompanyDatabase(profile, company, { skipMigration: true });
    expect(getPragmaUserVersion(inspected)).toBe(15);
    expect(getPragmaUserVersion(manager.getCompanyDatabase(profile, company))).toBe(MIGRATIONS.at(-1).version);
    expect(fs.readdirSync(path.join(path.dirname(inspected.name), 'pre-upgrade'))).toHaveLength(1);
  });
  it('rejects cross-company restore, not merely cross-company queries after restore', async () => {
    const profile = root(), backup = path.join(root(), 'backup.sqlite');
    const db = manager.getCompanyDatabase(profile, company);
    db.prepare("INSERT INTO workers(id,company_id,name,created_at,updated_at) VALUES (1,?,'retained','now','now')").run(company);
    await backupCompanyDatabase(profile, company, backup);
    const destination = root();
    expect(() => restoreCompanyDatabase(backup, destination, 'another-company')).toThrowError(expect.objectContaining({ code: 'BACKUP_COMPANY_MISMATCH' }));
    expect(fs.existsSync(sanitizeCompanyDbPath(destination, 'another-company'))).toBe(false);
  });
  it('refuses to overwrite an existing target and preserves its live handle and WAL', async () => {
    const profile = root(), backup = path.join(root(), 'backup.sqlite');
    await backupCompanyDatabase(profile, company, backup);
    const destination = root(), existing = manager.getCompanyDatabase(destination, company);
    existing.prepare("INSERT INTO workers(id,company_id,name,created_at,updated_at) VALUES (1,?,'newer than backup','now','now')").run(company);
    expect(() => restoreCompanyDatabase(backup, destination, company)).toThrowError(expect.objectContaining({ code: 'RESTORE_TARGET_EXISTS' }));
    expect(existing.open).toBe(true);
    expect(existing.prepare('SELECT name FROM workers').get().name).toBe('newer than backup');
  });
  it('does not accept a backup destination equal to the active SQLite file', async () => {
    const profile = root(), db = manager.getCompanyDatabase(profile, company);
    await expect(backupCompanyDatabase(profile, company, db.name)).rejects.toMatchObject({ code: 'BACKUP_DESTINATION_IS_SOURCE' });
    expect(db.open).toBe(true);
  });
  it('leaves no published partial target when restore publication fails', async () => {
    const profile = root(), backup = path.join(root(), 'backup.sqlite'), destination = root();
    await backupCompanyDatabase(profile, company, backup);
    const nativeFs = require('fs'), link = nativeFs.linkSync;
    nativeFs.linkSync = () => { throw new Error('injected restore publication failure'); };
    try { expect(() => restoreCompanyDatabase(backup, destination, company)).toThrow('injected restore publication failure'); }
    finally { nativeFs.linkSync = link; }
    const file = sanitizeCompanyDbPath(destination, company);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });
});
