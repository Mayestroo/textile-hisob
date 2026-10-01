'use strict';

const BOOTSTRAP_LOCK_SQL = 'SELECT pg_advisory_lock(hashtextextended($1, 0))';
const CHANGE_WRITER_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const BOOTSTRAP_UNLOCK_SQL = 'SELECT pg_advisory_unlock(hashtextextended($1, 0))';

function assertCompanyId(companyId) {
  if (typeof companyId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(companyId)) {
    const error = new Error('A valid authenticated company scope is required');
    error.code = 'COMPANY_SCOPE_REQUIRED';
    error.statusCode = 401;
    throw error;
  }
}

/**
 * Serializes change-log writers for a company through transaction commit.
 * Call immediately after BEGIN and before any business-row mutation.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} companyId
 */
async function acquireCompanyChangeLock(client, companyId) {
  assertCompanyId(companyId);
  await client.query(CHANGE_WRITER_LOCK_SQL, [companyId]);
}

/**
 * Acquires the matching session lock before beginning a repeatable-read
 * transaction. This prevents sequence allocation order from creating a gap at
 * the snapshot watermark when an earlier change-log ID is still uncommitted.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} companyId
 */
async function acquireCompanyBootstrapLock(client, companyId) {
  assertCompanyId(companyId);
  await client.query(BOOTSTRAP_LOCK_SQL, [companyId]);
}

async function releaseCompanyBootstrapLock(client, companyId) {
  const result = await client.query(BOOTSTRAP_UNLOCK_SQL, [companyId]);
  if (result.rows?.[0]?.pg_advisory_unlock !== true) {
    const error = new Error('Company bootstrap advisory lock could not be released');
    error.code = 'BOOTSTRAP_LOCK_RELEASE_FAILED';
    throw error;
  }
}

module.exports = {
  acquireCompanyChangeLock,
  acquireCompanyBootstrapLock,
  releaseCompanyBootstrapLock
};
