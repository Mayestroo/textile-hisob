import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hydrateWorkbookProjection } from '../../renderer/store/businessMutations';
import { selectPartyDashboardRecords, selectWorkerCount } from '../../renderer/store/selectors';

const databaseManager = require('../database/databaseManager.cjs');
const { sanitizeCompanyDbPath } = require('../database/companyPath.cjs');
const { loadWorkbookProjectionFromSqlite } = require('../database/projectionReader.cjs');
const { ensureCompanyBootstrapped } = require('./bootstrapInitializer.cjs');
const { applyBootstrapSnapshot } = require('./bootstrapApplier.cjs');
const { getBootstrapFixture } = require('../tests/fixtures/bootstrap.fixture.cjs');

const COMPANY_ID = 'comp_novda';

function getProductionLikeBootstrapFixture(companyId: string) {
  const base = getBootstrapFixture(companyId);
  const now = '2026-09-01T00:00:00.000Z';
  const models = Array.from({ length: 18 }, (_, index) => ({
    ...base.snapshot.models[0],
    id: `model-${index + 1}`,
    name: `Model ${index + 1}`,
    companyId,
    createdAt: now,
    updatedAt: now
  }));
  const workers = Array.from({ length: 201 }, (_, index) => ({
    ...base.snapshot.workers[0],
    id: index + 1,
    name: `Worker ${index + 1}`,
    companyId,
    createdAt: now,
    updatedAt: now
  }));
  const periods = [{
    ...base.snapshot.periods[0],
    id: 'period-september-2026',
    companyId,
    name: '2026-Sentabr oyligi',
    startDate: '2026-09-07',
    isClosed: false,
    createdAt: now,
    updatedAt: now
  }];
  const parties = Array.from({ length: 42 }, (_, index) => ({
    ...base.snapshot.parties[0],
    id: `party-${index + 1}`,
    companyId,
    partyNumber: String(index + 1),
    physicalPartyNumber: String(index + 1),
    modelId: models[index % models.length].id,
    modelName: models[index % models.length].name,
    isClosed: false,
    isArchived: false,
    printedAt: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: now
  }));
  const batchSettings = {
    company: { companyId, availableSizes: ['S', 'M', 'L'], serverRevision: 1, updatedAt: now },
    models: models.map((model) => ({
      companyId,
      modelId: model.id,
      partyNumber: '',
      isCustomParty: false,
      totalIshSoni: '',
      sizes: {},
      serverRevision: 1,
      updatedAt: now
    }))
  };
  const snapshot = {
    ...base.snapshot,
    models,
    workers,
    periods,
    parties,
    batchSettings
  };

  return {
    success: true,
    snapshot,
    cursor: '0',
    nextPattaNumber: base.nextPattaNumber,
    counts: {
      models: models.length,
      workers: workers.length,
      periods: periods.length,
      legacyPartyCollisionExceptions: base.snapshot.legacyPartyCollisionExceptions.length,
      parties: parties.length,
      workerAdjustments: 0,
      tickets: 0,
      ticketEntries: 0,
      productionAdjustments: 0,
      periodArchives: 0
    }
  };
}

