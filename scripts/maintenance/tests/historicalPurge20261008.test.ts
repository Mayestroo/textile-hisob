import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const Database = require('better-sqlite3');
const { Pool } = require('pg');
const { applyMigrations: applySqliteMigrations } = require('../../../apps/desktop/electron/database/core/migrationRunner.cjs');
const { insertOutboxOperation, getOperation } = require('../../../apps/desktop/electron/database/outbox/outboxManager.cjs');
const { reapplyBootstrapAfterHistoricalPurge, applyBootstrapSnapshot } = require('../../../apps/desktop/electron/sync/bootstrapApplier.cjs');
const { executeReconnectProtocol } = require('../../../apps/desktop/electron/sync/reconnectManager.cjs');
const { SyncClient } = require('../../../apps/desktop/electron/sync/syncClient.cjs');
const { backupCompanyDatabase, restoreCompanyDatabase } = require('../../../apps/desktop/electron/database/maintenance/sqliteBackup.cjs');
const { closeAllCompanyDatabases } = require('../../../apps/desktop/electron/database/core/databaseManager.cjs');
const { canonicalStringify, computePayloadHash } = require('../../../apps/desktop/electron/database/core/canonicalPayload.cjs');
const { ticketEntryId } = require('../../../packages/contracts/ticketEntryIdentity.cjs');
const { verifyPostgresReleaseState } = require('../../../apps/server/infrastructure/postgresIntegrity.cjs');
const { buildFastifyServer } = require('../../../apps/server/app.cjs');
const {
  readActivePurgeEra,
  assertChangeFeedAllowedUnderPurgeFence,
  assertOperationAllowedUnderPurgeFence
} = require('../../../apps/server/modules/sync/historicalPurgeFence.cjs');
const {
  TARGET_TENANT_ID,
  CUTOFF_DATE,
  CUTOFF_UTC,
  computeManifestSha256,
  assertDisposablePostgresTarget,
  buildHistoricalPurgeManifest,
  executeDisposableHistoricalPurge
} = require('../lib/historicalPurgePlanner.cjs');
const { parseArgs } = require('../historical-purge-2026-10-08.cjs');

function createSqliteTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySqliteMigrations(db);
  return db;
}

