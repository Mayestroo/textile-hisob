'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { Client } = require('pg');
const { verifyFreshPostgres16TestEnvironment } = require('./verify-pg16-test-env.cjs');
const { verifyPostgresReleaseState } = require('../../apps/server/infrastructure/postgresIntegrity.cjs');

function readSqliteEvidence(sqlitePath) {
  if (!sqlitePath || !path.isAbsolute(sqlitePath)) {
    const error = new Error('SQLITE_PATH_REQUIRED: provide an absolute path with --sqlite-path');
    error.code = 'SQLITE_PATH_REQUIRED';
    throw error;
  }

  const database = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const integrityRows = database.pragma('integrity_check');
    const foreignKeyRows = database.pragma('foreign_key_check');
    const schemaMetaExists = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'"
    ).get();
    const schemaMetaVersion = schemaMetaExists
      ? Number(database.prepare('SELECT MAX(version) AS version FROM schema_meta').get()?.version || 0)
      : null;
    const userVersion = Number(database.pragma('user_version', { simple: true }));
    const integrityCheck = integrityRows.length === 1 ? String(integrityRows[0].integrity_check) : 'invalid';
    const report = {
      evidenceType: 'sqlite_pragmas',
      integrityCheck,
      foreignKeyViolationCount: foreignKeyRows.length,
      userVersion,
      schemaMetaVersion
    };
    if (integrityCheck !== 'ok' || foreignKeyRows.length !== 0
      || !Number.isSafeInteger(userVersion) || !Number.isSafeInteger(schemaMetaVersion)
      || userVersion !== schemaMetaVersion) {
      const error = new Error('SQLITE_RELEASE_INTEGRITY_FAILED');
      error.code = 'SQLITE_RELEASE_INTEGRITY_FAILED';
      error.details = report;
      throw error;
    }
    return report;
  } finally {
    database.close();
  }
}

async function readPostgresEvidence(env = process.env) {
  const { database, serverVersion } = await verifyFreshPostgres16TestEnvironment(env.NOVDA_PG_URL, { env });
  const client = new Client({ connectionString: env.NOVDA_PG_URL });
  try {
    await client.connect();
    const report = await verifyPostgresReleaseState(client);
    return { database, serverVersion, ...report };
  } finally {
    await client.end().catch(() => {});
  }
}

function parseSqlitePath(argv, env = process.env) {
  const index = argv.indexOf('--sqlite-path');
  return index >= 0 ? argv[index + 1] : env.NOVDA_SQLITE_PATH;
}

async function main() {
  const sqlite = readSqliteEvidence(parseSqlitePath(process.argv.slice(2), process.env));
  process.stdout.write(`SQLITE_RELEASE_INTEGRITY_PASS ${JSON.stringify(sqlite)}\n`);
  const postgres = await readPostgresEvidence();
  process.stdout.write(`POSTGRES_RELEASE_INTEGRITY_PASS ${JSON.stringify(postgres)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    const code = error?.code || 'RELEASE_INTEGRITY_FAILED';
    process.stderr.write(`${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { readSqliteEvidence, readPostgresEvidence, parseSqlitePath };
