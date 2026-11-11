import { describe, expect, it } from 'vitest';
const Database = require('better-sqlite3');
const { applyMigrations } = require('../core/migrationRunner.cjs');
const { MIGRATIONS } = require('../core/schema.cjs');
describe('desktop downgrade compatibility boundary', () => {
  it('refuses a coherent but newer profile without altering it', () => {
    const db = new Database(':memory:');
    try {
      const newer = MIGRATIONS.at(-1).version + 1;
      db.exec(`CREATE TABLE schema_meta(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT,checksum TEXT);
        INSERT INTO schema_meta VALUES (${newer},'future','now','retained'); PRAGMA user_version=${newer};`);
      const before = db.prepare('SELECT * FROM schema_meta').all();
      expect(() => applyMigrations(db)).toThrowError(expect.objectContaining({ code: 'SCHEMA_VERSION_NEWER_THAN_APP' }));
      expect(db.prepare('SELECT * FROM schema_meta').all()).toEqual(before);
      expect(db.pragma('user_version', { simple: true })).toBe(newer);
    } finally { db.close(); }
  });
});
