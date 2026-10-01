import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
const { getCompanyDatabase, closeCompanyDatabase } = require('./databaseManager.cjs');
const { backupCompanyDatabase, restoreCompanyDatabase, computeFileSha256 } = require('./sqliteBackup.cjs');
const { sanitizeCompanyDbPath } = require('./companyPath.cjs');
const { MIGRATIONS } = require('./schema.cjs');
const Database = require('better-sqlite3');
const nativeFs = require('fs');

describe('SQLite Backup & Restore Procedure (Step 4 / Gate 6)', () => {
  let sourceUserData: string;
  let restoreUserData: string;
  let backupDir: string;
  const COMPANY_ID = 'company-backup-drill';

  beforeEach(() => {
    sourceUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'hisob-src-data-'));
    restoreUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'hisob-restore-data-'));
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hisob-backups-'));
  });

  afterEach(() => {
    closeCompanyDatabase(COMPANY_ID);
    closeCompanyDatabase('company-restored');
    try { fs.rmSync(sourceUserData, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(restoreUserData, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
  });

  it('safely backups active WAL SQLite DB and restores into isolated userData directory', async () => {
    // 1. Initialize source database to the current schema version
    const db = getCompanyDatabase(sourceUserData, COMPANY_ID);

    // Insert models, workers, and a ticket
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('m-1', COMPANY_ID, 'Kofta Sport', JSON.stringify([{ name: 'Bichish', rate: 1200 }]), nowIso, nowIso);

    db.prepare(`
      INSERT INTO workers (id, company_id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(101, COMPANY_ID, 'Alisher Usmanov', 'ACTIVE', nowIso, nowIso);
    db.prepare(`
      INSERT INTO parties (
        id, company_id, party_number, physical_party_number, model_id, model_name,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
    `).run('party-10', COMPANY_ID, '10', '10', 'm-1', 'Kofta Sport', nowIso, nowIso);

    db.prepare(`
      INSERT INTO tickets (id, company_id, model_id, party_number, party_record_id, patta_number, qty, status, submitted_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('30000000-0000-4000-8000-000000000001', COMPANY_ID, 'm-1', '10', 'party-10', 1, 50, 'CONFIRMED', '2026-09-20T10:00:00Z', nowIso);

    db.prepare(`
      INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id, qty, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('te-1', '30000000-0000-4000-8000-000000000001', COMPANY_ID, 'Bichish', 101, 50, nowIso);

    // 2. Perform online backup using SQLite backup API
    const backupFile = path.join(backupDir, 'company-backup-drill.sqlite.bak');
    const backupResult = await backupCompanyDatabase(sourceUserData, COMPANY_ID, backupFile);

    expect(backupResult.success).toBe(true);
    expect(backupResult.integrity).toBe('ok');
    expect(backupResult.integrityCheck).toBe('ok');
    expect(backupResult.foreignKeyCheck).toEqual([]);
    expect(backupResult.schemaVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
    expect(fs.existsSync(backupFile)).toBe(true);
    expect(backupResult.byteSize).toBeGreaterThan(0);
    expect(backupResult.sha256).toMatch(/^[a-f0-9]{64}$/);

    // 3. Restore backup into completely separate target userData directory
    const RESTORED_COMPANY = 'company-restored';
    const restoreResult = restoreCompanyDatabase(backupFile, restoreUserData, RESTORED_COMPANY);

    expect(restoreResult.success).toBe(true);
    expect(restoreResult.integrity).toBe('ok');
    expect(restoreResult.integrityCheck).toBe('ok');
    expect(restoreResult.foreignKeyCheck).toEqual([]);
    expect(restoreResult.schemaVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
    expect(restoreResult.sha256).toBe(backupResult.sha256);

    // 4. Verify restored database contents
    const restoredDb = getCompanyDatabase(restoreUserData, RESTORED_COMPANY, { skipMigration: true });

    const modelRow = restoredDb.prepare('SELECT * FROM models WHERE id = ?').get('m-1');
    expect(modelRow).toBeDefined();
    expect(modelRow.name).toBe('Kofta Sport');

    const workerRow = restoredDb.prepare('SELECT * FROM workers WHERE id = ?').get(101);
    expect(workerRow).toBeDefined();
    expect(workerRow.name).toBe('Alisher Usmanov');

    const ticketRow = restoredDb.prepare('SELECT * FROM tickets WHERE id = ?').get('30000000-0000-4000-8000-000000000001');
    expect(ticketRow).toBeDefined();
    expect(ticketRow.party_number).toBe('10');
    expect(ticketRow.qty).toBe(50);

    const entryRow = restoredDb.prepare('SELECT * FROM ticket_entries WHERE id = ?').get('te-1');
    expect(entryRow).toBeDefined();
    expect(entryRow.qty).toBe(50);

    closeCompanyDatabase(RESTORED_COMPANY);
  });

  it('rejects an orphaned backup before copying it into the target path', async () => {
    const orphanCompany = 'company-orphan-backup';
    const restoredCompany = 'company-orphan-restored';
    const orphanDbPath = sanitizeCompanyDbPath(sourceUserData, orphanCompany);
    const orphanBackupFile = path.join(backupDir, 'orphaned.sqlite.bak');
    const rejectedBackupFile = path.join(backupDir, 'should-not-be-created.sqlite.bak');

    getCompanyDatabase(sourceUserData, orphanCompany);
    closeCompanyDatabase(orphanCompany);

    const orphanedDb = new Database(orphanDbPath);
    try {
      orphanedDb.pragma('foreign_keys = OFF');
      orphanedDb.prepare(`
        INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id, qty, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'orphan-entry-backup-check',
        'missing-ticket-backup-check',
        orphanCompany,
        'Bichish',
        999999,
        1,
        new Date().toISOString()
      );
      orphanedDb.pragma('foreign_keys = ON');
      await orphanedDb.backup(orphanBackupFile);
    } finally {
      orphanedDb.close();
    }

    await expect(
      backupCompanyDatabase(sourceUserData, orphanCompany, rejectedBackupFile)
    ).rejects.toMatchObject({ code: 'DATABASE_FOREIGN_KEY_VIOLATION' });
    expect(fs.existsSync(rejectedBackupFile)).toBe(false);

    const restoredDbPath = sanitizeCompanyDbPath(restoreUserData, restoredCompany);
    expect(() => restoreCompanyDatabase(orphanBackupFile, restoreUserData, restoredCompany)).toThrowError(
      expect.objectContaining({ code: 'DATABASE_FOREIGN_KEY_VIOLATION' })
    );
    expect(fs.existsSync(restoredDbPath)).toBe(false);
  });

  it('preserves an existing valid destination when an orphaned backup is rejected', async () => {
    const backupFile = path.join(backupDir, 'existing-valid.sqlite.bak');
    const sourceDbPath = sanitizeCompanyDbPath(sourceUserData, COMPANY_ID);

    getCompanyDatabase(sourceUserData, COMPANY_ID);
    closeCompanyDatabase(COMPANY_ID);

    const initialBackup = await backupCompanyDatabase(sourceUserData, COMPANY_ID, backupFile);
    const initialSha256 = initialBackup.sha256;

    const orphanedDb = new Database(sourceDbPath);
    try {
      orphanedDb.pragma('foreign_keys = OFF');
      orphanedDb.prepare(`
        INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id, qty, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'orphan-entry-replacement-check',
        'missing-ticket-replacement-check',
        COMPANY_ID,
        'Bichish',
        999999,
        1,
        new Date().toISOString()
      );
      orphanedDb.pragma('foreign_keys = ON');
    } finally {
      orphanedDb.close();
    }

    await expect(
      backupCompanyDatabase(sourceUserData, COMPANY_ID, backupFile)
    ).rejects.toMatchObject({ code: 'DATABASE_FOREIGN_KEY_VIOLATION' });

    expect(fs.existsSync(backupFile)).toBe(true);
    expect(computeFileSha256(backupFile)).toBe(initialSha256);

    const preservedDb = new Database(backupFile, { readonly: true });
    try {
      expect(preservedDb.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(preservedDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      preservedDb.close();
    }

    expect(fs.readdirSync(backupDir).filter((entry) =>
      entry.includes('.tmp-') || entry.includes('.previous-')
    )).toEqual([]);
  });

  it('preserves a recoverable previous backup when replacement and restoration fail', async () => {
    const backupFile = path.join(backupDir, 'fault-injected.sqlite.bak');

    getCompanyDatabase(sourceUserData, COMPANY_ID);
    closeCompanyDatabase(COMPANY_ID);

    const initialBackup = await backupCompanyDatabase(sourceUserData, COMPANY_ID, backupFile);
    const initialSha256 = initialBackup.sha256;
    const realRenameSync = nativeFs.renameSync;
    let directReplacementFailed = false;
    const finalReplacementError = new Error('injected final replacement failure');
    const restorationError = new Error('injected restoration failure');
    nativeFs.renameSync = (source: fs.PathLike, destination: fs.PathLike) => {
      const sourcePath = String(source);
      const destinationPath = String(destination);

      if (destinationPath === backupFile && sourcePath.includes('.tmp-')) {
        if (!directReplacementFailed) {
          directReplacementFailed = true;
          throw new Error('injected direct replacement failure');
        }

        nativeFs.writeFileSync(destinationPath, 'PARTIAL_REPLACEMENT');
        throw finalReplacementError;
      }

      if (
        destinationPath === backupFile &&
        (sourcePath.includes('.previous-') || sourcePath.includes('.restore-'))
      ) {
        throw restorationError;
      }

      return realRenameSync(source, destination);
    };

    let replacementError: (Error & {
      restorePath?: string;
      restoreError?: Error;
    }) | undefined;
    try {
      await backupCompanyDatabase(sourceUserData, COMPANY_ID, backupFile);
    } catch (error) {
      replacementError = error as Error & {
        restorePath?: string;
        restoreError?: Error;
      };
    } finally {
      nativeFs.renameSync = realRenameSync;
    }

    expect(replacementError).toBeDefined();
    expect(replacementError).not.toHaveProperty('success', true);
    expect(replacementError?.restoreError).toBe(restorationError);
    expect(replacementError?.restorePath).toEqual(expect.any(String));

    const preservedPath = replacementError?.restorePath;
    if (!preservedPath) throw new Error('Expected a recoverable previous backup path');

    expect(fs.existsSync(preservedPath)).toBe(true);
    expect(computeFileSha256(preservedPath)).toBe(initialSha256);
    const preservedDb = new Database(preservedPath, { readonly: true });
    try {
      expect(preservedDb.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(preservedDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      preservedDb.close();
    }

    expect(fs.existsSync(backupFile)).toBe(false);
    expect(fs.readdirSync(path.dirname(preservedPath))).toContain(path.basename(preservedPath));
    expect(fs.readdirSync(backupDir).filter((entry) => entry.includes('.tmp-') || entry.includes('.restore-'))).toEqual([]);
  });

  it('rejects a corrupt backup before copying it into the target path', () => {
    const corruptBackupFile = path.join(backupDir, 'corrupt.sqlite.bak');
    const restoredCompany = 'company-corrupt-restored';
    fs.writeFileSync(corruptBackupFile, 'CORRUPT_SQLITE_BACKUP');

    const restoredDbPath = sanitizeCompanyDbPath(restoreUserData, restoredCompany);
    expect(() => restoreCompanyDatabase(corruptBackupFile, restoreUserData, restoredCompany)).toThrow();
    expect(fs.existsSync(restoredDbPath)).toBe(false);
  });
});