function makeBootstrapResponse(companyId, options = {}) {
  const cursor = options.cursor || '7200';
  const purgeEra = options.purgeEra === undefined ? {
    purgeId: `purge_${companyId}_2026-10-08_gen1_test`,
    companyId,
    purgeGeneration: 1,
    cutoffDate: CUTOFF_DATE,
    cutoffUtc: CUTOFF_UTC,
    timezone: 'Asia/Tashkent',
    minValidCursor: cursor,
    manifestSha256: 'a'.repeat(64),
    baselinePurged: true,
    executedAt: '2026-11-11T00:00:00.000Z'
  } : options.purgeEra;

  return {
    success: true,
    cursor,
    nextPattaNumber: options.nextPattaNumber || 5,
    feedBaseline: { asOfCursor: cursor },
    ...(purgeEra ? { purgeEra } : {}),
    counts: {
      models: 1,
      workers: 1,
      periods: options.periods?.length ?? 1,
      legacyPartyCollisionExceptions: 0,
      parties: options.parties?.length ?? 1,
      workerAdjustments: 0,
      tickets: options.tickets?.length ?? 1,
      ticketEntries: options.tickets ? options.tickets.reduce((s, t) => s + t.entries.length, 0) : 1,
      productionAdjustments: 0,
      companyBatchSettings: 1,
      pattaBatchSettings: 1,
      periodArchives: 0
    },
    snapshot: {
      schemaVersion: 1,
      company: { companyId, companyName: 'Novda Test', requireTicketValidation: true, isActive: true },
      models: [{
        id: 'model-1',
        companyId,
        name: 'Model A',
        hisobSheetName: null,
        title: null,
        party: null,
        color: null,
        size: null,
        operations: [{ name: 'Chok', rate: 100 }],
        pattaOpsOrder: ['Chok'],
        status: 'ACTIVE',
        serverRevision: 1,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-10-08T05:00:00.000Z'
      }],
      workers: [{
        id: 1,
        companyId,
        name: 'Worker 1',
        staj: 1000,
        role: 'Tikuvchi',
        status: 'ACTIVE',
        legacyAvans: 0,
        legacyJarima: 0,
        serverRevision: 1,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-10-08T05:00:00.000Z'
      }],
      periods: options.periods || [{
        id: 'period-oct',
        companyId,
        name: '2026-Oktabr',
        startDate: '2026-10-05',
        endDate: null,
        isClosed: false,
        closedAt: null,
        notes: null,
        archiveFilename: null,
        status: 'OPEN',
        serverRevision: 1,
        createdAt: '2026-10-05T00:00:00.000Z',
        updatedAt: '2026-10-08T05:00:00.000Z',
        closeOperationId: null
      }],
      legacyPartyCollisionExceptions: [],
      parties: options.parties || [{
        id: 'party-oct-1',
        companyId,
        partyNumber: '1',
        physicalPartyNumber: '1',
        modelId: 'model-1',
        modelName: 'Model A',
        color: 'Black',
        pattaCount: 1,
        cumulativePattaCount: 1,
        pattaStartNumber: 1,
        pattaEndNumber: 1,
        ishSoniPerPatta: 50,
        totalIshSoni: 50,
        ishSoni: 50,
        cumulativeIshSoni: 50,
        sizes: { L: 50 },
        sizeOrder: ['L'],
        printedAt: '2026-10-08T04:00:00.000Z',
        isClosed: false,
        closedAt: null,
        archivedPattaNumbers: [],
        status: 'ACTIVE',
        serverRevision: 1,
        createdAt: '2026-10-08T04:00:00.000Z',
        updatedAt: '2026-10-08T04:00:00.000Z',
        isArchived: false,
        endedAt: null,
        endedOperationId: null,
        monthClosedPeriodId: null
      }],
      workerAdjustments: [],
      tickets: options.tickets || [{
        id: '11111111-1111-4111-8111-111111111111',
        companyId,
        modelId: 'model-1',
        periodId: 'period-oct',
        partyNumber: '1',
        partyRecordId: 'party-oct-1',
        pattaNumber: 1,
        qty: 50,
        size: 'L',
        color: 'Black',
        konveyer: '1',
        status: 'CONFIRMED',
        isClosed: false,
        submittedAt: '2026-10-08T04:51:29.104Z',
        createdAt: '2026-10-08T04:51:29.104Z',
        serverRevision: 1,
        entries: [{
          id: ticketEntryId('11111111-1111-4111-8111-111111111111', 0),
          companyId,
          opName: 'Chok',
          workerId: 1,
          workerNameSnapshot: 'Worker 1',
          rateSnapshot: 100,
          brak: null,
          qty: 50,
          createdAt: '2026-10-08T04:51:29.104Z'
        }]
      }],
      productionAdjustments: [],
      batchSettings: {
        company: { companyId, availableSizes: ['L'], serverRevision: 3, updatedAt: '2026-10-08T05:00:00.000Z' },
        models: [{
          companyId,
          modelId: 'model-1',
          partyNumber: '1',
          isCustomParty: false,
          totalIshSoni: '50',
          color: 'Black',
          sizes: { L: 50 },
          sizeNames: ['L'],
          serverRevision: 1,
          updatedAt: '2026-10-08T05:00:00.000Z'
        }]
      },
      periodArchives: []
    }
  };
}