describe(' startup bootstrap ordering and preservation', () => {
  let userData: string;
  let db: any;

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-bootstrap-startup-'));
    db = databaseManager.getCompanyDatabase(userData, COMPANY_ID);
  });

  afterEach(() => {
    databaseManager.closeAllCompanyDatabases();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('fetches and commits PostgreSQL state before startup reports bootstrap complete', async () => {
    const response = getBootstrapFixture(COMPANY_ID);
    const syncClient = { getBootstrap: vi.fn(async () => response) };

    await expect(ensureCompanyBootstrapped(db, COMPANY_ID, syncClient)).resolves.toMatchObject({
      status: 'APPLIED', cursor: response.cursor
    });
    expect(syncClient.getBootstrap).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT value FROM local_meta WHERE key = '_bootstrap_complete'").get().value).toBe('1');
  });

  it('does not request a full snapshot for an existing completed  database', async () => {
    const response = getBootstrapFixture(COMPANY_ID);
    applyBootstrapSnapshot(db, COMPANY_ID, response);
    const syncClient = { getBootstrap: vi.fn() };

    await expect(ensureCompanyBootstrapped(db, COMPANY_ID, syncClient)).resolves.toMatchObject({
      status: 'ALREADY_BOOTSTRAPPED', cursor: response.cursor
    });
    expect(syncClient.getBootstrap).not.toHaveBeenCalled();
  });

  it('restarts from the completed SQLite database and hydrates the global 201/18/42 renderer projections', async () => {
    const response = getProductionLikeBootstrapFixture(COMPANY_ID);
    const syncClient = { getBootstrap: vi.fn(async () => response) };

    await expect(ensureCompanyBootstrapped(db, COMPANY_ID, syncClient)).resolves.toMatchObject({ status: 'APPLIED' });
    syncClient.getBootstrap.mockClear();
    await expect(ensureCompanyBootstrapped(db, COMPANY_ID, syncClient)).resolves.toMatchObject({ status: 'ALREADY_BOOTSTRAPPED' });

    const expectedPath = sanitizeCompanyDbPath(userData, COMPANY_ID);
    expect(path.resolve(db.name)).toBe(expectedPath);
    expect(syncClient.getBootstrap).not.toHaveBeenCalled();

    const sqliteProjection = loadWorkbookProjectionFromSqlite(db, COMPANY_ID);
    const rendererProjection = hydrateWorkbookProjection(sqliteProjection, COMPANY_ID);
    expect(rendererProjection.companyId).toBe(COMPANY_ID);
    expect(selectWorkerCount({ workers: rendererProjection.workers })).toBe(201);
    expect(rendererProjection.models).toHaveLength(18);
    expect(rendererProjection.printedPartyHistory).toHaveLength(42);
    expect(rendererProjection.currentPeriod.id).toBe('period-september-2026');
    expect(selectPartyDashboardRecords(rendererProjection)).toHaveLength(42);
    expect(selectPartyDashboardRecords(rendererProjection).every((party: any) => party.printedAt.startsWith('2026-08'))).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM patta_batch_settings WHERE company_id = ?').get(COMPANY_ID).count).toBe(18);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tickets WHERE company_id = ?').get(COMPANY_ID).count).toBe(0);
    expect(rendererProjection.printedPartyHistory.every((party: any) => !party.isClosed)).toBe(true);
  });

  it('preserves a stale legacy JSON profile physically while PostgreSQL response alone initializes ', async () => {
    const legacyPath = path.join(userData, 'NovdaData', 'hisob_database_comp_novda.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const legacyEvidence = JSON.stringify({ companyId: COMPANY_ID, workers: [{ id: 999, name: 'Stale legacy worker' }] });
    fs.writeFileSync(legacyPath, legacyEvidence, 'utf8');
    const indexedDbPath = path.join(userData, 'IndexedDB', 'legacy-profile', 'data.mdb');
    fs.mkdirSync(path.dirname(indexedDbPath), { recursive: true });
    const indexedDbEvidence = Buffer.from('legacy IndexedDB queue evidence');
    fs.writeFileSync(indexedDbPath, indexedDbEvidence);
    const syncClient = { getBootstrap: vi.fn(async () => getBootstrapFixture(COMPANY_ID)) };

    await ensureCompanyBootstrapped(db, COMPANY_ID, syncClient);

    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyEvidence);
    expect(fs.readFileSync(indexedDbPath)).toEqual(indexedDbEvidence);
    expect(db.prepare('SELECT COUNT(*) AS count FROM workers WHERE id = 999').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM workers WHERE company_id = ?').get(COMPANY_ID).count).toBe(1);
  });

  it('never requests or applies bootstrap over an existing unsynced local outbox operation', async () => {
    const payloadJson = JSON.stringify({ commandId: 'pending', companyId: COMPANY_ID });
    const hash = require('node:crypto').createHash('sha256').update(payloadJson).digest('hex');
    db.prepare(`INSERT INTO local_outbox (
      operation_id, company_id, command_type, entity_type, entity_id, base_revision,
      payload_json, payload_hash, causal_sequence, status, created_at, updated_at
    ) VALUES ('pending-operation', ?, 'SubmitTicket', 'ticket', 'pending-ticket', 0, ?, ?, 1, 'PENDING', datetime('now'), datetime('now'))`)
      .run(COMPANY_ID, payloadJson, hash);
    const syncClient = { getBootstrap: vi.fn(async () => getBootstrapFixture(COMPANY_ID)) };

    await expect(ensureCompanyBootstrapped(db, COMPANY_ID, syncClient))
      .rejects.toMatchObject({ code: 'BOOTSTRAP_RECOVERY_REQUIRED' });
    expect(syncClient.getBootstrap).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id = ?').get('pending-operation').status).toBe('PENDING');
    expect(db.prepare('SELECT COUNT(*) AS count FROM workers').get().count).toBe(0);
  });
});
