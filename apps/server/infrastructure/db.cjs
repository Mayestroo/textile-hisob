'use strict';

const { Pool } = require('pg');
const { createHash } = require('crypto');
const { applyMigrations } = require('../database/migrate.cjs');
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
  // Migration scripts contain transactions: pin all their queries to one connection.
  const client = await p.connect();
  let failure;
  try {
    await applyMigrations(client, { log: () => {} });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    client.release(failure);
  }
}

async function resetServerDatabase(options = {}) {
  const env = options.env || process.env;
  const target = env.NOVDA_PG_URL ? validatePostgresDsn(env.NOVDA_PG_URL, 'NOVDA_PG_URL') : null;
  if (env.NOVDA_DISPOSABLE_PG !== '1' || env.DATABASE_URL || env.NODE_ENV === 'production'
    || !target || !/(test|regression|disposable)/i.test(decodeURIComponent(target.pathname.slice(1)))) {
    throw Object.assign(new Error('DISPOSABLE_POSTGRES_REQUIRED: database reset is restricted to explicitly opted-in test databases'),
      { code: 'DISPOSABLE_POSTGRES_REQUIRED' });
  }
  const p = getServerPool({ env });
  const actual = (await p.query("SELECT current_database() AS database, current_setting('server_version_num') AS version")).rows[0];
  if (actual?.database !== decodeURIComponent(target.pathname.slice(1)) || !String(actual?.version).startsWith('16')) {
    throw Object.assign(new Error('DISPOSABLE_POSTGRES_REQUIRED: reset target verification failed'),
      { code: 'DISPOSABLE_POSTGRES_REQUIRED' });
  }
  await p.query(`
    DROP TABLE IF EXISTS period_archives CASCADE;
    DROP TABLE IF EXISTS party_id_aliases CASCADE;
    DROP TABLE IF EXISTS model_id_aliases CASCADE;
    DROP TABLE IF EXISTS protected_party_patta_ranges CASCADE;
    DROP TABLE IF EXISTS company_patta_sequences CASCADE;
    DROP TABLE IF EXISTS patta_batch_settings CASCADE;
    DROP TABLE IF EXISTS company_batch_settings CASCADE;
    DROP TABLE IF EXISTS schema_migrations CASCADE;
    DROP TABLE IF EXISTS allocation_resolution_audit CASCADE;
    DROP TABLE IF EXISTS allocation_resolution_fences CASCADE;
    DROP TABLE IF EXISTS allocation_review_candidates CASCADE;
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
  await initServerDatabase({ pool: p });
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