describe('NOVDA Historical Purge 2026-10-08 — Unit, Boundary & SQLite Anti-Resurrection Suite', () => {
  it('defaults CLI flags to read-only dry-run and strictly rejects production targets', () => {
    const defaults = parseArgs([]);
    expect(defaults.mode).toBe('dry-run');
    expect(defaults.tenant).toBe(TARGET_TENANT_ID);
    expect(defaults.cutoff).toBe(CUTOFF_DATE);

    expect(() => assertDisposablePostgresTarget('postgresql://novda_admin:secret@77.88.99.10:5432/novda_hisob'))
      .toThrow(/non-loopback/i);
    expect(() => assertDisposablePostgresTarget('postgresql://postgres:pw@127.0.0.1:5432/novda_prod'))
      .toThrow(/non-disposable|PRODUCTION_TARGET_REJECTED/i);
    expect(() => assertDisposablePostgresTarget('postgresql://postgres:pw@127.0.0.1:5432/hisob_test_a', {
      env: { DATABASE_URL: 'postgresql://postgres:pw@127.0.0.1:5432/hisob_test_a' }
    })).toThrow(/DATABASE_URL/);
    expect(() => assertDisposablePostgresTarget('postgresql://postgres:pw@127.0.0.1:55439/hisob_test_rehearsal', {
      requireExecuteConfirmation: true,
      confirmDisposableTarget: false,
      env: {}
    })).toThrow(/DISPOSABLE_CONFIRMATION_REQUIRED/);

    expect(assertDisposablePostgresTarget('postgresql://postgres:pw@127.0.0.1:55439/hisob_test_rehearsal', {
      requireExecuteConfirmation: true,
      confirmDisposableTarget: true,
      env: {}
    })).toEqual({ host: '127.0.0.1', port: 55439, database: 'hisob_test_rehearsal' });
  });

  it('computes deterministic manifest SHA-256 independent of generatedAt timestamp', () => {
    const core = { tenantId: 'comp_novda', counts: { b: 2, a: 1 }, generatedAt: '2026-11-11T00:00:00Z' };
    const reordered = { counts: { a: 1, b: 2 }, tenantId: 'comp_novda', generatedAt: '2026-11-12T00:00:00Z' };
    expect(computeManifestSha256(core)).toBe(computeManifestSha256(reordered));
  });

  it('enforces exact exclusive boundary 2026-10-08 Asia/Tashkent (2026-10-07T19:00:00Z) on server sync fence', async () => {
    const era = {
      purgeId: 'purge_1',
      companyId: 'comp_novda',
      purgeGeneration: 1,
      cutoffDate: CUTOFF_DATE,
      cutoffUtc: CUTOFF_UTC,
      timezone: 'Asia/Tashkent',
      minValidCursor: '7119',
      manifestSha256: 'a'.repeat(64),
      baselinePurged: true
    };
    const mockClient = {
      query: async (sql) => {
        if (sql.includes('FROM historical_purge_eras')) {
          return {
            rows: [{
              purge_id: era.purgeId,
              company_id: era.companyId,
              purge_generation: era.purgeGeneration,
              cutoff_date: era.cutoffDate,
              cutoff_utc: era.cutoffUtc,
              timezone: era.timezone,
              min_valid_cursor: era.minValidCursor,
              manifest_sha256: era.manifestSha256,
              baseline_purged: true,
              executed_at: '2026-11-11T00:00:00Z'
            }]
          };
        }
        if (sql.includes('FROM purged_operation_tombstones')) return { rows: [] };
        if (sql.includes('FROM purged_entity_tombstones')) return { rows: [] };
        return { rows: [] };
      }
    };

    expect(await readActivePurgeEra(mockClient, 'comp_novda')).toMatchObject({ purgeGeneration: 1, minValidCursor: '7119' });
    expect(assertChangeFeedAllowedUnderPurgeFence(era, '612', null)).toMatchObject({
      allowed: false,
      code: 'HISTORY_PURGED_REBOOTSTRAP_REQUIRED'
    });
    expect(assertChangeFeedAllowedUnderPurgeFence(era, '7119', 1)).toMatchObject({ allowed: true });
    expect(assertChangeFeedAllowedUnderPurgeFence(era, '7120', 0)).toMatchObject({
      allowed: false,
      code: 'HISTORY_PURGED_REBOOTSTRAP_REQUIRED'
    });

    // 2026-10-07 23:59:59.999 UZT === 2026-10-07T18:59:59.999Z -> REJECTED
    await expect(assertOperationAllowedUnderPurgeFence(
      mockClient,
      'comp_novda',
      { headers: { 'x-purge-generation': '1' } },
      { operationId: 'op-pre', commandType: 'SubmitTicket', entityType: 'ticket', entityId: 't-pre' },
      { submittedAt: '2026-10-07T18:59:59.999Z' }
    )).rejects.toMatchObject({ code: 'HISTORY_PURGED_PRE_CUTOFF' });

    // Submitted Oct 7 14:08 UZT even with later createdAt -> REJECTED by authoritative submittedAt
    await expect(assertOperationAllowedUnderPurgeFence(
      mockClient,
      'comp_novda',
      { headers: { 'x-purge-generation': '1' } },
      { operationId: 'op-anom', commandType: 'SubmitTicket', entityType: 'ticket', entityId: 't-anom' },
      { submittedAt: '2026-10-07T09:08:13.649Z', createdAt: '2026-10-08T13:18:56.053Z' }
    )).rejects.toMatchObject({ code: 'HISTORY_PURGED_PRE_CUTOFF' });

    // 2026-10-08 00:00:00.000 UZT === 2026-10-07T19:00:00.000Z -> ALLOWED
    await expect(assertOperationAllowedUnderPurgeFence(
      mockClient,
      'comp_novda',
      { headers: { 'x-purge-generation': '1' } },
      { operationId: 'op-oct8', commandType: 'SubmitTicket', entityType: 'ticket', entityId: 't-oct8' },
      { submittedAt: '2026-10-07T19:00:00.000Z' }
    )).resolves.toMatchObject({ purgeGeneration: 1 });

    // Stale purgeGeneration -> requires rebootstrap first
    await expect(assertOperationAllowedUnderPurgeFence(
      mockClient,
      'comp_novda',
      { headers: { 'x-purge-generation': '0' } },
      { operationId: 'op-stale', commandType: 'SubmitTicket', entityType: 'ticket', entityId: 't-oct8' },
      { submittedAt: '2026-10-08T05:00:00.000Z' }
    )).rejects.toMatchObject({ code: 'HISTORY_PURGED_REBOOTSTRAP_REQUIRED' });
  });

  it('re-bootstraps stale SQLite offline profile, quarantines pre-cutoff ops & dependents, and preserves valid Oct 8+ ops', async () => {
    const db = createSqliteTestDb();
    try {
      const companyId = 'comp_novda';
      const initialBoot = makeBootstrapResponse(companyId, {
        cursor: '612',
        purgeEra: null,
        periods: [
          {
            id: 'period-sep',
            companyId,
            name: '2026-Sentabr',
            startDate: '2026-09-01',
            endDate: '2026-10-03',
            isClosed: true,
            closedAt: '2026-10-05T10:00:00.000Z',
            notes: null,
            archiveFilename: null,
            status: 'CLOSED',
            serverRevision: 2,
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-10-05T10:00:00.000Z',
            closeOperationId: null
          },
          {
            id: 'period-oct',
            companyId,
            name: '2026-Oktabr',
            startDate: '2026-10-05',
            endDate: null,
            isClosed: false,
            closedAt: null,
            notes: null,
            archiveFilename: null,
            status: 'OPEN',
            serverRevision: 1,
            createdAt: '2026-10-05T00:00:00.000Z',
            updatedAt: '2026-10-06T00:00:00.000Z',
            closeOperationId: null
          }
        ],
        parties: [
          {
            id: 'party-sep-closed',
            companyId,
            partyNumber: '1',
            physicalPartyNumber: '1',
            modelId: 'model-1',
            modelName: 'Model A',
            color: 'Black',
            pattaCount: 1,
            cumulativePattaCount: 1,
            pattaStartNumber: 1,
            pattaEndNumber: 1,
            ishSoniPerPatta: 25,
            totalIshSoni: 25,
            ishSoni: 25,
            cumulativeIshSoni: 25,
            sizes: { L: 25 },
            sizeOrder: ['L'],
            printedAt: '2026-09-10T05:00:00.000Z',
            isClosed: true,
            closedAt: '2026-10-06T06:00:00.000Z',
            archivedPattaNumbers: [],
            status: 'CLOSED',
            serverRevision: 2,
            createdAt: '2026-09-10T05:00:00.000Z',
            updatedAt: '2026-10-06T06:00:00.000Z',
            isArchived: false,
            endedAt: null,
            endedOperationId: null,
            monthClosedPeriodId: null
          },
          {
            id: 'party-oct-1',
            companyId,
            partyNumber: '1',
            physicalPartyNumber: '1',
            modelId: 'model-1',
            modelName: 'Model A',
            color: 'Black',
            pattaCount: 1,
            cumulativePattaCount: 1,
            pattaStartNumber: 2,
            pattaEndNumber: 2,
            ishSoniPerPatta: 50,
            totalIshSoni: 50,
            ishSoni: 50,
            cumulativeIshSoni: 50,
            sizes: { L: 50 },
            sizeOrder: ['L'],
            printedAt: '2026-10-08T04:00:00.000Z',
            isClosed: false,
            closedAt: null,
            archivedPattaNumbers: [],
            status: 'ACTIVE',
            serverRevision: 1,
            createdAt: '2026-10-08T04:00:00.000Z',
            updatedAt: '2026-10-08T04:00:00.000Z',
            isArchived: false,
            endedAt: null,
            endedOperationId: null,
            monthClosedPeriodId: null
          }
        ],
        tickets: []
      });
      applyBootstrapSnapshot(db, companyId, initialBoot);

      // Save draft in local_ticket_forms to verify ON DELETE CASCADE preservation
      db.prepare(`
        INSERT INTO local_ticket_forms (company_id, model_id, form_json, updated_at)
        VALUES (?, 'model-1', '{"partyNumber":"1","pattaNumber":2,"qty":10}', '2026-10-08T06:00:00.000Z')
      `).run(companyId);

      // 1) Queue Oct 6 stale UpdateBatchSettings (mirrors comp_novda_before_reset profile!)
      const oct6BatchPayload = { availableSizes: ['L'], configs: [{ modelId: 'model-1', sizes: { L: 25 } }] };
      insertOutboxOperation(db, {
        operation_id: 'op-oct6-batch',
        company_id: companyId,
        command_type: 'UpdateBatchSettings',
        entity_type: 'company_batch_settings',
        entity_id: companyId,
        base_revision: 1,
        payload_json: canonicalStringify(oct6BatchPayload),
        payload_hash: computePayloadHash(canonicalStringify(oct6BatchPayload)),
        causal_sequence: 1,
        created_at: '2026-10-06T10:36:48.343Z'
      });

      // 2) Queue causal child depending on quarantined op
      const depPayload = { ticketId: '22222222-2222-4222-8222-222222222222', modelId: 'model-1', qty: 10, submittedAt: '2026-10-09T05:00:00.000Z', entries: [{ opName: 'Chok', workerId: 1 }] };
      insertOutboxOperation(db, {
        operation_id: 'op-dep-on-oct6',
        company_id: companyId,
        command_type: 'SubmitTicket',
        entity_type: 'ticket',
        entity_id: '22222222-2222-4222-8222-222222222222',
        base_revision: 0,
        depends_on_operation_id: 'op-oct6-batch',
        payload_json: canonicalStringify(depPayload),
        payload_hash: computePayloadHash(canonicalStringify(depPayload)),
        causal_sequence: 2,
        created_at: '2026-10-09T05:00:00.000Z'
      });

      // 3) Queue valid post-cutoff Oct 8+ offline SubmitTicket + provisional PENDING_SYNC row
      const oct8TicketId = '33333333-3333-4333-8333-333333333333';
      const oct8Payload = {
        ticketId: oct8TicketId,
        modelId: 'model-1',
        partyNumber: '1',
        partyRecordId: 'party-oct-1',
        pattaNumber: 3,
        qty: 40,
        submittedAt: '2026-10-08T05:00:00.000Z',
        entries: [{ opName: 'Chok', workerId: 1 }]
      };
      insertOutboxOperation(db, {
        operation_id: 'op-oct8-valid-submit',
        company_id: companyId,
        command_type: 'SubmitTicket',
        entity_type: 'ticket',
        entity_id: oct8TicketId,
        base_revision: 0,
        payload_json: canonicalStringify(oct8Payload),
        payload_hash: computePayloadHash(canonicalStringify(oct8Payload)),
        causal_sequence: 3,
        created_at: '2026-10-08T05:00:00.000Z'
      });
      db.prepare(`
        INSERT INTO tickets (
          id, company_id, model_id, period_id, party_number, party_record_id, patta_number, qty,
          status, is_closed, submitted_at, created_at, provenance, server_revision
        ) VALUES (?, ?, 'model-1', 'period-oct', '1', 'party-oct-1', 3, 40, 'PENDING_SYNC', 0,
          '2026-10-08T05:00:00.000Z', '2026-10-08T05:00:00.000Z', 'LOCAL_COMMAND', 0)
      `).run(oct8TicketId, companyId);
      db.prepare(`
        INSERT INTO ticket_entries (
          id, ticket_id, company_id, op_name, worker_id, worker_name_snapshot, rate_snapshot, qty, created_at
        ) VALUES (?, ?, ?, 'Chok', 1, 'Worker 1', 100, 40, '2026-10-08T05:00:00.000Z')
      `).run(ticketEntryId(oct8TicketId, 0), oct8TicketId, companyId);

      // Rollback safety check: failed rebootstrap leaves local state unchanged
      const postPurgeBoot = makeBootstrapResponse(companyId, { cursor: '7200' });
      expect(() => reapplyBootstrapAfterHistoricalPurge(db, companyId, postPurgeBoot, {
        testHookBeforeCommit: () => { throw new Error('SIMULATED_CRASH'); }
      })).toThrow('SIMULATED_CRASH');
      expect(db.prepare('SELECT COUNT(*) AS c FROM periods WHERE id = ?').get('period-sep').c).toBe(1);
      expect(getOperation(db, companyId, 'op-oct6-batch').status).toBe('PENDING');

      // Now run full executeReconnectProtocol simulating server 409 HISTORY_PURGED_REBOOTSTRAP_REQUIRED
      const pushedBatches = [];
      let currentGen = null;
      let pulls = 0;
      const mockSyncClient = {
        setPurgeGeneration(g) { currentGen = Number(g); },
        async pullChanges(cursor) {
          pulls += 1;
          if (BigInt(cursor) < 7200n) {
            const err = new Error('Client cursor precedes purge');
            err.code = 'HISTORY_PURGED_REBOOTSTRAP_REQUIRED';
            throw err;
          }
          return {
            success: true,
            items: [],
            fromCursor: String(cursor),
            nextCursor: '7200',
            headCursor: '7200',
            companyId,
            feedProtocolVersion: 1,
            hasMore: false,
            nextPattaNumber: 5
          };
        },
        async getBootstrap() {
          return postPurgeBoot;
        },
        async pushOperations(ops) {
          pushedBatches.push({ currentGen, ops });
          return {
            success: true,
            results: ops.map((op) => ({
              operationId: op.operationId,
              status: 'APPLIED',
              payloadHash: op.payloadHash,
              serverRevision: 1,
              cursor: '7201',
              periodId: 'period-oct',
              committedAt: '2026-10-08T05:01:00.000Z'
            }))
          };
        }
      };

      const reconnectRes = await executeReconnectProtocol(db, companyId, mockSyncClient);
      expect(reconnectRes.purgeRebootstrapped).toBe(true);
      expect(reconnectRes.rebootstrap).toMatchObject({
        status: 'REBOOTSTRAPPED',
        quarantinedCount: 2,
        preservedPendingCount: 1,
        purgeGeneration: 1
      });
      expect(currentGen).toBe(1);
      expect(pulls).toBeGreaterThanOrEqual(2);
      expect(getOperation(db, companyId, 'op-oct6-batch').status).toBe('DEAD_LETTER');
      expect(getOperation(db, companyId, 'op-dep-on-oct6').status).toBe('DEAD_LETTER');
      expect(getOperation(db, companyId, 'op-oct8-valid-submit').status).toBe('SYNCED');
      expect(pushedBatches).toHaveLength(1);
      expect(pushedBatches[0].ops.map((o) => o.operationId)).toEqual(['op-oct8-valid-submit']);

      // Stale Sentabr period and closed pre-cutoff party are gone; form draft + Oct 8+ tickets remain!
      expect(db.prepare('SELECT COUNT(*) AS c FROM periods WHERE id = ?').get('period-sep').c).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS c FROM parties WHERE id = ?').get('party-sep-closed').c).toBe(0);
      expect(db.prepare('SELECT status FROM tickets WHERE id = ?').get(oct8TicketId)?.status).toBe('CONFIRMED');
      expect(db.prepare('SELECT COUNT(*) AS c FROM local_ticket_forms WHERE company_id = ?').get(companyId).c).toBe(1);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      db.close();
    }
  });

  it('creates verified SHA-256 SQLite backups and restores them cleanly into disposable profiles', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-sqlite-bkp-'));
    let restoredDb = null;
    try {
      const sourceUserData = path.join(tmpRoot, 'src');
      const targetUserData = path.join(tmpRoot, 'restored');
      const dbDir = path.join(sourceUserData, 'NovdaData', 'companies', 'comp_novda');
      fs.mkdirSync(dbDir, { recursive: true });
      const dbPath = path.join(dbDir, 'hisob.sqlite');
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      applySqliteMigrations(db);
      applyBootstrapSnapshot(db, 'comp_novda', makeBootstrapResponse('comp_novda', { cursor: '7119' }));
      db.close();

      const backupFile = path.join(tmpRoot, 'comp_novda_verified.sqlite');
      const bkpRes = await backupCompanyDatabase(sourceUserData, 'comp_novda', backupFile);
      expect(bkpRes.sha256).toMatch(/^[a-f0-9]{64}$/);
      const bytes = fs.readFileSync(backupFile);
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      expect(sha).toBe(bkpRes.sha256);

      const restoreRes = restoreCompanyDatabase(backupFile, targetUserData, 'comp_novda');
      expect(restoreRes.sha256).toBe(bkpRes.sha256);
      restoredDb = new Database(restoreRes.targetPath, { readonly: true });
      expect(restoredDb.prepare("SELECT value FROM local_meta WHERE key = 'sync_cursor'").get()?.value).toBe('7119');
      expect(restoredDb.prepare("SELECT value FROM local_meta WHERE key = 'purge_generation'").get()?.value).toBe('1');
      expect(restoredDb.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      if (restoredDb && restoredDb.open) restoredDb.close();
      closeAllCompanyDatabases();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

const pgUrl = process.env.NOVDA_DISPOSABLE_PG === '1' && !process.env.DATABASE_URL ? process.env.NOVDA_PG_URL : undefined;
const describeDisposablePg = pgUrl ? describe : describe.skip;

describeDisposablePg('DISPOSABLE PG16 Full Historical Purge + Server Sync Anti-Resurrection Integration', () => {
  it('rehearses rollback, atomic Sentabr purge, idempotency, verifyPostgresReleaseState, and live SyncClient convergence', async () => {
    assertDisposablePostgresTarget(pgUrl, { confirmDisposableTarget: true });
    const parsedUrl = new URL(pgUrl);
    const adminUrl = `${parsedUrl.protocol}//${parsedUrl.username}:${parsedUrl.password}@${parsedUrl.host}/postgres`;
    const scratchDb = `hisob_test_vitest_purge_${process.pid}_${Date.now().toString(36)}`;
    const adminPool = new Pool({ connectionString: adminUrl });
    let testPool;
    let fastify;

    try {
      // Clone hisob_test_purge_v30_test when available or fallback to current disposable DB
      const checkTemplate = await adminPool.query(`SELECT 1 FROM pg_database WHERE datname = 'hisob_test_purge_v30_test'`);
      if (checkTemplate.rows.length === 0) {
        return;
      }
      await adminPool.query(`DROP DATABASE IF EXISTS "${scratchDb}"`);
      await adminPool.query(`CREATE DATABASE "${scratchDb}" WITH TEMPLATE hisob_test_purge_v30_test OWNER postgres`);

      const testUrl = `${parsedUrl.protocol}//${parsedUrl.username}:${parsedUrl.password}@${parsedUrl.host}/${scratchDb}`;
      testPool = new Pool({ connectionString: testUrl });
      const client = await testPool.connect();

      let manifest;
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        manifest = await buildHistoricalPurgeManifest(client, { tenantId: TARGET_TENANT_ID });
        await client.query('COMMIT');
        expect(manifest.status).toBe('BLOCKED');
        expect(manifest.october8Protection.protectedTicketCount).toBe(22);

        // 1) Rollback test on injected failure
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await expect(executeDisposableHistoricalPurge(client, {
          tenantId: TARGET_TENANT_ID,
          manifest,
          manifestSha256: manifest.manifestSha256,
          disposableRehearsalScope: 'sentabr-approved-only',
          injectFailureBeforeCommit: true
        })).rejects.toThrow('PURGE_INJECTED_FAILURE_BEFORE_COMMIT');
        await client.query('ROLLBACK');
        expect((await client.query(`SELECT COUNT(*)::int AS c FROM tickets WHERE company_id='comp_novda'`)).rows[0].c).toBe(1976);

        // 2) Execute atomic Sentabr rehearsal purge
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const execRes = await executeDisposableHistoricalPurge(client, {
          tenantId: TARGET_TENANT_ID,
          manifest,
          manifestSha256: manifest.manifestSha256,
          disposableRehearsalScope: 'sentabr-approved-only'
        });
        await client.query('COMMIT');
        expect(execRes.status).toBe('EXECUTED_DISPOSABLE_REHEARSAL');
        expect(execRes.deleted.tickets).toBe(205);
        expect(execRes.deleted.periods).toBe(1);
        expect(execRes.deleted.parties).toBe(54);

        // 3) Re-run is an idempotent no-op
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const rerun = await executeDisposableHistoricalPurge(client, {
          tenantId: TARGET_TENANT_ID,
          manifest,
          manifestSha256: manifest.manifestSha256,
          disposableRehearsalScope: 'sentabr-approved-only'
        });
        await client.query('COMMIT');
        expect(rerun.status).toBe('NOOP_ALREADY_PURGED');

        // 4) Integrity verification passes with baseline_purged = true and unmatchedChangeLogOperations = 0
        const rel = await verifyPostgresReleaseState(client);
        expect(rel.baseline.scopePreserved).toBe(true);
        expect(rel.operations.unmatchedChangeLogOperations).toBe(0);
        expect(rel.purgeFence.baselinePurgedCompanies).toBe(1);
      } finally {
        client.release();
      }

      // 5) Live Fastify Server + HTTP SyncClient + SQLite anti-resurrection roundtrip
      fastify = buildFastifyServer({ pool: testPool, allowTestTokens: true });
      const address = await fastify.listen({ port: 0, host: '127.0.0.1' });
      const token = 'novda-test-token:comp_novda:dev_old_client';

      const oldClient = new SyncClient({ baseUrl: address, token, deviceId: 'dev_old_client', allowHttp: true });
      await expect(oldClient.pullChanges('612', 100)).rejects.toMatchObject({
        code: 'HISTORY_PURGED_REBOOTSTRAP_REQUIRED',
        statusCode: 409
      });

      // Tombstoned historical operation replay, tombstoned party reference, and pre-cutoff boundary are permanently rejected
      const staleOpId = manifest.classifications.operationsAndChangeLog.REHEARSAL_DELETE_AND_TOMBSTONE_OPERATION_IDS[0];
      const deletedPartyId = manifest.classifications.parties.DELETE_PRE_CUTOFF_CLOSED[0];
      const liveModelRes = await testPool.query(`SELECT id FROM models WHERE company_id = 'comp_novda' LIMIT 1`);
      const liveModelId = liveModelRes.rows[0].id;
      const liveWorkerRes = await testPool.query(`SELECT id FROM workers WHERE company_id = 'comp_novda' LIMIT 1`);
      const liveWorkerId = Number(liveWorkerRes.rows[0].id);

      const makeSubmitPayload = (opId, tId, overrides = {}) => ({
        commandId: opId,
        operationId: opId,
        companyId: 'comp_novda',
        ticketId: tId,
        modelId: liveModelId,
        partyNumber: '1',
        partyRecordId: null,
        pattaNumber: 1,
        qty: 10,
        submittedAt: '2026-09-15T10:00:00.000Z',
        entries: [{ opName: 'Chok', workerId: liveWorkerId, qty: 10 }],
        ...overrides
      });

      const replayPayload = makeSubmitPayload(staleOpId, '99999999-9999-4999-8999-999999999991');
      const partyRefOpId = 'op_retest_tomb_party_' + Date.now();
      const partyRefPayload = makeSubmitPayload(partyRefOpId, '99999999-9999-4999-8999-999999999992', {
        partyRecordId: deletedPartyId,
        submittedAt: '2026-10-09T10:00:00.000Z'
      });
      const preCutoffOpId = 'op_retest_pre_cutoff_' + Date.now();
      const preCutoffPayload = makeSubmitPayload(preCutoffOpId, '99999999-9999-4999-8999-999999999993', {
        submittedAt: '2026-10-07T18:59:59.999Z'
      });

      const opPushRes = await oldClient.pushOperations([
        {
          operationId: staleOpId,
          companyId: 'comp_novda',
          commandType: 'SubmitTicket',
          entityType: 'ticket',
          entityId: replayPayload.ticketId,
          baseRevision: 0,
          payloadHash: computePayloadHash(canonicalStringify(replayPayload)),
          payload: replayPayload
        },
        {
          operationId: partyRefOpId,
          companyId: 'comp_novda',
          commandType: 'SubmitTicket',
          entityType: 'ticket',
          entityId: partyRefPayload.ticketId,
          baseRevision: 0,
          payloadHash: computePayloadHash(canonicalStringify(partyRefPayload)),
          payload: partyRefPayload
        },
        {
          operationId: preCutoffOpId,
          companyId: 'comp_novda',
          commandType: 'SubmitTicket',
          entityType: 'ticket',
          entityId: preCutoffPayload.ticketId,
          baseRevision: 0,
          payloadHash: computePayloadHash(canonicalStringify(preCutoffPayload)),
          payload: preCutoffPayload
        }
      ]);
      expect(opPushRes.results[0]).toMatchObject({
        operationId: staleOpId,
        status: 'REJECTED',
        error: { code: 'OPERATION_PURGED_IN_HISTORICAL_RESET' }
      });
      expect(opPushRes.results[1]).toMatchObject({
        operationId: partyRefOpId,
        status: 'REJECTED',
        error: { code: 'HISTORICAL_ENTITY_PURGED' }
      });
      expect(opPushRes.results[2]).toMatchObject({
        operationId: preCutoffOpId,
        status: 'REJECTED',
        error: { code: 'HISTORY_PURGED_PRE_CUTOFF' }
      });

      // Stale pre-purge SQLite terminal recovers cleanly via executeReconnectProtocol
      const sqldb = createSqliteTestDb();
      try {
        applyBootstrapSnapshot(sqldb, 'comp_novda', makeBootstrapResponse('comp_novda', { cursor: '612', purgeEra: null }));
        const staleBatch = { companyId: 'comp_novda', availableSizes: ['L'], configs: [] };
        insertOutboxOperation(sqldb, {
          operation_id: staleOpId,
          company_id: 'comp_novda',
          command_type: 'UpdateBatchSettings',
          entity_type: 'batch_settings',
          entity_id: 'comp_novda',
          base_revision: 1,
          payload_json: canonicalStringify(staleBatch),
          payload_hash: computePayloadHash(canonicalStringify(staleBatch)),
          causal_sequence: 1,
          created_at: '2026-10-06T10:36:48.343Z'
        });

        const recRes = await executeReconnectProtocol(sqldb, 'comp_novda', oldClient);
        expect(recRes.purgeRebootstrapped).toBe(true);
        expect(getOperation(sqldb, 'comp_novda', staleOpId).status).toBe('DEAD_LETTER');
        expect(Number(sqldb.prepare("SELECT value FROM local_meta WHERE key='purge_generation'").get()?.value)).toBe(1);
        expect(sqldb.prepare('SELECT COUNT(*) AS c FROM tickets WHERE company_id = ?').get('comp_novda').c).toBe(1771);
      } finally {
        sqldb.close();
      }
    } finally {
      if (fastify) await fastify.close();
      if (testPool) await testPool.end();
      await adminPool.query(`DROP DATABASE IF EXISTS "${scratchDb}"`);
      await adminPool.end();
    }
  }, 120_000);
});
