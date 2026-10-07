'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');
const { validatePostgresDsn } = require('../../apps/server/infrastructure/connectionConfig.cjs');

const EXPECTED_SQLITE_SCHEMA_VERSION = 15;
const IMPORT_TABLES = Object.freeze([
  'models',
  'workers',
  'periods',
  'legacy_party_collision_exceptions',
  'model_id_aliases',
  'party_id_aliases',
  'company_batch_settings',
  'company_patta_sequences',
  'patta_batch_settings',
  'parties',
  'protected_party_patta_ranges',
  'tickets',
  'ticket_entries',
  'worker_adjustments',
  'production_adjustments',
  'period_archives',
  'migration_party_resolutions',
  'migration_reconciliation_candidates',
  'migration_reconciliation_resolutions'
]);
const LOCAL_ONLY_EMPTY_TABLES = Object.freeze([
  'migration_quarantine_parties',
  'migration_quarantine_tickets',
  'migration_quarantine_ticket_entries',
  'migration_runs',
  'local_party_leases'
]);

function parseArgs(argv) {
  const args = { apply: false, source: null, companyId: null, expectedSha256: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply') args.apply = true;
    else if (token === '--source') args.source = argv[++index] || null;
    else if (token === '--company-id') args.companyId = argv[++index] || null;
    else if (token === '--expected-sha256') args.expectedSha256 = argv[++index] || null;
    else throw new Error(`UNKNOWN_ARGUMENT:${token}`);
  }
  if (!args.source || !path.isAbsolute(args.source)) throw new Error('ABSOLUTE_SQLITE_SOURCE_REQUIRED');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(args.companyId || '')) throw new Error('COMPANY_ID_INVALID');
  if (args.apply && !/^[a-f0-9]{64}$/.test(args.expectedSha256 || '')) {
    throw new Error('EXPECTED_SOURCE_SHA256_REQUIRED_FOR_APPLY');
  }
  return args;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function inspectSqliteSource(sourcePath, companyId) {
  const raw = fs.readFileSync(sourcePath);
  const sourceSha256 = crypto.createHash('sha256').update(raw).digest('hex');
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error('SQLITE_INTEGRITY_CHECK_FAILED');
    }
    const schemaVersion = Number(db.prepare('SELECT MAX(version) AS version FROM schema_meta').get()?.version);
    if (schemaVersion !== EXPECTED_SQLITE_SCHEMA_VERSION) {
      throw new Error(`SQLITE_SCHEMA_VERSION_UNSUPPORTED:${schemaVersion}`);
    }

    const actualTables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const tableCounts = {};
    const rowsByTable = new Map();
    for (const table of IMPORT_TABLES) {
      if (!actualTables.has(table)) throw new Error(`SQLITE_TABLE_REQUIRED:${table}`);
      const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE company_id = ?`).all(companyId);
      const outOfScope = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE company_id <> ? OR company_id IS NULL`).get(companyId).count;
      if (Number(outOfScope) !== 0) throw new Error(`SQLITE_COMPANY_SCOPE_MISMATCH:${table}`);
      rowsByTable.set(table, rows);
      tableCounts[table] = rows.length;
    }

    const sourceOnlyCounts = {
      nonemptyLegacyModelQuantities: 0,
      nonemptyTicketLegacySnapshots: 0,
      nonemptyPartyArchivedRanges: 0,
      nonemptyWorkerAdjustmentDescriptions: 0,
      nonPostedWorkerAdjustments: 0,
      localTicketForms: actualTables.has('local_ticket_forms')
        ? Number(db.prepare('SELECT COUNT(*) AS count FROM local_ticket_forms WHERE company_id = ?').get(companyId).count)
        : 0
    };
    for (const row of db.prepare(`SELECT legacy_hisob_quantities_json FROM models WHERE company_id = ?`).all(companyId)) {
      if (row.legacy_hisob_quantities_json == null) continue;
      let value;
      try { value = JSON.parse(row.legacy_hisob_quantities_json); } catch { throw new Error('SQLITE_LEGACY_MODEL_QUANTITIES_INVALID'); }
      if (value && typeof value === 'object' && Object.keys(value).length > 0) sourceOnlyCounts.nonemptyLegacyModelQuantities += 1;
    }
    sourceOnlyCounts.nonemptyTicketLegacySnapshots = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM tickets WHERE company_id = ? AND raw_legacy_json IS NOT NULL
    `).get(companyId).count);
    for (const row of db.prepare(`SELECT archived_patta_numbers_json FROM parties WHERE company_id = ?`).all(companyId)) {
      if (row.archived_patta_numbers_json == null) continue;
      let value;
      try { value = JSON.parse(row.archived_patta_numbers_json); } catch { throw new Error('SQLITE_ARCHIVED_PARTY_RANGES_INVALID'); }
      if (Array.isArray(value) ? value.length > 0 : Boolean(value && typeof value === 'object' && Object.keys(value).length > 0)) {
        sourceOnlyCounts.nonemptyPartyArchivedRanges += 1;
      }
    }
    sourceOnlyCounts.nonemptyWorkerAdjustmentDescriptions = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM worker_adjustments
      WHERE company_id = ? AND description IS NOT NULL AND trim(description) <> ''
    `).get(companyId).count);
    sourceOnlyCounts.nonPostedWorkerAdjustments = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM worker_adjustments WHERE company_id = ? AND status <> 'POSTED'
    `).get(companyId).count);
    const unsupportedSourceData = Object.entries(sourceOnlyCounts)
      .filter(([name, count]) => name !== 'localTicketForms' && Number(count) !== 0)
      .map(([name]) => name);
    if (unsupportedSourceData.length) throw new Error(`SQLITE_SOURCE_FIELDS_NOT_MAPPED:${unsupportedSourceData.join(',')}`);

    const localOnlyCounts = {};
    for (const table of LOCAL_ONLY_EMPTY_TABLES) {
      if (!actualTables.has(table)) throw new Error(`SQLITE_TABLE_REQUIRED:${table}`);
      localOnlyCounts[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE company_id = ?`).get(companyId).count);
      if (localOnlyCounts[table] !== 0) throw new Error(`SQLITE_LOCAL_ONLY_DATA_PRESENT:${table}`);
    }

    // Deliberately never query local_outbox; pending/dead-letter delivery state stays local.
    return { sourceSha256, schemaVersion, companyId, tableCounts, sourceOnlyCounts, localOnlyCounts, rowsByTable };
  } finally {
    db.close();
  }
}

