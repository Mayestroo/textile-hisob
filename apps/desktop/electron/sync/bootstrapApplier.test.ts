import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const databaseManager = require('../database/databaseManager.cjs');
const { applyBootstrapSnapshot, getBootstrapState, validateBootstrapResponse } = require('./bootstrapApplier.cjs');
const { loadWorkbookProjectionFromSqlite } = require('../database/projectionReader.cjs');
const { canonicalStringify, computePayloadHash } = require('../database/canonicalPayload.cjs');

const COMPANY_ID = 'comp_novda';

function makeProductionLikeBootstrap() {
  const models = Array.from({ length: 18 }, (_, index) => ({
    id: `model_${index + 1}`,
    companyId: COMPANY_ID,
    name: `Model ${index + 1}`,
    operations: [{ id: 'operation-sew', name: 'Sew', rate: 12.5 }],
    hisobSheetName: `Model ${index + 1}-hisob`,
    title: `Model- ${index + 1}`,
    party: '',
    color: 'Black',
    size: 'M',
    pattaOpsOrder: ['Sew'],
    status: 'ACTIVE',
    serverRevision: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z'
  }));
  const workers = Array.from({ length: 201 }, (_, index) => ({
    id: index + 1,
    companyId: COMPANY_ID,
    name: `Worker ${index + 1}`,
    status: 'ACTIVE',
    staj: 0,
    role: 'Operator',
    legacyAvans: 0,
    legacyJarima: 0,
    serverRevision: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z'
  }));
  const periods = [
    {
      id: 'period-current', companyId: COMPANY_ID, name: 'September 2026', startDate: '2026-09-01',
      endDate: null, isClosed: false, closedAt: null, notes: null, archiveFilename: null,
      status: 'OPEN', serverRevision: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z'
    },
    {
      id: 'period-archive', companyId: COMPANY_ID, name: 'August 2026', startDate: '2026-08-01',
      endDate: '2026-08-31', isClosed: true, closedAt: '2026-09-01T00:00:00.000Z', notes: null,
      archiveFilename: 'august.json', status: 'CLOSED', serverRevision: 1,
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z'
    }
  ];
  const parties = Array.from({ length: 42 }, (_, index) => ({
    id: `party_${index + 1}`,
    companyId: COMPANY_ID,
    partyNumber: String(index + 1),
    physicalPartyNumber: String(index + 1),
    modelId: `model_${(index % 18) + 1}`,
    modelName: `Model ${(index % 18) + 1}`,
    color: 'Black',
    pattaCount: 0,
    cumulativePattaCount: 0,
    ishSoniPerPatta: null,
    totalIshSoni: null,
    ishSoni: 0,
    cumulativeIshSoni: 0,
    sizes: {},
    printedAt: '2026-09-01T00:00:00.000Z',
    isClosed: false,
    closedAt: null,
    archivedPattaNumbers: [],
    status: 'ACTIVE',
    isArchived: false,
    serverRevision: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z'
  }));
  const workerAdjustments = [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `opening-avans-${index + 1}`, companyId: COMPANY_ID, workerId: 1, periodId: 'period-current',
      type: 'AVANS', amount: 505000, provenance: 'OWNER_APPROVED_BASELINE', createdAt: '2026-09-01T00:00:00.000Z'
    })),
    ...Array.from({ length: 7 }, (_, index) => ({
      id: `opening-jarima-${index + 1}`, companyId: COMPANY_ID, workerId: 1, periodId: 'period-current',
      type: 'JARIMA', amount: index === 6 ? 78574 : 78571, provenance: 'OWNER_APPROVED_BASELINE', createdAt: '2026-09-01T00:00:00.000Z'
    }))
  ];
  const snapshot = {
    schemaVersion: 1,
    company: { companyId: COMPANY_ID },
    models,
    workers,
    periods,
    legacyPartyCollisionExceptions: [],
    parties,
    workerAdjustments,
    tickets: [],
    productionAdjustments: [],
    batchSettings: {
      company: { companyId: COMPANY_ID, availableSizes: ['S', 'M', 'L'], serverRevision: 1, updatedAt: '2026-09-01T00:00:00.000Z' },
      models: [{
        companyId: COMPANY_ID, modelId: 'model_1', partyNumber: '42', isCustomParty: true,
        totalIshSoni: '446', color: 'Black', sizes: { M: '446' }, serverRevision: 1,
        updatedAt: '2026-09-01T00:00:00.000Z'
      }]
    },
    periodArchives: [{
      companyId: COMPANY_ID, periodId: 'period-archive', archive: { periodId: 'period-archive', workers: [] },
      sha256: 'a'.repeat(64), archivedAt: '2026-09-01T00:00:00.000Z'
    }]
  };
  return {
    success: true,
    snapshot,
    cursor: '9223372036854775000',
    counts: {
      models: models.length,
      workers: workers.length,
      periods: periods.length,
      legacyPartyCollisionExceptions: 0,
      parties: parties.length,
      workerAdjustments: workerAdjustments.length,
      tickets: 0,
      ticketEntries: 0,
      productionAdjustments: 0,
      periodArchives: 1
    }
  };
}

