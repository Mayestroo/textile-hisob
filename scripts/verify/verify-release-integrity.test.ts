import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const { parseSqlitePath, readPostgresEvidence, readSqliteEvidence } = require('./verify-release-integrity.cjs');

describe('read-only release-integrity command', () => {
  let tempDirectory: string | undefined;

  afterEach(() => {
    if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  });

  it('requires an explicit SQLite path and reports SQLite evidence separately', () => {
    expect(() => readSqliteEvidence(undefined)).toThrowError(
      expect.objectContaining({ code: 'SQLITE_PATH_REQUIRED' })
    );

    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-release-integrity-'));
    const sqlitePath = path.join(tempDirectory, 'release-test.sqlite');
    const database = new Database(sqlitePath);
    database.exec('CREATE TABLE schema_meta (version INTEGER NOT NULL); INSERT INTO schema_meta (version) VALUES (11); PRAGMA user_version = 11;');
    database.close();

    expect(parseSqlitePath(['--sqlite-path', sqlitePath])).toBe(sqlitePath);
    expect(parseSqlitePath([], { NOVDA_SQLITE_PATH: sqlitePath })).toBe(sqlitePath);
    expect(readSqliteEvidence(sqlitePath)).toEqual({
      evidenceType: 'sqlite_pragmas',
      integrityCheck: 'ok',
      foreignKeyViolationCount: 0,
      userVersion: 11,
      schemaMetaVersion: 11
    });
  });

  it('never falls back to DATABASE_URL or connects without explicit disposable PostgreSQL opt-in', async () => {
    await expect(readPostgresEvidence({
      NOVDA_PG_URL: undefined,
      NOVDA_DISPOSABLE_PG: undefined,
      DATABASE_URL: 'postgresql://must-not-be-used'
    } as NodeJS.ProcessEnv)).rejects.toThrow('DISPOSABLE_POSTGRES_REQUIRED');
  });
});