function getSafeImportDsn(env = process.env) {
  const value = env.NOVDA_IMPORT_DATABASE_URL;
  const parsed = validatePostgresDsn(value, 'NOVDA_IMPORT_DATABASE_URL');
  if (parsed.pathname !== '/novda_prod' || decodeURIComponent(parsed.username) !== 'novda_migrator') {
    throw new Error('POSTGRES_IMPORT_TARGET_INVALID');
  }
  return value;
}

async function verifyTarget(client, companyId) {
  const result = await client.query(
    "SELECT current_database() AS database, current_setting('server_version_num') AS server_version_num"
  );
  if (result.rows[0]?.database !== 'novda_prod' || !String(result.rows[0]?.server_version_num || '').startsWith('16')) {
    throw new Error('POSTGRES_IMPORT_TARGET_INVALID');
  }
  const migrationRows = await client.query('SELECT version, name FROM schema_migrations WHERE version IN (16, 17, 18, 19, 20) ORDER BY version');
  const expectedMigrations = [
    [16, 'deploy_canonical_ids_global_patta_sequence.sql'],
    [17, 'deploy_production_adjustment_provenance_migration.sql'],
    [18, 'deploy_patta_series_sequence_migration.sql'],
    [19, 'deploy_patta_sequence_runtime_grant_migration.sql'],
    [20, 'deploy_voided_ticket_patta_reuse_migration.sql']
  ];
  if (migrationRows.rows.length !== expectedMigrations.length
    || migrationRows.rows.some((row, index) => row.version !== expectedMigrations[index][0]
      || row.name !== expectedMigrations[index][1])) {
    throw new Error('POSTGRES_IMPORT_MIGRATIONS_REQUIRED');
  }

  const scopedTables = await client.query(`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'company_id'
    GROUP BY table_name ORDER BY table_name
  `);
  const occupied = [];
  for (const { table_name: table } of scopedTables.rows) {
    const count = await client.query(
      `SELECT COUNT(*)::bigint AS count FROM public.${quoteIdentifier(table)} WHERE company_id = $1`,
      [companyId]
    );
    if (BigInt(count.rows[0].count) > 0n) occupied.push(table);
  }
  if (occupied.length) throw new Error(`POSTGRES_COMPANY_NOT_EMPTY:${occupied.join(',')}`);
  return {
    database: result.rows[0].database,
    serverVersion: String(result.rows[0].server_version_num).slice(0, 2),
    companyEmpty: true
  };
}

