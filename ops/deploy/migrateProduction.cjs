'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { validatePostgresDsn } = require('../../apps/server/infrastructure/connectionConfig.cjs');
const { verifyPostgresReleaseState } = require('../../apps/server/infrastructure/postgresIntegrity.cjs');

const MIGRATIONS = [
  'schema.sql',
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
  'deploy_production_adjustment_provenance_migration.sql',
  'deploy_patta_series_sequence_migration.sql',
  'deploy_patta_sequence_runtime_grant_migration.sql',
  'deploy_voided_ticket_patta_reuse_migration.sql',
  'deploy_company_admin_scope_migration.sql'
];

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

async function applyMigrations(migrator, options = {}) {
  const migrationDirectory = options.migrationDirectory
    || path.join(__dirname, '..', '..', 'apps', 'server', 'database', 'migrations');
  const schemaPath = options.schemaPath
    || path.join(__dirname, '..', '..', 'apps', 'server', 'database', 'schema.sql');
  const readFile = options.readFile || ((filePath) => fs.readFileSync(filePath, 'utf8'));

  for (let index = 0; index < MIGRATIONS.length; index += 1) {
    const filename = MIGRATIONS[index];
    if (index > 0) {
      const version = index + 1;
      const result = await migrator.query(
        'SELECT name FROM schema_migrations WHERE version = $1',
        [version]
      );
      const applied = result.rows[0];
      if (applied) {
        if (applied.name !== filename) {
          const error = new Error(`POSTGRES_MIGRATION_VERSION_CONFLICT version=${version}`);
          error.code = 'POSTGRES_MIGRATION_VERSION_CONFLICT';
          throw error;
        }
        process.stdout.write(`POSTGRES_MIGRATION_ALREADY_APPLIED version=${version}\n`);
        continue;
      }
    }

    const sqlPath = filename === 'schema.sql'
      ? schemaPath
      : path.join(migrationDirectory, filename);
    await migrator.query(readFile(sqlPath));
    if (index > 0) process.stdout.write(`POSTGRES_MIGRATION_APPLIED version=${index + 1}\n`);
  }
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
