'use strict';

const fs = require('node:fs');
const path = require('node:path');

// One ordered lineage for local startup, disposable resets and production deploy.
const MIGRATIONS = Object.freeze([
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
  'deploy_company_admin_scope_migration.sql',
  'deploy_worker_telegram_unbind_migration.sql',
  'deploy_production_adjustment_attribution_migration.sql',
  'deploy_activation_policy_sync_count_migration.sql',
  'deploy_worker_adjustment_manual_payroll_types.sql',
  'deploy_model_batch_size_names_migration.sql',
  'deploy_party_size_order_migration.sql',
  'deploy_patta_lifecycle_provenance_migration.sql',
  'deploy_worker_onboarding_profile_migration.sql'
]);

const EXPECTED_MIGRATIONS = Object.freeze(Object.fromEntries(MIGRATIONS.map((name, index) => [index + 1, name])));

async function applyMigrations(client, options = {}) {
  const migrationDirectory = options.migrationDirectory || path.join(__dirname, 'migrations');
  const schemaPath = options.schemaPath || path.join(__dirname, 'schema.sql');
  const readFile = options.readFile || ((filePath) => fs.readFileSync(filePath, 'utf8'));
  const log = options.log || ((line) => process.stdout.write(`${line}\n`));
  for (const [index, filename] of MIGRATIONS.entries()) {
    const version = index + 1;
    if (index > 0) {
      const result = await client.query('SELECT name FROM schema_migrations WHERE version = $1', [version]);
      const applied = result.rows[0];
      if (applied) {
        if (applied.name !== filename) {
          throw Object.assign(new Error(`POSTGRES_MIGRATION_VERSION_CONFLICT version=${version}`),
            { code: 'POSTGRES_MIGRATION_VERSION_CONFLICT' });
        }
        log(`POSTGRES_MIGRATION_ALREADY_APPLIED version=${version}`);
        continue;
      }
    }
    await client.query(readFile(filename === 'schema.sql' ? schemaPath : path.join(migrationDirectory, filename)));
    if (index > 0) log(`POSTGRES_MIGRATION_APPLIED version=${version}`);
  }
}

module.exports = { MIGRATIONS, EXPECTED_MIGRATIONS, applyMigrations };
