import { describe, expect, it, vi } from 'vitest';

const { MIGRATIONS, applyMigrations } = require('./migrateProduction.cjs');

describe('production PostgreSQL migration runner', () => {
  it('skips already-applied historical migrations, including the legacy Party FK preflight', async () => {
    const executedSql: string[] = [];
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql === 'SELECT name FROM schema_migrations WHERE version = $1') {
        return {
          rows: parameters?.[0] === 6
            ? [{ name: 'deploy_ticket_identity_party_fk_migration.sql' }]
            : []
        };
      }
      executedSql.push(sql);
      return { rows: [] };
    });

    await applyMigrations({ query }, {
      readFile: (filePath: string) => filePath.endsWith('schema.sql')
        ? '-- schema.sql'
        : `-- ${filePath.split(/[\\/]/).pop()}`
    });

    expect(query).toHaveBeenCalledWith('SELECT name FROM schema_migrations WHERE version = $1', [6]);
    expect(executedSql).not.toContain('-- deploy_ticket_identity_party_fk_migration.sql');
    expect(executedSql).toContain('-- schema.sql');
    expect(executedSql).toContain(`-- ${MIGRATIONS[6]}`);
  });

  it('fails closed when an applied migration version has a different name', async () => {
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql === 'SELECT name FROM schema_migrations WHERE version = $1' && parameters?.[0] === 6) {
        return { rows: [{ name: 'unexpected-migration.sql' }] };
      }
      return { rows: [] };
    });

    await expect(applyMigrations({ query }, {
      readFile: (filePath: string) => filePath.endsWith('schema.sql')
        ? '-- schema.sql'
        : `-- ${filePath.split(/[\\/]/).pop()}`
    })).rejects.toMatchObject({ code: 'POSTGRES_MIGRATION_VERSION_CONFLICT' });
  });
});
