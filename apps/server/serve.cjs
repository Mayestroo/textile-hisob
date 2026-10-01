'use strict';

const { buildFastifyServer } = require('./app.cjs');
const { getServerPool, initServerDatabase } = require('./infrastructure/db.cjs');
const { resolveDatabaseUrl } = require('./infrastructure/connectionConfig.cjs');
const { verifyPostgresReleaseState } = require('./infrastructure/postgresIntegrity.cjs');

function verifyPreinitializedProductionDatabase({ pool }) {
  return verifyPostgresReleaseState(pool);
}

/**
 * Start server only after explicit configuration has been validated and the
 * authoritative database schema has been initialized.
 *
 * The dependency options are intentionally injectable so startup ordering can
 * be tested without creating a PostgreSQL connection or binding a real port.
 *
 * @param {object} [options={}]
 * @param {NodeJS.ProcessEnv|object} [options.env=process.env]
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {Function} [options.createPool=getServerPool]
 * @param {Function} [options.buildServer=buildFastifyServer]
 * @param {Function} [options.initializeDatabase=initServerDatabase]
 * @returns {Promise<{app: object, address: string|object}>}
 */
async function startServer(options = {}) {
  const env = options.env || process.env;
  const databaseUrl = resolveDatabaseUrl(env);
  const createPool = options.createPool || getServerPool;
  const buildServer = options.buildServer || buildFastifyServer;
  const initializeDatabase = options.initializeDatabase || (
    env.NODE_ENV === 'production' ? verifyPreinitializedProductionDatabase : initServerDatabase
  );
  const host = options.host || env.HOST || '127.0.0.1';
  const port = options.port === undefined ? Number(env.PORT || 3474) : options.port;
  const pool = createPool({ env, databaseUrl });
  const app = buildServer({
    pool,
    env,
    minClientVersion: env.MIN_CLIENT_VERSION || '2.0.0',
    allowTestTokens: env.ALLOW_TEST_TOKENS === 'true',
    logger: { level: env.LOG_LEVEL || 'info' }
  });

  await initializeDatabase({ env, databaseUrl, pool });
  const address = await app.listen({ host, port });
  return { app, address };
}

async function stopServer(app, signal) {
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    console.error(`[Server] server shutdown failed (${error && error.code ? error.code : signal})`);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer()
    .then(({ app }) => {
      process.once('SIGTERM', () => void stopServer(app, 'SIGTERM'));
      process.once('SIGINT', () => void stopServer(app, 'SIGINT'));
    })
    .catch((error) => {
      const code = error && error.code ? error.code : 'SERVER_STARTUP_FAILED';
      console.error(`[Server] server startup failed (${code})`);
      process.exit(1);
    });
}

module.exports = {
  startServer
};
