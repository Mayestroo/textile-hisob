import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
const { dumpDatabase, restoreDatabase, verifyRestoredDatabase } = require('./postgresBackup.cjs');
import { resetServerDatabase, initServerDatabase, getServerPool, closeServerPool } from './db.cjs';
const { verifyFreshPostgres16TestEnvironment } = require('../../../scripts/verify/verify-pg16-test-env.cjs');

const disposableUrl = process.env.NOVDA_DISPOSABLE_PG === '1' && !process.env.DATABASE_URL
  ? process.env.NOVDA_PG_URL
  : undefined;
const dockerContainer = process.env.NOVDA_PG_DOCKER_CONTAINER;
const backupDsnHasNoPassword = disposableUrl ? !new URL(disposableUrl).password : false;
const describeDisposableBackup = disposableUrl && dockerContainer && backupDsnHasNoPassword ? describe : describe.skip;

describeDisposableBackup('Disposable PostgreSQL 16 Backup & Restore Drill', () => {
  let sourcePool: Pool;
  let restorePool: Pool | undefined;
  let adminPool: Pool | undefined;
  let tempDumpFile: string | undefined;
  let restoreDatabaseCreated = false;
  const COMPANY_ID = 'company-drill-alpha';
  const sourceUrl = disposableUrl ? new URL(disposableUrl) : undefined;
  const SOURCE_DB = sourceUrl ? decodeURIComponent(sourceUrl.pathname.slice(1)) : '';
  const RESTORE_DB = `novda_restore_drill_${process.pid}_${Date.now().toString(36)}`;
  const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

  beforeAll(async () => {
    if (!disposableUrl || process.env.NOVDA_DISPOSABLE_PG !== '1' || process.env.DATABASE_URL || !dockerContainer || !sourceUrl) {
      throw new Error('DISPOSABLE_POSTGRES_REQUIRED: backup drill requires NOVDA_PG_URL, NOVDA_DISPOSABLE_PG=1, and NOVDA_PG_DOCKER_CONTAINER');
    }
    if (!LOCAL_HOSTS.has(sourceUrl.hostname) || !sourceUrl.port || sourceUrl.password) {
      throw new Error('DISPOSABLE_POSTGRES_REQUIRED: Docker backup drill requires a loopback, password-free disposable DSN');
    }
    await verifyFreshPostgres16TestEnvironment(disposableUrl);

    const inspection = execFileSync('docker', [
      'inspect',
      '--format={{.Config.Image}}|{{.State.Running}}|{{json .NetworkSettings.Ports}}',
      dockerContainer
    ], { encoding: 'utf8' }).trim();
    const [image, running, rawPorts] = inspection.split('|');
    const portMappings = JSON.parse(rawPorts || '{}')['5432/tcp'] || [];
    const portIsBoundToDsn = portMappings.some((mapping: any) =>
      LOCAL_HOSTS.has(mapping.HostIp) && String(mapping.HostPort) === sourceUrl!.port
    );
    if (!/(?:^|\/)postgres:16(?:$|@)/.test(image) || running !== 'true' || !portIsBoundToDsn) {
      throw new Error('DISPOSABLE_POSTGRES_REQUIRED: Docker backup target must be a running PostgreSQL 16 container mapped to the disposable loopback DSN');
    }

    sourcePool = getServerPool();
    await resetServerDatabase();
    await initServerDatabase();

    const adminUrl = new URL(disposableUrl);
    adminUrl.pathname = '/postgres';
    adminPool = new Pool({ connectionString: adminUrl.toString(), max: 2, connectionTimeoutMillis: 5000 });
    await adminPool.query(`CREATE DATABASE "${RESTORE_DB}"`);
    restoreDatabaseCreated = true;

    const restoreUrl = new URL(disposableUrl);
    restoreUrl.pathname = `/${RESTORE_DB}`;
    restorePool = new Pool({
      connectionString: restoreUrl.toString(),
      max: 5,
      connectionTimeoutMillis: 5000
    });

    tempDumpFile = path.join(os.tmpdir(), `hisob_backup_drill_${Date.now()}.sql`);
  });

  afterAll(async () => {
    if (restorePool) await restorePool.end();
    await closeServerPool();
    try {
      if (restoreDatabaseCreated && adminPool) await adminPool.query(`DROP DATABASE IF EXISTS "${RESTORE_DB}"`);
    } catch {}
    if (adminPool) await adminPool.end();
    if (tempDumpFile && fs.existsSync(tempDumpFile)) {
      try { fs.unlinkSync(tempDumpFile); } catch {}
    }
  });

  it('populates source PostgreSQL DB, performs pg_dump, restores into isolated verification DB, and passes 100% parity', async () => {
    // 1. Seed comprehensive production-like state across authoritative tables
    await sourcePool.query(`
      INSERT INTO models (id, company_id, name, operations_json)
      VALUES ('m-drill-1', $1, 'Drill Model A', '[{"name":"Bichish","rate":1500}]')
    `, [COMPANY_ID]);

    await sourcePool.query(`
      INSERT INTO workers (id, company_id, name, status)
      VALUES (501, $1, 'Valijon Aliyev', 'ACTIVE')
    `, [COMPANY_ID]);

    await sourcePool.query(`
      INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status)
      VALUES ('party-drill-1', $1, '25', '25', 'm-drill-1', 'ACTIVE')
    `, [COMPANY_ID]);

    await sourcePool.query(`
      INSERT INTO tickets (id, company_id, model_id, party_number, party_record_id, patta_number, qty, status, submitted_at, server_revision)
      VALUES ('00000000-0000-4000-8000-000000000501', $1, 'm-drill-1', '25', 'party-drill-1', 1, 100, 'CONFIRMED', NOW(), 1)
    `, [COMPANY_ID]);

    await sourcePool.query(`
      INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id, qty)
      VALUES ('te-drill-1', '00000000-0000-4000-8000-000000000501', $1, 'Bichish', 501, 100)
    `, [COMPANY_ID]);

    await sourcePool.query(`
      INSERT INTO production_adjustments (adjustment_id, company_id, model_id, worker_id, op_name, delta_qty, reason, created_by)
      VALUES ('adj-drill-1', $1, 'm-drill-1', 501, 'Bichish', 5, 'Material defekti kompensatsiyasi', 'admin')
    `, [COMPANY_ID]);

    await sourcePool.query(`
      INSERT INTO operations_dedup (company_id, operation_id, command_type, entity_type, entity_id, payload_hash, result_json, server_revision)
      VALUES ($1, 'op-drill-1', 'SubmitTicket', 'ticket', '00000000-0000-4000-8000-000000000501', 'hash-drill-1', '{"status":"CONFIRMED"}', 1)
    `, [COMPANY_ID]);

    await sourcePool.query(`
      INSERT INTO change_log (company_id, entity_type, entity_id, entity_revision, operation_id, change_type, payload_json)
      VALUES ($1, 'ticket', '00000000-0000-4000-8000-000000000501', 1, 'op-drill-1', 'INSERT', '{"id":"00000000-0000-4000-8000-000000000501","qty":100}')
    `, [COMPANY_ID]);

    await sourcePool.query(`
      INSERT INTO party_sequence_leases (lease_id, company_id, device_id, range_start, range_end, next_value, expires_at_server)
      VALUES ('lease-drill-1', $1, 'device-drill-1', 1, 50, 26, NOW() + INTERVAL '1 hour')
    `, [COMPANY_ID]);

    await sourcePool.query(`
      INSERT INTO server_devices (device_id, company_id, token_hash, client_version, is_revoked)
      VALUES ('device-drill-1', $1, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '2.0.0', false)
    `, [COMPANY_ID]);

    // 2. Perform pg_dump backup
    const dumpResult = dumpDatabase({
      database: SOURCE_DB,
      outputFile: tempDumpFile,
      host: '127.0.0.1',
      port: 5432,
      user: decodeURIComponent(sourceUrl!.username),
      useWsl: false,
      dockerContainer
    });

    expect(dumpResult.success).toBe(true);
    expect(dumpResult.byteSize).toBeGreaterThan(500);
    expect(fs.existsSync(tempDumpFile)).toBe(true);

    // 3. Restore dump into different isolated database (hisob_restore_drill)
    const restoreResult = restoreDatabase({
      database: RESTORE_DB,
      inputFile: tempDumpFile,
      host: '127.0.0.1',
      port: 5432,
      user: decodeURIComponent(sourceUrl!.username),
      useWsl: false,
      dockerContainer
    });
    expect(restoreResult.success).toBe(true);

    // 4. Verify restored database has 100% exact parity with source database
    const verification = await verifyRestoredDatabase(sourcePool, restorePool!, COMPANY_ID);

    expect(verification.success).toBe(true);
    expect(verification.tableCounts.models.target).toBe(1);
    expect(verification.tableCounts.workers.target).toBe(1);
    expect(verification.tableCounts.tickets.target).toBe(1);
    expect(verification.tableCounts.ticket_entries.target).toBe(1);
    expect(verification.tableCounts.production_adjustments.target).toBe(1);
    expect(verification.tableCounts.operations_dedup.target).toBe(1);
    expect(verification.tableCounts.change_log.target).toBe(1);
    expect(verification.tableCounts.party_sequence_leases.target).toBe(1);
    expect(verification.tableCounts.server_devices.target).toBe(1);
  });
});
