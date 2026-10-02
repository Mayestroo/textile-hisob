import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

// @ts-ignore
const companyPath = require('./companyPath.cjs');
// @ts-ignore
const databaseManager = require('./databaseManager.cjs');
// @ts-ignore
const { getMigrationChecksum, MIGRATIONS } = require('./schema.cjs');
// @ts-ignore
const migrationRunner = require('./migrationRunner.cjs');
// @ts-ignore
const identifierPolicy = require('./identifierPolicy.cjs');
// @ts-ignore
const migrator = require('./migrator.cjs');
// @ts-ignore
const parityReporter = require('./parityReporter.cjs');
const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');
const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

describe('Phase 2 Step 1: Local SQLite Engine & V1-> Migration Foundation', () => {
  let tempUserDataDir: string;
  const companyId = 'company_alpha';

  beforeEach(() => {
    tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), '-step1-test-'));
  });

  afterEach(() => {
    databaseManager.closeAllCompanyDatabases();
    try {
      if (fs.existsSync(tempUserDataDir)) {
        fs.rmSync(tempUserDataDir, { recursive: true, force: true });
      }
    } catch (e) {}
  });

  function createSampleLegacyJson(company = companyId, overrides: any = {}) {
    const data = {
      companyId: company,
      models: [
        {
          id: 'model_101',
          name: 'Futbolka Erkaklar',
          hisobSheetName: 'Model-101',
          title: 'Erkaklar futbolkasi',
          party: '1',
          color: 'Qora',
          size: 'XL',
          operations: [
            { id: 'op_1', name: 'Bichish', rate: 1200 },
            { id: 'op_2', name: 'Tikish', rate: 3500 }
          ],
          pattaOpsOrder: ['Bichish', 'Tikish'],
          hisobQuantities: {
            '1': { 'Bichish': 100 },
            '2': { 'Tikish': 100 }
          }
        }
      ],
      workers: [
        { id: 1, name: 'Ali Karimov', staj: 5, avans: 50000, jarima: 0, role: 'Bichuvchi' },
        { id: 2, name: 'Vali Toshev', staj: 3, avans: 0, jarima: 20000, role: 'Tikuvchi' }
      ],
      submittedTickets: [
        {
          id: 'sub_171000_abc',
          modelId: 'model_101',
          partyNumber: '1',
          pattaNumber: 1,
          qty: 100,
          submittedAt: '2026-03-01T10:00:00.000Z',
          entries: [
            { opName: 'Bichish', workerId: 1, workerName: 'Ali Karimov', rateSnapshot: 1200 },
            { opName: 'Tikish', workerId: 2, workerName: 'Vali Toshev', rateSnapshot: 3500 }
          ]
        }
      ],
      printedPartyHistory: [
        {
          id: 'rec_101_1',
          partyNumber: '1',
          modelId: 'model_101',
          pattaCount: 1,
          ishSoni: 100,
          printedAt: '2026-03-01T09:00:00.000Z'
        }
      ],
      periods: [
        { id: 'period_2026_03', name: '2026 Mart', startDate: '2026-03-01', isClosed: false }
      ],
      currentPeriod: { id: 'period_2026_03', name: '2026 Mart', startDate: '2026-03-01', isClosed: false },
      ...overrides
    };

    const novdaDir = path.join(tempUserDataDir, 'NovdaData');
    fs.mkdirSync(novdaDir, { recursive: true });
    const targetFile = path.join(novdaDir, `hisob_database_${company}.json`);
    fs.writeFileSync(targetFile, JSON.stringify(data, null, 2), 'utf8');
    return targetFile;
  }

  function createPattaWorkQuantityMigrationDb(fileName: string) {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(tempUserDataDir, fileName));
    migrationRunner.applyMigrations(db, { targetVersion: 12 });
    return db;
  }

  function expectPattaWorkQuantityMigrationBlocked(fileName: string, invalidOverrides: any = {}) {
    const db = createPattaWorkQuantityMigrationDb(fileName);
    const now = '2026-09-20T10:00:00.000Z';
    const invalidParty = {
      pattaCount: 9,
      sourceQuantity: 973,
      totalQuantity: 0,
      ishSoni: 0,
      sizesJson: '',
      ...invalidOverrides
    };

    try {
      db.prepare(`
        INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
        VALUES ('model_patta_preflight', ?, 'Patta Preflight Model', '[]', ?, ?)
      `).run(companyId, now, now);
      const insertParty = db.prepare(`
        INSERT INTO parties (
          id, company_id, party_number, physical_party_number, model_id, patta_count,
          ish_soni_per_patta, total_ish_soni, ish_soni, sizes_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'model_patta_preflight', ?, ?, ?, ?, ?, ?, ?)
      `);
      insertParty.run(
        'party_patta_valid', companyId, 'valid', 'valid', 9, 972, 0, 0, '',
        '2026-09-20T08:00:00.000Z', now
      );
      insertParty.run(
        'party_patta_invalid', companyId, 'invalid', 'invalid', invalidParty.pattaCount,
        invalidParty.sourceQuantity, invalidParty.totalQuantity, invalidParty.ishSoni,
        invalidParty.sizesJson, '2026-09-20T09:00:00.000Z', now
      );

      const partiesBefore = db.prepare('SELECT * FROM parties ORDER BY created_at ASC, id ASC').all();
      const schemaMetaBefore = db.prepare('SELECT * FROM schema_meta ORDER BY version ASC').all();
      expect(migrationRunner.getMetaTableVersion(db)).toBe(12);
      expect(migrationRunner.getPragmaUserVersion(db)).toBe(12);

      let migrationError: any;
      try {
        migrationRunner.applyMigrations(db, { targetVersion: 13 });
      } catch (error) {
        migrationError = error;
      }

      expect(migrationError).toBeDefined();
      expect(migrationError.code).toBe('PATTA_WORK_QUANTITY_MIGRATION_BLOCKED');
      expect(migrationError.records.map((party: any) => party.id)).toEqual(['party_patta_invalid']);
      expect(db.prepare('SELECT * FROM parties ORDER BY created_at ASC, id ASC').all()).toEqual(partiesBefore);
      expect(db.prepare('SELECT * FROM schema_meta ORDER BY version ASC').all()).toEqual(schemaMetaBefore);
      expect(migrationRunner.getMetaTableVersion(db)).toBe(12);
      expect(migrationRunner.getPragmaUserVersion(db)).toBe(12);
    } finally {
      db.close();
    }
  }

  // 1. database path traversal rejected
  it('1. database path traversal rejected', () => {
    expect(() => companyPath.sanitizeCompanyDbPath(tempUserDataDir, '../etc')).toThrow(/Path traversal detected|Invalid company ID/);
    expect(() => companyPath.sanitizeCompanyDbPath(tempUserDataDir, 'comp/sub')).toThrow();
    expect(() => companyPath.sanitizeCompanyDbPath(tempUserDataDir, 'comp\\sub')).toThrow();
    expect(() => companyPath.sanitizeCompanyDbPath(tempUserDataDir, 'comp\0any')).toThrow();
    expect(() => companyPath.sanitizeCompanyDbPath(tempUserDataDir, 'comp:bad')).toThrow();
  });

  // 2. DB opens in WAL mode
  it('2. DB opens in WAL mode', () => {
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      const mode = db.pragma('journal_mode', { simple: true });
      const fk = db.pragma('foreign_keys', { simple: true });
      const timeout = db.pragma('busy_timeout', { simple: true });
      expect(mode).toBe('wal');
      expect(fk).toBe(1);
      expect(timeout).toBe(5000);
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 3. schema initializes
  it('3. schema initializes with all canonical and tracking tables', () => {
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      const version = db.pragma('user_version', { simple: true });
      expect(version).toBe(CURRENT_SCHEMA_VERSION);

      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table'
      `).all().map((r: any) => r.name);

      expect(tables).toContain('schema_meta');
      expect(tables).toContain('local_meta');
      expect(tables).toContain('migration_runs');
      expect(tables).toContain('migration_quarantine_parties');
      expect(tables).toContain('migration_quarantine_tickets');
      expect(tables).toContain('migration_quarantine_ticket_entries');
      expect(tables).toContain('migration_reconciliation_candidates');
      expect(tables).toContain('migration_party_resolutions');
      expect(tables).toContain('legacy_party_collision_exceptions');
      expect(tables).toContain('migration_reconciliation_resolutions');
      expect(tables).toContain('models');
      expect(tables).toContain('workers');
      expect(tables).toContain('parties');
      expect(tables).toContain('tickets');
      expect(tables).toContain('ticket_entries');
      expect(tables).toContain('worker_adjustments');
      expect(tables).toContain('production_adjustments');
      expect(tables).toContain('periods');
      expect(tables).toContain('local_outbox');
      expect(tables).toContain('local_party_leases');
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  it('version 11 adds synchronized workbook metadata tables without changing existing facts', () => {
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
        VALUES ('model_v11', ?, 'V11 Model', '[]', ?, ?)
      `).run(companyId, now, now);
      db.prepare(`
        INSERT INTO workers (id, company_id, name, created_at, updated_at)
        VALUES (711, ?, 'V11 Worker', ?, ?)
      `).run(companyId, now, now);
      db.prepare(`
        INSERT INTO periods (id, company_id, name, start_date, created_at)
        VALUES ('period_v11', ?, 'V11 Period', '2026-09-01', ?)
      `).run(companyId, now);
      db.prepare(`
        INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, created_at, updated_at)
        VALUES ('party_v11', ?, '71', '71', 'model_v11', ?, ?)
      `).run(companyId, now, now);

      const migration = MIGRATIONS.find((entry: any) => entry.version === 11);
      expect(migration).toBeDefined();
      migration.up(db);

      expect(db.prepare('SELECT id, name FROM models WHERE id = ?').get('model_v11')).toEqual({ id: 'model_v11', name: 'V11 Model' });
      expect(db.prepare('SELECT id, name FROM workers WHERE id = ?').get(711)).toEqual({ id: 711, name: 'V11 Worker' });
      expect(db.prepare('SELECT id, name FROM periods WHERE id = ?').get('period_v11')).toEqual({ id: 'period_v11', name: 'V11 Period' });
      expect(db.prepare('SELECT id, model_id FROM parties WHERE id = ?').get('party_v11')).toEqual({ id: 'party_v11', model_id: 'model_v11' });

      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((row: any) => row.name);
      expect(tables).toContain('company_batch_settings');
      expect(tables).toContain('patta_batch_settings');
      expect(tables).toContain('period_archives');
      expect(tables).toContain('local_ticket_forms');
      const modelColumns = db.prepare('PRAGMA table_info(models)').all().map((column: any) => column.name);
      const workerColumns = db.prepare('PRAGMA table_info(workers)').all().map((column: any) => column.name);
      const periodColumns = db.prepare('PRAGMA table_info(periods)').all().map((column: any) => column.name);
      const partyColumns = db.prepare('PRAGMA table_info(parties)').all().map((column: any) => column.name);
      const ticketColumns = db.prepare('PRAGMA table_info(tickets)').all().map((column: any) => column.name);
      expect(modelColumns).toContain('server_revision');
      expect(modelColumns).toContain('status');
      expect(workerColumns).toContain('server_revision');
      expect(periodColumns).toContain('server_revision');
      expect(partyColumns).toContain('server_revision');
      expect(partyColumns).toContain('is_archived');
      expect(ticketColumns).toContain('period_id');
      expect(ticketColumns).toContain('server_revision');
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  it('migration 012 records a pre-existing collision without hardcoded company or row IDs', () => {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(tempUserDataDir, 'party-two-company-scope-v11.sqlite'));
    try {
      for (const migration of MIGRATIONS.slice(0, 9)) {
        migration.up(db);
        db.prepare('INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString(), getMigrationChecksum(migration));
        db.pragma(`user_version = ${migration.version}`);
      }
      db.pragma('foreign_keys = ON');
      for (const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'parties'").all()) {
        db.exec(`DROP TRIGGER IF EXISTS "${trigger.name}"`);
      }
      db.prepare(`
        INSERT INTO parties (
          id, company_id, party_number, physical_party_number, model_id, status, is_closed,
          created_at, updated_at
        ) VALUES (?, 'company-other', '2', '2', 'model-a', 'ACTIVE', 0, datetime('now'), datetime('now')),
                 (?, 'company-other', '2', '2', 'model-b', 'ACTIVE', 0, datetime('now'), datetime('now'))
      `).run('rec_1788774889449_vrbkv', 'rec_1788930871307_cg1iv');

      const result = migrationRunner.applyMigrations(db);
      expect(result.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(db.prepare("SELECT COUNT(*) AS count FROM parties WHERE company_id = 'company-other' AND party_number = '2'").get().count).toBe(2);
      expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_party_collision_exceptions WHERE company_id = 'company-other' AND party_number = '2' AND status = 'ACTIVE'").get().count).toBe(2);
      expect(() => db.prepare(`
        INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status, is_closed, created_at, updated_at)
        VALUES ('third-party', 'company-other', '2', '2', 'model-c', 'ACTIVE', 0, datetime('now'), datetime('now'))
      `).run()).toThrow(/ACTIVE_PARTY_EXISTS/);
    } finally {
      db.close();
    }
  });

  it('migration 012 preserves the exact comp_novda pair and rejects transferring it to another company', () => {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(tempUserDataDir, 'party-two-company-scope-valid-v11.sqlite'));
    try {
      for (const migration of MIGRATIONS.slice(0, 9)) {
        migration.up(db);
        db.prepare('INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString(), getMigrationChecksum(migration));
        db.pragma(`user_version = ${migration.version}`);
      }
      db.pragma('foreign_keys = ON');
      for (const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'parties'").all()) {
        db.exec(`DROP TRIGGER IF EXISTS "${trigger.name}"`);
      }
      const insertParty = db.prepare(`
        INSERT INTO parties (
          id, company_id, party_number, physical_party_number, model_id, status, is_closed,
          created_at, updated_at
        ) VALUES (?, ?, '2', '2', 'model-a', 'ACTIVE', 0, datetime('now'), datetime('now'))
      `);
      insertParty.run('rec_1788774889449_vrbkv', 'comp_novda');
      insertParty.run('rec_1788930871307_cg1iv', 'comp_novda');

      const result = migrationRunner.applyMigrations(db);
      expect(result.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(db.prepare("SELECT COUNT(*) AS count FROM parties WHERE company_id = 'comp_novda' AND party_number = '2' AND status != 'CLOSED'").get().count).toBe(2);
      expect(() => insertParty.run('third-party-2', 'comp_novda')).toThrow(/ACTIVE_PARTY_EXISTS/);
    } finally {
      db.close();
    }
  });

  it.each([
    { name: 'numeric sizes', sizesJson: '{"M":9}' },
    { name: 'numeric-string sizes', sizesJson: '{"M":"9","L":"","XL":"  "}' },
    { name: 'empty size object', sizesJson: '{}' }
  ])('patta work quantity migration corrects legacy party totals with $name and preserves ticket data', ({ name, sizesJson }: any) => {
    const db = createPattaWorkQuantityMigrationDb(`patta-work-quantity-conversion-${name.replace(/\s+/g, '-')}.sqlite`);
    const now = '2026-09-20T10:00:00.000Z';

    try {
      db.prepare(`
        INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
        VALUES ('model_patta_quantity', ?, 'Patta Quantity Model', '[]', ?, ?)
      `).run(companyId, now, now);
      db.prepare(`
        INSERT INTO parties (
          id, company_id, party_number, physical_party_number, model_id, model_name, color,
          patta_count, cumulative_patta_count, ish_soni_per_patta, total_ish_soni,
          ish_soni, cumulative_ish_soni, sizes_json, printed_at, is_closed, closed_at,
          archived_patta_numbers_json, status, created_at, updated_at, provenance,
          server_revision, is_archived
        ) VALUES (
          'party_patta_quantity', ?, '9', '9', 'model_patta_quantity', 'Patta Quantity Model', 'Blue',
          9, 27, 972, 8748, 8748, 12000, ?, '2026-09-20T09:00:00.000Z', 1,
          '2026-09-20T09:30:00.000Z', '[1,2]', 'CLOSED', '2026-09-20T08:00:00.000Z', ?,
          'LEGACY_MIGRATION', 7, 1
        )
      `).run(companyId, sizesJson, now);
      db.prepare(`
        INSERT INTO tickets (
          id, company_id, model_id, party_number, party_record_id, patta_number, qty,
          size, color, konveyer, status, is_closed, submitted_at, created_at,
          provenance, raw_legacy_json, period_id, server_revision
        ) VALUES (
          '11111111-1111-4111-8111-111111111111', ?, 'model_patta_quantity', '9',
          'party_patta_quantity', 1, 42, 'M', 'Blue', 'Line A', 'CONFIRMED', 0,
          '2026-09-20T09:15:00.000Z', ?, 'LEGACY_MIGRATION', '{"ticket":"unchanged"}',
          'period_2026_09', 3
        )
      `).run(companyId, now);
      db.prepare(`
        INSERT INTO parties (
          id, company_id, party_number, physical_party_number, model_id, patta_count,
          ish_soni_per_patta, total_ish_soni, ish_soni, cumulative_ish_soni,
          sizes_json, created_at, updated_at
        ) VALUES (
          'party_patta_zero_sizes', ?, '10', '10', 'model_patta_quantity', 0,
          NULL, NULL, 0, 972, '{"M":"0"}', '2026-09-20T09:00:00.000Z', ?
        )
      `).run(companyId, now);
      db.prepare(`
        INSERT INTO parties (
          id, company_id, party_number, physical_party_number, model_id, patta_count,
          ish_soni_per_patta, total_ish_soni, ish_soni, cumulative_ish_soni,
          sizes_json, created_at, updated_at
        ) VALUES (
          'party_patta_zero_unavailable_sizes', ?, '11', '11', 'model_patta_quantity', 0,
          0, 0, 0, 0, NULL, '2026-09-20T09:30:00.000Z', ?
        )
      `).run(companyId, now);

      const partyBefore = db.prepare('SELECT * FROM parties WHERE id = ?').get('party_patta_quantity');
      const ticketBefore = db.prepare('SELECT * FROM tickets WHERE id = ?').get('11111111-1111-4111-8111-111111111111');
      const zeroCountPartiesBefore = db.prepare(`
        SELECT * FROM parties WHERE id IN (?, ?) ORDER BY id ASC
      `).all('party_patta_zero_sizes', 'party_patta_zero_unavailable_sizes');
      expect(migrationRunner.getMetaTableVersion(db)).toBe(12);
      expect(migrationRunner.getPragmaUserVersion(db)).toBe(12);

      const result = migrationRunner.applyMigrations(db, { targetVersion: 13 });

      const partyAfter = db.prepare('SELECT * FROM parties WHERE id = ?').get('party_patta_quantity');
      const ticketAfter = db.prepare('SELECT * FROM tickets WHERE id = ?').get('11111111-1111-4111-8111-111111111111');
      const zeroCountPartiesAfter = db.prepare(`
        SELECT * FROM parties WHERE id IN (?, ?) ORDER BY id ASC
      `).all('party_patta_zero_sizes', 'party_patta_zero_unavailable_sizes');
      expect(result.currentVersion).toBe(13);
      expect(partyAfter).toEqual({
        ...partyBefore,
        ish_soni_per_patta: 108,
        total_ish_soni: 972,
        ish_soni: 972,
        cumulative_ish_soni: 972
      });
      expect(partyAfter.id).toBe('party_patta_quantity');
      expect(partyAfter.company_id).toBe(companyId);
      expect(partyAfter.sizes_json).toBe(sizesJson);
      expect(ticketAfter).toEqual(ticketBefore);
      expect(zeroCountPartiesAfter).toEqual(zeroCountPartiesBefore);
      expect(partyAfter.cumulative_ish_soni).toBe(972);
    } finally {
      db.close();
    }
  });

  it.each([
    { name: 'non-divisible source', invalidParty: { sourceQuantity: 973 } },
    { name: 'null source quantity', invalidParty: { sourceQuantity: null } },
    { name: 'unsafe source integer', invalidParty: { sourceQuantity: 9007199254740996 } },
    {
      name: 'unsafe patta count',
      invalidParty: { pattaCount: 9007199254740992, sourceQuantity: 9007199254740992 }
    },
    { name: 'size count mismatch', invalidParty: { sourceQuantity: 972, sizesJson: '{"M":8}' } },
    { name: 'malformed size JSON', invalidParty: { sourceQuantity: 972, sizesJson: '{"M":' } },
    { name: 'invalid size count', invalidParty: { sourceQuantity: 972, sizesJson: '{"M":-1}' } },
    { name: 'exponent-form size string', invalidParty: { sourceQuantity: 972, sizesJson: '{"M":"9e0"}' } },
    { name: 'hex size string', invalidParty: { sourceQuantity: 972, sizesJson: '{"M":"0x9"}' } },
    { name: 'fractional size string', invalidParty: { sourceQuantity: 972, sizesJson: '{"M":"9.5"}' } },
    { name: 'negative size string', invalidParty: { sourceQuantity: 972, sizesJson: '{"M":"-1"}' } },
    { name: 'unsafe size string', invalidParty: { sourceQuantity: 972, sizesJson: '{"M":"9007199254740992"}' } },
    {
      name: 'negative patta count',
      invalidParty: { pattaCount: -1, sourceQuantity: null, totalQuantity: 0, ishSoni: 0 }
    },
    {
      name: 'zero count with per-patta work',
      invalidParty: { pattaCount: 0, sourceQuantity: 1, totalQuantity: 0, ishSoni: 0 }
    },
    {
      name: 'zero count with party total',
      invalidParty: { pattaCount: 0, sourceQuantity: null, totalQuantity: 1, ishSoni: 0 }
    },
    {
      name: 'zero count with ish soni',
      invalidParty: { pattaCount: 0, sourceQuantity: null, totalQuantity: 0, ishSoni: 1 }
    },
    {
      name: 'zero count with nonzero size count',
      invalidParty: { pattaCount: 0, sourceQuantity: null, totalQuantity: 0, ishSoni: 0, sizesJson: '{"M":1}' }
    }
  ])('patta work quantity migration rejects $name before changing any parties', ({ name, invalidParty }: any) => {
    expectPattaWorkQuantityMigrationBlocked(`patta-work-quantity-${name.replace(/\s+/g, '-')}.sqlite`, invalidParty);
  });

  it('legacy import uses persisted operator approval instead of hardcoded row identities', () => {
    const exactA = 'rec_1788774889449_vrbkv';
    const exactB = 'rec_1788930871307_cg1iv';
    const jsonPath = createSampleLegacyJson('another-company', {
      printedPartyHistory: [
        { id: exactA, partyNumber: '2', modelId: 'model_101', isClosed: false },
        { id: exactB, partyNumber: '2', modelId: 'model_101', isClosed: false }
      ],
      submittedTickets: []
    });
    const result = migrator.migrateLegacyData(tempUserDataDir, 'another-company', {
      explicitSourcePath: jsonPath,
      partyResolutions: [
        { partyId: exactA, decision: 'GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED' },
        { partyId: exactB, decision: 'GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED' }
      ]
    });

    expect(result.counts.quarantine).toBe(0);
    expect(result.counts.parties).toBe(2);
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, 'another-company');
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM parties WHERE party_number = '2'").get().count).toBe(2);
      expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_party_collision_exceptions WHERE party_number = '2' AND status = 'ACTIVE'").get().count).toBe(2);
    } finally {
      databaseManager.closeCompanyDatabase('another-company');
    }
  });

  it('reports one contiguous migration definition sequence', () => {
    const versions = MIGRATIONS.map((migration: any) => migration.version);
    expect(versions).toEqual(versions.map((_, index) => index + 1));
    expect(new Set(versions).size).toBe(versions.length);
    expect(MIGRATIONS.every((migration: any) =>
      migration.name.startsWith(`${String(migration.version).padStart(3, '0')}_`)
    )).toBe(true);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      const schemaVersionRow = db.prepare('SELECT MAX(version) AS v FROM schema_meta').get();
      const pragmaVersion = db.pragma('user_version', { simple: true });
      expect(schemaVersionRow.v).toBe(pragmaVersion);
      expect(migrationRunner.getMetaTableVersion(db)).toBe(pragmaVersion);
      expect(migrationRunner.getPragmaUserVersion(db)).toBe(pragmaVersion);
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(pragmaVersion);

      const appliedMigrations = db.prepare('SELECT version, name FROM schema_meta ORDER BY version').all();
      expect(appliedMigrations).toEqual(MIGRATIONS.map((migration: any) => ({
        version: migration.version,
        name: migration.name
      })));
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  it('migration 016 creates one canonical refresh operation for previously rejected model snapshots', () => {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(tempUserDataDir, 'migration-016-model-refresh.sqlite'));
    try {
      migrationRunner.applyMigrations(db, { targetVersion: 15 });
      const now = new Date().toISOString();
      const modelId = identifierPolicy.createCanonicalEntityUuid('model', companyId, 'Old Model');
      db.prepare(`INSERT INTO models (id, company_id, name, operations_json, patta_ops_order_json, created_at, updated_at)
        VALUES (?, ?, 'Old Model', '[]', '[]', ?, ?)`).run(modelId, companyId, now, now);
      db.prepare(`INSERT INTO model_id_aliases(company_id, legacy_model_id, canonical_model_id, created_at)
        VALUES (?, 'Old Model', ?, ?)`).run(companyId, modelId, now);
      const failedPayload = canonicalStringify({ modelId: 'Old Model', party: '' });
      db.prepare(`INSERT INTO local_outbox (
        operation_id, company_id, command_type, entity_type, entity_id, base_revision,
        payload_json, status, created_at, updated_at, payload_hash
      ) VALUES ('failed-old-model-write', ?, 'UpsertModel', 'model', 'Old Model', 0, ?, 'DEAD_LETTER', ?, ?, ?)`)
        .run(companyId, failedPayload, now, now, computePayloadHash(failedPayload));

      const result = migrationRunner.applyMigrations(db);
      expect(result.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
      const refresh = db.prepare(`SELECT entity_id, status, payload_json FROM local_outbox
        WHERE company_id = ? AND command_type = 'UpsertModel' AND status = 'PENDING'`).all(companyId);
      expect(refresh).toHaveLength(1);
      expect(refresh[0]).toMatchObject({ entity_id: modelId, status: 'PENDING' });
      expect(JSON.parse(refresh[0].payload_json)).toMatchObject({ modelId, party: '', name: 'Old Model' });
    } finally {
      db.close();
    }
  });

  it('migration 017 preserves ticket column identities while allowing a missing printed party', () => {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(tempUserDataDir, 'migration-017-ticket-columns.sqlite'));
    const ticketId = '11111111-1111-4111-8111-111111111117';
    const now = '2026-10-02T10:00:00.000Z';
    try {
      migrationRunner.applyMigrations(db, { targetVersion: 16 });
      db.prepare(`INSERT INTO models (id, company_id, name, created_at, updated_at)
        VALUES ('model-017', ?, 'Model 017', ?, ?)`).run(companyId, now, now);
      db.prepare(`INSERT INTO parties (
        id, company_id, party_number, physical_party_number, model_id, created_at, updated_at
      ) VALUES ('party-record-017', ?, 'party-017', 'party-017', 'model-017', ?, ?)`)
        .run(companyId, now, now);
      db.prepare(`INSERT INTO workers (id, company_id, name, created_at, updated_at)
        VALUES (17, ?, 'Worker 17', ?, ?)`).run(companyId, now, now);
      db.prepare(`INSERT INTO tickets (
        id, company_id, model_id, party_number, party_record_id, patta_number,
        qty, size, color, status, is_closed, submitted_at, created_at,
        provenance, raw_legacy_json, period_id, server_revision
      ) VALUES (?, ?, 'model-017', 'party-017', 'party-record-017', 7,
        12, 'M', 'Blue', 'CONFIRMED', 0, ?, ?, 'TEST_IMPORT', NULL, 'period-017', 9)`)
        .run(ticketId, companyId, now, now);
      db.prepare(`INSERT INTO ticket_entries (
        id, ticket_id, company_id, op_name, worker_id, worker_name_snapshot,
        rate_snapshot, brak, qty, created_at
      ) VALUES ('entry-017', ?, ?, 'Sew', 17, 'Worker 17', 2.5, NULL, 12, ?)`)
        .run(ticketId, companyId, now);

      const result = migrationRunner.applyMigrations(db);
      expect(result.currentVersion).toBe(17);
      expect(db.prepare(`SELECT period_id, party_number, party_record_id, patta_number,
        provenance, server_revision FROM tickets WHERE id = ?`).get(ticketId)).toEqual({
        period_id: 'period-017',
        party_number: 'party-017',
        party_record_id: 'party-record-017',
        patta_number: 7,
        provenance: 'TEST_IMPORT',
        server_revision: 9
      });
      expect(db.prepare('SELECT ticket_id, op_name, worker_id, qty FROM ticket_entries WHERE id = ?').get('entry-017'))
        .toEqual({ ticket_id: ticketId, op_name: 'Sew', worker_id: 17, qty: 12 });
      db.prepare('UPDATE tickets SET party_record_id = NULL WHERE id = ?').run(ticketId);
      expect(db.prepare('SELECT party_record_id FROM tickets WHERE id = ?').get(ticketId).party_record_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it('fails closed when schema_meta has no verified applied migration', () => {
    const jsonPath = createSampleLegacyJson(companyId);
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);

    try {
      db.prepare('DELETE FROM schema_meta').run();

      let error: any;
      try {
        migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeDefined();
      expect(error.code).toBe('SCHEMA_LINEAGE_MISSING');
      expect(error.message).toBe('SCHEMA_LINEAGE_MISSING: schema_meta has no verified applied migration');
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 4. schema migration atomic
  it('4. schema migration is atomic and records checksum', () => {
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      const metaRows = db.prepare('SELECT * FROM schema_meta ORDER BY version').all();
      expect(metaRows.length).toBe(MIGRATIONS.length);
      expect(metaRows[0].version).toBe(1);
      expect(metaRows[0].name).toBe('001_initial_sync_foundation');
      expect(metaRows[0].checksum).toBe(getMigrationChecksum(MIGRATIONS[0]));
      expect(metaRows[1].version).toBe(2);
      expect(metaRows[1].name).toBe('002_step3_pipeline_and_adjustments');
      expect(metaRows[1].checksum).toBe(getMigrationChecksum(MIGRATIONS[1]));
      expect(metaRows[2].version).toBe(3);
      expect(metaRows[2].name).toBe('003_outbox_payload_hash');
      expect(metaRows[2].checksum).toBe(getMigrationChecksum(MIGRATIONS[2]));
      expect(metaRows[3].version).toBe(4);
      expect(metaRows[3].name).toBe('004_outbox_payload_hash_constraints');
      expect(metaRows[3].checksum).toBe(getMigrationChecksum(MIGRATIONS[3]));
      expect(metaRows[4].version).toBe(5);
      expect(metaRows[4].name).toBe('005_outbox_semantic_immutability');
      expect(metaRows[4].checksum).toBe(getMigrationChecksum(MIGRATIONS[4]));
      expect(metaRows[5].version).toBe(6);
      expect(metaRows[5].name).toBe('006_active_party_uniqueness_and_ticket_identity');
      expect(metaRows[5].checksum).toBe(getMigrationChecksum(MIGRATIONS[5]));
      expect(metaRows[6].version).toBe(7);
      expect(metaRows[6].name).toBe('007_grandfathered_active_party_exception');
      expect(metaRows[6].checksum).toBe(getMigrationChecksum(MIGRATIONS[6]));
      expect(metaRows[7].version).toBe(8);
      expect(metaRows[7].name).toBe('008_reconciliation_resolution_audit');
      expect(metaRows[7].checksum).toBe(getMigrationChecksum(MIGRATIONS[7]));
       expect(metaRows[8].version).toBe(9);
       expect(metaRows[8].name).toBe('009_ticket_uuid_party_fk');
       expect(metaRows[8].checksum).toBe(getMigrationChecksum(MIGRATIONS[8]));
      expect(metaRows[9].version).toBe(10);
      expect(metaRows[9].name).toBe('010_exact_party_2_policy');
      expect(metaRows[9].checksum).toBe(getMigrationChecksum(MIGRATIONS[9]));
      expect(metaRows[10].version).toBe(11);
      expect(metaRows[10].name).toBe('011_synchronized_workbook_mutations');
      expect(metaRows[10].checksum).toBe(getMigrationChecksum(MIGRATIONS[10]));
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 5. schema migration crash rollback
  it('5. schema migration crash rollback leaves version at N-1', () => {
    const testDbPath = path.join(tempUserDataDir, 'crash_migration.sqlite');
    const Database = require('better-sqlite3');
    const db = new Database(testDbPath);

    try {
      migrationRunner.applyMigrations(db);
      expect(migrationRunner.getMetaTableVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(migrationRunner.getPragmaUserVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

      // Attempt faulty migration after the current schema version.
       const faultyMigration = {
         version: CURRENT_SCHEMA_VERSION + 1,
         name: '013_faulty_migration',
        up: (targetDb: any) => {
          targetDb.exec('CREATE TABLE temp_test_table (id INT PRIMARY KEY);');
          throw new Error('INTENTIONAL_MIGRATION_FAILURE');
        }
      };

      expect(() => {
        const tx = db.transaction(() => {
          faultyMigration.up(db);
           db.prepare('INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)')
             .run(faultyMigration.version, faultyMigration.name, new Date().toISOString(), 'hash');
           db.pragma(`user_version = ${faultyMigration.version}`);
        });
        tx.immediate();
      }).toThrow('INTENTIONAL_MIGRATION_FAILURE');

      // Version must remain at the last committed migration.
      expect(migrationRunner.getMetaTableVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(migrationRunner.getPragmaUserVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

      // Verify temp_test_table was rolled back
      const tableCheck = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='temp_test_table'").get();
      expect(tableCheck.c).toBe(0);
    } finally {
      db.close();
    }

  });

  // 6. same migration repeated 3x produces zero duplicates
  it('6. same migration repeated 3x produces zero duplicates (idempotency)', () => {
    const jsonPath = createSampleLegacyJson(companyId);

    const run1 = migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });
    expect(run1.success).toBe(true);
    expect(run1.status).toBe('COMPLETED');
    expect(run1.counts.models).toBe(1);
    expect(run1.counts.workers).toBe(2);
    expect(run1.counts.tickets).toBe(1);

    const run2 = migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });
    expect(run2.success).toBe(true);
    expect(run2.status).toBe('IDEMPOTENT_ALREADY_MIGRATED');
    expect(run2.isRerun).toBe(true);

    const run3 = migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });
    expect(run3.success).toBe(true);
    expect(run3.status).toBe('IDEMPOTENT_ALREADY_MIGRATED');

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      expect(db.prepare('SELECT COUNT(*) as c FROM models').get().c).toBe(1);
      expect(db.prepare('SELECT COUNT(*) as c FROM workers').get().c).toBe(2);
      expect(db.prepare('SELECT COUNT(*) as c FROM tickets').get().c).toBe(1);
      expect(db.prepare('SELECT COUNT(*) as c FROM ticket_entries').get().c).toBe(2);
      expect(db.prepare('SELECT COUNT(*) as c FROM worker_adjustments').get().c).toBe(2); // 1 avans + 1 jarima
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 7. deterministic IDs stable
  it('7. deterministic IDs stable across repeated derivations', () => {
    const modelIdA = identifierPolicy.createCanonicalEntityUuid('model', 'comp_1', 'Old Model Name');
    const modelIdB = identifierPolicy.createCanonicalEntityUuid('model', 'comp_1', 'Old Model Name');
    const partyId = identifierPolicy.createCanonicalEntityUuid('party', 'comp_1', 'old-party-id');
    expect(modelIdA).toBe(modelIdB);
    expect(modelIdA).not.toBe(identifierPolicy.createCanonicalEntityUuid('model', 'comp_2', 'Old Model Name'));
    expect(modelIdA).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(partyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const idA = identifierPolicy.getWorkerAdjustmentId('comp_1', 'AVANS', 5, 'p1');
    const idB = identifierPolicy.getWorkerAdjustmentId('comp_1', 'AVANS', 5, 'p1');
    expect(idA).toBe(idB);
    expect(idA).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const entryIdA = identifierPolicy.getTicketEntryId('sub_123', 0, 'Tikish', 4);
    const entryIdB = identifierPolicy.getTicketEntryId('sub_123', 0, 'Tikish', 4);
    expect(entryIdA).toBe(entryIdB);
  });

  // 8. ticket mapping
  it('8. ticket mapping preserves all core business fields', () => {
    const jsonPath = createSampleLegacyJson(companyId);
    migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      const ticket = db.prepare('SELECT * FROM tickets').get();
      expect(ticket).toBeDefined();
      expect(ticket.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(ticket.model_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(db.prepare('SELECT id FROM models WHERE company_id = ? AND id = ?').get(companyId, ticket.model_id)).toBeDefined();
      expect(ticket.party_number).toBe('1');
      const partyAlias = db.prepare('SELECT canonical_party_id FROM party_id_aliases WHERE company_id = ? AND legacy_party_id = ?').get(companyId, 'rec_101_1');
      expect(ticket.party_record_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(ticket.party_record_id).toBe(partyAlias.canonical_party_id);
      expect(ticket.patta_number).toBe(1);
      expect(ticket.qty).toBe(100);
      expect(ticket.status).toBe('CONFIRMED');
      expect(ticket.provenance).toBe('LEGACY_MIGRATION');
      expect(JSON.parse(ticket.raw_legacy_json)._migration.legacyTicketId).toBe('sub_171000_abc');
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 9. ticket entries mapping
  it('9. ticket entries mapping preserves operations, worker IDs, and rates', () => {
    const jsonPath = createSampleLegacyJson(companyId);
    migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      const entries = db.prepare('SELECT * FROM ticket_entries ORDER BY op_name').all();
      expect(entries.length).toBe(2);
      expect(entries[0].op_name).toBe('Bichish');
      expect(entries[0].worker_id).toBe(1);
      expect(entries[0].rate_snapshot).toBe(1200);
      expect(entries[0].qty).toBe(100);

      expect(entries[1].op_name).toBe('Tikish');
      expect(entries[1].worker_id).toBe(2);
      expect(entries[1].rate_snapshot).toBe(3500);
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 10. missing model reference detected
  it('10. missing model reference detected and quarantined without dropping data', () => {
    const jsonPath = createSampleLegacyJson(companyId, {
      submittedTickets: [
        {
          id: 'sub_orphan_model',
          modelId: 'non_existent_model',
          partyNumber: '5',
          pattaNumber: 2,
          qty: 40,
          submittedAt: '2026-03-01T11:00:00.000Z',
          entries: []
        }
      ]
    });

    const res = migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });
    expect(res.success).toBe(false);
    expect(res.status).toBe('LEGACY_TICKET_PARTY_RESOLUTION_FAILED');
    expect(res.records[0].reason).toBe('MISSING_MODEL_PARTY_REFERENCE');
  });

  // 11. missing worker reference detected
  it('11. missing worker reference detected and quarantined without FK error', () => {
    const jsonPath = createSampleLegacyJson(companyId, {
      submittedTickets: [
        {
          id: 'sub_orphan_worker',
          modelId: 'model_101',
          partyNumber: '1',
          pattaNumber: 2,
          qty: 50,
          submittedAt: '2026-03-01T12:00:00.000Z',
          entries: [
            { opName: 'Bichish', workerId: 9999, workerName: 'Ghost Worker', rateSnapshot: 1000 }
          ]
        }
      ]
    });

    const res = migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });
    expect(res.counts.quarantine).toBeGreaterThanOrEqual(1);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      const quarantined = db.prepare('SELECT * FROM migration_quarantine_ticket_entries WHERE worker_id = ?').get(9999);
      expect(quarantined).toBeDefined();
      expect(quarantined.reason).toBe('MISSING_WORKER_REFERENCE');

      // Canonical ticket was saved, but broken entry was quarantined to maintain FK integrity
      const canonicalTicket = db.prepare('SELECT * FROM tickets').get();
      expect(canonicalTicket).toBeDefined();
      const canonicalEntry = db.prepare('SELECT * FROM ticket_entries WHERE worker_id = ?').get(9999);
      expect(canonicalEntry).toBeUndefined();
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 12. worker avans deterministic adjustment
  it('12. worker avans deterministic adjustment created as ledger fact', () => {
    const jsonPath = createSampleLegacyJson(companyId);
    migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      const adj = db.prepare("SELECT * FROM worker_adjustments WHERE worker_id = 1 AND type = 'AVANS'").get();
      expect(adj).toBeDefined();
      expect(adj.amount).toBe(50000);
      expect(adj.provenance).toBe('MIGRATION_OPENING_BALANCE');
      expect(adj.status).toBe('POSTED');
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 13. worker jarima deterministic adjustment
  it('13. worker jarima deterministic adjustment created as ledger fact', () => {
    const jsonPath = createSampleLegacyJson(companyId);
    migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      const adj = db.prepare("SELECT * FROM worker_adjustments WHERE worker_id = 2 AND type = 'JARIMA'").get();
      expect(adj).toBeDefined();
      expect(adj.amount).toBe(20000);
      expect(adj.provenance).toBe('MIGRATION_OPENING_BALANCE');
      expect(adj.status).toBe('POSTED');
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 14. party collision quarantined
  it('14. party collision quarantined into migration_quarantine_parties', () => {
    const jsonPath = createSampleLegacyJson(companyId, {
      printedPartyHistory: [
        { id: 'p_1_a', partyNumber: '12', modelId: 'model_101', pattaCount: 10, ishSoni: 500 },
        { id: 'p_1_b', partyNumber: '12', modelId: 'model_102', pattaCount: 15, ishSoni: 750 }
      ],
      submittedTickets: []
    });

    const res = migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });
    expect(res.counts.quarantine).toBe(2);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      const quarantined = db.prepare('SELECT * FROM migration_quarantine_parties WHERE original_party_number = ?').all('12');
      expect(quarantined.length).toBe(2);
      expect(quarantined[0].resolution_status).toBe('PENDING_REVIEW');
      expect(quarantined[1].resolution_status).toBe('PENDING_REVIEW');
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 15. party number is NOT renamed
  it('15. party number is NOT renamed or suffixed in quarantine', () => {
    const jsonPath = createSampleLegacyJson(companyId, {
      printedPartyHistory: [
        { id: 'p_coll_1', partyNumber: '7', modelId: 'model_101', pattaCount: 5, ishSoni: 250 },
        { id: 'p_coll_2', partyNumber: '7', modelId: 'model_102', pattaCount: 8, ishSoni: 400 }
      ],
      submittedTickets: []
    });

    migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      const quarantined = db.prepare('SELECT original_party_number FROM migration_quarantine_parties').all();
      expect(quarantined.every((q: any) => q.original_party_number === '7')).toBe(true);
      // Ensure no "_COLLISION" or renamed party exists in parties table
      const canonicalParties = db.prepare('SELECT party_number FROM parties').all();
      expect(canonicalParties.some((p: any) => p.party_number.includes('COLLISION'))).toBe(false);
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 16. archived data not imported as live
  it('16. archived data not imported as live active tickets', () => {
    // Create an archive file in archives/<companyId>/archive_2026-02.json
    const archiveDir = path.join(tempUserDataDir, 'NovdaData', 'archives', companyId);
    fs.mkdirSync(archiveDir, { recursive: true });
    const archivePayload = {
      period: { id: 'period_2026_02', name: '2026 Fevral', startDate: '2026-02-01', isClosed: true },
      archivedAt: '2026-02-28T23:59:59.000Z',
      submittedTickets: [
        { id: 'sub_archived_feb_1', modelId: 'model_101', partyNumber: '99', pattaNumber: 1, qty: 50, entries: [] }
      ]
    };
    fs.writeFileSync(path.join(archiveDir, 'archive_2026-02.json'), JSON.stringify(archivePayload), 'utf8');

    const jsonPath = createSampleLegacyJson(companyId);
    migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      // Live tickets table must ONLY have the active ticket, not the archived ticket
      const tickets = db.prepare('SELECT raw_legacy_json FROM tickets').all().map((t: any) => JSON.parse(t.raw_legacy_json).id);
      expect(tickets).toContain('sub_171000_abc');
      expect(tickets).not.toContain('sub_archived_feb_1');
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 17. hisob projection parity calculation
  it('17. hisob projection parity calculation identifies discrepancies', () => {
    // Create legacy JSON where hisobQuantities (150) differs from ticket sum (100)
    const jsonPath = createSampleLegacyJson(companyId, {
      models: [
        {
          id: 'model_101',
          name: 'Futbolka',
          operations: [{ id: 'op_1', name: 'Bichish', rate: 1000 }],
          pattaOpsOrder: ['Bichish'],
          hisobQuantities: {
            '1': { 'Bichish': 150 } // Difference of +50 over ticket qty (100)
          }
        }
      ]
    });

    const res = migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });
    expect(res.counts.reconciliationCandidates).toBe(1);
    expect(res.parity.financial.differenceCount).toBe(1);
    expect(res.parity.financial.differenceMagnitude).toBe(50);
  });

  // 18. unresolved reconciliation reported
  it('18. unresolved reconciliation reported in parity report and blocks migrationReady', () => {
    const jsonPath = createSampleLegacyJson(companyId, {
      models: [
        {
          id: 'model_101',
          name: 'Futbolka',
          operations: [{ id: 'op_1', name: 'Bichish', rate: 1000 }],
          pattaOpsOrder: ['Bichish'],
          hisobQuantities: {
            '1': { 'Bichish': 120 }
          }
        }
      ]
    });

    const res = migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });
    expect(res.migrationReady).toBe(false);

    const report = parityReporter.generateParityReport(tempUserDataDir, companyId);
    expect(report.migrationReady).toBe(false);
    expect(report.financial.differenceCount).toBe(1);
  });

  // 19. source SHA-256 recorded
  it('19. source SHA-256 recorded in migration_runs', () => {
    const jsonPath = createSampleLegacyJson(companyId);
    const expectedSha = crypto.createHash('sha256').update(fs.readFileSync(jsonPath)).digest('hex');

    const res = migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });
    expect(res.sourceSha256).toBe(expectedSha);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      const run = db.prepare('SELECT source_sha256 FROM migration_runs WHERE migration_run_id = ?').get(res.migrationRunId);
      expect(run.source_sha256).toBe(expectedSha);
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 20. source mutation after migration detected
  it('20. source mutation after migration detected as SOURCE_CHANGED_AFTER_MIGRATION', () => {
    const jsonPath = createSampleLegacyJson(companyId);
    const run1 = migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });
    expect(run1.status).toBe('COMPLETED');

    // Mutate source JSON (e.g. user adds a worker)
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    raw.workers.push({ id: 3, name: 'Sardor', staj: 1 });
    fs.writeFileSync(jsonPath, JSON.stringify(raw, null, 2), 'utf8');

    const run2 = migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });
    expect(run2.status).toBe('SOURCE_CHANGED_AFTER_MIGRATION');
    expect(run2.migrationReady).toBe(false);
  });

  // 21. SQLite integrity check
  it('21. SQLite integrity check runs and fails closed on corrupt DB', () => {
    const testDbPath = path.join(tempUserDataDir, 'corrupt.sqlite');
    // Write garbage header to simulate corrupt file
    fs.writeFileSync(testDbPath, 'CORRUPT_SQLITE_HEADER_GARBAGE_BYTES_1234567890');

    const Database = require('better-sqlite3');
    expect(() => {
      const db = new Database(testDbPath);
      try {
        databaseManager.runIntegrityCheck(db);
      } finally {
        db.close();
      }
    }).toThrow();
  });

  it('runs combined SQLite health checks and fails closed on orphaned rows', () => {
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    const dbPath = companyPath.sanitizeCompanyDbPath(tempUserDataDir, companyId);

    try {
      expect(databaseManager.runDatabaseIntegrityChecks(db)).toEqual({
        integrityCheck: 'ok',
        foreignKeyCheck: []
      });
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }

    const Database = require('better-sqlite3');
    const orphanedDb = new Database(dbPath);
    try {
      orphanedDb.pragma('foreign_keys = OFF');
      orphanedDb.prepare(`
        INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id, qty, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'orphan-entry-health-check',
        'missing-ticket-health-check',
        companyId,
        'Bichish',
        999999,
        1,
        new Date().toISOString()
      );
      orphanedDb.pragma('foreign_keys = ON');

      expect(() => databaseManager.runDatabaseIntegrityChecks(orphanedDb)).toThrowError(
        expect.objectContaining({ code: 'DATABASE_FOREIGN_KEY_VIOLATION' })
      );
    } finally {
      orphanedDb.close();
    }

    expect(() => databaseManager.getCompanyDatabase(tempUserDataDir, companyId)).toThrowError(
      expect.objectContaining({ code: 'DATABASE_FOREIGN_KEY_VIOLATION' })
    );
  });

  // 22. protected patta batch implementation integrity
  it('22. protected patta batch file matches its exact expected SHA-256', () => {
    const pattaBatchPath = path.resolve(__dirname, '../../renderer/store/slices/createPattaBatchSlice.ts');

    const pattaBatchSha = crypto.createHash('sha256').update(fs.readFileSync(pattaBatchPath)).digest('hex').toLowerCase();

    expect(pattaBatchSha).toBe('8c966e35f2d6c2e8cf784260c4f18f8f15489a883179df600d876ab58a8cdb44');
  });

  // 23. legacy staj maps to workers.staj, not adjustment ledger
  it('23. legacy staj maps to workers.staj, NOT adjustment ledger', () => {
    const jsonPath = createSampleLegacyJson(companyId, {
      workers: [
        { id: 10, name: 'Usta Bobur', staj: 12, avans: 0, jarima: 0 }
      ]
    });

    migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      const worker = db.prepare('SELECT * FROM workers WHERE id = 10').get();
      expect(worker.staj).toBe(12);

      // Staj must NOT appear in worker_adjustments!
      const stajAdj = db.prepare("SELECT * FROM worker_adjustments WHERE worker_id = 10 AND type LIKE '%STAJ%'").get();
      expect(stajAdj).toBeUndefined();
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 24. PENDING_REVIEW reconciliation does not affect authoritative projection
  it('24. PENDING_REVIEW reconciliation does not affect authoritative projection', () => {
    const jsonPath = createSampleLegacyJson(companyId, {
      models: [
        {
          id: 'model_101',
          name: 'Futbolka',
          operations: [{ id: 'op_1', name: 'Bichish', rate: 1000 }],
          pattaOpsOrder: ['Bichish'],
          hisobQuantities: {
            '1': { 'Bichish': 250 } // Ticket qty is 100, so 150 delta is unapproved
          }
        }
      ]
    });

    migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      const candidate = db.prepare("SELECT * FROM migration_reconciliation_candidates WHERE status = 'PENDING_REVIEW'").get();
      expect(candidate).toBeDefined();
      expect(candidate.delta_qty).toBe(150);

      // Authoritative projection query (sums only confirmed ticket entries)
      const authoritativeSum = db.prepare(`
        SELECT COALESCE(SUM(te.qty), 0) as total
        FROM ticket_entries te
        JOIN tickets t ON t.id = te.ticket_id
        WHERE t.status = 'CONFIRMED' AND te.worker_id = 1 AND te.op_name = 'Bichish'
      `).get().total;

      expect(authoritativeSum).toBe(100); // Only canonical ticket qty, NOT 250!
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 25. missing-model Party mapping fails before any canonical or quarantine write
  it('25. missing-model Party mapping fails closed before writes', () => {
    const jsonPath = createSampleLegacyJson(companyId, {
      submittedTickets: [
        { id: 't_good', modelId: 'model_101', partyNumber: '1', pattaNumber: 1, qty: 10, entries: [] },
        { id: 't_bad', modelId: 'non_existent', partyNumber: '1', pattaNumber: 2, qty: 20, entries: [] }
      ]
    });

    const res = migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });
    expect(res.status).toBe('LEGACY_TICKET_PARTY_RESOLUTION_FAILED');
    expect(res.records).toEqual(expect.arrayContaining([expect.objectContaining({ legacyTicketId: 't_bad', reason: 'MISSING_MODEL_PARTY_REFERENCE' })]));

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      expect(db.prepare('SELECT COUNT(*) AS c FROM tickets').get().c).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS c FROM migration_quarantine_tickets').get().c).toBe(0);
      const fkCheck = db.pragma('foreign_key_check');
      expect(fkCheck.length).toBe(0);
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 26. missing-worker ticket entry is quarantined, canonical FK remains valid
  it('26. missing-worker ticket entry is quarantined and canonical ticket_entries remain FK valid', () => {
    const jsonPath = createSampleLegacyJson(companyId, {
      submittedTickets: [
        {
          id: 'sub_test_entry_fk',
          modelId: 'model_101',
          partyNumber: '1',
          pattaNumber: 1,
          qty: 10,
          entries: [
            { opName: 'Bichish', workerId: 1 }, // Valid worker
            { opName: 'Tikish', workerId: 8888 } // Invalid worker
          ]
        }
      ]
    });

    migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      // Ticket is present
      expect(db.prepare('SELECT id FROM tickets').get()).toBeDefined();
      // Valid entry is present
      expect(db.prepare('SELECT id FROM ticket_entries WHERE worker_id = 1').get()).toBeDefined();
      // Invalid entry is quarantined
      expect(db.prepare('SELECT id FROM ticket_entries WHERE worker_id = 8888').get()).toBeUndefined();
      expect(db.prepare('SELECT * FROM migration_quarantine_ticket_entries WHERE worker_id = 8888').get()).toBeDefined();

      // Zero foreign key violations
      const fkCheck = db.pragma('foreign_key_check');
      expect(fkCheck.length).toBe(0);
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 27. ambiguous global legacy DB is not assigned to active company
  it('27. ambiguous global legacy DB is not assigned to active company', () => {
    const novdaDir = path.join(tempUserDataDir, 'NovdaData');
    fs.mkdirSync(novdaDir, { recursive: true });

    // Global file with NO companyId or unassigned
    const ambiguousGlobal = path.join(novdaDir, 'hisob_database.json');
    fs.writeFileSync(ambiguousGlobal, JSON.stringify({ models: [{ id: 'm1', name: 'Test' }] }), 'utf8');

    // Attempt discovery for company_b
    const discovery = migrator.discoverLegacySource(tempUserDataDir, 'company_b');
    expect(discovery.status).toBe('AMBIGUOUS_LEGACY_SOURCE');

    // Migration must fail closed
    const res = migrator.migrateLegacyData(tempUserDataDir, 'company_b');
    expect(res.success).toBe(false);
    expect(res.status).toBe('AMBIGUOUS_LEGACY_SOURCE');
  });

  // 28. schema_meta/user_version mismatch fails closed
  it('28. schema_meta / user_version mismatch fails closed with SCHEMA_VERSION_MISMATCH', () => {
    const testDbPath = path.join(tempUserDataDir, 'mismatch.sqlite');
    const Database = require('better-sqlite3');
    const db = new Database(testDbPath);

    try {
      migrationRunner.applyMigrations(db);
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(CURRENT_SCHEMA_VERSION);

      // Artificially create mismatch
      db.pragma('user_version = 99');

      expect(() => {
        migrationRunner.verifySchemaVersionConsistency(db);
      }).toThrow(/SCHEMA_VERSION_MISMATCH/);
    } finally {
      db.close();
    }
  });

  // 29. migration verification IPC cannot select arbitrary filesystem source
  it('29. migration verification IPC rejects path traversal and arbitrary company contexts', () => {
    // Calling discoverLegacySource with traversal must fail closed
    const res = migrator.discoverLegacySource(tempUserDataDir, '../../secret_company');
    expect(res.status).toBe('NOT_FOUND');
    expect(res.error).toMatch(/Invalid company ID/);
  });

  // 30. Production Seam Test
  it('30. Production Seam: executes end-to-end against real DB manager, real company path, real transaction', () => {
    const jsonPath = createSampleLegacyJson(companyId);

    // 1. Run real migration
    const migrationResult = migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: jsonPath });
    expect(migrationResult.success).toBe(true);
    expect(migrationResult.status).toBe('COMPLETED');

    // 2. Open via real production databaseManager
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    try {
      // 3. Verify disk file exists at canonical path
      const expectedDbFile = path.join(tempUserDataDir, 'NovdaData', 'companies', companyId, 'hisob.sqlite');
      expect(fs.existsSync(expectedDbFile)).toBe(true);

      // 4. Verify data in real database
      const row = db.prepare('SELECT COUNT(*) as c FROM tickets').get();
      expect(row.c).toBe(1);

      // 5. Verify real parity reporter
      const parity = parityReporter.generateParityReport(tempUserDataDir, companyId);
      expect(parity.success).toBe(true);
      expect(parity.sqlite.ticketCount).toBe(1);
      expect(parity.legacy.ticketCount).toBe(1);
      expect(parity.migrationReady).toBe(true);
    } finally {
      databaseManager.closeCompanyDatabase(companyId);
    }
  });

  // 31. Migration 003 adds payload_hash and backfills existing outbox rows
  it('31. Migration 003: adds payload_hash column, index, and deterministically backfills existing rows', () => {
    const testDbPath = path.join(tempUserDataDir, 'migration_003_test.sqlite');
    const Database = require('better-sqlite3');
    const db = new Database(testDbPath);

    try {
      // 1. Apply Migration 001 and 002 manually
      MIGRATIONS[0].up(db);
      db.prepare("INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (1, ?, datetime('now'), ?)")
        .run(MIGRATIONS[0].name, getMigrationChecksum(MIGRATIONS[0]));
      db.pragma('user_version = 1');

      MIGRATIONS[1].up(db);
      db.prepare("INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (2, ?, datetime('now'), ?)")
        .run(MIGRATIONS[1].name, getMigrationChecksum(MIGRATIONS[1]));
      db.pragma('user_version = 2');

      // 2. Insert outbox row before migration 003 (payload_hash does not exist yet)
      db.prepare(`
        INSERT INTO local_outbox (
          operation_id, company_id, command_type, entity_type, entity_id,
          base_revision, payload_json, status, created_at, updated_at
        ) VALUES (
          'op_legacy_1', 'comp_test', 'SubmitTicket', 'ticket', 'tick_leg_1',
          0, '{"z": 10, "a": [1, 2]}', 'PENDING', datetime('now'), datetime('now')
        )
      `).run();

      // 3. Now run applyMigrations to apply Migration 003 through 009
      migrationRunner.applyMigrations(db);
      expect(migrationRunner.getMetaTableVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

      // 4. Verify payload_hash column and backfilled value
      const row = db.prepare('SELECT operation_id, payload_hash FROM local_outbox WHERE operation_id = ?').get('op_legacy_1');
      expect(row).toBeDefined();
      expect(row.payload_hash).toBeTruthy();
      expect(row.payload_hash.length).toBe(64); // SHA-256 hex length

      // Verify exact hash calculation matches canonical serialization
      const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');
      const expectedHash = computePayloadHash(canonicalStringify({ z: 10, a: [1, 2] }));
      expect(row.payload_hash).toBe(expectedHash);

      // Verify index exists
      const indices = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r: any) => r.name);
      expect(indices).toContain('idx_outbox_payload_hash');
    } finally {
      db.close();
    }
  });

  // =========================================================================
  // 32. MIGRATION 004 TESTS (Items A-G)
  // =========================================================================

  function setupV3Db(dbPath: string) {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    // Apply 001
    MIGRATIONS[0].up(db);
    db.prepare("INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (1, ?, datetime('now'), ?)")
      .run(MIGRATIONS[0].name, getMigrationChecksum(MIGRATIONS[0]));
    db.pragma('user_version = 1');

    // Apply 002
    MIGRATIONS[1].up(db);
    db.prepare("INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (2, ?, datetime('now'), ?)")
      .run(MIGRATIONS[1].name, getMigrationChecksum(MIGRATIONS[1]));
    db.pragma('user_version = 2');

    // Apply 003
    MIGRATIONS[2].up(db);
    db.prepare("INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (3, ?, datetime('now'), ?)")
      .run(MIGRATIONS[2].name, getMigrationChecksum(MIGRATIONS[2]));
    db.pragma('user_version = 3');

    expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(3);
    return db;
  }

  it('32A. v3 DB with valid payload_json and NULL hash => Migration 004 deterministically backfills correct hash => v4', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig004_test_a.sqlite');
    const db = setupV3Db(testDbPath);
    try {
      db.prepare(`
        INSERT INTO local_outbox (
          operation_id, company_id, command_type, entity_type, entity_id,
          base_revision, payload_json, payload_hash, status, created_at, updated_at
        ) VALUES (
          'op_test_a', 'comp_a', 'SubmitTicket', 'ticket', 't_a',
          0, '{"foo": "bar", "count": 42}', NULL, 'PENDING', datetime('now'), datetime('now')
        )
      `).run();

       migrationRunner.applyMigrations(db);
        expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(CURRENT_SCHEMA_VERSION);

      const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');
      const expectedHash = computePayloadHash(canonicalStringify({ foo: 'bar', count: 42 }));
      const row = db.prepare('SELECT payload_hash FROM local_outbox WHERE operation_id = ?').get('op_test_a');
      expect(row.payload_hash).toBe(expectedHash);
      expect(row.payload_hash.length).toBe(64);
    } finally {
      db.close();
    }
  });

  it('32B. v3 DB with valid canonical payload_json and valid matching hash => preserved unchanged => v6', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig004_test_b.sqlite');
    const db = setupV3Db(testDbPath);
    try {
      const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');
      const canonicalJson = canonicalStringify({ alpha: 1, beta: [2, 3] });
      const validHash = computePayloadHash(canonicalJson);

      db.prepare(`
        INSERT INTO local_outbox (
          operation_id, company_id, command_type, entity_type, entity_id,
          base_revision, payload_json, payload_hash, status, created_at, updated_at
        ) VALUES (
          'op_test_b', 'comp_b', 'SubmitTicket', 'ticket', 't_b',
          0, ?, ?, 'PENDING', datetime('now'), datetime('now')
        )
      `).run(canonicalJson, validHash);

      migrationRunner.applyMigrations(db);
        expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(CURRENT_SCHEMA_VERSION);

      const row = db.prepare('SELECT payload_json, payload_hash FROM local_outbox WHERE operation_id = ?').get('op_test_b');
      expect(row.payload_json).toBe(canonicalJson);
      expect(row.payload_hash).toBe(validHash);
    } finally {
      db.close();
    }
  });

  it('32C. v3 DB with valid payload_json but WRONG existing non-empty hash => migration FAILS CLOSED => DB remains version 3', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig004_test_c.sqlite');
    const db = setupV3Db(testDbPath);
    try {
      db.prepare(`
        INSERT INTO local_outbox (
          operation_id, company_id, command_type, entity_type, entity_id,
          base_revision, payload_json, payload_hash, status, created_at, updated_at
        ) VALUES (
          'op_test_c', 'comp_c', 'SubmitTicket', 'ticket', 't_c',
          0, '{"valid": true}', 'conflicting_wrong_hash', 'PENDING', datetime('now'), datetime('now')
        )
      `).run();

      expect(() => {
        migrationRunner.applyMigrations(db);
      }).toThrow(/Conflicting payload_hash/);

      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(3);
      const metaVersion = migrationRunner.getMetaTableVersion(db);
      const pragmaVersion = migrationRunner.getPragmaUserVersion(db);
      expect(metaVersion).toBe(3);
      expect(pragmaVersion).toBe(3);
    } finally {
      db.close();
    }
  });

  it('32D. v3 DB with malformed payload_json => migration FAILS CLOSED => DB remains version 3', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig004_test_d.sqlite');
    const db = setupV3Db(testDbPath);
    try {
      db.prepare(`
        INSERT INTO local_outbox (
          operation_id, company_id, command_type, entity_type, entity_id,
          base_revision, payload_json, payload_hash, status, created_at, updated_at
        ) VALUES (
          'op_test_d', 'comp_d', 'SubmitTicket', 'ticket', 't_d',
          0, 'malformed JSON { not valid', NULL, 'PENDING', datetime('now'), datetime('now')
        )
      `).run();

      expect(() => {
        migrationRunner.applyMigrations(db);
      }).toThrow(/Malformed payload_json/);

      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(3);
      expect(migrationRunner.getMetaTableVersion(db)).toBe(3);
      expect(migrationRunner.getPragmaUserVersion(db)).toBe(3);
    } finally {
      db.close();
    }
  });

  it('32E. fresh DB v1 -> sync -> v3 -> v4 -> v5 succeeds sequentially', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig004_test_e.sqlite');
    const Database = require('better-sqlite3');
    const db = new Database(testDbPath);
    try {
      MIGRATIONS[0].up(db);
      db.prepare("INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (1, ?, datetime('now'), ?)")
        .run(MIGRATIONS[0].name, getMigrationChecksum(MIGRATIONS[0]));
      db.pragma('user_version = 1');
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(1);

      const res = migrationRunner.applyMigrations(db);
      expect(res.previousVersion).toBe(1);
      expect(res.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(res.appliedCount).toBe(CURRENT_SCHEMA_VERSION - res.previousVersion);
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('32F. sync -> v3 -> v4 -> v5 succeeds sequentially', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig004_test_f.sqlite');
    const Database = require('better-sqlite3');
    const db = new Database(testDbPath);
    try {
      MIGRATIONS[0].up(db);
      db.prepare("INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (1, ?, datetime('now'), ?)")
        .run(MIGRATIONS[0].name, getMigrationChecksum(MIGRATIONS[0]));
      db.pragma('user_version = 1');

      MIGRATIONS[1].up(db);
      db.prepare("INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (2, ?, datetime('now'), ?)")
        .run(MIGRATIONS[1].name, getMigrationChecksum(MIGRATIONS[1]));
      db.pragma('user_version = 2');
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(2);

      const res = migrationRunner.applyMigrations(db);
      expect(res.previousVersion).toBe(2);
      expect(res.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(res.appliedCount).toBe(CURRENT_SCHEMA_VERSION - res.previousVersion);
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('32G. v3 -> v4 -> v5 succeeds', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig004_test_g.sqlite');
    const db = setupV3Db(testDbPath);
    try {
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(3);
      const res = migrationRunner.applyMigrations(db);
      expect(res.previousVersion).toBe(3);
      expect(res.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(res.appliedCount).toBe(CURRENT_SCHEMA_VERSION - res.previousVersion);
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  // =========================================================================
  // 33. MIGRATION 005 TESTS (Items A-I)
  // =========================================================================

  function setupV4Db(dbPath: string) {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    for (let i = 0; i < 4; i++) {
      MIGRATIONS[i].up(db);
      db.prepare("INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (?, ?, datetime('now'), ?)")
        .run(MIGRATIONS[i].version, MIGRATIONS[i].name, getMigrationChecksum(MIGRATIONS[i]));
      db.pragma(`user_version = ${MIGRATIONS[i].version}`);
    }
    expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(4);
    return db;
  }

  it('33A. v4 -> v5 succeeds', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig005_test_a.sqlite');
    const db = setupV4Db(testDbPath);
    try {
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(4);
      const res = migrationRunner.applyMigrations(db);
      expect(res.previousVersion).toBe(4);
      expect(res.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(res.appliedCount).toBe(CURRENT_SCHEMA_VERSION - res.previousVersion);
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(migrationRunner.getMetaTableVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(migrationRunner.getPragmaUserVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('33B. v3 -> v4 -> v5 succeeds', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig005_test_b.sqlite');
    const db = setupV3Db(testDbPath);
    try {
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(3);
      const res = migrationRunner.applyMigrations(db);
      expect(res.previousVersion).toBe(3);
      expect(res.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(res.appliedCount).toBe(CURRENT_SCHEMA_VERSION - res.previousVersion);
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('33C. sync -> v3 -> v4 -> v5 succeeds', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig005_test_c.sqlite');
    const Database = require('better-sqlite3');
    const db = new Database(testDbPath);
    try {
      for (let i = 0; i < 2; i++) {
        MIGRATIONS[i].up(db);
        db.prepare("INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (?, ?, datetime('now'), ?)")
          .run(MIGRATIONS[i].version, MIGRATIONS[i].name, getMigrationChecksum(MIGRATIONS[i]));
        db.pragma(`user_version = ${MIGRATIONS[i].version}`);
      }
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(2);

      const res = migrationRunner.applyMigrations(db);
      expect(res.previousVersion).toBe(2);
      expect(res.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(res.appliedCount).toBe(CURRENT_SCHEMA_VERSION - res.previousVersion);
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('33D. fresh DB -> all migrations -> v11 succeeds', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig005_test_d.sqlite');
    const Database = require('better-sqlite3');
    const db = new Database(testDbPath);
    try {
      expect(migrationRunner.getMetaTableVersion(db)).toBe(0);
      expect(migrationRunner.getPragmaUserVersion(db)).toBe(0);

      const res = migrationRunner.applyMigrations(db);
      expect(res.previousVersion).toBe(0);
      expect(res.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(res.appliedCount).toBe(MIGRATIONS.length);
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(migrationRunner.getMetaTableVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(migrationRunner.getPragmaUserVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('33E. Migration 005 creates immutability trigger', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig005_test_e.sqlite');
    const db = setupV4Db(testDbPath);
    try {
      migrationRunner.applyMigrations(db);
      const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r: any) => r.name);
      expect(triggers).toContain('trg_local_outbox_semantic_immutability');
    } finally {
      db.close();
    }
  });

  it('33F. existing valid outbox rows remain semantically identical after migration', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig005_test_f.sqlite');
    const db = setupV4Db(testDbPath);
    try {
      const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');
      const payloadJson = canonicalStringify({ testKey: 'testVal', numbers: [1, 2, 3] });
      const payloadHash = computePayloadHash(payloadJson);
      const originalRow = {
        operation_id: 'op_existing_v4',
        company_id: 'comp_test_v5',
        command_type: 'SubmitTicket',
        entity_type: 'ticket',
        entity_id: 'tick_v4_preserved',
        base_revision: 3,
        payload_json: payloadJson,
        payload_hash: payloadHash,
        depends_on_operation_id: 'op_dep_parent',
        causal_sequence: 12,
        created_at: '2026-03-01T12:00:00.000Z',
        status: 'PENDING',
        attempt_count: 1,
        retry_count: 0,
        last_error: 'transient_timeout',
        error_message: 'transient_timeout',
        updated_at: '2026-03-01T12:01:00.000Z'
      };

      db.prepare(`
        INSERT INTO local_outbox (
          operation_id, company_id, command_type, entity_type, entity_id,
          base_revision, payload_json, payload_hash, depends_on_operation_id, causal_sequence,
          created_at, status, attempt_count, retry_count, last_error, error_message, updated_at
        ) VALUES (
          @operation_id, @company_id, @command_type, @entity_type, @entity_id,
          @base_revision, @payload_json, @payload_hash, @depends_on_operation_id, @causal_sequence,
          @created_at, @status, @attempt_count, @retry_count, @last_error, @error_message, @updated_at
        )
      `).run(originalRow);

      migrationRunner.applyMigrations(db);
        expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(CURRENT_SCHEMA_VERSION);

      const afterRow = db.prepare('SELECT * FROM local_outbox WHERE operation_id = ?').get('op_existing_v4');
      expect(afterRow.operation_id).toBe(originalRow.operation_id);
      expect(afterRow.company_id).toBe(originalRow.company_id);
      expect(afterRow.command_type).toBe(originalRow.command_type);
      expect(afterRow.entity_type).toBe(originalRow.entity_type);
      expect(afterRow.entity_id).toBe(originalRow.entity_id);
      expect(afterRow.base_revision).toBe(originalRow.base_revision);
      expect(afterRow.payload_json).toBe(originalRow.payload_json);
      expect(afterRow.payload_hash).toBe(originalRow.payload_hash);
      expect(afterRow.depends_on_operation_id).toBe(originalRow.depends_on_operation_id);
      expect(afterRow.causal_sequence).toBe(originalRow.causal_sequence);
      expect(afterRow.created_at).toBe(originalRow.created_at);
      expect(afterRow.status).toBe(originalRow.status);
      expect(afterRow.attempt_count).toBe(originalRow.attempt_count);
      expect(afterRow.retry_count).toBe(originalRow.retry_count);
      expect(afterRow.last_error).toBe(originalRow.last_error);
      expect(afterRow.error_message).toBe(originalRow.error_message);
      expect(afterRow.updated_at).toBe(originalRow.updated_at);
    } finally {
      db.close();
    }
  });

  it('33G & 33H. schema_meta version = 7 and PRAGMA user_version = 7', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig005_test_gh.sqlite');
    const db = setupV4Db(testDbPath);
    try {
      migrationRunner.applyMigrations(db);
        expect(migrationRunner.getMetaTableVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
        expect(migrationRunner.getPragmaUserVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

      const metaRow5 = db.prepare('SELECT * FROM schema_meta WHERE version = 5').get();
      expect(metaRow5).toBeDefined();
      expect(metaRow5.name).toBe('005_outbox_semantic_immutability');
      expect(metaRow5.checksum).toBe(getMigrationChecksum(MIGRATIONS[4]));

      const metaRow6 = db.prepare('SELECT * FROM schema_meta WHERE version = 6').get();
      expect(metaRow6).toBeDefined();
      expect(metaRow6.name).toBe('006_active_party_uniqueness_and_ticket_identity');
      expect(metaRow6.checksum).toBe(getMigrationChecksum(MIGRATIONS[5]));

      const metaRow7 = db.prepare('SELECT * FROM schema_meta WHERE version = 7').get();
      expect(metaRow7).toBeDefined();
      expect(metaRow7.name).toBe('007_grandfathered_active_party_exception');
      expect(metaRow7.checksum).toBe(getMigrationChecksum(MIGRATIONS[6]));

      const metaRow8 = db.prepare('SELECT * FROM schema_meta WHERE version = 8').get();
      expect(metaRow8).toBeDefined();
      expect(metaRow8.name).toBe('008_reconciliation_resolution_audit');
      expect(metaRow8.checksum).toBe(getMigrationChecksum(MIGRATIONS[7]));

      const metaRow9 = db.prepare('SELECT * FROM schema_meta WHERE version = 9').get();
      expect(metaRow9.name).toBe('009_ticket_uuid_party_fk');
      expect(metaRow9.checksum).toBe(getMigrationChecksum(MIGRATIONS[8]));
    } finally {
      db.close();
    }
  });

  it('33I. Migration failure atomicity: if Migration 005 fails, database remains strictly at version 4', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig005_test_atomicity.sqlite');
    const db = setupV4Db(testDbPath);
    try {
      expect(migrationRunner.getMetaTableVersion(db)).toBe(4);
      expect(migrationRunner.getPragmaUserVersion(db)).toBe(4);

      // Faulty migration definition for version 5
      const faultyMigration5 = {
        version: 5,
        name: '005_outbox_semantic_immutability',
        up: (targetDb: any) => {
          targetDb.exec("CREATE TRIGGER trg_test_faulty BEFORE UPDATE ON local_outbox BEGIN SELECT 1; END;");
          throw new Error('SIMULATED_MIGRATION_005_FAILURE');
        }
      };

      expect(() => {
        const tx = db.transaction(() => {
          faultyMigration5.up(db);
          db.prepare('INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (5, ?, ?, ?)')
            .run(faultyMigration5.name, new Date().toISOString(), 'hash');
          db.pragma('user_version = 5');
        });
        tx.immediate();
      }).toThrow('SIMULATED_MIGRATION_005_FAILURE');

      // Database state, schema_meta, and PRAGMA user_version must remain strictly at 4
      expect(migrationRunner.getMetaTableVersion(db)).toBe(4);
      expect(migrationRunner.getPragmaUserVersion(db)).toBe(4);
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(4);

      // Trigger must not exist (rolled back cleanly)
      const triggerCheck = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='trigger' AND name='trg_test_faulty'").get();
      expect(triggerCheck.c).toBe(0);
    } finally {
      db.close();
    }
  });

  // =========================================================================
  // 34. MIGRATION 006 UPGRADE TEST (v5 -> v6)
  // =========================================================================

  function setupV5Db(dbPath: string) {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    for (let i = 0; i < 5; i++) {
      MIGRATIONS[i].up(db);
      db.prepare("INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (?, ?, datetime('now'), ?)")
        .run(MIGRATIONS[i].version, MIGRATIONS[i].name, getMigrationChecksum(MIGRATIONS[i]));
      db.pragma(`user_version = ${MIGRATIONS[i].version}`);
    }
    expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(5);
    return db;
  }

  it('34. Migration 006: v5 -> v6 transactional upgrade ensures parties active unique index, drops tickets business key, and creates migration_party_resolutions table', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig006_upgrade.sqlite');
    const db = setupV5Db(testDbPath);
    try {
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(5);

      // Execute migration 006 specifically
      MIGRATIONS[5].up(db);
      db.prepare("INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (6, ?, datetime('now'), ?)")
        .run(MIGRATIONS[5].name, getMigrationChecksum(MIGRATIONS[5]));
      db.pragma('user_version = 6');
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(6);

      // Verify migration_party_resolutions table exists
      const tableCheck = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='migration_party_resolutions'").get();
      expect(tableCheck.c).toBe(1);

      // Verify parties table and idx_parties_active_unique index
      const partyIdxCheck = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='index' AND name='idx_parties_active_unique'").get();
      expect(partyIdxCheck.c).toBe(1);

      // Verify idx_tickets_business_key was dropped
      const ticketOldIdxCheck = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='index' AND name='idx_tickets_business_key'").get();
      expect(ticketOldIdxCheck.c).toBe(0);

      // Verify idx_tickets_party_record exists
      const ticketNewIdxCheck = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='index' AND name='idx_tickets_party_record'").get();
      expect(ticketNewIdxCheck.c).toBe(1);
    } finally {
      db.close();
    }
  });

  // =========================================================================
  // 35-37. MANDATORY ACTIVE-PARTY HISTORICAL COLLISION & REUSE TESTS (Sec 9, 10, 11)
  // =========================================================================

  // Test 9: Active-Active Collision Quarantine Test
  it('35. Mandatory Test 9: Simultaneous Active Party Collision Quarantine (Zero Auto-Close)', () => {
    const compTest = 'comp_simul_active';
    const jsonPath = createSampleLegacyJson(compTest, {
      printedPartyHistory: [
        {
          id: 'rec_party_2_alpha',
          partyNumber: '2',
          modelId: 'model_101',
          pattaCount: 8,
          ishSoni: 520,
          printedAt: '2026-03-01T09:00:00.000Z',
          isClosed: false,
          closedAt: null
        },
        {
          id: 'rec_party_2_beta',
          partyNumber: '2',
          modelId: 'model_101',
          pattaCount: 7,
          ishSoni: 721,
          printedAt: '2026-03-03T10:00:00.000Z',
          isClosed: false,
          closedAt: null
        }
      ],
      submittedTickets: []
    });

    const sourceRawBefore = fs.readFileSync(jsonPath, 'utf8');
    const sourceShaBefore = crypto.createHash('sha256').update(sourceRawBefore).digest('hex');

    // Run 1: initial migration
    const res1 = migrator.migrateLegacyData(tempUserDataDir, compTest, { explicitSourcePath: jsonPath });

    // 1. Both parties enter quarantine (quarantine count >= 2)
    expect(res1.counts.quarantine).toBe(2);
    // 2. Cutover blocked
    expect(res1.migrationReady).toBe(false);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, compTest);
    try {
      // 3. Neither party auto-closed into parties table
      const canonicalParties = db.prepare('SELECT * FROM parties WHERE party_number = ?').all('2');
      expect(canonicalParties.length).toBe(0);

      // 4. Collision enters quarantine with original semantic state preserved
      const quarParties = db.prepare('SELECT * FROM migration_quarantine_parties WHERE original_party_number = ? ORDER BY printed_at ASC').all('2');
      expect(quarParties.length).toBe(2);

      const quarA = quarParties[0];
      const quarB = quarParties[1];

      expect(quarA.legacy_record_id).toBe('rec_party_2_alpha');
      expect(quarA.original_is_closed).toBe(0);
      expect(quarA.original_closed_at).toBeNull();
      expect(quarA.collision_type).toBe('LEGACY_SIMULTANEOUS_ACTIVE_COLLISION');
      expect(quarA.resolution_status).toBe('PENDING_REVIEW');

      expect(quarB.legacy_record_id).toBe('rec_party_2_beta');
      expect(quarB.original_is_closed).toBe(0);
      expect(quarB.original_closed_at).toBeNull();
      expect(quarB.collision_type).toBe('LEGACY_SIMULTANEOUS_ACTIVE_COLLISION');
      expect(quarB.resolution_status).toBe('PENDING_REVIEW');

      // 5. Source record not mutated
      const sourceRawAfter = fs.readFileSync(jsonPath, 'utf8');
      expect(sourceRawAfter).toBe(sourceRawBefore);
      const sourceShaAfter = crypto.createHash('sha256').update(sourceRawAfter).digest('hex');
      expect(sourceShaAfter).toBe(sourceShaBefore);

      // 6. Deterministic re-run produces same quarantine IDs
      const expectedQuarIdA = identifierPolicy.getQuarantineId('party', compTest, 'rec_party_2_alpha');
      const expectedQuarIdB = identifierPolicy.getQuarantineId('party', compTest, 'rec_party_2_beta');
      expect(quarA.quarantine_id).toBe(expectedQuarIdA);
      expect(quarB.quarantine_id).toBe(expectedQuarIdB);

      // Rerun verification
      const res2 = migrator.migrateLegacyData(tempUserDataDir, compTest, { explicitSourcePath: jsonPath });
      expect(res2.status).toBe('IDEMPOTENT_ALREADY_MIGRATED');
      expect(res2.counts.quarantine).toBe(2);
      expect(res2.migrationReady).toBe(false);
    } finally {
      databaseManager.closeCompanyDatabase(compTest);
    }
  });

  // Test 10: Closed-Then-Reuse Migration Test
  it('36. Closed-Then-Reuse Migration purges closed history and retains the active party', () => {
    const compTest = 'comp_reuse_test';
    const jsonPath = createSampleLegacyJson(compTest, {
      printedPartyHistory: [
        {
          id: 'party_uuid_2_closed',
          partyNumber: '2',
          modelId: 'model_101',
          pattaCount: 10,
          ishSoni: 500,
          printedAt: '2026-03-01T08:00:00.000Z',
          isClosed: true,
          closedAt: '2026-03-01T18:00:00.000Z'
        },
        {
          id: 'party_uuid_2_active',
          partyNumber: '2',
          modelId: 'model_101',
          pattaCount: 12,
          ishSoni: 600,
          printedAt: '2026-03-02T09:00:00.000Z',
          isClosed: false,
          closedAt: null
        }
      ],
      submittedTickets: []
    });

    const res = migrator.migrateLegacyData(tempUserDataDir, compTest, { explicitSourcePath: jsonPath });
    expect(res.success).toBe(true);
    expect(res.counts.quarantine).toBe(0); // Zero quarantine for legitimate sequential reuse
    expect(res.counts.parties).toBe(2);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, compTest);
    try {
      const rows = db.prepare('SELECT * FROM parties WHERE party_number = ? ORDER BY printed_at ASC').all('2');
      expect(rows.length).toBe(1);
      expect(rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(rows[0].party_number).toBe('2');
      expect(rows[0].status).toBe('ACTIVE');
      expect(rows[0].is_closed).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM parties WHERE id = 'party_uuid_2_closed'").get().count).toBe(0);

      // Zero collision on active unique index
      const activeRows = db.prepare("SELECT * FROM parties WHERE party_number = '2' AND status != 'CLOSED'").all();
      expect(activeRows.length).toBe(1);
      expect(activeRows[0].id).toBe(rows[0].id);
    } finally {
      databaseManager.closeCompanyDatabase(compTest);
    }
  });

  // Test 11: Operator-Resolution Test
  it('37. Mandatory Test 11: Operator Resolution of Quarantined Active Collision', () => {
    const compTest = 'comp_operator_res';
    const jsonPath = createSampleLegacyJson(compTest, {
      printedPartyHistory: [
        {
          id: 'rec_party_2_earlier',
          partyNumber: '2',
          modelId: 'model_101',
          pattaCount: 5,
          ishSoni: 250,
          printedAt: '2026-03-01T09:00:00.000Z',
          isClosed: false,
          closedAt: null
        },
        {
          id: 'rec_party_2_later',
          partyNumber: '2',
          modelId: 'model_101',
          pattaCount: 6,
          ishSoni: 300,
          printedAt: '2026-03-03T10:00:00.000Z',
          isClosed: false,
          closedAt: null
        }
      ],
      submittedTickets: []
    });

    const sourceRaw = fs.readFileSync(jsonPath, 'utf8');
    const sourceSha256 = crypto.createHash('sha256').update(sourceRaw).digest('hex');

    // 1. Initial migration quarantines both parties
    const res1 = migrator.migrateLegacyData(tempUserDataDir, compTest, { explicitSourcePath: jsonPath });
    expect(res1.counts.quarantine).toBe(2);
    expect(res1.migrationReady).toBe(false);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, compTest);
    try {
      const quarIdEarlier = identifierPolicy.getQuarantineId('party', compTest, 'rec_party_2_earlier');

      // 2. Apply explicit operator resolution: CONFIRM_HISTORICALLY_CLOSED on earlier party
      const decidedAt = '2026-03-10T14:30:00.000Z';
      const resolutionResult = migrator.applyPartyQuarantineResolution(db, {
        quarantineId: quarIdEarlier,
        companyId: compTest,
        partyId: 'rec_party_2_earlier',
        decision: 'CONFIRM_HISTORICALLY_CLOSED',
        operatorId: 'operator_senior_auditor',
        decidedAt,
        sourceSnapshotHash: sourceSha256,
        reason: 'Verified cutting slip #42 was sewn and completed; legacy app failed to record close event',
        originalIsClosed: 0,
        originalClosedAt: null
      });

      expect(resolutionResult.success).toBe(true);
      expect(resolutionResult.audit).toBeDefined();
      expect(resolutionResult.audit.resolutionProvenance).toBe('OPERATOR_MIGRATION_DECISION');

      // 3. Decision audit metadata persisted in migration_party_resolutions
      const auditRow = db.prepare('SELECT * FROM migration_party_resolutions WHERE party_id = ?').get('rec_party_2_earlier');
      expect(auditRow).toBeDefined();
      expect(auditRow.decision).toBe('CONFIRM_HISTORICALLY_CLOSED');
      expect(auditRow.operator_id).toBe('operator_senior_auditor');
      expect(auditRow.decided_at).toBe(decidedAt);
      expect(auditRow.source_snapshot_hash).toBe(sourceSha256);
      expect(auditRow.original_is_closed).toBe(0);
      expect(auditRow.original_closed_at).toBeNull();
      expect(auditRow.resolution_provenance).toBe('OPERATOR_MIGRATION_DECISION');

      // 4. Source snapshot remains unchanged
      const sourceRawAfter = fs.readFileSync(jsonPath, 'utf8');
      expect(sourceRawAfter).toBe(sourceRaw);

      // 5. Canonical parties table has resolved party imported as historical CLOSED with NULL closed_at
      const resolvedParty = db.prepare('SELECT * FROM parties WHERE id = ?').get('rec_party_2_earlier');
      expect(resolvedParty).toBeDefined();
      expect(resolvedParty.status).toBe('CLOSED');
      expect(resolvedParty.is_closed).toBe(1);
      // Historical closed_at kept null (DO NOT fabricate historical date!)
      expect(resolvedParty.closed_at).toBeNull();
      expect(resolvedParty.provenance).toBe('OPERATOR_MIGRATION_DECISION');

      // 6. Other party is imported as ACTIVE
      const activeParty = db.prepare('SELECT * FROM parties WHERE id = ?').get('rec_party_2_later');
      expect(activeParty).toBeDefined();
      expect(activeParty.status).toBe('ACTIVE');
      expect(activeParty.is_closed).toBe(0);

      // 7. Active uniqueness satisfied in DB
      const activeParties = db.prepare("SELECT * FROM parties WHERE party_number = '2' AND status != 'CLOSED'").all();
      expect(activeParties.length).toBe(1);
      expect(activeParties[0].id).toBe('rec_party_2_later');

      // 8. Quarantine item becomes explicitly RESOLVED
      const quarRowEarlier = db.prepare('SELECT * FROM migration_quarantine_parties WHERE legacy_record_id = ?').get('rec_party_2_earlier');
      expect(quarRowEarlier.resolution_status).toBe('RESOLVED');
      expect(quarRowEarlier.resolution_decision).toBe('CONFIRM_HISTORICALLY_CLOSED');
      expect(quarRowEarlier.resolution_operator_id).toBe('operator_senior_auditor');
    } finally {
      databaseManager.closeCompanyDatabase(compTest);
    }
  });

  // =========================================================================
  // 38-39. MIGRATION 007 & GRANDFATHERED PARTY #2 EXCEPTION TESTS
  // =========================================================================

  function setupV6Db(dbPath: string) {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    for (let i = 0; i < 6; i++) {
      MIGRATIONS[i].up(db);
      db.prepare("INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (?, ?, datetime('now'), ?)")
        .run(MIGRATIONS[i].version, MIGRATIONS[i].name, getMigrationChecksum(MIGRATIONS[i]));
      db.pragma(`user_version = ${MIGRATIONS[i].version}`);
    }
    expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(6);
    return db;
  }

  it('38. Migration 007: v6 -> v7 transactional upgrade drops idx_parties_active_unique, creates legacy_party_collision_exceptions, and installs uniqueness triggers', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig007_upgrade.sqlite');
    const db = setupV6Db(testDbPath);
    try {
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(6);

      const res = migrationRunner.applyMigrations(db);
      expect(res.previousVersion).toBe(6);
      expect(res.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(res.appliedCount).toBe(CURRENT_SCHEMA_VERSION - res.previousVersion);
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(CURRENT_SCHEMA_VERSION);

      // Verify idx_parties_active_unique index was dropped
      const oldIdxCheck = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='index' AND name='idx_parties_active_unique'").get();
      expect(oldIdxCheck.c).toBe(0);

      // Verify legacy_party_collision_exceptions table exists
      const tableCheck = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='legacy_party_collision_exceptions'").get();
      expect(tableCheck.c).toBe(1);

      // Verify triggers exist
       const insertTrg = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='trigger' AND name='trg_parties_active_unique_insert'").get();
       expect(insertTrg.c).toBe(0);
       const updateTrg = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='trigger' AND name='trg_parties_active_unique_update'").get();
       expect(updateTrg.c).toBe(0);
       const exactInsertTrg = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='trigger' AND name='trg_parties_exact_party_2_insert'").get();
       expect(exactInsertTrg.c).toBe(1);
       const exactUpdateTrg = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='trigger' AND name='trg_parties_exact_party_2_update'").get();
       expect(exactUpdateTrg.c).toBe(1);

      // Verify normal active uniqueness enforcement
      db.prepare(`
        INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, model_name, patta_count, ish_soni, printed_at, status, is_closed, created_at, updated_at)
        VALUES ('p_first_5', 'comp_test', '5', '5', 'm1', 'Model 1', 10, 100, datetime('now'), 'ACTIVE', 0, datetime('now'), datetime('now'))
      `).run();

      // Duplicate active party 5 must throw constraint violation
      expect(() => {
        db.prepare(`
          INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, model_name, patta_count, ish_soni, printed_at, status, is_closed, created_at, updated_at)
          VALUES ('p_second_5', 'comp_test', '5', '5', 'm1', 'Model 1', 10, 100, datetime('now'), 'ACTIVE', 0, datetime('now'), datetime('now'))
        `).run();
      }).toThrow(/ACTIVE_PARTY_EXISTS/);
    } finally {
      db.close();
    }
  });

  it('39. Grandfathered Party #2 Active Collision Migration (comp_novda authorized UUIDs)', () => {
    const compTest = 'comp_novda';
    const jsonPath = createSampleLegacyJson(compTest, {
      printedPartyHistory: [
        {
          id: 'rec_1788774889449_vrbkv',
          partyNumber: '2',
          modelId: 'model_101',
          pattaCount: 8,
          ishSoni: 520,
          printedAt: '2026-03-01T09:00:00.000Z',
          isClosed: false,
          closedAt: null
        },
        {
          id: 'rec_1788930871307_cg1iv',
          partyNumber: '2',
          modelId: 'model_101',
          pattaCount: 7,
          ishSoni: 721,
          printedAt: '2026-03-03T10:00:00.000Z',
          isClosed: false,
          closedAt: null
        }
      ],
      submittedTickets: []
    });

    const res = migrator.migrateLegacyData(tempUserDataDir, compTest, {
      explicitSourcePath: jsonPath,
      partyResolutions: [
        { partyId: 'rec_1788774889449_vrbkv', decision: 'GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED' },
        { partyId: 'rec_1788930871307_cg1iv', decision: 'GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED' }
      ]
    });
    expect(res.success).toBe(true);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, compTest);
    try {
      // 1. Both grandfathered parties imported as ACTIVE
      const activeParties = db.prepare("SELECT * FROM parties WHERE party_number = '2' AND status = 'ACTIVE' ORDER BY printed_at ASC").all();
      expect(activeParties.length).toBe(2);
      expect(activeParties[0].id).toBe('rec_1788774889449_vrbkv');
      expect(activeParties[1].id).toBe('rec_1788930871307_cg1iv');
      expect(activeParties[0].closed_at).toBeNull();
      expect(activeParties[1].closed_at).toBeNull();

      // 2. Grandfather exception table populated
      const exceptions = db.prepare('SELECT * FROM legacy_party_collision_exceptions WHERE party_number = ?').all('2');
      expect(exceptions.length).toBe(2);
      expect(exceptions[0].collision_group_id).toBe('col_group_comp_novda_party_2');
      expect(exceptions[1].collision_group_id).toBe('col_group_comp_novda_party_2');
      expect(exceptions[0].status).toBe('ACTIVE');
      expect(exceptions[1].status).toBe('ACTIVE');

      // 3. Quarantine table has both marked as RESOLVED with owner decision
      const quarRows = db.prepare('SELECT * FROM migration_quarantine_parties WHERE original_party_number = ?').all('2');
      expect(quarRows.length).toBe(2);
      expect(quarRows[0].resolution_status).toBe('RESOLVED');
      expect(quarRows[0].resolution_decision).toBe('GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED');
      expect(quarRows[1].resolution_status).toBe('RESOLVED');
      expect(quarRows[1].resolution_decision).toBe('GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED');

      // 4. Zero UNRESOLVED critical quarantine
      const unresolvedQuar = db.prepare("SELECT count(*) as c FROM migration_quarantine_parties WHERE resolution_status != 'RESOLVED'").get();
      expect(unresolvedQuar.c).toBe(0);

      // 5. Creating a 3rd Party #2 is REJECTED while grandfathered parties are active
      expect(() => {
        db.prepare(`
          INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, model_name, patta_count, ish_soni, printed_at, status, is_closed, created_at, updated_at)
          VALUES ('rec_third_party_2', 'comp_novda', '2', '2', 'model_101', 'Model 1', 5, 200, datetime('now'), 'ACTIVE', 0, datetime('now'), datetime('now'))
        `).run();
      }).toThrow(/ACTIVE_PARTY_EXISTS/);

      // 6. Close Party A: new Party #2 is STILL REJECTED because Party B is still active
      db.prepare("UPDATE parties SET status = 'CLOSED', is_closed = 1, closed_at = datetime('now') WHERE id = 'rec_1788774889449_vrbkv'").run();
      db.prepare("UPDATE legacy_party_collision_exceptions SET status = 'CLOSED' WHERE party_id = 'rec_1788774889449_vrbkv'").run();

      expect(() => {
        db.prepare(`
          INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, model_name, patta_count, ish_soni, printed_at, status, is_closed, created_at, updated_at)
          VALUES ('rec_third_party_2', 'comp_novda', '2', '2', 'model_101', 'Model 1', 5, 200, datetime('now'), 'ACTIVE', 0, datetime('now'), datetime('now'))
        `).run();
      }).toThrow(/ACTIVE_PARTY_EXISTS/);

      // 7. Close Party B: now new Party #2 is ALLOWED
      db.prepare("UPDATE parties SET status = 'CLOSED', is_closed = 1, closed_at = datetime('now') WHERE id = 'rec_1788930871307_cg1iv'").run();
      db.prepare("UPDATE legacy_party_collision_exceptions SET status = 'CLOSED' WHERE party_id = 'rec_1788930871307_cg1iv'").run();

      db.prepare(`
        INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, model_name, patta_count, ish_soni, printed_at, status, is_closed, created_at, updated_at)
        VALUES ('rec_third_party_2', 'comp_novda', '2', '2', 'model_101', 'Model 1', 5, 200, datetime('now'), 'ACTIVE', 0, datetime('now'), datetime('now'))
      `).run();

      const newParty = db.prepare("SELECT * FROM parties WHERE id = 'rec_third_party_2'").get();
      expect(newParty).toBeDefined();
      expect(newParty.party_number).toBe('2');
      expect(newParty.status).toBe('ACTIVE');
    } finally {
      databaseManager.closeCompanyDatabase(compTest);
    }
  });

  it('40. Migration 008: creates migration_reconciliation_resolutions table and immutability triggers', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig008_audit.sqlite');
    const Database = require('better-sqlite3');
    const db = new Database(testDbPath);
    try {
      migrationRunner.applyMigrations(db);
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(CURRENT_SCHEMA_VERSION);

      const tableCheck = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='migration_reconciliation_resolutions'").get();
      expect(tableCheck.c).toBe(1);

      const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r: any) => r.name);
      expect(triggers).toContain('trg_reconciliation_resolutions_immutable_update');
      expect(triggers).toContain('trg_reconciliation_resolutions_immutable_delete');
    } finally {
      db.close();
    }
  });

  it('41. Migration 009 upgrades a valid v8 ticket and preserves its same-company Party FK', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig009_valid.sqlite');
    const Database = require('better-sqlite3');
    const db = new Database(testDbPath);
    try {
      for (let i = 0; i < 8; i++) {
        MIGRATIONS[i].up(db);
        db.prepare('INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (?, ?, datetime(\'now\'), ?)')
          .run(MIGRATIONS[i].version, MIGRATIONS[i].name, getMigrationChecksum(MIGRATIONS[i]));
        db.pragma(`user_version = ${MIGRATIONS[i].version}`);
      }
      db.prepare(`INSERT INTO models (id, company_id, name, operations_json, patta_ops_order_json, legacy_hisob_quantities_json, created_at, updated_at, provenance) VALUES ('m_v8', 'comp_v8', 'Model', '[]', '[]', '{}', datetime('now'), datetime('now'), 'TEST')`).run();
      db.prepare(`INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, patta_count, ish_soni, sizes_json, status, is_closed, created_at, updated_at) VALUES ('p_v8', 'comp_v8', '7', '7', 'm_v8', 0, 0, '{}', 'ACTIVE', 0, datetime('now'), datetime('now'))`).run();
      const ticketId = '8a735c00-912b-4b2f-8f01-4f8647b4a001';
      db.prepare(`INSERT INTO tickets (id, company_id, model_id, party_number, party_record_id, patta_number, qty, submitted_at, created_at) VALUES (?, 'comp_v8', 'm_v8', '7', 'p_v8', 1, 10, datetime('now'), datetime('now'))`).run(ticketId);

      const result = migrationRunner.applyMigrations(db, { targetVersion: 9 });
      expect(result.previousVersion).toBe(8);
      expect(result.currentVersion).toBe(9);
      expect(result.appliedCount).toBe(1);
      expect(db.prepare('SELECT party_record_id FROM tickets WHERE id = ?').get(ticketId).party_record_id).toBe('p_v8');
      expect(db.pragma('foreign_key_check')).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('42. Migration 009 rejects invalid v8 ticket Party links without advancing schema version', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig009_invalid.sqlite');
    const Database = require('better-sqlite3');
    const db = new Database(testDbPath);
    try {
      for (let i = 0; i < 8; i++) {
        MIGRATIONS[i].up(db);
        db.prepare('INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (?, ?, datetime(\'now\'), ?)')
          .run(MIGRATIONS[i].version, MIGRATIONS[i].name, getMigrationChecksum(MIGRATIONS[i]));
        db.pragma(`user_version = ${MIGRATIONS[i].version}`);
      }
      db.prepare(`INSERT INTO models (id, company_id, name, operations_json, patta_ops_order_json, legacy_hisob_quantities_json, created_at, updated_at, provenance) VALUES ('m_v8_bad', 'comp_v8', 'Model', '[]', '[]', '{}', datetime('now'), datetime('now'), 'TEST')`).run();
      db.prepare(`INSERT INTO tickets (id, company_id, model_id, party_number, party_record_id, patta_number, qty, submitted_at, created_at) VALUES ('not-a-uuid', 'comp_v8', 'm_v8_bad', '7', NULL, 1, 10, datetime('now'), datetime('now'))`).run();

      expect(() => migrationRunner.applyMigrations(db)).toThrow(/TICKET_IDENTITY_MIGRATION_BLOCKED/);
      expect(migrationRunner.getMetaTableVersion(db)).toBe(8);
      expect(migrationRunner.getPragmaUserVersion(db)).toBe(8);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tickets_v9'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  function setupV9Db(dbPath: string) {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    for (let i = 0; i < 9; i++) {
      MIGRATIONS[i].up(db);
      db.prepare("INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (?, ?, datetime('now'), ?)")
        .run(MIGRATIONS[i].version, MIGRATIONS[i].name, getMigrationChecksum(MIGRATIONS[i]));
      db.pragma(`user_version = ${MIGRATIONS[i].version}`);
    }
    expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(9);
    return db;
  }

  it('43. Migration 012 preserves an explicitly persisted collision group without ID-specific policy', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig010_exact_pair.sqlite');
      const db = setupV9Db(testDbPath);
      try {
      for (const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'parties'").all()) {
        db.exec(`DROP TRIGGER IF EXISTS "${trigger.name}"`);
      }
      const now = new Date().toISOString();
      const insertException = db.prepare(`
        INSERT INTO legacy_party_collision_exceptions (
          exception_id, company_id, party_number, party_id, collision_group_id,
          approved_by, approved_at, reason, status
        ) VALUES (?, 'comp_v9', '2', ?, 'historical-group', 'operator', ?, 'provenance', 'ACTIVE')
      `);
      insertException.run('exc-v9-a', 'rec_1788774889449_vrbkv', now);
      insertException.run('exc-v9-b', 'rec_1788930871307_cg1iv', now);

      const insertParty = db.prepare(`
        INSERT INTO parties (
          id, company_id, party_number, physical_party_number, model_id,
          status, is_closed, created_at, updated_at
        ) VALUES (?, 'comp_v9', '2', '2', 'model-v9', 'ACTIVE', 0, ?, ?)
      `);
      insertParty.run('rec_1788774889449_vrbkv', now, now);
      insertParty.run('rec_1788930871307_cg1iv', now, now);

      for (const migration of MIGRATIONS.slice(9, 11)) {
        const transaction = db.transaction(() => {
          migration.up(db);
          db.prepare('INSERT INTO schema_meta (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)')
            .run(migration.version, migration.name, new Date().toISOString(), getMigrationChecksum(migration));
          db.pragma(`user_version = ${migration.version}`);
        });
        transaction.immediate();
      }
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(11);
      expect(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_parties_exact_party_2_insert'").get().c).toBe(1);
      const result = migrationRunner.applyMigrations(db);
      expect(result.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(migrationRunner.verifySchemaVersionConsistency(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(db.prepare("SELECT count(*) AS c FROM parties WHERE company_id = 'comp_v9' AND party_number = '2'").get().c).toBe(2);
      const insertThird = db.prepare(`
        INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status, is_closed, created_at, updated_at)
        VALUES ('third', 'comp_v9', '2', '2', 'model-v9', 'ACTIVE', 0, ?, ?)
      `);
      expect(() => insertThird.run(new Date().toISOString(), new Date().toISOString())).toThrow(/ACTIVE_PARTY_EXISTS/);
    } finally {
      db.close();
    }
  });

  it('44. Migration 010 rejects more than two pre-existing active collisions', () => {
    const testDbPath = path.join(tempUserDataDir, 'mig010_rollback.sqlite');
    const db = setupV9Db(testDbPath);
    try {
      for (const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'parties'").all()) {
        db.exec(`DROP TRIGGER IF EXISTS "${trigger.name}"`);
      }
      const now = new Date().toISOString();
      const insertException = db.prepare(`
        INSERT INTO legacy_party_collision_exceptions (
          exception_id, company_id, party_number, party_id, collision_group_id,
          approved_by, approved_at, reason, status
        ) VALUES (?, 'comp_v9_bad', '12', ?, 'fake-group', 'fake-operator', ?, 'fake claim', 'ACTIVE')
      `);
      insertException.run('exc-v9-fake-a', 'fake-v9-a', now);
      insertException.run('exc-v9-fake-b', 'fake-v9-b', now);
      insertException.run('exc-v9-fake-c', 'fake-v9-c', now);

      const insertParty = db.prepare(`
        INSERT INTO parties (
          id, company_id, party_number, physical_party_number, model_id,
          status, is_closed, created_at, updated_at
        ) VALUES (?, 'comp_v9_bad', '12', '12', 'model-v9', 'ACTIVE', 0, ?, ?)
      `);
      insertParty.run('fake-v9-a', now, now);
      insertParty.run('fake-v9-b', now, now);
      insertParty.run('fake-v9-c', now, now);

      expect(() => migrationRunner.applyMigrations(db)).toThrowError(
        expect.objectContaining({ code: 'ACTIVE_PARTY_MIGRATION_BLOCKED' })
      );
      expect(migrationRunner.getMetaTableVersion(db)).toBe(9);
      expect(migrationRunner.getPragmaUserVersion(db)).toBe(9);
      expect(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_parties_active_unique_insert'").get().c).toBe(0);
      expect(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_parties_exact_party_2_insert'").get().c).toBe(0);
      expect(db.prepare("SELECT count(*) AS c FROM parties WHERE company_id = 'comp_v9_bad' AND party_number = '12'").get().c).toBe(3);
    } finally {
      db.close();
    }
  });
});
