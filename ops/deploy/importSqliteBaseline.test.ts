import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

const {
  IMPORT_TABLES,
  parseArgs,
  inspectSqliteSource,
  buildInsert
} = require('./importSqliteBaseline.cjs');

let tempDirectory = '';

function createSource(schemaVersion = 15) {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-sqlite-import-'));
  const sourcePath = path.join(tempDirectory, 'source.sqlite');
  const db = new DatabaseSync(sourcePath);
  db.exec('CREATE TABLE schema_meta (version INTEGER NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  db.prepare('INSERT INTO schema_meta VALUES (?, ?, ?, ?)').run(schemaVersion, 'fixture', '2026-10-01T00:00:00.000Z', '0'.repeat(64));
  for (const table of IMPORT_TABLES) {
    const extraColumns: Record<string, string> = {
      models: ', legacy_hisob_quantities_json TEXT',
      parties: ', archived_patta_numbers_json TEXT',
      tickets: ', raw_legacy_json TEXT',
      worker_adjustments: ', description TEXT, status TEXT'
    };
    db.exec(`CREATE TABLE "${table}" (company_id TEXT NOT NULL, id TEXT, value TEXT${extraColumns[table] || ''})`);
  }
  db.exec('CREATE TABLE local_outbox (company_id TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL)');
  for (const table of ['migration_quarantine_parties', 'migration_quarantine_tickets', 'migration_quarantine_ticket_entries', 'migration_runs', 'local_party_leases']) {
    db.exec(`CREATE TABLE "${table}" (company_id TEXT NOT NULL, id TEXT)`);
  }
  db.exec('CREATE TABLE local_ticket_forms (company_id TEXT NOT NULL, model_id TEXT, form_json TEXT)');
  db.prepare('INSERT INTO models(company_id, id, value) VALUES (?, ?, ?)').run('comp_novda', 'model-a', 'model');
  db.prepare('INSERT INTO workers(company_id, id, value) VALUES (?, ?, ?)').run('comp_novda', '1', 'worker');
  db.prepare('INSERT INTO local_outbox(company_id, status, payload_json) VALUES (?, ?, ?)')
    .run('comp_novda', 'DEAD_LETTER', '{"must":"stay local"}');
  db.close();
  return sourcePath;
}

afterEach(() => {
  if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
  tempDirectory = '';
});

describe('SQLite baseline import guardrails', () => {
  it('requires an absolute source and an exact hash before apply', () => {
    expect(() => parseArgs(['--source', 'relative.sqlite', '--company-id', 'comp_novda']))
      .toThrow('ABSOLUTE_SQLITE_SOURCE_REQUIRED');
    expect(() => parseArgs(['--apply', '--source', path.resolve('source.sqlite'), '--company-id', 'comp_novda']))
      .toThrow('EXPECTED_SOURCE_SHA256_REQUIRED_FOR_APPLY');
    expect(() => parseArgs(['--source', path.resolve('source.sqlite'), '--company-id', 'other_company']))
      .not.toThrow();
  });

  it('plans only canonical business tables and leaves the outbox untouched', () => {
    const sourcePath = createSource();
    const plan = inspectSqliteSource(sourcePath, 'comp_novda');
    expect(plan.schemaVersion).toBe(15);
    expect(plan.tableCounts.models).toBe(1);
    expect(plan.tableCounts.workers).toBe(1);
    expect(plan.tableCounts.local_outbox).toBeUndefined();
    expect(IMPORT_TABLES).not.toContain('local_outbox');
    expect(plan.sourceOnlyCounts.localTicketForms).toBe(0);
    expect(plan.localOnlyCounts.local_party_leases).toBe(0);
  });

  it('rejects a source with another companyâ€™s rows instead of mixing tenants', () => {
    const sourcePath = createSource();
    const db = new DatabaseSync(sourcePath);
    db.prepare('INSERT INTO workers(company_id, id, value) VALUES (?, ?, ?)').run('other_company', '2', 'foreign');
    db.close();
    expect(() => inspectSqliteSource(sourcePath, 'comp_novda')).toThrow('SQLITE_COMPANY_SCOPE_MISMATCH:workers');
  });

  it('refuses to discard a nonempty source-only business field', () => {
    const sourcePath = createSource();
    const db = new DatabaseSync(sourcePath);
    db.prepare('INSERT INTO worker_adjustments(company_id, id, description, status) VALUES (?, ?, ?, ?)')
      .run('comp_novda', 'adjustment-a', 'owner note', 'POSTED');
    db.close();
    expect(() => inspectSqliteSource(sourcePath, 'comp_novda'))
      .toThrow('SQLITE_SOURCE_FIELDS_NOT_MAPPED:nonemptyWorkerAdjustmentDescriptions');
  });

  it('rejects an unqualified SQLite schema version', () => {
    expect(() => inspectSqliteSource(createSource(16), 'comp_novda'))
      .toThrow('SQLITE_SCHEMA_VERSION_UNSUPPORTED:16');
  });

  it('maps the required PostgreSQL worker-adjustment source reference and booleans', () => {
    const built = buildInsert('worker_adjustments', {
      id: 'adjustment-1', company_id: 'comp_novda', worker_id: 1, is_archived: 0
    }, [
      { column_name: 'id', is_nullable: 'NO', column_default: null, is_generated: 'NEVER', data_type: 'text' },
      { column_name: 'company_id', is_nullable: 'NO', column_default: null, is_generated: 'NEVER', data_type: 'text' },
      { column_name: 'worker_id', is_nullable: 'NO', column_default: null, is_generated: 'NEVER', data_type: 'integer' },
      { column_name: 'source_id', is_nullable: 'NO', column_default: null, is_generated: 'NEVER', data_type: 'text' },
      { column_name: 'is_archived', is_nullable: 'NO', column_default: null, is_generated: 'NEVER', data_type: 'boolean' }
    ]);
    expect(built.sql).toContain('"source_id"');
    expect(built.values).toEqual(['adjustment-1', 'comp_novda', 1, false, 'adjustment-1']);
  });
});
