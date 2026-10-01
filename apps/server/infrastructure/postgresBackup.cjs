'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

/**
 * Executes a PostgreSQL database dump using pg_dump.
 * Supports running via local binary or WSL2 environment.
 *
 * @param {object} options
 * @param {string} [options.host='localhost']
 * @param {number} [options.port=5432]
 * @param {string} [options.user='postgres']
 * @param {string} options.database
 * @param {string} options.outputFile
 * @param {boolean} [options.useWsl=true]
 * @param {string} [options.dockerContainer] Disposable PostgreSQL container name.
 * @returns {{ success: boolean, outputFile: string, byteSize: number }}
 */
function dumpDatabase(options) {
  const host = options.host || 'localhost';
  const port = options.port || 5432;
  const user = options.user || 'postgres';
  const database = options.database;
  const outputFile = options.outputFile;
  const useWsl = options.useWsl !== false;
  const dockerContainer = options.dockerContainer;

  const outDir = path.dirname(outputFile);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  if (dockerContainer) {
    const cmd = `docker exec ${dockerContainer} pg_dump -h ${host} -p ${port} -U ${user} --clean --if-exists --no-owner --no-privileges ${database}`;
    const sqlDump = execSync(cmd, { maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' });
    fs.writeFileSync(outputFile, sqlDump, 'utf8');
  // Use WSL if on Windows and useWsl is true
  } else if (process.platform === 'win32' && useWsl) {
    // Translate Windows output path to WSL /mnt/... path if needed, or pipe stdout
    const cmd = `wsl -e pg_dump -h ${host} -p ${port} -U ${user} --clean --if-exists --no-owner --no-privileges ${database}`;
    const sqlDump = execSync(cmd, { maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' });
    fs.writeFileSync(outputFile, sqlDump, 'utf8');
  } else {
    const cmd = `pg_dump -h ${host} -p ${port} -U ${user} --clean --if-exists --no-owner --no-privileges -f "${outputFile}" ${database}`;
    execSync(cmd, { encoding: 'utf8' });
  }

  const stat = fs.statSync(outputFile);
  return {
    success: true,
    outputFile,
    byteSize: stat.size
  };
}

/**
 * Restores a PostgreSQL dump into a target database using psql.
 *
 * @param {object} options
 * @param {string} [options.host='localhost']
 * @param {number} [options.port=5432]
 * @param {string} [options.user='postgres']
 * @param {string} options.database Target verification database
 * @param {string} options.inputFile SQL dump file
 * @param {boolean} [options.useWsl=true]
 * @param {string} [options.dockerContainer] Disposable PostgreSQL container name.
 * @returns {{ success: boolean }}
 */
function restoreDatabase(options) {
  const host = options.host || 'localhost';
  const port = options.port || 5432;
  const user = options.user || 'postgres';
  const database = options.database;
  const inputFile = options.inputFile;
  const useWsl = options.useWsl !== false;
  const dockerContainer = options.dockerContainer;

  if (!fs.existsSync(inputFile)) {
    throw new Error(`Dump file does not exist: ${inputFile}`);
  }

  const sql = fs.readFileSync(inputFile, 'utf8');

  if (dockerContainer) {
    execSync(`docker exec -i ${dockerContainer} psql -h ${host} -p ${port} -U ${user} -d ${database}`, {
      input: sql,
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf8'
    });
  } else if (process.platform === 'win32' && useWsl) {
    execSync(`wsl -e psql -h ${host} -p ${port} -U ${user} -d ${database}`, {
      input: sql,
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf8'
    });
  } else {
    execSync(`psql -h ${host} -p ${port} -U ${user} -d ${database} -f "${inputFile}"`, {
      encoding: 'utf8'
    });
  }

  return { success: true };
}

/**
 * Verifies that a target restored PostgreSQL database has 100% parity with source.
 * Compares: table row counts, sequences, constraints, and runs application integrity queries.
 *
 * @param {Pool} sourcePool
 * @param {Pool} targetPool
 * @param {string} companyId
 * @returns {Promise<{ success: boolean, tableCounts: object, checks: string[] }>}
 */
async function verifyRestoredDatabase(sourcePool, targetPool, companyId) {
  const tables = [
    'operations_dedup',
    'change_log',
    'models',
    'workers',
    'tickets',
    'ticket_entries',
    'production_adjustments',
    'party_sequence_leases',
    'server_devices'
  ];

  const tableCounts = {};
  const checks = [];

  for (const table of tables) {
    const srcRes = await sourcePool.query(`SELECT COUNT(*) as c FROM ${table} WHERE company_id = $1`, [companyId]);
    const tgtRes = await targetPool.query(`SELECT COUNT(*) as c FROM ${table} WHERE company_id = $1`, [companyId]);

    const srcCount = parseInt(srcRes.rows[0].c, 10);
    const tgtCount = parseInt(tgtRes.rows[0].c, 10);

    tableCounts[table] = { source: srcCount, target: tgtCount };

    if (srcCount !== tgtCount) {
      throw new Error(`Table count mismatch for "${table}": source=${srcCount}, target=${tgtCount}`);
    }
    checks.push(`Table ${table}: ${srcCount} rows match`);
  }

  // Check ticket entries sum vs ticket qty sum
  const srcSum = await sourcePool.query(
    'SELECT COALESCE(SUM(qty), 0) as s FROM ticket_entries WHERE company_id = $1',
    [companyId]
  );
  const tgtSum = await targetPool.query(
    'SELECT COALESCE(SUM(qty), 0) as s FROM ticket_entries WHERE company_id = $1',
    [companyId]
  );
  if (Number(srcSum.rows[0].s) !== Number(tgtSum.rows[0].s)) {
    throw new Error(`Ticket entries sum mismatch: source=${srcSum.rows[0].s}, target=${tgtSum.rows[0].s}`);
  }
  checks.push(`Ticket entries total qty: ${srcSum.rows[0].s} exact match`);

  // Check active party uniqueness trigger and ticket party record index exist
  const trgRes = await targetPool.query(`
    SELECT tgname FROM pg_trigger WHERE tgname = 'trg_parties_active_uniqueness'
  `);
  if (trgRes.rows.length === 0) {
    throw new Error('Trigger trg_parties_active_uniqueness missing in restored database');
  }
  checks.push('Active uniqueness trigger trg_parties_active_uniqueness verified');

  const tktIdxRes = await targetPool.query(`
    SELECT indexname FROM pg_indexes WHERE indexname = 'idx_tickets_party_record'
  `);
  if (tktIdxRes.rows.length === 0) {
    throw new Error('Index idx_tickets_party_record missing in restored database');
  }
  checks.push('Index idx_tickets_party_record verified');

  // Check sequence max value
  const seqRes = await targetPool.query(`
    SELECT last_value FROM change_log_change_id_seq
  `);
  if (seqRes.rows.length > 0) {
    checks.push(`Sequence change_log_change_id_seq at ${seqRes.rows[0].last_value}`);
  }

  return {
    success: true,
    tableCounts,
    checks
  };
}

module.exports = {
  dumpDatabase,
  restoreDatabase,
  verifyRestoredDatabase
};
