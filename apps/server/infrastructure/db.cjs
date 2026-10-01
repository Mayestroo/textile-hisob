'use strict';

const { Pool } = require('pg');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveDatabaseUrl, validatePostgresDsn } = require('./connectionConfig.cjs');

let pool = null;
let poolConnectionIdentity = null;

function getConnectionString(env = process.env) {
  return resolveDatabaseUrl(env);
}

function getRequestedConnection(options = {}) {
  const requestedValue = options.databaseUrl === undefined
    ? getConnectionString(options.env || process.env)
    : options.databaseUrl;
  validatePostgresDsn(requestedValue, options.source || 'DATABASE_URL');
  const connectionString = String(requestedValue).trim();

  return {
    connectionString,
    identity: createHash('sha256').update(connectionString, 'utf8').digest('hex')
  };
}

function getServerPool(options = {}) {
  const requestedConnection = getRequestedConnection(options);

  if (pool) {
    if (poolConnectionIdentity !== requestedConnection.identity) {
      const error = new Error('Requested database configuration does not match the existing server pool');
      error.code = 'DATABASE_POOL_CONFIGURATION_MISMATCH';
      throw error;
    }
    return pool;
  }

  pool = new Pool({
    connectionString: requestedConnection.connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
  poolConnectionIdentity = requestedConnection.identity;
  return pool;
}

async function withTransaction(callback) {
  const p = getServerPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[PostgreSQL] Rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function initServerDatabase(options = {}) {
  const p = options.pool || getServerPool(options);
  const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await p.query(sql);
}

async function resetServerDatabase() {
  const p = getServerPool();
  await p.query(`
    DROP TABLE IF EXISTS period_archives CASCADE;
    DROP TABLE IF EXISTS party_id_aliases CASCADE;
    DROP TABLE IF EXISTS model_id_aliases CASCADE;
    DROP TABLE IF EXISTS protected_party_patta_ranges CASCADE;
    DROP TABLE IF EXISTS company_patta_sequences CASCADE;
    DROP TABLE IF EXISTS patta_batch_settings CASCADE;
    DROP TABLE IF EXISTS company_batch_settings CASCADE;
    DROP TABLE IF EXISTS schema_migrations CASCADE;
    DROP TABLE IF EXISTS printed_patta_operations CASCADE;
    DROP TABLE IF EXISTS printed_pattas CASCADE;
    DROP TABLE IF EXISTS worker_adjustments CASCADE;
    DROP TABLE IF EXISTS migration_baseline_exclusions CASCADE;
    DROP TABLE IF EXISTS baseline_import_runs CASCADE;
    DROP TABLE IF EXISTS migration_baseline_decisions CASCADE;
    DROP TABLE IF EXISTS ticket_entries CASCADE;
    DROP TABLE IF EXISTS tickets CASCADE;
    DROP TABLE IF EXISTS parties CASCADE;
    DROP TABLE IF EXISTS legacy_party_collision_exceptions CASCADE;
    DROP TABLE IF EXISTS migration_party_resolutions CASCADE;
    DROP TABLE IF EXISTS migration_reconciliation_resolutions CASCADE;
    DROP TABLE IF EXISTS migration_reconciliation_candidates CASCADE;
    DROP TABLE IF EXISTS production_adjustments CASCADE;
    DROP TABLE IF EXISTS operations_dedup CASCADE;
    DROP TABLE IF EXISTS change_log CASCADE;
    DROP TABLE IF EXISTS party_sequence_leases CASCADE;
    DROP TABLE IF EXISTS server_devices CASCADE;
    DROP TABLE IF EXISTS operator_sessions CASCADE;
    DROP TABLE IF EXISTS operator_login_attempts CASCADE;
    DROP TABLE IF EXISTS server_operators CASCADE;
    DROP TABLE IF EXISTS activation_policy_events CASCADE;
    DROP TABLE IF EXISTS activation_events CASCADE;
    DROP TABLE IF EXISTS activation_request_limits CASCADE;
    DROP TABLE IF EXISTS activation_requests CASCADE;
    DROP TABLE IF EXISTS activation_companies CASCADE;
    DROP TABLE IF EXISTS worker_binding_limits CASCADE;
    DROP TABLE IF EXISTS worker_telegram_bindings CASCADE;
    DROP TABLE IF EXISTS worker_credentials CASCADE;
    DROP TABLE IF EXISTS periods CASCADE;
    DROP TABLE IF EXISTS models CASCADE;
    DROP TABLE IF EXISTS workers CASCADE;
  `);
  await initServerDatabase();
  // Test-only reset helper: restore the complete source schema lineage so the
  // integration suite exercises the same migration set as the current client.
  const migrations = [
    'deploy_active_party_migration.sql',
    'deploy_operator_auth_migration.sql',
    'deploy_operator_auth_rate_limit_migration.sql',
    'deploy_reconciliation_migration.sql',
    'deploy_ticket_identity_party_fk_migration.sql',
    'deploy_exact_party_2_policy_migration.sql',
    'deploy_activation_migration.sql',
    'deploy_business_mutations_migration.sql',
    'deploy_activation_company_scope_migration.sql',
    'deploy_activation_policy_revision_migration.sql',
    'deploy_exact_party_2_company_scope_migration.sql',
    'deploy_activation_policy_device_sync_migration.sql',
    'deploy_free_mode_ticket_party_migration.sql',
    'deploy_patta_work_quantity_migration.sql',
    'deploy_canonical_ids_global_patta_sequence.sql',
    'deploy_production_adjustment_provenance_migration.sql'
  ];
  for (const filename of migrations) {
    await p.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', filename), 'utf8'));
  }
}

async function closeServerPool() {
  if (pool) {
    await pool.end();
    pool = null;
    poolConnectionIdentity = null;
  }
}

module.exports = {
  getConnectionString,
  getServerPool,
  withTransaction,
  initServerDatabase,
  resetServerDatabase,
  closeServerPool
};