async function getDestinationColumns(client, table) {
  const result = await client.query(`
    SELECT column_name, is_nullable, column_default, is_generated, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [table]);
  if (!result.rows.length) throw new Error(`POSTGRES_TABLE_REQUIRED:${table}`);
  return result.rows;
}

function buildInsert(table, sourceRow, destinationColumns) {
  const source = { ...sourceRow };
  if (table === 'worker_adjustments') source.source_id = source.id;
  const destinationNames = new Set(destinationColumns.map((column) => column.column_name));
  const columns = Object.keys(source).filter((column) => destinationNames.has(column));
  const mapped = new Set(columns);
  if (table === 'worker_adjustments') mapped.add('source_id');
  const missingRequired = destinationColumns.filter((column) =>
    column.is_nullable === 'NO'
      && column.column_default === null
      && column.is_generated === 'NEVER'
      && !mapped.has(column.column_name)
  );
  if (missingRequired.length) {
    throw new Error(`POSTGRES_REQUIRED_COLUMN_UNMAPPED:${table}:${missingRequired.map((column) => column.column_name).join(',')}`);
  }
  const values = columns.map((column) => {
    const value = source[column];
    const destination = destinationColumns.find((candidate) => candidate.column_name === column);
    return destination.data_type === 'boolean' && value !== null ? Boolean(Number(value)) : value;
  });
  if (table === 'worker_adjustments') {
    const index = columns.indexOf('source_id');
    values[index] = source.id;
  }
  const sql = `INSERT INTO public.${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`;
  return { sql, values };
}

async function importSqliteBaseline(args, env = process.env) {
  const snapshot = inspectSqliteSource(args.source, args.companyId);
  if (args.apply && snapshot.sourceSha256 !== args.expectedSha256) {
    throw new Error('SOURCE_SHA256_MISMATCH');
  }
  const client = new Client({ connectionString: getSafeImportDsn(env) });
  await client.connect();
  let transactionStarted = false;
  try {
    await client.query(args.apply ? 'BEGIN' : 'BEGIN READ ONLY');
    transactionStarted = true;
    if (args.apply) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('novda:sqlite-baseline-import:' || $1, 0))", [args.companyId]);
    }
    const target = await verifyTarget(client, args.companyId);
    if (!args.apply) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return {
        mode: 'DRY_RUN', sourceSha256: snapshot.sourceSha256, schemaVersion: snapshot.schemaVersion,
        companyId: snapshot.companyId, target, tableCounts: snapshot.tableCounts,
        sourceOnlyCounts: snapshot.sourceOnlyCounts, localOnlyCounts: snapshot.localOnlyCounts
      };
    }

    for (const table of IMPORT_TABLES) {
      const rows = snapshot.rowsByTable.get(table);
      if (!rows.length) continue;
      const destinationColumns = await getDestinationColumns(client, table);
      for (const row of rows) {
        const insert = buildInsert(table, row, destinationColumns);
        await client.query(insert.sql, insert.values);
      }
    }

    for (const table of IMPORT_TABLES) {
      const actual = await client.query(
        `SELECT COUNT(*)::bigint AS count FROM public.${quoteIdentifier(table)} WHERE company_id = $1`,
        [args.companyId]
      );
      if (BigInt(actual.rows[0].count) !== BigInt(snapshot.tableCounts[table])) {
        throw new Error(`POSTGRES_IMPORT_COUNT_MISMATCH:${table}`);
      }
    }
    await client.query('COMMIT');
    transactionStarted = false;
    return {
      mode: 'APPLIED', sourceSha256: snapshot.sourceSha256, schemaVersion: snapshot.schemaVersion,
      companyId: snapshot.companyId, target, tableCounts: snapshot.tableCounts,
      sourceOnlyCounts: snapshot.sourceOnlyCounts, localOnlyCounts: snapshot.localOnlyCounts
    };
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const result = await importSqliteBaseline(args, env);
  process.stdout.write(`SQLITE_BASELINE_IMPORT_${result.mode} ${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || 'SQLITE_BASELINE_IMPORT_FAILED'}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_SQLITE_SCHEMA_VERSION,
  IMPORT_TABLES,
  parseArgs,
  inspectSqliteSource,
  getSafeImportDsn,
  buildInsert,
  importSqliteBaseline
};
