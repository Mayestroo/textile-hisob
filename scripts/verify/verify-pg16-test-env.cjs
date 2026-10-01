'use strict';

const { Client } = require('pg');

async function verifyFreshPostgres16TestEnvironment(connectionString = process.env.NOVDA_PG_URL, options = {}) {
  const env = options.env || process.env;
  const ClientClass = options.ClientClass || Client;
  if (env.NOVDA_DISPOSABLE_PG !== '1') {
    throw new Error('DISPOSABLE_POSTGRES_REQUIRED: set NOVDA_DISPOSABLE_PG=1');
  }
  if (!connectionString) {
    throw new Error('DISPOSABLE_POSTGRES_REQUIRED: NOVDA_PG_URL is required');
  }
  if (env.DATABASE_URL) {
    throw new Error('DISPOSABLE_POSTGRES_REQUIRED: DATABASE_URL must be unset');
  }

  const client = new ClientClass({ connectionString });
  try {
    await client.connect();
    const result = await client.query(
      'SELECT current_database() AS database, current_setting(\'server_version_num\') AS server_version_num'
    );
    const database = String(result.rows[0]?.database || '');
    const serverVersion = String(result.rows[0]?.server_version_num || '');
    if (!serverVersion.startsWith('16')) {
      throw new Error('POSTGRESQL_16_REQUIRED: disposable tests require PostgreSQL 16');
    }
    if (!/(test|regression|disposable)/i.test(database)) {
      throw new Error('DISPOSABLE_DATABASE_REQUIRED: database name must identify a test, regression, or disposable database');
    }
    return { database, serverVersion };
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  verifyFreshPostgres16TestEnvironment().then(({ database, serverVersion }) => {
    process.stdout.write(`POSTGRESQL_16_TEST_ENV_PASS database=${database} server_version=${serverVersion}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { verifyFreshPostgres16TestEnvironment };
