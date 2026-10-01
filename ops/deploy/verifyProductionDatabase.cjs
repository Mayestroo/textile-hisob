'use strict';

const { Client } = require('pg');
const { validatePostgresDsn } = require('../../apps/server/infrastructure/connectionConfig.cjs');
const { verifyPostgresReleaseState } = require('../../apps/server/infrastructure/postgresIntegrity.cjs');

function getVerificationDsn(env = process.env) {
  if (env.NODE_ENV !== 'production') {
    const error = new Error('NODE_ENV_PRODUCTION_REQUIRED');
    error.code = 'NODE_ENV_PRODUCTION_REQUIRED';
    throw error;
  }
  const database = env.NOVDA_VERIFY_DATABASE_NAME;
  if (typeof database !== 'string' || !/^novda_(?:prod|restore_[a-z0-9_]+)$/.test(database)) {
    const error = new Error('NOVDA_VERIFY_DATABASE_NAME_INVALID');
    error.code = 'NOVDA_VERIFY_DATABASE_NAME_INVALID';
    throw error;
  }
  const value = env.NOVDA_MIGRATOR_DATABASE_URL;
  const parsed = validatePostgresDsn(value, 'NOVDA_MIGRATOR_DATABASE_URL');
  if (decodeURIComponent(parsed.username) !== 'novda_migrator') {
    const error = new Error('NOVDA_MIGRATOR_ROLE_REQUIRED');
    error.code = 'NOVDA_MIGRATOR_ROLE_REQUIRED';
    throw error;
  }
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function verifyProductionDatabase(env = process.env) {
  const connectionString = getVerificationDsn(env);
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const target = await client.query(
      "SELECT current_database() AS database, current_setting('server_version_num') AS server_version_num"
    );
    const database = String(target.rows[0]?.database || '');
    const serverVersion = String(target.rows[0]?.server_version_num || '');
    if (database !== env.NOVDA_VERIFY_DATABASE_NAME || !serverVersion.startsWith('16')) {
      const error = new Error('POSTGRES_RESTORE_TARGET_INVALID');
      error.code = 'POSTGRES_RESTORE_TARGET_INVALID';
      throw error;
    }
    const evidence = await verifyPostgresReleaseState(client);
    const report = { database, serverVersion, evidence };
    process.stdout.write(`POSTGRES_RESTORE_VERIFICATION_PASS ${JSON.stringify(report)}\n`);
    return report;
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  verifyProductionDatabase().catch((error) => {
    const code = error?.code || 'POSTGRES_RESTORE_VERIFICATION_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}

module.exports = { getVerificationDsn, verifyProductionDatabase };
