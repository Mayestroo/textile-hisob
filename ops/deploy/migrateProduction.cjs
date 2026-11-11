'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { validatePostgresDsn } = require('../../apps/server/infrastructure/connectionConfig.cjs');
const { verifyPostgresReleaseState } = require('../../apps/server/infrastructure/postgresIntegrity.cjs');

const { MIGRATIONS, applyMigrations } = require('../../apps/server/database/migrate.cjs');

function requireDsn(env, name, requiredUsername) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(`${name}_REQUIRED`);
    error.code = `${name}_REQUIRED`;
    throw error;
  }
  const parsed = validatePostgresDsn(value, name);
  if (parsed.pathname !== '/novda_prod' || decodeURIComponent(parsed.username) !== requiredUsername) {
    const error = new Error(`${name}_SCOPE_INVALID`);
    error.code = `${name}_SCOPE_INVALID`;
    throw error;
  }
  return value;
}

async function verifyPostgres16(client) {
  const result = await client.query(
    "SELECT current_database() AS database, current_setting('server_version_num') AS server_version_num"
  );
  const database = String(result.rows[0]?.database || '');
  const serverVersion = String(result.rows[0]?.server_version_num || '');
  if (database !== 'novda_prod' || !serverVersion.startsWith('16')) {
    const error = new Error('POSTGRES_PRODUCTION_TARGET_INVALID');
    error.code = 'POSTGRES_PRODUCTION_TARGET_INVALID';
    throw error;
  }
  return { database, serverVersion };
}

async function connect(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

async function main(env = process.env) {
  if (env.NODE_ENV !== 'production') {
    const error = new Error('NODE_ENV_PRODUCTION_REQUIRED');
    error.code = 'NODE_ENV_PRODUCTION_REQUIRED';
    throw error;
  }
  if (env.NOVDA_PG_URL) {
    const error = new Error('NOVDA_PG_URL_FORBIDDEN_IN_PRODUCTION_MIGRATION');
    error.code = 'NOVDA_PG_URL_FORBIDDEN_IN_PRODUCTION_MIGRATION';
    throw error;
  }

  const ownerDsn = requireDsn(env, 'NOVDA_OWNER_DATABASE_URL', 'novda_owner');
  const migratorDsn = requireDsn(env, 'NOVDA_MIGRATOR_DATABASE_URL', 'novda_migrator');
  const appDsn = requireDsn(env, 'DATABASE_URL', 'novda_app');
  const clients = [];

  try {
    const owner = await connect(ownerDsn);
    clients.push(owner);
    const migrator = await connect(migratorDsn);
    clients.push(migrator);
    const app = await connect(appDsn);
    clients.push(app);

    const target = await verifyPostgres16(migrator);
    await applyMigrations(migrator);

    await owner.query(
      fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'server', 'database', 'production_roles.sql'), 'utf8')
    );

    const appRoleResult = await owner.query(`
      SELECT role_row.rolsuper, role_row.rolcreatedb, role_row.rolcreaterole,
        role_row.rolbypassrls,
        has_schema_privilege('novda_app', 'public', 'CREATE') AS can_create_schema
      FROM pg_roles role_row
      WHERE role_row.rolname = 'novda_app'
    `);
    const appRole = appRoleResult.rows[0];
    if (!appRole || appRole.rolsuper || appRole.rolcreatedb || appRole.rolcreaterole
      || appRole.rolbypassrls || appRole.can_create_schema) {
      const error = new Error('NOVDA_APP_LEAST_PRIVILEGE_FAILED');
      error.code = 'NOVDA_APP_LEAST_PRIVILEGE_FAILED';
      throw error;
    }

    const report = await verifyPostgresReleaseState(app);
    process.stdout.write(`POSTGRES_PRODUCTION_SCHEMA_PASS ${JSON.stringify({ ...target, evidence: report })}\n`);
    return { ...target, evidence: report };
  } finally {
    await Promise.all(clients.map((client) => client.end().catch(() => {})));
  }
}

if (require.main === module) {
  main().catch((error) => {
    const code = error?.code || 'NOVDA_PRODUCTION_SCHEMA_FAILED';
    const problems = code === 'POSTGRES_RELEASE_INTEGRITY_FAILED' && Array.isArray(error?.details?.problems)
      ? ` checks=${JSON.stringify(error.details.problems)}`
      : '';
    const baseline = code === 'POSTGRES_RELEASE_INTEGRITY_FAILED' ? error?.details?.report?.baseline : null;
    const baselineState = baseline
      ? ` baseline=${JSON.stringify({
        scopePreserved: baseline.scopePreserved,
        ownerDecisionCount: baseline.ownerDecisionCount,
        ownerExclusionRows: baseline.ownerExclusionRows,
        ownerScopeMismatchRows: baseline.ownerScopeMismatchRows,
        ownerDecisionMismatchCount: baseline.ownerDecisionMismatchCount,
        retrospectiveEvidenceMismatchCount: baseline.retrospectiveEvidenceMismatchCount,
        retrospectiveEvidenceChecks: baseline.retrospectiveEvidenceChecks
      })}`
      : '';
    process.stderr.write(`${code}${problems}${baselineState}\n`);
    process.exitCode = 1;
  });
}

module.exports = { MIGRATIONS, requireDsn, verifyPostgres16, applyMigrations, main };