function makeProductionCanaryBootstrapFailureFixture() {
  const response = makeProductionLikeBootstrap();
  // Captured production contract shape: default, non-custom settings use an
  // empty partyNumber and totalIshSoni. Names/IDs and business values remain
  // synthetic while the baseline counts and JSON field shapes are preserved.
  response.cursor = '0';
  response.snapshot.workers.forEach((worker: any) => { worker.role = null; });
  response.snapshot.periodArchives = [];
  response.counts.periodArchives = 0;
  response.snapshot.batchSettings.models = response.snapshot.models.map((model: any) => ({
    companyId: COMPANY_ID,
    modelId: model.id,
    partyNumber: '',
    isCustomParty: false,
    totalIshSoni: '',
    color: 'Black',
    sizes: {},
    serverRevision: 1,
    updatedAt: '2026-09-01T00:00:00.000Z'
  }));
  return response;
}

describe(' SQLite authoritative bootstrap', () => {
  let userData: string;
  let db: any;

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-bootstrap-'));
    db = databaseManager.getCompanyDatabase(userData, COMPANY_ID);
  });

  afterEach(() => {
    databaseManager.closeAllCompanyDatabases();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('hydrates an empty canonical database with the exact production-like roster, references, and opening balances', () => {
    const response = makeProductionLikeBootstrap();
    expect(getBootstrapState(db, COMPANY_ID)).toMatchObject({ status: 'NEEDS_BOOTSTRAP' });

    const applied = applyBootstrapSnapshot(db, COMPANY_ID, response);

    expect(applied).toMatchObject({ status: 'APPLIED', cursor: '9223372036854775000', counts: response.counts });
    expect(getBootstrapState(db, COMPANY_ID)).toMatchObject({ status: 'COMPLETE', cursor: '9223372036854775000' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM workers WHERE company_id = ?').get(COMPANY_ID).count).toBe(201);
    expect(db.prepare('SELECT COUNT(*) AS count FROM models WHERE company_id = ?').get(COMPANY_ID).count).toBe(18);
    expect(db.prepare('SELECT COUNT(*) AS count FROM parties WHERE company_id = ?').get(COMPANY_ID).count).toBe(42);
    expect(db.prepare('SELECT COUNT(*) AS count FROM worker_adjustments WHERE company_id = ?').get(COMPANY_ID).count).toBe(11);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tickets WHERE company_id = ?').get(COMPANY_ID).count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM ticket_entries WHERE company_id = ?').get(COMPANY_ID).count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM production_adjustments WHERE company_id = ?').get(COMPANY_ID).count).toBe(0);
    expect(db.prepare('SELECT value FROM local_meta WHERE key = ?').get('_bootstrap_complete').value).toBe('1');
    expect(db.prepare('SELECT value FROM local_meta WHERE key = ?').get('sync_cursor').value).toBe('9223372036854775000');

    const projection = loadWorkbookProjectionFromSqlite(db, COMPANY_ID);
    expect(projection.workers).toHaveLength(201);
    expect(projection.models).toHaveLength(18);
    expect(projection.printedPartyHistory).toHaveLength(42);
    expect(projection.availableSizes).toEqual(['S', 'M', 'L']);
    expect(projection.pattaBatchConfigs.model_1).toMatchObject({ partyNumber: '42', totalIshSoni: '446' });
    expect(projection.workers.find((worker: any) => worker.id === 1)).toMatchObject({ avans: 2020000, jarima: 550000 });
  });

  it('imports persisted grandfathered party-collision exceptions before their duplicate parties', () => {
    const response = makeProductionLikeBootstrap();
    const firstParty = response.snapshot.parties.find((party: any) => party.id === 'party_2');
    const secondParty = {
      ...firstParty,
      id: 'party_2-grandfathered',
      modelId: 'model_2',
      modelName: 'Model 2',
      serverRevision: 2
    };
    response.snapshot.parties.push(secondParty);
    response.snapshot.legacyPartyCollisionExceptions = [
      {
        exceptionId: 'exception-party-2-a', companyId: COMPANY_ID, partyNumber: '2', partyId: firstParty.id,
        collisionGroupId: 'collision-party-2', approvedBy: 'OWNER_BUSINESS_DECISION',
        approvedAt: '2026-09-01T00:00:00.000Z', reason: 'Preserve the approved historical Party #2 pair',
        status: 'ACTIVE', createdAt: '2026-09-01T00:00:00.000Z'
      },
      {
        exceptionId: 'exception-party-2-b', companyId: COMPANY_ID, partyNumber: '2', partyId: secondParty.id,
        collisionGroupId: 'collision-party-2', approvedBy: 'OWNER_BUSINESS_DECISION',
        approvedAt: '2026-09-01T00:00:00.000Z', reason: 'Preserve the approved historical Party #2 pair',
        status: 'ACTIVE', createdAt: '2026-09-01T00:00:00.000Z'
      }
    ];
    response.counts.parties = response.snapshot.parties.length;
    response.counts.legacyPartyCollisionExceptions = 2;

    expect(() => validateBootstrapResponse(response, COMPANY_ID)).not.toThrow();
    expect(applyBootstrapSnapshot(db, COMPANY_ID, response)).toMatchObject({ status: 'APPLIED' });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM parties
      WHERE company_id = ? AND party_number = '2' AND status != 'CLOSED'`).get(COMPANY_ID).count).toBe(2);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM legacy_party_collision_exceptions
      WHERE company_id = ? AND party_number = '2' AND status = 'ACTIVE'`).get(COMPANY_ID).count).toBe(2);
  });

  it('accepts and atomically imports the production default batch-settings contract', () => {
    const response = makeProductionCanaryBootstrapFailureFixture();

    expect(response.counts).toMatchObject({ workers: 201, models: 18, parties: 42 });
    expect(response.cursor).toBe('0');
    expect(response.snapshot.batchSettings.models).toHaveLength(18);
    expect(response.snapshot.batchSettings.models[0]).toMatchObject({ partyNumber: '', isCustomParty: false });
    expect(response.snapshot).not.toHaveProperty('printedPattas');
    expect(() => validateBootstrapResponse(response, COMPANY_ID)).not.toThrow();

    const applied = applyBootstrapSnapshot(db, COMPANY_ID, response);
    expect(applied).toMatchObject({ status: 'APPLIED', cursor: response.cursor });
    expect(getBootstrapState(db, COMPANY_ID)).toMatchObject({ status: 'COMPLETE', cursor: response.cursor });
    expect(db.prepare('SELECT COUNT(*) AS count FROM workers').get().count).toBe(201);
    expect(db.prepare('SELECT COUNT(*) AS count FROM models').get().count).toBe(18);
    expect(db.prepare('SELECT COUNT(*) AS count FROM parties').get().count).toBe(42);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tickets').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM ticket_entries').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM local_meta WHERE key = ?').get('_bootstrap_complete').count).toBe(1);
    const projection = loadWorkbookProjectionFromSqlite(db, COMPANY_ID);
    expect(projection.workers.find((worker: any) => worker.id === 1)).toMatchObject({ avans: 2020000, jarima: 550000 });
    expect(projection.pattaBatchConfigs.model_1).toMatchObject({ partyNumber: '', isCustomParty: false, totalIshSoni: '' });
  });

  it('treats a repeated snapshot application as a no-op and creates no duplicate entities', () => {
    const response = makeProductionLikeBootstrap();
    applyBootstrapSnapshot(db, COMPANY_ID, response);

    expect(applyBootstrapSnapshot(db, COMPANY_ID, response)).toMatchObject({ status: 'ALREADY_BOOTSTRAPPED' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM workers WHERE company_id = ?').get(COMPANY_ID).count).toBe(201);
    expect(db.prepare('SELECT COUNT(*) AS count FROM worker_adjustments WHERE company_id = ?').get(COMPANY_ID).count).toBe(11);
    expect(db.prepare('SELECT COUNT(*) AS count FROM parties WHERE company_id = ?').get(COMPANY_ID).count).toBe(42);
  });

  it('rolls back every imported row, the cursor, and completion metadata on a pre-commit crash and retries safely', () => {
    const response = makeProductionCanaryBootstrapFailureFixture();
    expect(() => applyBootstrapSnapshot(db, COMPANY_ID, response, {
      testHookBeforeCommit: () => { throw new Error('SIMULATED_BOOTSTRAP_CRASH'); }
    })).toThrow('SIMULATED_BOOTSTRAP_CRASH');

    expect(getBootstrapState(db, COMPANY_ID)).toMatchObject({ status: 'NEEDS_BOOTSTRAP' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM models').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM workers').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM parties').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM worker_adjustments').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM local_meta WHERE key IN (?, ?)').get('_bootstrap_complete', 'sync_cursor').count).toBe(0);

    expect(applyBootstrapSnapshot(db, COMPANY_ID, response).status).toBe('APPLIED');
    expect(db.prepare('SELECT COUNT(*) AS count FROM workers').get().count).toBe(201);
  });

  it('refuses to overwrite existing canonical rows or any unsynced outbox operation', () => {
    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES ('local-model', ?, 'Local Model', '[]', datetime('now'), datetime('now'))`).run(COMPANY_ID);
    expect(() => applyBootstrapSnapshot(db, COMPANY_ID, makeProductionLikeBootstrap()))
      .toThrowError(expect.objectContaining({ code: 'BOOTSTRAP_RECOVERY_REQUIRED' }));
    expect(db.prepare('SELECT COUNT(*) AS count FROM models').get().count).toBe(1);
    db.prepare('DELETE FROM models WHERE id = ?').run('local-model');

    const payload = { commandId: 'unsynced-operation', companyId: COMPANY_ID };
    const payloadJson = canonicalStringify(payload);
    db.prepare(`INSERT INTO local_outbox (
      operation_id, company_id, command_type, entity_type, entity_id, base_revision,
      payload_json, payload_hash, causal_sequence, status, created_at, updated_at
    ) VALUES (?, ?, 'SubmitTicket', 'ticket', 'local-ticket', 0, ?, ?, 1, 'PENDING', datetime('now'), datetime('now'))`)
      .run('unsynced-operation', COMPANY_ID, payloadJson, computePayloadHash(payloadJson));

    expect(() => applyBootstrapSnapshot(db, COMPANY_ID, makeProductionLikeBootstrap()))
      .toThrowError(expect.objectContaining({ code: 'BOOTSTRAP_RECOVERY_REQUIRED' }));
    expect(db.prepare('SELECT operation_id, status FROM local_outbox').get()).toEqual({ operation_id: 'unsynced-operation', status: 'PENDING' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM workers').get().count).toBe(0);
  });

  it('fails closed for malformed response metadata, cross-company rows, bad references, and changed counts', () => {
    const valid = makeProductionLikeBootstrap();
    expect(() => validateBootstrapResponse({ ...valid, cursor: '1; DROP TABLE workers' }, COMPANY_ID))
      .toThrowError(expect.objectContaining({ code: 'BOOTSTRAP_RESPONSE_INVALID' }));
    expect(() => validateBootstrapResponse({ ...valid, cursor: '9223372036854775808' }, COMPANY_ID))
      .toThrowError(expect.objectContaining({ code: 'BOOTSTRAP_RESPONSE_INVALID' }));
    expect(() => validateBootstrapResponse({ ...valid, counts: { ...valid.counts, workers: 200 } }, COMPANY_ID))
      .toThrowError(expect.objectContaining({ code: 'BOOTSTRAP_RESPONSE_INVALID' }));

    const wrongCompany = makeProductionLikeBootstrap();
    wrongCompany.snapshot.workers[0].companyId = 'another-company';
    expect(() => validateBootstrapResponse(wrongCompany, COMPANY_ID))
      .toThrowError(expect.objectContaining({ code: 'BOOTSTRAP_RESPONSE_INVALID' }));

    const invalidReference = makeProductionLikeBootstrap();
    invalidReference.snapshot.parties[0].modelId = 'missing-model';
    expect(() => validateBootstrapResponse(invalidReference, COMPANY_ID))
      .toThrowError(expect.objectContaining({ code: 'BOOTSTRAP_RESPONSE_INVALID' }));

    const fabricatedLegacyAuthority = makeProductionLikeBootstrap() as any;
    fabricatedLegacyAuthority.snapshot.deletedWorkerIds = [201];
    expect(() => validateBootstrapResponse(fabricatedLegacyAuthority, COMPANY_ID))
      .toThrowError(expect.objectContaining({ code: 'BOOTSTRAP_RESPONSE_INVALID' }));

    const customPartyWithoutNumber = makeProductionCanaryBootstrapFailureFixture();
    customPartyWithoutNumber.snapshot.batchSettings.models[0].isCustomParty = true;
    expect(() => validateBootstrapResponse(customPartyWithoutNumber, COMPANY_ID))
      .toThrowError(expect.objectContaining({ code: 'BOOTSTRAP_RESPONSE_INVALID' }));

    const nonStringTotal = makeProductionCanaryBootstrapFailureFixture();
    nonStringTotal.snapshot.batchSettings.models[0].totalIshSoni = null;
    expect(() => validateBootstrapResponse(nonStringTotal, COMPANY_ID))
      .toThrowError(expect.objectContaining({ code: 'BOOTSTRAP_RESPONSE_INVALID' }));
  });

  it('rejects malformed ticket identities, non-integer quantities, booleans, timestamps, and unsafe numeric values before writes', () => {
    const makeResponseWithTicket = () => {
      const response = makeProductionLikeBootstrap();
      response.snapshot.tickets = [{
        id: '00000000-0000-4000-8000-000000000001',
        companyId: COMPANY_ID,
        modelId: 'model_1',
        periodId: 'period-current',
        partyNumber: '1',
        partyRecordId: 'party_1',
        pattaNumber: 1,
        qty: 1,
        size: null,
        color: null,
        konveyer: null,
        status: 'CONFIRMED',
        isClosed: false,
        submittedAt: '2026-09-01T00:00:00.000Z',
        createdAt: '2026-09-01T00:00:00.000Z',
        serverRevision: 1,
        entries: [{
          id: 'entry-1', companyId: COMPANY_ID, opName: 'Sew', workerId: 1,
          workerNameSnapshot: 'Worker 1', rateSnapshot: 12.5, brak: null, qty: 1,
          createdAt: '2026-09-01T00:00:00.000Z'
        }]
      }];
      response.counts.tickets = 1;
      response.counts.ticketEntries = 1;
      return response;
    };
    const expectInvalid = (mutate: (response: any) => void) => {
      const response = makeResponseWithTicket();
      mutate(response);
      expect(() => validateBootstrapResponse(response, COMPANY_ID))
        .toThrowError(expect.objectContaining({ code: 'BOOTSTRAP_RESPONSE_INVALID' }));
    };

    expectInvalid((response) => { response.snapshot.tickets[0].id = 'ticket-not-a-uuid'; });
    expectInvalid((response) => { response.snapshot.tickets[0].qty = 1.5; });
    expectInvalid((response) => { response.snapshot.tickets[0].isClosed = 'false'; });
    expectInvalid((response) => { response.snapshot.tickets[0].submittedAt = 'not-a-timestamp'; });
    expectInvalid((response) => { response.snapshot.tickets[0].entries[0].qty = Number.POSITIVE_INFINITY; });
    expectInvalid((response) => { response.snapshot.workerAdjustments[0].amount = Number.MAX_SAFE_INTEGER + 1; });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tickets').get().count).toBe(0);
  });

  it('accepts a completed  database only with a valid durable cursor', () => {
    db.prepare(`INSERT INTO local_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run('_bootstrap_complete', '1');
    db.prepare(`INSERT INTO local_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run('sync_cursor', '42');
    expect(getBootstrapState(db, COMPANY_ID)).toMatchObject({ status: 'COMPLETE', cursor: '42' });

    db.prepare(`UPDATE local_meta SET value = 'invalid', updated_at = datetime('now') WHERE key = 'sync_cursor'`).run();
    expect(() => getBootstrapState(db, COMPANY_ID))
      .toThrowError(expect.objectContaining({ code: 'BOOTSTRAP_METADATA_INVALID' }));
  });

  it('fails closed when a cursor exists without its bootstrap completion marker', () => {
    db.prepare(`INSERT INTO local_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run('sync_cursor', '0');
    expect(() => getBootstrapState(db, COMPANY_ID))
      .toThrowError(expect.objectContaining({ code: 'BOOTSTRAP_METADATA_INVALID' }));
    expect(db.prepare("SELECT value FROM local_meta WHERE key = 'sync_cursor'").get().value).toBe('0');
  });
});
